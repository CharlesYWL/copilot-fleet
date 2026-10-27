import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { toolDetail } from "./agents.js";

/**
 * Follows Copilot's own session log so turns taken outside Fleet — someone
 * running `copilot --resume <id>` in a terminal on this machine — still reach
 * the Fleet transcript.
 *
 * Copilot appends every conversation, whichever client drives it, to
 * `${COPILOT_HOME}/session-state/<native-id>/events.jsonl`. Fleet's own live
 * stream already records the turns Fleet prompted, so this module imports only
 * the turns nobody in Fleet asked for, and reports whether some other process
 * holds the conversation open right now.
 *
 * Cost decides the shape. A long session's log runs to hundreds of megabytes,
 * so reading is strictly incremental from a persisted byte offset; an
 * unchanged file costs one `stat`; and a line is parsed only when its leading
 * `"type"` is one the transcript shows — about half of a typical log is hook
 * bookkeeping that never reaches `JSON.parse`.
 */

/** Native event types worth parsing. Everything else is skipped by prefix. */
const IMPORTED_TYPES = new Set([
  "user.message",
  "assistant.message",
  "assistant.turn_end",
  "tool.execution_start",
  "tool.execution_complete",
  "abort",
]);
const TYPE_PREFIX = '{"type":"';
const CHUNK_BYTES = 256 * 1024;
/** A line past this is skipped whole rather than buffered. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_TOOL_TEXT_CHARS = 2 * 1024;
/** Matches the protocol's per-message bound. */
export const MAX_IMPORT_EVENTS = 512;
/**
 * Bytes one pass reads per session. A long terminal session's backlog is
 * drained over several 3-second passes instead of one long stall.
 */
const DEFAULT_MAX_BYTES_PER_PASS = 8 * 1024 * 1024;
const ACK_TIMEOUT_MS = 5_000;
/** A resume waits at most this long for outside turns to be imported first. */
const CATCH_UP_LIMIT_MS = 30_000;
/** Matches the Node's ACP startup budget; a failed start stops claiming. */
const CLAIM_WINDOW_MS = 120_000;

export type NativeEvent = {
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  /** Byte offset just past this line, so ownership can be decided per line. */
  end: number;
};

export type NativeCursor = {
  offset: number;
  /** File identity at `offset`; a replaced or truncated log restarts from 0. */
  identity?: string;
};

export type NativeReadResult = {
  events: NativeEvent[];
  cursor: NativeCursor;
  /** Bytes read this pass; zero means the file had not grown. */
  bytesRead: number;
  /** Lines seen, including skipped ones; for measurement. */
  linesSeen: number;
  /** Lines that reached JSON.parse. */
  linesParsed: number;
};

export function copilotHomeDirectory(): string {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

export function isSafeNativeSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && !/[^a-zA-Z0-9_-]/.test(id);
}

export function nativeSessionDirectory(copilotHome: string, nativeId: string): string {
  if (!isSafeNativeSessionId(nativeId))
    throw new Error("Invalid Copilot session id: expected one safe path component");
  return join(copilotHome, "session-state", nativeId);
}

function fileIdentity(info: { dev: number; ino: number; birthtimeMs: number }): string {
  return `${info.dev}:${info.ino}:${Math.trunc(info.birthtimeMs)}`;
}

/** The top-level `"type"` of a log line, read without parsing it. */
export function lineType(line: Buffer | string): string | undefined {
  const text =
    typeof line === "string" ? line.slice(0, 96) : line.toString("latin1", 0, 96);
  if (!text.startsWith(TYPE_PREFIX)) return undefined;
  const end = text.indexOf('"', TYPE_PREFIX.length);
  return end < 0 ? undefined : text.slice(TYPE_PREFIX.length, end);
}

/**
 * Reads complete lines appended since `cursor`.
 *
 * Only newline-terminated lines are consumed: Copilot may be mid-write, and a
 * half line is left for the next pass rather than parsed and lost.
 */
