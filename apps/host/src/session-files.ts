import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  HostToNodeMessageSchema,
  SESSION_FILES_CAPABILITY,
  SESSION_FILE_CHUNK_BYTES,
  errorMessage,
  type SessionFileErrorCode,
  type SessionFileInfo,
  type SessionFileReadRequest,
  type SessionFileReadResult,
} from "@fleet/protocol";
import type { FleetService, NodeLink } from "./fleet-service.js";
import { SealedNodeLink } from "./gateway/node-channel.js";

/** How long one read may take before the download is abandoned. */
const READ_TIMEOUT_MS = 30_000;

/**
 * Downloads relayed from one Node at once. Each keeps a couple of chunks on
 * that Node's socket, which it shares with every session event it sends.
 */
const DOWNLOADS_PER_NODE = 3;

/** Reads kept in flight per download, so a round trip is not paid per chunk. */
const READ_WINDOW = 2;

const STATUS: Record<SessionFileErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  not_a_file: 400,
  forbidden: 403,
  too_large: 413,
  changed: 409,
  busy: 503,
  unavailable: 502,
};

export type SessionFileFailure = { ok: false; status: number; error: string };

export type SessionFileDownload = {
  ok: true;
  info: SessionFileInfo;
  /** The file's bytes, pulled from the Node as they are consumed. */
  stream: Readable;
  nodeId: string;
};

export type SessionFileServiceOptions = {
  timeoutMs?: number;
  downloadsPerNode?: number;
  window?: number;
};

type ReadFile = Extract<SessionFileReadResult, { ok: true }>;
type ReadOutcome = SessionFileReadResult | SessionFileFailure;
type ReadPart = Pick<SessionFileReadRequest, "path" | "offset" | "length" | "version">;
type Target = {
  ok: true;
  nodeId: string;
  link: NodeLink;
  base: Omit<SessionFileReadRequest, keyof ReadPart | "requestId">;
};

/**
 * Relays a file from the machine that ran a session to a browser.
 *
 * Nodes only dial out, so the Host cannot fetch from one; it asks over the
 * connection the Node already holds and streams the answers on as they arrive.
 * Reads are pulled rather than pushed, a small window at a time, so a slow
 * browser slows the Node down instead of piling a file up in memory here, and
 * a download never crowds out the session events sharing that socket.
 *
 * The Host names where a session was allowed to work; the Node decides what
 * that permits and reads nothing outside it.
 */
export class SessionFileService {
  private readonly pending = new Map<
    string,
    { nodeId: string; resolve: (outcome: ReadOutcome) => void; timer: NodeJS.Timeout }
  >();
  private readonly downloads = new Map<string, number>();

  constructor(
    private readonly service: FleetService,
    private readonly options: SessionFileServiceOptions = {},
  ) {}

  /** What a file is, without reading any of it. */
  async stat(
    sessionId: string,
    path: string,
  ): Promise<{ ok: true; info: SessionFileInfo; nodeId: string } | SessionFileFailure> {
    const target = this.target(sessionId);
    if (!target.ok) return target;
    const result = await this.read(target, { path, offset: 0, length: 0, version: "" });
    if (!result.ok) return failure(result);
    return { ok: true, info: infoOf(result), nodeId: target.nodeId };
  }

  /**
   * Starts a download, answering once the first chunk is in hand.
   *
   * Waiting for it means a missing or refused file is still an HTTP error the
   * browser can show, rather than a download that fails after it has begun.
   */
  async open(
    sessionId: string,
    path: string,
  ): Promise<SessionFileDownload | SessionFileFailure> {
    const target = this.target(sessionId);
    if (!target.ok) return target;
    const { nodeId } = target;
    const held = this.downloads.get(nodeId) ?? 0;
    if (held >= (this.options.downloadsPerNode ?? DOWNLOADS_PER_NODE)) {
      return {
        ok: false,
        status: 429,
        error:
          "This Node is already sending as many downloads as it will at once. Wait for one to finish.",
      };
    }
    this.downloads.set(nodeId, held + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (this.downloads.get(nodeId) ?? 1) - 1;
      if (remaining > 0) this.downloads.set(nodeId, remaining);
      else this.downloads.delete(nodeId);
    };
    const first = await this.read(target, {
      path,
      offset: 0,
      length: SESSION_FILE_CHUNK_BYTES,
      version: "",
    });
    if (!first.ok) {
      release();
      return failure(first);
    }
    const stream = Readable.from(this.chunks(target, first), { objectMode: false });
    stream.once("close", release);
    return { ok: true, info: infoOf(first), stream, nodeId };
  }

  /** Downloads currently being relayed from a Node. */
  activeDownloads(nodeId: string): number {
    return this.downloads.get(nodeId) ?? 0;
  }

