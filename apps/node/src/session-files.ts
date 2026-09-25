import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  SESSION_FILE_MAX_BYTES,
  errorMessage,
  type SessionFileErrorCode,
  type SessionFileReadRequest,
  type SessionFileReadResult,
} from "@fleet/protocol";
import { containedPath } from "./canonical-path.js";

/** Copilot names a session's state folder with one safe path component. */
const AGENT_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Reads in progress at once across every download; a Host keeps a few each. */
const MAX_CONCURRENT_READS = 8;

/**
 * Opened without following a swapped-in link, and without blocking on a FIFO
 * that is waiting for a writer. Windows has neither flag, and needs neither:
 * its pipes and devices live outside every folder a session is given.
 */
const OPEN_FLAGS =
  process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

export type SessionFileReaderOptions = {
  /** Where a session still live on this Node is working, working directory first. */
  liveRoots?: (sessionId: string) => readonly string[];
  /** The scratch directory an orchestrator is started in. */
  coordinatorDirectory?: (sessionId: string) => string | undefined;
  /** Fleet's own state on this machine: its identity, journals and settings. */
  protectedRoots?: readonly string[];
  copilotHome?: string;
  homeDirectory?: string;
  maxConcurrentReads?: number;
  /** The largest file relayed; the protocol ceiling unless a test lowers it. */
  maxBytes?: number;
};