export async function readNativeEvents(
  path: string,
  cursor: NativeCursor,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<NativeReadResult> {
  const empty = (next: NativeCursor): NativeReadResult => ({
    events: [],
    cursor: next,
    bytesRead: 0,
    linesSeen: 0,
    linesParsed: 0,
  });
  const file = await open(path, "r").catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return empty({ offset: 0 });
  try {
    const info = await file.stat();
    const identity = fileIdentity(info);
    let offset = cursor.offset;
    if ((cursor.identity && cursor.identity !== identity) || info.size < offset)
      offset = 0;
    if (info.size === offset) return empty({ offset, identity });

    const end = Math.min(info.size, offset + maxBytes);
    const events: NativeEvent[] = [];
    let linesSeen = 0;
    let linesParsed = 0;
    let consumed = offset;
    let position = offset;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (position < end) {
      const { bytesRead } = await file.read({
        buffer,
        offset: 0,
        length: Math.min(buffer.length, end - position),
        position,
      });
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        if (newline < 0) {
          const rest = chunk.subarray(start);
          // Only the start of an oversized line is kept: enough for its type.
          if (pendingBytes < MAX_LINE_BYTES) pending.push(Buffer.from(rest));
          pendingBytes += rest.length;
          break;
        }
        const tail = chunk.subarray(start, newline);
        const lineBytes = pendingBytes + tail.length;
        const line = pending.length === 0 ? tail : Buffer.concat([...pending, tail]);
        linesSeen += 1;
        consumed = position + newline + 1;
        const type = lineType(line);
        if (type && IMPORTED_TYPES.has(type) && lineBytes <= MAX_LINE_BYTES) {
          linesParsed += 1;
          try {
            const parsed = JSON.parse(line.toString("utf8")) as Partial<NativeEvent>;
            if (
              typeof parsed.id === "string" &&
              typeof parsed.timestamp === "string" &&
              parsed.data &&
              typeof parsed.data === "object"
            )
              events.push({
                id: parsed.id,
                type,
                timestamp: parsed.timestamp,
                // Tool output and encrypted reasoning are most of a log's
                // bytes and none of the transcript; drop them now so a
                // catch-up does not hold the whole file in memory.
                data: slimNativeData(type, parsed.data),
                end: consumed,
              });
          } catch {
            // A malformed line is skipped; the offset still moves past it.
          }
        }
        pending = [];
        pendingBytes = 0;
        start = newline + 1;
      }
      position += bytesRead;
    }
    return {
      events,
      cursor: { offset: consumed, identity },
      bytesRead: position - offset,
      linesSeen,
      linesParsed,
    };
  } finally {
    await file.close();
  }
}

/** What the Fleet transcript records for one native event. */
export type ImportedEvent = {
  eventId: string;
  type: "system" | "agent_text" | "agent_thought" | "tool" | "turn_complete";
  payload: Record<string, unknown>;
  createdAt: string;
  /** Assigned by the Node only while Fleet's own process is live. */
  sequence?: number;
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : new Date().toISOString();
}

/** Only the fields the transcript uses, already clipped. */
export function slimNativeData(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const parent = asString(data.parentToolCallId);
  const common = parent ? { parentToolCallId: parent } : {};
  if (type === "user.message")
    return {
      ...common,
      content: clip(asString(data.content), MAX_TEXT_CHARS),
      source: asString(data.source),
    };
  if (type === "assistant.message")
    return {
      ...common,
      content: clip(asString(data.content), MAX_TEXT_CHARS),
      reasoningText: clip(asString(data.reasoningText), MAX_TEXT_CHARS),
    };
  if (type === "tool.execution_start")
    return {
      ...common,
      toolCallId: asString(data.toolCallId),
      toolName: asString(data.toolName),
      toolTitle: asString(data.toolTitle),
      detail: toolDetail({ rawInput: data.arguments }) ?? "",
    };
  if (type === "tool.execution_complete") {
    const error =
      data.error && typeof data.error === "object"
        ? asString((data.error as Record<string, unknown>).message)
        : "";
    return {
      ...common,
      toolCallId: asString(data.toolCallId),
      success: data.success !== false,
      errorMessage: clip(error, MAX_TOOL_TEXT_CHARS),
    };
  }
  return common;
}

/**
 * Translates native events into the normalized events Fleet already renders.
 *
 * Event ids derive from the native id, so importing the same line twice —
 * after a Node restart, or a lost acknowledgement — is a no-op on the Host
 * rather than a duplicate transcript line.
 */
