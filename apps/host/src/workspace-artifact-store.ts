import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  WORKSPACE_ARTIFACT_CHUNK_BYTES,
  WORKSPACE_ARTIFACT_MAX_BYTES,
  WorktreeConflict,
  type ArtifactDownloadChunk,
  type ArtifactUploadBegin,
  type ArtifactUploadChunk,
  type ArtifactUploadComplete,
  type WorkspaceResult,
} from "@fleet/protocol";
import type { FleetStore } from "./store.js";

const META_SUFFIX = ".json";
const PARTIAL_SUFFIX = ".partial";

export class WorkspaceArtifactStore {
  constructor(
    private readonly store: FleetStore,
    private readonly root = store.artifactDirectory,
  ) {}

  private async directory(artifactId: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(artifactId))
      throw new WorktreeConflict("artifact_identity", "Invalid artifact identity.");
    await mkdir(this.root, { recursive: true });
    const rootInfo = await lstat(this.root);
    if (rootInfo.isSymbolicLink())
      throw new WorktreeConflict("artifact_root_alias", "Artifact root is not trusted.");
    const directory = join(this.root, artifactId.slice(0, 2));
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink())
      throw new WorktreeConflict(
        "artifact_directory_alias",
        "Artifact directory is not trusted.",
      );
    const contained = relative(resolve(this.root), resolve(directory));
    if (!contained || contained.startsWith("..") || isAbsolute(contained))
      throw new WorktreeConflict("artifact_path", "Artifact path escaped storage.");
    return directory;
  }

  private async paths(artifactId: string) {
    const directory = await this.directory(artifactId);
    return {
      final: join(directory, artifactId),
      partial: join(directory, `${artifactId}${PARTIAL_SUFFIX}`),
      metadata: join(directory, `${artifactId}${META_SUFFIX}`),
    };
  }

  async begin(value: ArtifactUploadBegin): Promise<number> {
    const { result } = value;
    if (
      result.id !== value.resultId ||
      result.artifactId !== value.artifactId ||
      result.artifactSize > WORKSPACE_ARTIFACT_MAX_BYTES
    )
      throw new WorktreeConflict(
        "artifact_metadata",
        "Artifact metadata is inconsistent.",
      );
    const existing = this.store.getWorkspaceResult(result.id);
    if (existing?.state === "available") return existing.artifactSize;
    this.enforceQuotas(result);
    const paths = await this.paths(result.artifactId);
    const current = await stat(paths.partial).catch(() => undefined);
    if (current && current.size > result.artifactSize) {
      await rm(paths.partial, { force: true });
    }
    const offset = (await stat(paths.partial).catch(() => undefined))?.size ?? 0;
    const sealing = { ...result, state: "uploading" as const, verifiedAt: "" };
    this.store.putWorkspaceResult(sealing);
    await writeFile(paths.metadata, JSON.stringify(sealing), {
      encoding: "utf8",
      mode: 0o600,
    });
    return offset;
  }

  async append(value: ArtifactUploadChunk): Promise<number> {
    const result = this.store.getWorkspaceResult(value.resultId);
    if (
      !result ||
      result.artifactId !== value.artifactId ||
      !["sealing", "uploading"].includes(result.state)
    )
      throw new WorktreeConflict("artifact_upload_unknown", "Upload is not authorized.");
    const chunk = Buffer.from(value.data, "base64");
    if (
      chunk.length === 0 ||
      chunk.length > WORKSPACE_ARTIFACT_CHUNK_BYTES ||
      value.offset + chunk.length > result.artifactSize
    )
      throw new WorktreeConflict(
        "artifact_chunk_bounds",
        "Artifact chunk is out of bounds.",
      );
    const { partial } = await this.paths(value.artifactId);
    const file = await open(partial, "a+", 0o600);
    try {
      const size = (await file.stat()).size;
      if (value.offset < size) {
        if (value.offset + chunk.length > size)
          throw new WorktreeConflict(
            "artifact_offset",
            "A replayed chunk overlaps unverified bytes.",
          );
        const existing = Buffer.alloc(chunk.length);
        await file.read(existing, 0, existing.length, value.offset);
        if (!existing.equals(chunk))
          throw new WorktreeConflict(
            "artifact_chunk_mismatch",
            "A replayed artifact chunk changed.",
          );
        return size;
      }
      if (value.offset !== size)
        throw new WorktreeConflict(
          "artifact_offset",
          "Artifact chunks must be contiguous.",
        );
      await file.write(chunk, 0, chunk.length, value.offset);
      await file.sync();
      return value.offset + chunk.length;
    } finally {
      await file.close();
    }
  }

  async complete(value: ArtifactUploadComplete): Promise<WorkspaceResult> {
    const result = this.store.getWorkspaceResult(value.resultId);
    if (!result || result.artifactId !== value.artifactId)
      throw new WorktreeConflict("artifact_upload_unknown", "Upload is not authorized.");
    if (result.state === "available") return result;
    if (value.size !== result.artifactSize || value.sha256 !== result.artifactSha256)
      throw new WorktreeConflict("artifact_metadata", "Artifact completion changed.");
    const paths = await this.paths(value.artifactId);
    const info = await stat(paths.partial);
    if (info.size !== value.size)
      throw new WorktreeConflict("artifact_size", "Artifact upload is incomplete.");
    const digest = await sha256File(paths.partial);
    if (digest !== value.sha256) {
      await rm(paths.partial, { force: true });
      const corrupt = {
        ...result,
        state: "corrupt" as const,
        error: "Artifact SHA-256 verification failed.",
      };
      this.store.putWorkspaceResult(corrupt);
      throw new WorktreeConflict("artifact_corrupt", corrupt.error);
    }
    await rename(paths.partial, paths.final).catch(async (error: unknown) => {
      const present = await stat(paths.final).catch(() => undefined);
      if (!present || present.size !== value.size) throw error;
      await rm(paths.partial, { force: true });
    });
    const available = {
      ...result,
      state: "available" as const,
      verifiedAt: new Date().toISOString(),
      error: "",
    };
    this.store.putWorkspaceResult(available);
    await writeFile(paths.metadata, JSON.stringify(available), {
      encoding: "utf8",
      mode: 0o600,
    });
    return available;
  }

  async read(
    resultId: string,
    artifactId: string,
    offset: number,
  ): Promise<ArtifactDownloadChunk> {
    const result = this.store.getWorkspaceResult(resultId);
    if (
      !result ||
      result.state !== "available" ||
      result.artifactId !== artifactId ||
      offset < 0 ||
      offset > result.artifactSize
    )
      throw new WorktreeConflict(
        "artifact_download_unknown",
        "Artifact is unavailable or the offset is invalid.",
      );
    const { final } = await this.paths(artifactId);
    const file = await open(final, "r");
    try {
      const length = Math.min(
        WORKSPACE_ARTIFACT_CHUNK_BYTES,
        result.artifactSize - offset,
      );
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      return {
        operationId: "",
        resultId,
        artifactId,
        offset,
        data: buffer.subarray(0, bytesRead).toString("base64"),
        complete: offset + bytesRead === result.artifactSize,
        size: result.artifactSize,
        sha256: result.artifactSha256,
      };
    } finally {
      await file.close();
    }
  }

  async expire(resultId: string): Promise<void> {
    const result = this.store.getWorkspaceResult(resultId);
    if (!result) return;
    const paths = await this.paths(result.artifactId);
    await Promise.all([
      rm(paths.final, { force: true }),
      rm(paths.partial, { force: true }),
      rm(paths.metadata, { force: true }),
    ]);
    this.store.putWorkspaceResult({
      ...result,
      state: "expired",
      error: "",
    });
  }

  private enforceQuotas(candidate: WorkspaceResult): void {
    const all = this.store
      .listWorkspaceResults()
      .filter((entry) => entry.state !== "expired" && entry.id !== candidate.id);
    const perRun = all.filter((entry) => entry.runId === candidate.runId);
    if (perRun.length >= 64)
      throw new WorktreeConflict("artifact_count_quota", "Task artifact limit reached.");
    if (
      perRun.reduce((sum, entry) => sum + entry.artifactSize, candidate.artifactSize) >
      2 * 1024 * 1024 * 1024
    )
      throw new WorktreeConflict(
        "artifact_task_quota",
        "Task artifact byte limit reached.",
      );
    if (
      all.reduce((sum, entry) => sum + entry.artifactSize, candidate.artifactSize) >
      20 * 1024 * 1024 * 1024
    )
      throw new WorktreeConflict(
        "artifact_host_quota",
        "Host artifact byte limit reached.",
      );
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}
