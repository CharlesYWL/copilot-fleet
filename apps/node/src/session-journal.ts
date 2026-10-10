import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  eventPayload,
  isSessionActivityEvent,
  SessionEventSchema,
  SessionSchema,
  TRANSCRIPT_PAGE_LIMIT,
  TRANSCRIPT_PAGE_MAX,
  TranscriptProjector,
  type FleetSession,
  type SessionActivity,
  type SessionEvent,
  type TranscriptPage,
} from "@fleet/protocol";
import { z } from "zod";
import { privateJournalDirectory } from "./command-journal.js";

export const LocalSessionOperationSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  grantId: z.string().min(1),
  controlEpoch: z.number().int().nonnegative(),
  action: z.enum(["prompt", "cancel", "stop", "config"]),
  origin: z.enum(["local", "host"]).default("local"),
  payload: z.unknown(),
  digest: z.string().length(64),
  afterSequence: z.number().int().nonnegative(),
  state: z.enum(["queued", "accepted", "settled", "uncertain", "rejected"]),
  priority: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type LocalSessionOperation = z.infer<typeof LocalSessionOperationSchema>;

export type LocalSessionRecord = {
  hostId: string;
  grantId: string;
  session: FleetSession;
  controlEpoch: number;
  acknowledgedControlEpoch: number;
  acknowledgedSequence: number;
  highWater: number;
};
const REOPEN_ERROR =
  "Node reopened without proven completion; never automatically invoke again.";

export type SessionJournalOptions = {
  secure?: boolean;
  onEvents?: (events: SessionEvent[]) => void;
  onFailure?: (error: unknown) => void;
  batchMs?: number;
  batchBytes?: number;
  /** Serialized records, including retained identity and permission evidence. */
  maxBytes?: number;
};

type StoredSession = LocalSessionRecord & {
  generation: string;
  revision: number;
  activity?: SessionActivity;
};
type PendingEvent = { event: SessionEvent; data: string; digest: string; bytes: number };

function integer(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error("Journal limits and watermarks must be safe nonnegative integers.");
  return value;
}

function json(value: unknown): string {
  try {
    const data = JSON.stringify(value);
    if (data !== undefined) return data;
  } catch {
    // Never include a prompt, attachment, or transcript body in diagnostics.
  }
  throw new Error("Journal values must be JSON serializable.");
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            )
          : item,
      ),
    )
    .digest("hex");
}

function eventDigest(event: SessionEvent): string {
  const { sequence: _sequence, ...identity } = event;
  return digest(identity);
}

function eligible(session: FleetSession): FleetSession {
  const parsed = SessionSchema.safeParse(session);
  if (!parsed.success || parsed.data.runRole === "lead")
    throw new Error(
      "Only valid, explicitly enabled non-lead Fleet sessions may journal.",
    );
  return JSON.parse(json(parsed.data)) as FleetSession;
}

function sameBinding(before: FleetSession, after: FleetSession): boolean {
  return (
    before.nodeId === after.nodeId &&
    before.workspaceId === after.workspaceId &&
    before.placementId === after.placementId &&
    digest(before.executionBinding ?? null) === digest(after.executionBinding ?? null) &&
    digest(before.agentParams ?? null) === digest(after.agentParams ?? null)
  );
}

/** Refuse linked database files/sidecars as well as linked ancestor directories. */
function checkStoragePath(directory: string): void {
  for (let path = resolve(directory); ; path = dirname(path)) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Session journal storage may not use linked paths.");
    if (dirname(path) === path) break;
  }
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const path = join(directory, `sessions.db${suffix}`);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !stat.isFile())
      throw new Error("Session journal database paths must be regular files.");
  }
}

/** Private FULL transactions; output publication always follows its durable commit. */
export class SessionJournal {
  private readonly db: DatabaseSync;
  private readonly batchMs: number;
  private readonly batchBytes: number;
  private readonly maxBytes: number;
  private readonly pending = new Map<string, PendingEvent>();
  private readonly pendingWater = new Map<string, number>();
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private failed = false;
  private failure: unknown;
  // Keep just the selected session warm; other sessions are never eagerly projected.
  private projection:
    | {
        sessionId: string;
        generation: string;
        sequence: number;
        projector: TranscriptProjector;
      }
    | undefined;