export function translateNativeEvents(
  events: readonly NativeEvent[],
  fleetSessionId: string,
): ImportedEvent[] {
  const imported: ImportedEvent[] = [];
  const origin = { kind: "external", source: "copilot-native-log" };
  const push = (
    native: NativeEvent,
    suffix: string,
    type: ImportedEvent["type"],
    payload: Record<string, unknown>,
  ) =>
    imported.push({
      eventId: `native:${fleetSessionId}:${native.id}${suffix}`,
      type,
      payload: { ...payload, origin },
      createdAt: validTimestamp(native.timestamp),
    });
  for (const native of events) {
    const data = native.data;
    // Sub-agents run inside a tool call; their chatter is not the conversation.
    if (asString(data.parentToolCallId)) continue;
    if (native.type === "user.message") {
      // Messages a sub-agent or background task addresses to itself.
      if (asString(data.source)) continue;
      const text = asString(data.content);
      if (!text) continue;
      push(native, "", "system", { text: `User: ${clip(text, MAX_TEXT_CHARS)}` });
    } else if (native.type === "assistant.message") {
      const reasoning = asString(data.reasoningText);
      if (reasoning)
        push(native, ":thought", "agent_thought", {
          text: clip(reasoning, MAX_TEXT_CHARS),
        });
      const text = asString(data.content);
      if (text) push(native, ":text", "agent_text", { text: clip(text, MAX_TEXT_CHARS) });
    } else if (native.type === "tool.execution_start") {
      const toolCallId = asString(data.toolCallId);
      if (!toolCallId) continue;
      const detail =
        asString(data.detail) || toolDetail({ rawInput: data.arguments }) || "";
      push(native, "", "tool", {
        toolCallId: `native:${toolCallId}`,
        title: asString(data.toolTitle) || asString(data.toolName) || "Tool",
        status: "in_progress",
        ...(detail ? { detail } : {}),
      });
    } else if (native.type === "tool.execution_complete") {
      const toolCallId = asString(data.toolCallId);
      if (!toolCallId) continue;
      const failed = data.success === false;
      const error = failed
        ? asString(data.errorMessage) ||
          (data.error && typeof data.error === "object"
            ? asString((data.error as Record<string, unknown>).message)
            : "")
        : "";
      push(native, "", "tool", {
        toolCallId: `native:${toolCallId}`,
        status: failed ? "failed" : "completed",
        ...(error ? { error: clip(error, MAX_TOOL_TEXT_CHARS) } : {}),
      });
    } else if (native.type === "assistant.turn_end") {
      push(native, "", "turn_complete", { stopReason: "end_turn" });
    } else if (native.type === "abort") {
      push(native, "", "turn_complete", { stopReason: "cancelled" });
    }
  }
  return imported;
}

/**
 * Whether a process id exists, without asking the OS for anything costlier.
 *
 * `process.kill(pid, 0)` sends nothing. EPERM means the process exists but
 * belongs to someone else, which still counts.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

const execFileAsync = promisify(execFile);

/**
 * When each process started, in epoch milliseconds; absent when unknown.
 *
 * Used only to reject a lock whose pid was reused by an unrelated process: a
 * process that started after the lock was written cannot have written it.
 * Spawning is slow (PowerShell especially), so the caller caches answers and
 * asks only about pids it has not judged before.
 */
export async function processStartTimes(
  pids: readonly number[],
): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  if (pids.length === 0) return times;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToUniversalTime().ToString('o'))" }`,
        ],
        { timeout: 15_000, windowsHide: true },
      );
      for (const line of stdout.split(/\r?\n/)) {
        const [pid, at] = line.trim().split(" ");
        const time = Date.parse(at ?? "");
        if (pid && Number.isFinite(time)) times.set(Number(pid), time);
      }
    } else {
      const { stdout } = await execFileAsync(
        "ps",
        ["-o", "pid=,lstart=", "-p", pids.join(",")],
        { timeout: 15_000 },
      );
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        const time = match ? Date.parse(match[2]!) : NaN;
        if (match && Number.isFinite(time)) times.set(Number(match[1]), time);
      }
    }
  } catch {
    // Unknown start time: the caller treats the holder as unverified.
  }
  return times;
}

type LockFile = { pid: number; writtenAt: number };

async function sessionLocks(directory: string): Promise<LockFile[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const locks: LockFile[] = [];
  for (const name of names) {
    const match = /^inuse\.(\d+)\.lock$/.exec(name);
    if (!match) continue;
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (info) locks.push({ pid: Number(match[1]), writtenAt: info.mtimeMs });
  }
  return locks;
}

export type ExternalAttachment = {
  pids: number[];
  /** Whether the log grew while the outside process held it. */
  active: boolean;
  since: string;
};