  /** Settles the read a Node answered; false when nothing from it was waiting. */
  handleResult(nodeId: string, result: SessionFileReadResult): boolean {
    const pending = this.pending.get(result.requestId);
    if (!pending || pending.nodeId !== nodeId) return false;
    this.pending.delete(result.requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }

  /** Fails every read still waiting on a Node whose connection is gone. */
  nodeDisconnected(nodeId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.nodeId !== nodeId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        status: 503,
        error: "The Node disconnected before the file arrived.",
      });
    }
  }

  private target(sessionId: string): Target | SessionFileFailure {
    const { store } = this.service;
    const session = store.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
    const node = store.getNode(session.nodeId);
    const link = this.service.nodeSocket(session.nodeId);
    if (!node?.online || !link || link.readyState !== link.OPEN) {
      return {
        ok: false,
        status: 503,
        error: `${session.nodeName} is offline, so its files cannot be downloaded right now.`,
      };
    }
    if (!node.capabilities.includes(SESSION_FILES_CAPABILITY)) {
      return {
        ok: false,
        status: 409,
        error: `Update ${node.name} to download files from its sessions.`,
      };
    }
    // File contents are exactly what a relay that saw a shared secret could
    // read, so they travel only over a mutually authenticated channel.
    if (!(link instanceof SealedNodeLink)) {
      return {
        ok: false,
        status: 409,
        error: `${node.name} still authenticates with a shared secret. Run a fresh Connect command on it to download files over an authenticated connection.`,
      };
    }
    const placement = store.getPlacement(session.placementId);
    const cwd = session.executionBinding?.cwd || placement?.localPath;
    return {
      ok: true,
      nodeId: node.id,
      link,
      base: {
        sessionId: session.id,
        roots: [...(cwd ? [cwd] : []), ...(session.additionalDirectories ?? [])].slice(
          0,
          101,
        ),
        protectedRoots: store.dataDirectory ? [store.dataDirectory] : [],
        agentSessionId:
          (session.agentParams?.kind ?? "copilot") === "copilot" &&
          session.agentSessionId.length <= 128
            ? session.agentSessionId
            : "",
        coordinator: session.runRole === "lead",
      },
    };
  }

  /** One read, settled by the Node's answer, a timeout or a disconnect; never thrown. */
  private read(target: Target, part: ReadPart): Promise<ReadOutcome> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      let frame: string;
      try {
        frame = JSON.stringify(
          HostToNodeMessageSchema.parse({
            type: "session_file_read",
            request: { ...target.base, ...part, requestId },
          }),
        );
      } catch (error) {
        resolve({
          ok: false,
          status: 400,
          error: `That file cannot be requested: ${errorMessage(error)}`,
        });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, status: 504, error: "The Node did not answer in time." });
      }, this.options.timeoutMs ?? READ_TIMEOUT_MS);
      timer.unref();
      this.pending.set(requestId, { nodeId: target.nodeId, resolve, timer });
      if (target.link.readyState === target.link.OPEN) target.link.send(frame);
    });
  }

  /**
   * The rest of a file, in order, pinned to the version its first read saw.
   *
   * Every answer is checked against where it should fall: a Node that skipped,
   * repeated or resized a chunk would otherwise hand the browser a file that
   * looks complete and is not.
   */
  private async *chunks(target: Target, first: ReadFile): AsyncGenerator<Buffer> {
    const firstBytes = Buffer.from(first.data, "base64");
    if (firstBytes.length !== Math.min(SESSION_FILE_CHUNK_BYTES, first.size)) {
      throw new Error("The Node sent the start of the file at the wrong length.");
    }
    if (firstBytes.length > 0) yield firstBytes;
    let offset = firstBytes.length;
    let requested = offset;
    const window: Promise<ReadOutcome>[] = [];
    while (offset < first.size) {
      while (
        window.length < (this.options.window ?? READ_WINDOW) &&
        requested < first.size
      ) {
        const length = Math.min(SESSION_FILE_CHUNK_BYTES, first.size - requested);
        window.push(
          this.read(target, {
            path: first.path,
            offset: requested,
            length,
            version: first.version,
          }),
        );
        requested += length;
      }
      const result = await window.shift()!;
      if (!result.ok) throw new Error(result.error);
      const bytes = Buffer.from(result.data, "base64");
      if (
        result.offset !== offset ||
        result.version !== first.version ||
        result.size !== first.size ||
        bytes.length !== Math.min(SESSION_FILE_CHUNK_BYTES, first.size - offset)
      ) {
        throw new Error("The Node's answer did not match the file being downloaded.");
      }
      offset += bytes.length;
      yield bytes;
    }
  }
}

function infoOf(result: ReadFile): SessionFileInfo {
  return {
    path: result.path,
    name: result.name,
    size: result.size,
    modifiedAt: result.modifiedAt,
  };
}

function failure(outcome: Exclude<ReadOutcome, ReadFile>): SessionFileFailure {
  return "status" in outcome
    ? outcome
    : { ok: false, status: STATUS[outcome.code], error: outcome.error };
}

/**
 * A `Content-Disposition` that saves under the file's own name.
 *
 * The quoted name is an ASCII stand-in for clients that ignore `filename*`;
 * anything that could end the quote or the header is replaced, not escaped.
 */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, "_") || "download";
  let encoded: string;
  try {
    encoded = encodeURIComponent(name).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    // A name that is not well-formed UTF-16 cannot be percent-encoded.
    return `attachment; filename="${fallback}"`;
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