  constructor(
    readonly directory: string,
    private readonly options: SessionJournalOptions = {},
  ) {
    this.batchMs = integer(options.batchMs ?? 32);
    this.batchBytes = integer(options.batchBytes ?? 64 * 1024, 1);
    this.maxBytes = integer(options.maxBytes ?? 256 * 1024 * 1024, 1);
    let database: DatabaseSync | undefined;
    try {
      checkStoragePath(directory);
      if (options.secure !== false) privateJournalDirectory(directory);
      else mkdirSync(directory, { recursive: true });
      this.db = database = new DatabaseSync(join(directory, "sessions.db"));
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA foreign_keys=ON;
        PRAGMA secure_delete=ON;
        PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS storage (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL);
        INSERT OR IGNORE INTO storage VALUES (1,0);
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, host_id TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_host ON sessions(host_id);
        CREATE TABLE IF NOT EXISTS retired_sessions (
          id TEXT PRIMARY KEY, host_id TEXT NOT NULL, high_water INTEGER NOT NULL,
          control_epoch INTEGER NOT NULL, bytes INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS retired_sessions_host ON retired_sessions(host_id);
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL, digest TEXT NOT NULL, data TEXT, bytes INTEGER NOT NULL,
          UNIQUE(session_id,sequence)
        );
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          data TEXT NOT NULL, bytes INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operations_session ON operations(session_id);
        CREATE TABLE IF NOT EXISTS permissions (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(session_id,request_id)
        );
      `);
      for (const table of [
        "sessions",
        "retired_sessions",
        "events",
        "operations",
        "permissions",
      ]) {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS ${table}_insert AFTER INSERT ON ${table}
            BEGIN UPDATE storage SET bytes=bytes+NEW.bytes WHERE id=1; END;
          CREATE TRIGGER IF NOT EXISTS ${table}_update AFTER UPDATE ON ${table}
            BEGIN UPDATE storage SET bytes=bytes+NEW.bytes-OLD.bytes WHERE id=1; END;
          CREATE TRIGGER IF NOT EXISTS ${table}_delete AFTER DELETE ON ${table}
            BEGIN UPDATE storage SET bytes=bytes-OLD.bytes WHERE id=1; END;
        `);
      }
      // Include SQLite indexes/pages, without treating a small test content cap as
      // too little space even to create the schema. The serialized cap is stricter.
      const pageSize = Number(this.db.prepare("PRAGMA page_size").get()!.page_size);
      this.db.exec(
        `PRAGMA max_page_count=${Math.ceil((this.maxBytes * 2 + 1024 * 1024) / pageSize)}`,
      );
      this.transaction(() => {
        for (const row of this.db
          .prepare(
            "SELECT data FROM operations WHERE json_extract(data,'$.state')='accepted'",
          )
          .all()) {
          const operation = this.parseOperation(String(row.data));
          this.saveOperation({
            ...operation,
            state: "uncertain",
            error: REOPEN_ERROR,
          });
        }
      });
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the original storage failure.
      }
      this.fail(error);
    }
  }

  enable(input: {
    hostId: string;
    grantId: string;
    session: FleetSession;
    controlEpoch?: number;
    /** Host's already-durable prefix, used only when first enabling this session. */
    sequenceOffset?: number;
  }): void {
    this.writable();
    const session = eligible(input.session);
    if (!input.hostId || !input.grantId)
      throw new Error("A Host identity and continuation grant are required.");
    const controlEpoch = integer(input.controlEpoch ?? 0);
    const sequenceOffset = integer(input.sequenceOffset ?? 0);
    this.flush();
    if (this.retiredHighWater(session.id) !== undefined)
      throw new Error("A retired session cannot be enabled again.");
    const prior = this.stored(session.id);
    if (
      prior &&
      (prior.hostId !== input.hostId ||
        prior.grantId !== input.grantId ||
        !sameBinding(prior.session, session))
    )
      throw new Error("Session continuation binding conflicts with retained evidence.");
    this.transaction(() =>
      this.saveSession({
        ...(prior ?? {
          acknowledgedControlEpoch: 0,
          acknowledgedSequence: sequenceOffset,
          highWater: sequenceOffset,
          generation: randomUUID(),
          revision: 0,
        }),
        hostId: input.hostId,
        grantId: input.grantId,
        session,
        controlEpoch: Math.max(prior?.controlEpoch ?? 0, controlEpoch),
        acknowledgedControlEpoch: Math.max(
          prior?.acknowledgedControlEpoch ?? 0,
          Math.min(controlEpoch, prior?.controlEpoch ?? 0),
        ),
      }),
    );
  }

  has(sessionId: string): boolean {
    return this.get(sessionId) !== undefined;
  }

  get(sessionId: string): LocalSessionRecord | undefined {
    const value = this.stored(sessionId);
    if (!value) return undefined;
    const {
      generation: _generation,
      revision: _revision,
      activity: _activity,
      ...record
    } = value;
    return record;
  }

  list(hostId: string): LocalSessionRecord[] {
    return this.read(() =>
      this.db
        .prepare("SELECT id FROM sessions WHERE host_id=? ORDER BY id")
        .all(hostId)
        .map((row) => this.get(String(row.id))!),
    );
  }

  updateSession(input: FleetSession): void {
    this.writable();
    const session = eligible(input);
    this.flush();
    const record = this.required(session.id);
    if (!sameBinding(record.session, session))
      throw new Error("Session metadata cannot change its continuation binding.");
    this.transaction(() => this.saveSession({ ...record, session }));
  }

  /** New emissions allocate monotonically; replay/dedup never allocates a new ID or sequence. */
  append(input: SessionEvent): SessionEvent {
    this.writable();
    const parsed = SessionEventSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid session journal event.");
    const event = JSON.parse(json(parsed.data)) as SessionEvent;
    const record = this.required(event.sessionId);
    const hash = eventDigest(event);
    const pending = this.pending.get(event.eventId);
    const prior = pending
      ? {
          session_id: pending.event.sessionId,
          sequence: pending.event.sequence,
          digest: pending.digest,
        }
      : this.read(() =>
          this.db
            .prepare("SELECT session_id,sequence,digest FROM events WHERE event_id=?")
            .get(event.eventId),
        );
    if (prior) {
      if (prior.session_id !== event.sessionId || prior.digest !== hash)
        throw new Error("Session event identity was reused with conflicting content.");
      return { ...event, sequence: Number(prior.sequence) };
    }
    event.sequence = integer(
      Math.max(
        event.sequence,
        (this.pendingWater.get(event.sessionId) ?? record.highWater) + 1,
      ),
      1,
    );
    let data = json(event);
    let bytes =
      Buffer.byteLength(data) +
      Buffer.byteLength(event.eventId) +
      Buffer.byteLength(event.sessionId) +
      64;
    if (this.pendingBytes + bytes > this.batchBytes) {
      this.flush();
      // A publication observer may itself have admitted more session output.
      event.sequence = integer(
        Math.max(event.sequence, this.highWater(event.sessionId) + 1),
        1,
      );
      const updated = json(event);
      bytes += Buffer.byteLength(updated) - Buffer.byteLength(data);
      data = updated;
    }
    this.writable();
    if (this.usedBytes() + this.pendingBytes + bytes > this.maxBytes)
      this.fail(new Error("Session journal storage is full; new admission is disabled."));
    this.pending.set(event.eventId, { event, data, digest: hash, bytes });
    this.pendingWater.set(event.sessionId, event.sequence);
    this.pendingBytes += bytes;
    if (
      this.pendingBytes >= this.batchBytes ||
      this.batchMs === 0 ||
      !["agent_text", "agent_thought", "tool"].includes(event.type)
    ) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          this.flush();
        } catch {
          // flush already failed closed and notified onFailure.
        }
      }, this.batchMs);
      this.timer.unref();
    }
    return JSON.parse(data) as SessionEvent;
  }

  flush(): void {
    this.writable();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) return;
    const batch = [...this.pending.values()];
    this.transaction(() => {
      const sessions = new Map<string, StoredSession>();
      const insert = this.db.prepare(
        "INSERT INTO events(event_id,session_id,sequence,digest,data,bytes) VALUES (?,?,?,?,?,?)",
      );
      for (const item of batch) {
        const { event, data, bytes } = item;
        insert.run(
          event.eventId,
          event.sessionId,
          event.sequence,
          item.digest,
          data,
          bytes,
        );
        const record = sessions.get(event.sessionId) ?? this.required(event.sessionId);
        record.highWater = event.sequence;
        record.revision = integer(record.revision + 1);
        this.applyMetadata(record, event);
        sessions.set(event.sessionId, record);
        if (event.type === "permission" || event.type === "permission_result") {
          const requestId = eventPayload(event, event.type)?.requestId;
          if (requestId)
            this.db
              .prepare(
                `INSERT INTO permissions VALUES (?,?,?,?)
                 ON CONFLICT(session_id,request_id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes`,
              )
              .run(
                event.sessionId,
                requestId,
                data,
                Buffer.byteLength(data) +
                  Buffer.byteLength(requestId) +
                  Buffer.byteLength(event.sessionId),
              );
        }
      }
      for (const record of sessions.values()) this.saveSession(record);
    });
    this.pending.clear();
    this.pendingWater.clear();
    this.pendingBytes = 0;
    try {
      this.options.onEvents?.(batch.map(({ data }) => JSON.parse(data) as SessionEvent));
    } catch (error) {
      this.fail(error);
    }
  }

  /** Includes buffered allocations and retired identities; get() only returns live metadata. */
  highWater(sessionId: string): number {
    return Math.max(
      this.get(sessionId)?.highWater ?? this.retiredHighWater(sessionId) ?? 0,
      this.pendingWater.get(sessionId) ?? 0,
    );
  }

  /**
   * Strict serialized-event byte/count bounds, over committed rows only. A first
   * row too large for the caller's budget throws, rather than wedging or skipping
   * the replay cursor; the caller must explicitly increase its transport budget.
   */
  events(
    sessionId: string,
    afterSequence: number,
    limit = 256,
    maxBytes = 1024 * 1024,
  ): SessionEvent[] {
    integer(afterSequence);
    integer(limit);
    integer(maxBytes);
    if (!limit || !maxBytes) return [];
    return this.read(() => {
      const events: SessionEvent[] = [];
      let bytes = 0;
      for (const row of this.db
        .prepare(
          "SELECT data FROM events WHERE session_id=? AND sequence>? AND data IS NOT NULL ORDER BY sequence LIMIT ?",
        )
        .iterate(sessionId, afterSequence, Math.min(limit, 2000))) {
        const data = String(row.data);
        const size = Buffer.byteLength(data);
        if (bytes + size > maxBytes) {
          if (!events.length) throw new ReplayBudgetError(size);
          break;
        }
        events.push(SessionEventSchema.parse(JSON.parse(data)));
        bytes += size;
      }
      return events;
    });
  }

  acknowledge(sessionId: string, throughSequence: number): void {
    this.writable();
    integer(throughSequence);
    const record = this.required(sessionId);
    if (throughSequence > record.highWater)
      throw new Error("Acknowledgement exceeds the committed session watermark.");
    if (throughSequence <= record.acknowledgedSequence) return;
    this.transaction(() =>
      this.saveSession({ ...record, acknowledgedSequence: throughSequence }),
    );
  }

  acknowledgeControl(sessionId: string, throughEpoch: number): void {
    this.writable();
    integer(throughEpoch);
    const record = this.required(sessionId);
    if (throughEpoch > record.controlEpoch)
      throw new Error("Control acknowledgement exceeds the local control epoch.");
    if (throughEpoch <= record.acknowledgedControlEpoch) return;
    this.transaction(() =>
      this.saveSession({ ...record, acknowledgedControlEpoch: throughEpoch }),
    );
  }

  /** Coalesced live receipts share one durable commit; unacknowledged bodies remain replayable. */
  acknowledgeBatch(
    acknowledgements: readonly {
      sessionId: string;
      sequence: number;
      controlEpoch: number;
    }[],
  ): void {
    this.writable();
    const changed = new Map<string, StoredSession>();
    for (const acknowledgement of acknowledgements) {
      integer(acknowledgement.sequence);
      integer(acknowledgement.controlEpoch);
      const record =
        changed.get(acknowledgement.sessionId) ??
        this.required(acknowledgement.sessionId);
      if (
        acknowledgement.sequence > record.highWater ||
        acknowledgement.controlEpoch > record.controlEpoch
      )
        throw new Error("Acknowledgement exceeds committed session evidence.");
      const sequence = Math.max(record.acknowledgedSequence, acknowledgement.sequence);
      const epoch = Math.max(
        record.acknowledgedControlEpoch,
        acknowledgement.controlEpoch,
      );
      if (
        sequence !== record.acknowledgedSequence ||
        epoch !== record.acknowledgedControlEpoch
      )
        changed.set(acknowledgement.sessionId, {
          ...record,
          acknowledgedSequence: sequence,
          acknowledgedControlEpoch: epoch,
        });
    }
    if (changed.size)
      this.transaction(() => {
        for (const record of changed.values()) this.saveSession(record);
      });
  }

  transcript(
    sessionId: string,
    request: { before?: number; limit?: number } = {},
  ): TranscriptPage {
    const record = this.required(sessionId);
    if (request.before !== undefined) integer(request.before);
    if (request.limit !== undefined) integer(request.limit, 1);
    return this.read(() => {
      if (
        this.projection?.sessionId !== sessionId ||
        this.projection.generation !== record.generation
      )
        this.projection = {
          sessionId,
          generation: record.generation,
          sequence: 0,
          projector: new TranscriptProjector(),
        };
      const projection = this.projection;
      for (const row of this.db
        .prepare(
          "SELECT data FROM events WHERE session_id=? AND sequence>? AND data IS NOT NULL ORDER BY sequence",
        )
        .iterate(sessionId, projection.sequence)) {
        const event = SessionEventSchema.parse(JSON.parse(String(row.data)));
        projection.projector.apply(event);
        projection.sequence = event.sequence;
      }
      const { blocks, prompts } = projection.projector;
      const newest = request.before === undefined;
      const end = Math.min(request.before ?? blocks.length, blocks.length);
      const limit = Math.min(request.limit ?? TRANSCRIPT_PAGE_LIMIT, TRANSCRIPT_PAGE_MAX);
      let start = Math.max(0, end - limit);
      if (start < Math.floor(limit / 4) && end <= TRANSCRIPT_PAGE_MAX) start = 0;
      return JSON.parse(
        json({
          generation: record.generation,
          revision: record.revision,
          total: blocks.length,
          start,
          blocks: blocks.slice(start, end),
          ...(newest
            ? { prompts, ...(record.activity ? { activity: record.activity } : {}) }
            : {}),
        }),
      ) as TranscriptPage;
    });
  }

  permissions(sessionId: string): SessionEvent[] {
    return this.read(() =>
      this.db
        .prepare(
          "SELECT data FROM permissions WHERE session_id=? ORDER BY json_extract(data,'$.sequence')",
        )
        .all(sessionId)
        .map((row) => SessionEventSchema.parse(JSON.parse(String(row.data)))),
    );
  }

  acceptOperation(input: {
    id: string;
    sessionId: string;
    action: LocalSessionOperation["action"];
    payload: unknown;
    queued?: boolean;
    origin?: LocalSessionOperation["origin"];
  }): { operation: LocalSessionOperation; invoke: boolean } {
    this.writable();
    if (!input.id || !["prompt", "cancel", "stop", "config"].includes(input.action))
      throw new Error("Invalid local session operation.");
    const origin = input.origin ?? "local";
    if (origin !== "local" && origin !== "host")
      throw new Error("Invalid local session operation origin.");
    const payload: unknown = JSON.parse(json(input.payload));
    const hash = digest({ sessionId: input.sessionId, action: input.action, payload });
    this.flush();
    const record = this.required(input.sessionId);
    const prior = this.operation(input.id);
    if (prior) {
      if (
        prior.digest !== hash ||
        prior.sessionId !== input.sessionId ||
        prior.grantId !== record.grantId
      )
        throw new Error("Local operation identity was reused with conflicting content.");
      return { operation: prior, invoke: false };
    }
    const controlEpoch =
      origin === "host" ? record.controlEpoch : integer(record.controlEpoch + 1);
    const operation = LocalSessionOperationSchema.parse({
      ...input,
      payload,
      origin,
      grantId: record.grantId,
      controlEpoch,
      digest: hash,
      afterSequence: record.highWater,
      state: input.queued ? "queued" : "accepted",
      createdAt: new Date().toISOString(),
    });
    // Both writes must commit before the caller is permitted to perform ACP I/O.
    this.transaction(() => {
      this.saveSession({ ...record, controlEpoch });
      this.saveOperation(operation);
    });
    return { operation, invoke: operation.state === "accepted" };
  }

  /** The queued-to-native boundary is committed before the caller performs ACP I/O. */
  beginOperation(id: string): LocalSessionOperation {
    this.writable();
    this.flush();
    const operation = this.operation(id);
    if (!operation || operation.state !== "queued" || operation.origin !== "local")
      throw new Error("Only queued local-origin operations may begin execution.");
    const record = this.required(operation.sessionId);
    const controlEpoch = integer(record.controlEpoch + 1);
    const accepted: LocalSessionOperation = {
      ...operation,
      controlEpoch,
      state: "accepted",
      afterSequence: record.highWater,
    };
    this.transaction(() => {
      this.saveSession({ ...record, controlEpoch });
      this.saveOperation(accepted);
    });
    return accepted;
  }

  prioritizeOperation(id: string): void {
    this.writable();
    const operation = this.operation(id);
    if (!operation || operation.state !== "queued")
      throw new Error("Only queued operations may be prioritized.");
    const highestOther = this.read(() =>
      Number(
        this.db
          .prepare(
            `SELECT COALESCE(MAX(COALESCE(json_extract(data,'$.priority'),0)),0) AS priority
             FROM operations WHERE session_id=? AND id<>? AND json_extract(data,'$.state')='queued'`,
          )
          .get(operation.sessionId, id)!.priority,
      ),
    );
    if (operation.priority > highestOther) return;
    const priority = integer(highestOther + 1);
    this.transaction(() => this.saveOperation({ ...operation, priority }));
  }

  settleOperation(
    id: string,
    state: Exclude<LocalSessionOperation["state"], "accepted" | "queued">,
    error?: string,
  ): void {
    this.writable();
    if (!["settled", "uncertain", "rejected"].includes(state))
      throw new Error("A local operation cannot return to accepted.");
    this.flush();
    const operation = this.operation(id);
    if (!operation) throw new Error("Unknown local session operation.");
    if (operation.state === state) return;
    if (operation.state === "settled" || operation.state === "rejected")
      throw new Error("A completed local operation cannot change its outcome.");
    const { error: _previous, ...rest } = operation;
    this.transaction(() =>
      this.saveOperation({
        ...rest,
        state,
        ...(error !== undefined ? { error: error.slice(0, 4000) } : {}),
      }),
    );
  }

  operations(sessionId: string): LocalSessionOperation[] {
    return this.read(() =>
      this.db
        .prepare(
          "SELECT data FROM operations WHERE session_id=? ORDER BY json_extract(data,'$.controlEpoch'),id",
        )
        .all(sessionId)
        .map((row) => this.parseOperation(String(row.data))),
    );
  }

  /** Explicit cache retirement only; event identity, permissions and high-water survive. */
  trimAcknowledged(sessionId: string, throughSequence: number): void {
    this.writable();
    integer(throughSequence);
    const record = this.required(sessionId);
    if (throughSequence > record.acknowledgedSequence)
      throw new Error("Cannot trim unacknowledged session history.");
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE events SET data=NULL,bytes=length(CAST(event_id AS BLOB))+length(CAST(session_id AS BLOB))+64
           WHERE session_id=? AND sequence<=? AND data IS NOT NULL`,
        )
        .run(sessionId, throughSequence);
      if (Number(result.changes))
        this.saveSession({ ...record, generation: randomUUID(), revision: 0 });
    });
    this.checkpointHistory();
  }

  /** Call only after Host confirms deletion and agent quiescence, never on a disconnect. */
  retire(sessionId: string): void {
    this.writable();
    this.flush();
    const record = this.stored(sessionId);
    if (!record) return;
    if (
      record.acknowledgedSequence < record.highWater ||
      record.acknowledgedControlEpoch < record.controlEpoch ||
      this.operations(sessionId).some(
        (operation) =>
          operation.origin === "local" &&
          (operation.state === "accepted" || operation.state === "queued"),
      )
    )
      throw new Error(
        "Cannot retire a session with unacknowledged events/control or active local operations.",
      );
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO retired_sessions VALUES (?,?,?,?,?)")
        .run(
          sessionId,
          record.hostId,
          record.highWater,
          record.controlEpoch,
          Buffer.byteLength(sessionId) + Buffer.byteLength(record.hostId) + 32,
        );
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
    });
    if (this.projection?.sessionId === sessionId) this.projection = undefined;
    this.checkpointHistory();
  }

  purge(hostId: string, allowUnacknowledged = false): void {
    this.writable();
    this.flush();
    if (
      !allowUnacknowledged &&
      this.list(hostId).some(
        (record) =>
          record.acknowledgedSequence < record.highWater ||
          record.acknowledgedControlEpoch < record.controlEpoch ||
          this.operations(record.session.id).some(
            (operation) => operation.state === "accepted" || operation.state === "queued",
          ),
      )
    )
      throw new Error(
        "Host namespace has unacknowledged events/control or active accepted/queued operations.",
      );
    this.transaction(() => {
      this.db.prepare("DELETE FROM sessions WHERE host_id=?").run(hostId);
      this.db.prepare("DELETE FROM retired_sessions WHERE host_id=?").run(hostId);
    });
    this.projection = undefined;
    this.checkpointHistory();
  }

  private checkpointHistory(): void {
    this.read(() => {
      const result = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (Number(result?.busy ?? 0))
        throw new Error(
          "History was deleted, but a database reader still holds its WAL snapshot. Close database readers before retrying.",
        );
    });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.closed = true;
      this.projection = undefined;
      try {
        this.db.close();
      } catch (error) {
        this.fail(error);
      }
    }
  }

  private stored(sessionId: string): StoredSession | undefined {
    return this.read(() => {
      const row = this.db.prepare("SELECT data FROM sessions WHERE id=?").get(sessionId);
      if (!row) return undefined;
      const record = JSON.parse(String(row.data)) as StoredSession;
      record.session = eligible(record.session);
      record.acknowledgedControlEpoch ??= 0;
      return record;
    });
  }

  private required(sessionId: string): StoredSession {
    const record = this.stored(sessionId);
    if (!record) throw new Error("Session continuation is not enabled.");
    return record;
  }

  private retiredHighWater(sessionId: string): number | undefined {
    return this.read(() => {
      const row = this.db
        .prepare("SELECT high_water FROM retired_sessions WHERE id=?")
        .get(sessionId);
      return row ? Number(row.high_water) : undefined;
    });
  }

  private saveSession(record: StoredSession): void {
    const data = json(record);
    this.db
      .prepare(
        "INSERT INTO sessions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes",
      )
      .run(
        record.session.id,
        record.hostId,
        data,
        Buffer.byteLength(data) +
          Buffer.byteLength(record.session.id) +
          Buffer.byteLength(record.hostId),
      );
  }

  private operation(id: string): LocalSessionOperation | undefined {
    return this.read(() => {
      const row = this.db.prepare("SELECT data FROM operations WHERE id=?").get(id);
      return row ? this.parseOperation(String(row.data)) : undefined;
    });
  }

  private parseOperation(data: string): LocalSessionOperation {
    return LocalSessionOperationSchema.parse(JSON.parse(data));
  }

  private saveOperation(operation: LocalSessionOperation): void {
    const data = json(LocalSessionOperationSchema.parse(operation));
    // Reserve recovery metadata now: a quota-full journal must still be able to
    // mark an already accepted operation uncertain after a restart.
    const bytes = Math.max(
      Buffer.byteLength(data),
      Buffer.byteLength(json({ ...operation, state: "uncertain", error: REOPEN_ERROR })),
    );
    this.db
      .prepare(
        "INSERT INTO operations VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes",
      )
      .run(
        operation.id,
        operation.sessionId,
        data,
        bytes + Buffer.byteLength(operation.id) + Buffer.byteLength(operation.sessionId),
      );
  }

  private applyMetadata(record: StoredSession, event: SessionEvent): void {
    const session = record.session;
    session.updatedAt = event.createdAt;
    if (isSessionActivityEvent(event)) {
      session.lastActivityAt = event.createdAt;
      record.activity = {
        eventId: event.eventId,
        sequence: event.sequence,
        createdAt: event.createdAt,
      };
    }
    const state = eventPayload(event, "state");
    if (state?.state) session.state = state.state;
    if (state?.activity !== undefined) session.currentActivity = state.activity;
    const text =
      eventPayload(event, "agent_text")?.text ??
      eventPayload(event, "agent_thought")?.text ??
      eventPayload(event, "system")?.text;
    if (text) session.lastText = text.slice(-500);
    const commands = eventPayload(event, "commands")?.commands;
    if (commands) session.commands = commands;
    const options = eventPayload(event, "config")?.options;
    if (options) session.configOptions = options;
    const usage = eventPayload(event, "usage");
    if (usage) session.usage = { ...session.usage, ...usage };
    const agentSessionId = eventPayload(event, "agent_session")?.agentSessionId;
    if (agentSessionId) session.agentSessionId = agentSessionId;
  }

  private usedBytes(): number {
    return this.read(() =>
      Number(this.db.prepare("SELECT bytes FROM storage WHERE id=1").get()!.bytes),
    );
  }

  private transaction<T>(body: () => T): T {
    this.writable();
    let begun = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      begun = true;
      const result = body();
      if (this.usedBytes() > this.maxBytes)
        throw new Error("Session journal storage is full; new admission is disabled.");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (begun) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // A disk error may have already rolled the transaction back.
        }
      }
      this.fail(error);
    }
  }

  private read<T>(body: () => T): T {
    if (this.closed) throw new Error("Session journal is closed.");
    try {
      return body();
    } catch (error) {
      if (error instanceof ReplayBudgetError) throw error;
      this.fail(error);
    }
  }

  private writable(): void {
    if (this.closed) throw new Error("Session journal is closed.");
    if (this.failed) throw this.failure;
  }

  private fail(error: unknown): never {
    if (!this.failed) {
      this.failed = true;
      this.failure = error;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      try {
        this.options.onFailure?.(error);
      } catch {
        // A failing observer cannot make a failed journal writable again.
      }
    }
    throw error;
  }
}

export class ReplayBudgetError extends Error {
  constructor(readonly requiredBytes: number) {
    super(`The next committed session event requires ${requiredBytes} replay bytes.`);
    this.name = "ReplayBudgetError";
  }
}