export type ImportMessage = {
  type: "native_session_import";
  importId: string;
  sessionId: string;
  events: ImportedEvent[];
  attachment?: ExternalAttachment | null;
};

type FollowedRecord = { nativeSessionId: string; cursor: NativeCursor };

/** Durable followed-session list and cursors. */
export interface FollowerStore {
  load(): Promise<Map<string, FollowedRecord>>;
  save(records: ReadonlyMap<string, FollowedRecord>): void;
  flush?(): Promise<void>;
}

export class MemoryFollowerStore implements FollowerStore {
  records = new Map<string, FollowedRecord>();
  load(): Promise<Map<string, FollowedRecord>> {
    return Promise.resolve(new Map(this.records));
  }
  save(records: ReadonlyMap<string, FollowedRecord>): void {
    this.records = new Map(records);
  }
}

/**
 * A small JSON file beside the Node's other state, written atomically and at
 * most once per second however often cursors move.
 */
export class FileFollowerStore implements FollowerStore {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: ReadonlyMap<string, FollowedRecord> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly delayMs = 1_000,
  ) {}

  async load(): Promise<Map<string, FollowedRecord>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as {
        sessions?: Record<string, FollowedRecord>;
      };
      return new Map(Object.entries(parsed.sessions ?? {}));
    } catch {
      return new Map();
    }
  }

  save(records: ReadonlyMap<string, FollowedRecord>): void {
    this.latest = records;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const records = this.latest;
    if (!records) return this.writing;
    this.latest = undefined;
    const body = JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(records),
    });
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writing.catch(() => undefined);
  }
}

export type NativeSessionFollowerOptions = {
  copilotHome?: string;
  store: FollowerStore;
  /** True while Fleet's own process is driving a turn in this session. */
  fleetTurnActive: (fleetSessionId: string) => boolean;
  /**
   * Reserves `count` sequence numbers from a live Fleet process's counter, or
   * answers undefined when none is live and the Host should number them.
   */
  reserveSequences: (fleetSessionId: string, count: number) => number | undefined;
  /** Sends one import; false when it could not leave (no Host connection). */
  send: (message: ImportMessage) => boolean;
  alive?: (pid: number) => boolean;
  startTimes?: (pids: readonly number[]) => Promise<Map<number, number>>;
  maxBytesPerPass?: number;
  ackTimeoutMs?: number;
  now?: () => number;
};

type FollowState = {
  nativeSessionId: string;
  cursor: NativeCursor;
  /** Size at the last pass; -1 forces a read. */
  lastSize: number;
  attachment: ExternalAttachment | null;
  /** Lock holders known to be Fleet's own process. */
  fleetPids: Set<number>;
  /**
   * Until this time a new lock holder is Fleet's process starting up, whose
   * lock appears before Fleet learns which pid wrote it (on Windows Copilot
   * runs beneath a shell, so the spawned pid is not the lock's pid).
   */
  claimingUntil: number;
  /** Lines up to this offset were written during a Fleet-owned turn. */
  ownedThrough: number;
  pending?: { importId: string; cursor: NativeCursor };
  /** Attachment changed but has not been delivered yet. */
  attachmentDirty: boolean;
};

export type FollowerPassStats = {
  sessions: number;
  statCalls: number;
  lockScans: number;
  bytesRead: number;
  linesSeen: number;
  linesParsed: number;
  imported: number;
  durationMs: number;
};

type Waiter = { resolve: () => void };

/**
 * Polls Fleet's Copilot sessions for activity that did not come from Fleet.
 *
 * A pass costs one `stat` per followed session; only appended bytes are ever
 * read. Appended lines are imported unless a Fleet turn owns them. Delivery
 * is acknowledged: the cursor advances only when the Host confirms it stored
 * the batch, so a dropped connection re-sends rather than loses, and native
 * ids make the re-send harmless.
 */
export class NativeSessionFollower {
  private readonly followed = new Map<string, FollowState>();
  private readonly copilotHome: string;
  private readonly verdicts = new Map<string, boolean>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly hostSequences = new Map<string, number>();
  private running: Promise<FollowerPassStats> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private connected = false;
  private loaded: Promise<void> | undefined;

  constructor(private readonly options: NativeSessionFollowerOptions) {
    this.copilotHome = options.copilotHome ?? copilotHomeDirectory();
  }