class Refusal extends Error {
  constructor(
    readonly code: SessionFileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads files off this machine for a browser download, one chunk per request.
 *
 * A session may name a file anywhere, so what it names is checked against
 * where the session was allowed to work rather than trusted: the file must
 * resolve — links and all — inside the session's working directory, one of its
 * additional roots, an orchestrator's scratch directory, or the session's own
 * Copilot state folder. On top of that, Fleet's identity and Copilot's own
 * configuration are never read, even from a session whose working directory
 * contains them, as a Chats session in the home directory does. A root that
 * sits inside one of those folders opens only itself: that is how the
 * orchestrator's scratch directory and the session's state folder stay
 * reachable without the rest of either becoming so.
 *
 * This is a policy for what a download relays, not a sandbox. The agent runs as
 * the same account and can read whatever that account can.
 */
export class SessionFileReader {
  private active = 0;

  constructor(private readonly options: SessionFileReaderOptions = {}) {}

  async read(request: SessionFileReadRequest): Promise<SessionFileReadResult> {
    if (this.active >= (this.options.maxConcurrentReads ?? MAX_CONCURRENT_READS)) {
      return refusal(
        request,
        "busy",
        "This Node is already reading as many files as it will at once. Try again shortly.",
      );
    }
    this.active += 1;
    try {
      return await this.readChecked(request);
    } catch (error) {
      const [code, message] = classify(error);
      return refusal(request, code, message);
    } finally {
      this.active -= 1;
    }
  }

  private async readChecked(
    request: SessionFileReadRequest,
  ): Promise<SessionFileReadResult> {
    const home = this.options.homeDirectory ?? homedir();
    const copilotHome =
      this.options.copilotHome ?? (process.env.COPILOT_HOME || join(home, ".copilot"));
    const live = this.options.liveRoots?.(request.sessionId) ?? [];
    const base = live[0] ?? request.roots[0];
    const named = expandHome(request.path, home);
    if (!isAbsolute(named) && !base) {
      throw new Refusal(
        "invalid",
        "Give an absolute path: this session has no working directory to resolve it against.",
      );
    }
    const target = await realpath(resolve(base ?? "", named));

    const granted = await canonicalAll([
      ...live,
      ...request.roots,
      request.coordinator
        ? this.options.coordinatorDirectory?.(request.sessionId)
        : undefined,
      AGENT_SESSION_ID.test(request.agentSessionId)
        ? join(copilotHome, "session-state", request.agentSessionId)
        : undefined,
    ]);
    const guarded = await canonicalAll([
      ...(this.options.protectedRoots ?? []),
      copilotHome,
      ...request.protectedRoots,
    ]);
    assertPermitted(target, granted, guarded);

    const file = await open(target, OPEN_FLAGS);
    try {
      const stats = await file.stat({ bigint: true });
      if (!stats.isFile()) {
        throw new Refusal("not_a_file", "That path is a folder or a device, not a file.");
      }
      const maxBytes = Math.min(
        this.options.maxBytes ?? SESSION_FILE_MAX_BYTES,
        SESSION_FILE_MAX_BYTES,
      );
      if (stats.size > BigInt(maxBytes)) {
        throw new Refusal(
          "too_large",
          `That file is larger than the ${formatMegabytes(maxBytes)} a download can relay. Copy it off the machine another way.`,
        );
      }
      const version = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
      if (request.version && request.version !== version) {
        throw new Refusal(
          "changed",
          "The file changed while it was being downloaded. Download it again.",
        );
      }
      const size = Number(stats.size);
      if (request.offset > size) {
        throw new Refusal("invalid", "That read starts past the end of the file.");
      }
      const length = Math.min(request.length, size - request.offset);
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await file.read(
          buffer,
          filled,
          length - filled,
          request.offset + filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled < length) {
        throw new Refusal(
          "changed",
          "The file got shorter while it was being read. Download it again.",
        );
      }
      return {
        requestId: request.requestId,
        ok: true,
        path: target,
        name: basename(target),
        size,
        modifiedAt: stats.mtime.toISOString(),
        version,
        offset: request.offset,
        data: buffer.toString("base64"),
      };
    } finally {
      await file.close();
    }
  }
}

/**
 * Whether a resolved file may be relayed, given the resolved roots.
 *
 * A protected folder blocks a file inside it unless the root that grants the
 * file sits strictly inside that same folder. Equal is not inside: a session
 * working in Fleet's configuration directory itself still cannot hand out the
 * identity stored at its top.
 */
function assertPermitted(
  target: string,
  granted: readonly string[],
  guarded: readonly string[],
): void {
  const holders = granted.filter((root) => containedPath(root, target));
  if (holders.length === 0) {
    throw new Refusal(
      "forbidden",
      "That file is outside the folders this session works in, so it cannot be downloaded from here.",
    );
  }
  const reachable = holders.some(
    (root) =>
      !guarded.some(
        (folder) =>
          (folder === target || containedPath(folder, target)) &&
          !containedPath(folder, root),
      ),
  );
  if (!reachable) {
    throw new Refusal(
      "forbidden",
      "That file belongs to Fleet's or Copilot's own configuration, which downloads never read.",
    );
  }
}

/** Absolute roots as the filesystem resolves them; missing ones drop out. */
async function canonicalAll(paths: readonly (string | undefined)[]): Promise<string[]> {
  const resolved = await Promise.all(
    paths.map(async (path) => {
      if (!path || !isAbsolute(path)) return undefined;
      try {
        return await realpath(path);
      } catch {
        return undefined;
      }
    }),
  );
  return [...new Set(resolved.filter((path): path is string => path !== undefined))];
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  const prefixed = process.platform === "win32" ? /^~[\\/]/ : /^~\//;
  return prefixed.test(path) ? join(home, path.slice(2)) : path;
}

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1 ? `${Math.round(megabytes)} MB` : `${bytes} bytes`;
}

function classify(error: unknown): [SessionFileErrorCode, string] {
  if (error instanceof Refusal) return [error.code, error.message];
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : "";
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return ["not_found", "That file does not exist on this machine."];
    case "EACCES":
    case "EPERM":
      return [
        "forbidden",
        "The account running this Node is not allowed to read that file.",
      ];
    case "EISDIR":
    case "ENXIO":
      return ["not_a_file", "That path is a folder or a device, not a file."];
    case "ELOOP":
      return ["changed", "The file changed while it was being read. Download it again."];
    case "EBUSY":
      return ["unavailable", "Another program has that file locked. Try again later."];
    default:
      return ["unavailable", errorMessage(error, "The file could not be read.")];
  }
}

function refusal(
  request: SessionFileReadRequest,
  code: SessionFileErrorCode,
  message: string,
): SessionFileReadResult {
  return { requestId: request.requestId, ok: false, code, error: message.slice(0, 2000) };
}
