import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_ARTIFACT_CHUNK_BYTES, WorkspaceResultSchema } from "@fleet/protocol";
import { FleetStore } from "./store.js";
import { WorkspaceArtifactStore } from "./workspace-artifact-store.js";

const roots: string[] = [];
const stores: FleetStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function result(bytes: Buffer) {
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  return WorkspaceResultSchema.parse({
    id: randomUUID(),
    runId: randomUUID(),
    ownerStepId: randomUUID(),
    repositoryIdentity: "f".repeat(64),
    baseSha: "a".repeat(40),
    baseRef: "refs/heads/main",
    headSha: "b".repeat(40),
    sourceWorktreeId: randomUUID(),
    sourceNodeId: "node-1",
    sourcePlacementId: "placement-1",
    sourceGeneration: 1,
    state: "sealing",
    artifactId: artifactSha256,
    artifactSha256,
    artifactSize: bytes.length,
    objectFormat: "sha1",
    createdAt: new Date().toISOString(),
  });
}

describe("workspace artifact storage", () => {
  it("resumes chunks idempotently and survives a store restart", async () => {
    const root = resolve(".mwi-test-work", randomUUID());
    roots.push(root);
    await mkdir(root, { recursive: true });
    const database = join(root, "host.db");
    const bytes = Buffer.alloc(WORKSPACE_ARTIFACT_CHUNK_BYTES + 17, 7);
    const metadata = result(bytes);
    let store = new FleetStore(database, { secureFiles: () => {} });
    stores.push(store);
    let artifacts = new WorkspaceArtifactStore(store);
    expect(
      await artifacts.begin({
        operationId: metadata.id,
        resultId: metadata.id,
        artifactId: metadata.artifactId,
        result: metadata,
      }),
    ).toBe(0);
    const first = bytes.subarray(0, WORKSPACE_ARTIFACT_CHUNK_BYTES);
    const chunk = {
      operationId: metadata.id,
      resultId: metadata.id,
      artifactId: metadata.artifactId,
      offset: 0,
      data: first.toString("base64"),
    };
    expect(await artifacts.append(chunk)).toBe(first.length);
    expect(await artifacts.append(chunk)).toBe(first.length);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = new FleetStore(database, { secureFiles: () => {} });
    stores.push(store);
    artifacts = new WorkspaceArtifactStore(store);
    expect(
      await artifacts.begin({
        operationId: metadata.id,
        resultId: metadata.id,
        artifactId: metadata.artifactId,
        result: metadata,
      }),
    ).toBe(first.length);
    await artifacts.append({
      ...chunk,
      offset: first.length,
      data: bytes.subarray(first.length).toString("base64"),
    });
    const available = await artifacts.complete({
      operationId: metadata.id,
      resultId: metadata.id,
      artifactId: metadata.artifactId,
      size: bytes.length,
      sha256: metadata.artifactSha256,
    });
    expect(available.state).toBe("available");
    const downloaded = await artifacts.read(metadata.id, metadata.artifactId, 0);
    expect(Buffer.from(downloaded.data, "base64")).toEqual(first);
  });

  it("rejects gaps, oversized chunks, and corrupt completion", async () => {
    const root = resolve(".mwi-test-work", randomUUID());
    roots.push(root);
    const store = new FleetStore(join(root, "host.db"), { secureFiles: () => {} });
    stores.push(store);
    const artifacts = new WorkspaceArtifactStore(store);
    const bytes = Buffer.from("portable-result");
    const metadata = result(bytes);
    await artifacts.begin({
      operationId: metadata.id,
      resultId: metadata.id,
      artifactId: metadata.artifactId,
      result: metadata,
    });
    await expect(
      artifacts.append({
        operationId: metadata.id,
        resultId: metadata.id,
        artifactId: metadata.artifactId,
        offset: 1,
        data: bytes.subarray(0, 1).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "artifact_offset" });
    await expect(
      artifacts.append({
        operationId: metadata.id,
        resultId: metadata.id,
        artifactId: metadata.artifactId,
        offset: 0,
        data: Buffer.alloc(WORKSPACE_ARTIFACT_CHUNK_BYTES + 1).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "artifact_chunk_bounds" });
    await artifacts.append({
      operationId: metadata.id,
      resultId: metadata.id,
      artifactId: metadata.artifactId,
      offset: 0,
      data: Buffer.from("portable-resulx").toString("base64"),
    });
    await expect(
      artifacts.complete({
        operationId: metadata.id,
        resultId: metadata.id,
        artifactId: metadata.artifactId,
        size: bytes.length,
        sha256: metadata.artifactSha256,
      }),
    ).rejects.toMatchObject({ code: "artifact_corrupt" });
    expect(store.getWorkspaceResult(metadata.id)?.state).toBe("corrupt");
  });
});