  /** Restores the followed list and cursors saved by a previous run. */
  load(): Promise<void> {
    this.loaded ??= this.options.store.load().then((records) => {
      for (const [fleetSessionId, record] of records)
        if (
          isSafeNativeSessionId(record.nativeSessionId) &&
          !this.followed.has(fleetSessionId)
        )
          this.followed.set(
            fleetSessionId,
            this.freshState(record.nativeSessionId, record.cursor),
          );
    });
    return this.loaded;
  }

  get size(): number {
    return this.followed.size;
  }

  attachment(fleetSessionId: string): ExternalAttachment | null {
    return this.followed.get(fleetSessionId)?.attachment ?? null;
  }

  /**
   * Starts following a native session Fleet has just opened.
   *
   * Everything already in the log is Fleet's or predates it, so a new record
   * starts at the end. Lock holders present now are this Fleet process — the
   * Host refuses to open a session another process holds — so they are
   * remembered as Fleet's own.
   */
  async track(fleetSessionId: string, nativeSessionId: string): Promise<void> {
    if (!isSafeNativeSessionId(nativeSessionId)) return;
    await this.load();
    const directory = nativeSessionDirectory(this.copilotHome, nativeSessionId);
    let state = this.followed.get(fleetSessionId);
    if (!state || state.nativeSessionId !== nativeSessionId) {
      const info = await stat(join(directory, "events.jsonl")).catch(() => undefined);
      state = this.freshState(nativeSessionId, {
        offset: info?.size ?? 0,
        ...(info ? { identity: fileIdentity(info) } : {}),
      });
      this.followed.set(fleetSessionId, state);
      this.persist();
    }
    const external = new Set(state.attachment?.pids ?? []);
    for (const lock of await sessionLocks(directory))
      if (!external.has(lock.pid)) state.fleetPids.add(lock.pid);
    state.claimingUntil = 0;
  }

  /**
   * Fleet is about to start (or restart) its own Copilot process on this
   * session. Its lock will appear before `track` learns the pid, so a new
   * holder seen meanwhile is Fleet's, not a terminal's.
   */
  claim(fleetSessionId: string): void {
    const state = this.followed.get(fleetSessionId);
    if (state) state.claimingUntil = (this.options.now ?? Date.now)() + CLAIM_WINDOW_MS;
  }

  untrack(fleetSessionId: string): void {
    if (!this.followed.delete(fleetSessionId)) return;
    this.release(fleetSessionId);
    this.persist();
  }

  /**
   * Notes that a Fleet turn just ended: whatever the log holds now is that
   * turn's output, already in the transcript, even if no pass read it yet.
   */
  async fleetTurnEnded(fleetSessionId: string): Promise<void> {
    const state = this.followed.get(fleetSessionId);
    if (!state) return;
    const info = await stat(this.logPath(state)).catch(() => undefined);
    if (info) state.ownedThrough = Math.max(state.ownedThrough, info.size);
  }

  /** The Host connection is up and has negotiated imports. */
  connect(intervalMs = 3_000): void {
    this.connected = true;
    for (const state of this.followed.values()) {
      // A batch in flight on the old connection was never acknowledged.
      delete state.pending;
      // The Host may hold a value from before this connection (or this
      // process): restate the current one, including "nobody".
      state.attachmentDirty = true;
      state.lastSize = -1;
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), intervalMs);
      this.timer.unref();
    }
    void this.poll();
  }

  disconnect(): void {
    this.connected = false;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const fleetSessionId of this.followed.keys()) this.release(fleetSessionId);
  }

  async close(): Promise<void> {
    this.disconnect();
    await this.running;
    await this.options.store.flush?.();
  }

  /** The Host answered one import. */
  acknowledge(
    importId: string,
    status: "stored" | "unknown_session" | "retry",
    throughSequence?: number,
  ): void {
    for (const [fleetSessionId, state] of this.followed) {
      if (state.pending?.importId !== importId) continue;
      if (status === "stored") {
        state.cursor = state.pending.cursor;
        this.persist();
        if (throughSequence !== undefined)
          this.hostSequences.set(
            fleetSessionId,
            Math.max(this.hostSequences.get(fleetSessionId) ?? 0, throughSequence),
          );
      } else if (status === "unknown_session") {
        // The Host no longer has this session; following it is pointless.
        this.followed.delete(fleetSessionId);
        this.persist();
      } else {
        // Not stored: read the same bytes again on a later pass.
        state.lastSize = -1;
        state.attachmentDirty = true;
      }
      delete state.pending;
      this.release(fleetSessionId);
      return;
    }
  }

  /** One pass over every followed session; concurrent callers share it. */
  poll(): Promise<FollowerPassStats> {
    if (this.running) return this.running;
    const run = this.pass().finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  /**
   * Imports everything up to now for one session and waits for the Host to
   * store it, for a caller about to put Fleet's own process to work on it.
   *
   * Answers the highest sequence the Host is known to have assigned, so a
   * resumed agent can number its events above the imported ones.
   */
  async catchUp(fleetSessionId: string): Promise<number | undefined> {
    const state = this.followed.get(fleetSessionId);
    if (!state || !this.connected) return this.hostSequences.get(fleetSessionId);
    await this.running;
    await this.settled(fleetSessionId);
    // Drained to the end, one bounded read at a time, so nothing the terminal
    // wrote is left to arrive after the resumed process starts talking.
    const deadline = Date.now() + CATCH_UP_LIMIT_MS;
    while (this.followed.get(fleetSessionId) === state && Date.now() < deadline) {
      state.lastSize = -1;
      const before = state.cursor.offset;
      await this.syncOne(fleetSessionId, state, emptyStats());
      await this.settled(fleetSessionId);
      const info = await stat(this.logPath(state)).catch(() => undefined);
      if (!info || state.cursor.offset >= info.size || state.cursor.offset === before)
        break;
    }
    return this.hostSequences.get(fleetSessionId);
  }

  private freshState(nativeSessionId: string, cursor: NativeCursor): FollowState {
    return {
      nativeSessionId,
      cursor,
      lastSize: -1,
      attachment: null,
      fleetPids: new Set(),
      claimingUntil: 0,
      ownedThrough: 0,
      attachmentDirty: false,
    };
  }

  private logPath(state: FollowState): string {
    return join(
      nativeSessionDirectory(this.copilotHome, state.nativeSessionId),
      "events.jsonl",
    );
  }

  private persist(): void {
    this.options.store.save(
      new Map(
        [...this.followed].map(([id, state]) => [
          id,
          { nativeSessionId: state.nativeSessionId, cursor: state.cursor },
        ]),
      ),
    );
  }

  private settled(fleetSessionId: string): Promise<void> {
    const state = this.followed.get(fleetSessionId);
    if (!state?.pending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // An old Host, or a lost connection: stop waiting, keep the evidence.
        if (state.pending) delete state.pending;
        resolve();
      }, this.options.ackTimeoutMs ?? ACK_TIMEOUT_MS);
      timer.unref();
      const list = this.waiters.get(fleetSessionId) ?? [];
      list.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
      this.waiters.set(fleetSessionId, list);
    });
  }

  private release(fleetSessionId: string): void {
    const list = this.waiters.get(fleetSessionId);
    if (!list) return;
    this.waiters.delete(fleetSessionId);
    for (const waiter of list) waiter.resolve();
  }

  private async pass(): Promise<FollowerPassStats> {
    const started = performance.now();
    const stats = emptyStats();
    if (!this.connected) return stats;
    for (const [fleetSessionId, state] of this.followed) {
      stats.sessions += 1;
      if (state.pending) continue;
      try {
        await this.syncOne(fleetSessionId, state, stats);
      } catch {
        // One unreadable session must not stop the others; the next pass retries.
      }
    }
    stats.durationMs = performance.now() - started;
    return stats;
  }

  private async syncOne(
    fleetSessionId: string,
    state: FollowState,
    stats: FollowerPassStats,
  ): Promise<void> {
    if (state.pending || !this.connected) return;
    const path = this.logPath(state);
    stats.statCalls += 1;
    const info = await stat(path).catch(() => undefined);
    const size = info?.size ?? 0;
    const grew = size !== state.lastSize;
    if (!grew && !state.attachment && !state.attachmentDirty) return;
    state.lastSize = size;

    stats.lockScans += 1;
    const external = await this.externalHolders(state);

    let events: ImportedEvent[] = [];
    let next = state.cursor;
    let externalWrite = false;
    if (grew) {
      const read = await readNativeEvents(
        path,
        state.cursor,
        this.options.maxBytesPerPass ?? DEFAULT_MAX_BYTES_PER_PASS,
      );
      stats.bytesRead += read.bytesRead;
      stats.linesSeen += read.linesSeen;
      stats.linesParsed += read.linesParsed;
      const fleetTurn = this.options.fleetTurnActive(fleetSessionId);
      const theirs = fleetTurn
        ? []
        : read.events.filter((event) => event.end > state.ownedThrough);
      externalWrite =
        !fleetTurn && read.bytesRead > 0 && read.cursor.offset > state.ownedThrough;
      if (fleetTurn)
        state.ownedThrough = Math.max(state.ownedThrough, read.cursor.offset);
      next = read.cursor;
      // Translate native events until one message is full; the cursor stops
      // just past the last native line taken, and the rest waits a pass.
      for (const [index, native] of theirs.entries()) {
        const translated = translateNativeEvents([native], fleetSessionId);
        if (events.length + translated.length > MAX_IMPORT_EVENTS) {
          // Resume at the start of this native line: the previous one's end.
          next = {
            ...read.cursor,
            offset: theirs[index - 1]?.end ?? state.cursor.offset,
          };
          break;
        }
        events.push(...translated);
      }
      // A read that stopped short of the end continues on the next pass.
      if (next.offset < size) state.lastSize = -1;
    }
    const attachmentChanged = this.updateAttachment(state, external, externalWrite);

    if (events.length === 0 && !attachmentChanged && !state.attachmentDirty) {
      if (next !== state.cursor) {
        state.cursor = next;
        this.persist();
      }
      return;
    }
    const first =
      events.length > 0
        ? this.options.reserveSequences(fleetSessionId, events.length)
        : undefined;
    if (first !== undefined)
      events = events.map((event, index) => ({ ...event, sequence: first + index }));
    const message: ImportMessage = {
      type: "native_session_import",
      importId: randomUUID(),
      sessionId: fleetSessionId,
      events,
      attachment: state.attachment,
    };
    if (!this.options.send(message)) return;
    state.attachmentDirty = false;
    state.pending = { importId: message.importId, cursor: next };
    stats.imported += events.length;
  }

  /** Live lock holders that are not Fleet's process and did write their lock. */
  private async externalHolders(state: FollowState): Promise<number[]> {
    const alive = this.options.alive ?? processAlive;
    // A Fleet process that has exited no longer vouches for its pid.
    for (const pid of state.fleetPids) if (!alive(pid)) state.fleetPids.delete(pid);
    const directory = nativeSessionDirectory(this.copilotHome, state.nativeSessionId);
    const known = new Set(state.attachment?.pids ?? []);
    const claiming = state.claimingUntil > (this.options.now ?? Date.now)();
    const candidates = (await sessionLocks(directory)).filter((lock) => {
      if (state.fleetPids.has(lock.pid) || !alive(lock.pid)) return false;
      if (claiming && !known.has(lock.pid)) {
        state.fleetPids.add(lock.pid);
        return false;
      }
      return true;
    });
    const unknown = candidates.filter(
      (lock) => !this.verdicts.has(`${lock.pid}:${lock.writtenAt}`),
    );
    if (unknown.length > 0) {
      const started = await (this.options.startTimes ?? processStartTimes)(
        unknown.map((lock) => lock.pid),
      );
      for (const lock of unknown) {
        const at = started.get(lock.pid);
        // Two seconds of slack for clock granularity between the two sources.
        this.verdicts.set(
          `${lock.pid}:${lock.writtenAt}`,
          at !== undefined && at <= lock.writtenAt + 2_000,
        );
      }
    }
    return candidates
      .filter((lock) => this.verdicts.get(`${lock.pid}:${lock.writtenAt}`))
      .map((lock) => lock.pid)
      .sort((a, b) => a - b);
  }

  private updateAttachment(
    state: FollowState,
    external: number[],
    active: boolean,
  ): boolean {
    const previous = state.attachment;
    if (external.length === 0) {
      if (!previous) return false;
      state.attachment = null;
      return true;
    }
    const samePids = previous?.pids.join() === external.join();
    // Activity is sticky while held: one quiet pass does not end a session.
    const nextActive = active || (samePids && previous!.active);
    if (previous && samePids && previous.active === nextActive) return false;
    state.attachment = {
      pids: external,
      active: nextActive,
      since:
        previous && samePids
          ? previous.since
          : new Date((this.options.now ?? Date.now)()).toISOString(),
    };
    return true;
  }
}

function emptyStats(): FollowerPassStats {
  return {
    sessions: 0,
    statCalls: 0,
    lockScans: 0,
    bytesRead: 0,
    linesSeen: 0,
    linesParsed: 0,
    imported: 0,
    durationMs: 0,
  };
}
