import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import {
  COMMAND_LIMITS,
  CommandExecutionSchema,
  CommandOutputEventSchema,
  CommandReceiptSchema,
  CommandExecutionBackupSchema,
  CommandFenceSchema,
  CommandPromptRecordSchema,
  commandDigestPayload,
  type CommandExecutionBackup,
  terminalCommandExecutionStates,
  type CommandExecution,
  type CommandExecutionPage,
  type CommandOutputEvent,
  type CommandOutputGap,
  type LeadPromptDelivery,
  type LeadPromptReceipt,
} from "@fleet/protocol";
import {
  assertHostArchiveSize,
  BackupCapacityError,
  HOST_ARCHIVE_BYTES,
} from "./backup-limits.js";

export const LEAD_PROMPT_SERIALIZED_BYTES = 16 * 1024 * 1024;
export const LEAD_PROMPT_PAYLOAD_BYTES = 128 * 1024 * 1024;
const PROMPT_RECEIPT_RESERVE_BYTES = 64 * 1024;

export class CommandConflict extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

export type PromptRecord = CommandExecutionBackup["prompts"][number] & {
  /** Local scheduling authority; restored deliveries are orphaned, never retried. */
  retryAfterSeq?: number | undefined;
};

export type CommandFence = CommandExecutionBackup["fences"][number];

export type CommandPreparationClock = {
  hostTime: string;
  acceptedAt: string | null;
  elapsedMs: number | null;
};

export function mergeCommandGaps(ranges: CommandOutputGap[]): CommandOutputGap[] {
  const merged: CommandOutputGap[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  // A fragmented tail is explicitly reported as one lossy range, never silently complete.
  if (merged.length > 128)
    merged.splice(127, merged.length - 127, {
      from: merged[127]!.from,
      to: merged.at(-1)!.to,
    });
  return merged;
}

/** Command evidence deliberately has no cascading catalog/session foreign keys. */
export class CommandExecutionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(work: () => T) => T,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS command_executions (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, node_id TEXT NOT NULL,
        task_id TEXT, version INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS command_execution_owner ON command_executions(lead_id);
      CREATE TABLE IF NOT EXISTS command_execution_events (
        execution_id TEXT NOT NULL, sequence INTEGER NOT NULL, bytes INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(execution_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS command_output_usage (
        id INTEGER PRIMARY KEY CHECK(id=1), stored_bytes INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO command_output_usage
        SELECT 1,coalesce(sum(length(data)),0) FROM command_execution_events;
      CREATE TRIGGER IF NOT EXISTS command_output_insert AFTER INSERT ON command_execution_events
      BEGIN UPDATE command_output_usage SET stored_bytes=stored_bytes+length(NEW.data) WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS command_output_delete AFTER DELETE ON command_execution_events
      BEGIN UPDATE command_output_usage SET stored_bytes=stored_bytes-length(OLD.data) WHERE id=1; END;
      CREATE TABLE IF NOT EXISTS command_request_tombstones (
        lead_id TEXT NOT NULL, request_key TEXT NOT NULL, execution_id TEXT NOT NULL,
        digest TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(lead_id,request_key)
      );
      CREATE TABLE IF NOT EXISTS command_attempt_tombstones (
        execution_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, digest TEXT NOT NULL,
        node_id TEXT NOT NULL, host_id TEXT NOT NULL, retired_at TEXT NOT NULL DEFAULT '',
        start_version INTEGER, cancelled INTEGER NOT NULL DEFAULT 0, receipt TEXT
      );
      CREATE TABLE IF NOT EXISTS command_task_fences (
        task_id TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_step_evidence (
        step_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_notification_states (
        execution_id TEXT PRIMARY KEY, phase TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_preparation_clocks (
        execution_id TEXT PRIMARY KEY, host_time TEXT NOT NULL,
        accepted_at TEXT, elapsed_ms REAL
      );
      CREATE TABLE IF NOT EXISTS command_session_revocations (
        host_id TEXT NOT NULL, node_id TEXT NOT NULL, lead_id TEXT NOT NULL,
        PRIMARY KEY(host_id,node_id,lead_id)
      );
      CREATE TABLE IF NOT EXISTS command_execution_namespace (
        id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lead_prompt_deliveries (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, logical_key TEXT NOT NULL,
        state TEXT NOT NULL, data TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL DEFAULT 0, metadata_bytes INTEGER NOT NULL DEFAULT 0,
        UNIQUE(lead_id,logical_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS lead_prompt_reservation
        ON lead_prompt_deliveries(lead_id)
        WHERE state IN ('reserved','accepted','uncertain');
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO command_execution_namespace(id,namespace) VALUES(1,?)",
      )
      .run(randomUUID());
    const columns = this.db.prepare("PRAGMA table_info(lead_prompt_deliveries)").all();
    if (!columns.some((column) => column.name === "payload_bytes")) {
      this.db.exec(
        "ALTER TABLE lead_prompt_deliveries ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0",
      );
      this.db.exec(
        "ALTER TABLE lead_prompt_deliveries ADD COLUMN metadata_bytes INTEGER NOT NULL DEFAULT 0",
      );
      this.db.exec(`UPDATE lead_prompt_deliveries SET
        payload_bytes=length(CAST(json_extract(data,'$.delivery') AS BLOB)),
        metadata_bytes=length(CAST(data AS BLOB))-length(CAST(json_extract(data,'$.delivery') AS BLOB))`);
    }
  }

  get(id: string): CommandExecution | undefined {
    const row = this.db.prepare("SELECT data FROM command_executions WHERE id=?").get(id);
    return row ? CommandExecutionSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  /** Routing evidence only; command/path grants and their validity belong to the Node. */
  sessionGrantTargets(): { hostId: string; nodeId: string; leadSessionId: string }[] {
    return this.db
      .prepare(
        `SELECT json_extract(data,'$.hostId') AS host_id,node_id,lead_id
         FROM command_executions
         UNION
         SELECT a.host_id,a.node_id,r.lead_id FROM command_attempt_tombstones a
         JOIN command_request_tombstones r ON r.execution_id=a.execution_id`,
      )
      .all()
      .map((row) => ({
        hostId: String(row.host_id),
        nodeId: String(row.node_id),
        leadSessionId: String(row.lead_id),
      }));
  }

  revokeSessionGrants(leadId?: string): void {
    this.atomic(() => {
      for (const target of this.sessionGrantTargets()) {
        if (leadId !== undefined && target.leadSessionId !== leadId) continue;
        this.db
          .prepare(
            "INSERT OR IGNORE INTO command_session_revocations(host_id,node_id,lead_id) VALUES(?,?,?)",
          )
          .run(target.hostId, target.nodeId, target.leadSessionId);
      }
    });
  }

  sessionGrantRevocations(nodeId: string) {
    return this.db
      .prepare("SELECT host_id,lead_id FROM command_session_revocations WHERE node_id=?")
      .all(nodeId)
      .map((row) => ({
        hostId: String(row.host_id),
        leadSessionId: String(row.lead_id),
      }));
  }

  preparationClock(id: string): CommandPreparationClock | undefined {
    const row = this.db
      .prepare(
        "SELECT host_time,accepted_at,elapsed_ms FROM command_preparation_clocks WHERE execution_id=?",
      )
      .get(id);
    return row
      ? {
          hostTime: String(row.host_time),
          acceptedAt: row.accepted_at === null ? null : String(row.accepted_at),
          elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
        }
      : undefined;
  }

  recordPreparationSend(id: string, hostTime: string): void {
    this.db
      .prepare(
        "INSERT INTO command_preparation_clocks(execution_id,host_time) VALUES(?,?)",
      )
      .run(id, hostTime);
  }

  acceptPreparationClock(
    id: string,
    hostTime: string,
    acceptedAt: string,
    elapsedMs: number,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE command_preparation_clocks SET accepted_at=?,elapsed_ms=?
       WHERE execution_id=? AND host_time=? AND accepted_at IS NULL`,
      )
      .run(acceptedAt, elapsedMs, id, hostTime);
    if (!result.changes) throw new CommandConflict("preparation_clock_conflict");
  }

  notificationPhase(id: string): "approval" | "closed" | "completion" | undefined {
    const row = this.db
      .prepare("SELECT phase FROM command_notification_states WHERE execution_id=?")
      .get(id);
    if (!row) return undefined;
    const phase = row.phase;
    if (phase === "approval" || phase === "closed" || phase === "completion")
      return phase;
    throw new CommandConflict("invalid_notification_phase");
  }

  recordNotificationPhase(id: string, phase: "approval" | "closed" | "completion"): void {
    this.db
      .prepare(
        `INSERT INTO command_notification_states(execution_id,phase) VALUES(?,?)
       ON CONFLICT(execution_id) DO UPDATE SET phase=excluded.phase`,
      )
      .run(id, phase);
  }

  list(
    input: {
      leadSessionId?: string | undefined;
      taskId?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): CommandExecution[] {
    return this.db
      .prepare(
        `SELECT data FROM command_executions
       WHERE (? IS NULL OR lead_id=?) AND (? IS NULL OR task_id=?)
       ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        input.leadSessionId ?? null,
        input.leadSessionId ?? null,
        input.taskId ?? null,
        input.taskId ?? null,
        Math.min(input.limit ?? 100, 10_000),
      )
      .map((row) => CommandExecutionSchema.parse(JSON.parse(String(row.data))));
  }

  unsettled(): CommandExecution[] {
    return this.db
      .prepare(
        `SELECT data FROM command_executions WHERE json_extract(data,'$.settledAt') IS NULL`,
      )
      .all()
      .map((row) => CommandExecutionSchema.parse(JSON.parse(String(row.data))));
  }

  request(
    leadId: string,
    key: string,
    digest: string,
    now: number,
  ): CommandExecution | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM command_request_tombstones WHERE lead_id=? AND request_key=?",
      )
      .get(leadId, key);
    if (!row) return undefined;
    if (row.digest !== digest) throw new CommandConflict("request_key_conflict");
    if (row.revoked || now - Date.parse(String(row.created_at)) >= COMMAND_LIMITS.retryMs)
      throw new CommandConflict("request_expired");
    const execution = this.get(String(row.execution_id));
    if (!execution) throw new CommandConflict("request_expired");
    return execution;
  }

  insert(value: CommandExecution): CommandExecution {
    return this.atomic(() => {
      const execution = CommandExecutionSchema.parse(value);
      this.assertAdmission(execution.leadSessionId, execution.nodeId);
      this.db
        .prepare(
          "INSERT INTO command_request_tombstones(lead_id,request_key,execution_id,digest,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          execution.leadSessionId,
          execution.requestKey,
          execution.id,
          execution.requestDigest,
          execution.createdAt,
        );
      this.db
        .prepare(
          "INSERT INTO command_executions(id,lead_id,node_id,task_id,version,data) VALUES(?,?,?,?,?,?)",
        )
        .run(
          execution.id,
          execution.leadSessionId,
          execution.nodeId,
          execution.taskId ?? null,
          execution.version,
          JSON.stringify(execution),
        );
      return execution;
    });
  }

  assertAdmission(leadId: string, nodeId: string): void {
    const pending = this.unsettled();
    if (
      pending.filter((e) => e.leadSessionId === leadId).length >=
        COMMAND_LIMITS.maxLeadPending ||
      pending.filter((e) => e.nodeId === nodeId).length >= COMMAND_LIMITS.maxNodePending
    )
      throw new CommandConflict("admission_limit");
    const evidenceBytes = this.lifecycleBytes();
    // Leave room for the worst-case receipts of every already-admitted request.
    if (
      evidenceBytes +
        (pending.length + 1) * 32_768 +
        this.prompts().length * PROMPT_RECEIPT_RESERVE_BYTES >=
      COMMAND_LIMITS.lifecycleReserveBytes
    )
      throw new CommandConflict("lifecycle_storage_pressure");
  }

  private lifecycleBytes(): number {
    const evidence = this.db
      .prepare(
        `SELECT (SELECT coalesce(sum(length(data)),0) FROM command_executions)
        + (SELECT coalesce(sum(metadata_bytes),0) FROM lead_prompt_deliveries)
        + (SELECT count(*)*512 FROM command_request_tombstones)
        + (SELECT coalesce(sum(length(receipt)),0) FROM command_attempt_tombstones) AS bytes`,
      )
      .get()!;
    return Number(evidence.bytes);
  }

  update(
    id: string,
    expectedVersion: number,
    patch: Partial<CommandExecution>,
  ): CommandExecution {
    const current = this.get(id);
    if (!current || current.version !== expectedVersion)
      throw new CommandConflict("execution_version_conflict");
    const value = CommandExecutionSchema.parse({
      ...current,
      ...patch,
      id,
      version: expectedVersion + 1,
      updatedAt: new Date().toISOString(),
    });
    if (
      value.attemptId !== current.attemptId ||
      value.requestDigest !== current.requestDigest ||
      value.leadSessionId !== current.leadSessionId ||
      value.nodeId !== current.nodeId
    )
      throw new CommandConflict("execution_identity_conflict");
    const result = this.db
      .prepare("UPDATE command_executions SET version=?,data=? WHERE id=? AND version=?")
      .run(value.version, JSON.stringify(value), id, expectedVersion);
    if (!result.changes) throw new CommandConflict("execution_version_conflict");
    return value;
  }

  markStart(execution: CommandExecution): void {
    this.db
      .prepare(
        `INSERT INTO command_attempt_tombstones(execution_id,attempt_id,digest,start_version,node_id,host_id)
         VALUES(?,?,?,?,?,?) ON CONFLICT(execution_id) DO NOTHING`,
      )
      .run(
        execution.id,
        execution.attemptId,
        execution.descriptor!.digest,
        execution.version,
        execution.nodeId,
        execution.hostId,
      );
    const row = this.attempt(execution.id);
    if (!row || row.cancelled || row.start_version !== execution.version)
      throw new CommandConflict("attempt_already_recorded");
  }

  attempt(id: string) {
    return this.db
      .prepare("SELECT * FROM command_attempt_tombstones WHERE execution_id=?")
      .get(id);
  }

  markCancel(execution: CommandExecution): void {
    this.db
      .prepare(
        `INSERT INTO command_attempt_tombstones(execution_id,attempt_id,digest,cancelled,node_id,host_id)
         VALUES(?,?,?,1,?,?) ON CONFLICT(execution_id) DO UPDATE SET
         cancelled=1,digest=CASE WHEN start_version IS NULL THEN excluded.digest ELSE digest END`,
      )
      .run(
        execution.id,
        execution.attemptId,
        execution.descriptor?.digest ?? execution.requestDigest,
        execution.nodeId,
        execution.hostId,
      );
  }

  recordReceipt(id: string, receipt: string): void {
    this.db
      .prepare("UPDATE command_attempt_tombstones SET receipt=? WHERE execution_id=?")
      .run(receipt, id);
  }

  appendOutput(
    execution: CommandExecution,
    value: CommandOutputEvent,
  ): { execution: CommandExecution; stored: boolean } {
    return this.atomic(() => {
      const event = CommandOutputEventSchema.parse(value);
      const bytes = Buffer.from(event.data, "base64").length;
      if (bytes > COMMAND_LIMITS.chunkBytes)
        throw new CommandConflict("output_chunk_limit");
      const existing = this.db
        .prepare(
          "SELECT data FROM command_execution_events WHERE execution_id=? AND sequence=?",
        )
        .get(event.executionId, event.sequence);
      if (existing) {
        if (existing.data !== JSON.stringify(event))
          throw new CommandConflict("output_identity_conflict");
        return { execution, stored: false };
      }
      if (
        execution.gaps.some(
          (gap) => event.sequence >= gap.from && event.sequence <= gap.to,
        )
      )
        return { execution, stored: false };
      if (
        execution.finalOutputSeq !== undefined &&
        event.sequence > execution.finalOutputSeq
      )
        throw new CommandConflict("output_after_final_watermark");
      const total = Number(
        this.db
          .prepare("SELECT stored_bytes AS bytes FROM command_output_usage WHERE id=1")
          .get()!.bytes,
      );
      const retain =
        execution.outputBytes + bytes <= COMMAND_LIMITS.outputBytes &&
        total + Buffer.byteLength(JSON.stringify(event), "utf8") <=
          COMMAND_LIMITS.hostLogBytes;
      if (retain)
        this.db
          .prepare(
            "INSERT INTO command_execution_events(execution_id,sequence,bytes,data) VALUES(?,?,?,?)",
          )
          .run(event.executionId, event.sequence, bytes, JSON.stringify(event));
      const updated = this.update(execution.id, execution.version, {
        outputBytes: execution.outputBytes + (retain ? bytes : 0),
        lastOutputSeq: Math.max(execution.lastOutputSeq, event.sequence),
        gaps: retain
          ? execution.gaps
          : mergeCommandGaps([
              ...execution.gaps,
              { from: event.sequence, to: event.sequence },
            ]),
      });
      return { execution: this.refreshOutput(updated), stored: retain };
    });
  }

  throughSeq(execution: CommandExecution): number {
    const ranges = [
      ...execution.gaps,
      ...this.db
        .prepare(
          "SELECT sequence FROM command_execution_events WHERE execution_id=? ORDER BY sequence",
        )
        .all(execution.id)
        .map((row) => ({ from: Number(row.sequence), to: Number(row.sequence) })),
    ].sort((a, b) => a.from - b.from);
    let through = 0;
    for (const range of ranges) {
      if (range.from > through + 1) break;
      through = Math.max(through, range.to);
    }
    return through;
  }

  refreshOutput(execution: CommandExecution): CommandExecution {
    const complete =
      execution.finalOutputSeq !== undefined &&
      this.throughSeq(execution) >= execution.finalOutputSeq;
    return complete === execution.outputComplete
      ? execution
      : this.update(execution.id, execution.version, { outputComplete: complete });
  }

  page(id: string, afterSeq: number, limitBytes: number): CommandExecutionPage {
    const execution = this.get(id);
    if (!execution) throw new CommandConflict("execution_not_found");
    const rows = this.db
      .prepare(
        "SELECT data,bytes FROM command_execution_events WHERE execution_id=? AND sequence>? ORDER BY sequence LIMIT 513",
      )
      .all(id, afterSeq);
    const events: CommandOutputEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (bytes + Number(row.bytes) > limitBytes || events.length >= 512) break;
      events.push(CommandOutputEventSchema.parse(JSON.parse(String(row.data))));
      bytes += Number(row.bytes);
    }
    if (rows.length && !events.length)
      throw new CommandConflict(
        "page_limit_too_small",
        `The next raw event requires ${rows[0]!.bytes} bytes; increase limitBytes (maximum ${COMMAND_LIMITS.pageBytes}).`,
      );
    let nextSeq = events.at(-1)?.sequence ?? afterSeq;
    for (const gap of execution.gaps)
      if (gap.from <= nextSeq + 1 && gap.to > nextSeq) nextSeq = gap.to;
    return {
      execution,
      events,
      nextSeq,
      hasMore: rows.length > events.length,
      outputComplete: execution.outputComplete,
    };
  }

  fence(taskId: string): CommandFence | undefined {
    const row = this.db
      .prepare("SELECT data FROM command_task_fences WHERE task_id=?")
      .get(taskId);
    return row ? (JSON.parse(String(row.data)) as CommandFence) : undefined;
  }

  putFence(fence: CommandFence): void {
    this.db
      .prepare(
        "INSERT INTO command_task_fences(task_id,data) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
      )
      .run(fence.taskId, JSON.stringify(fence));
  }

  assertTaskUnfenced(taskId: string): void {
    const fence = this.fence(taskId);
    if (fence && ["executing", "observation_required"].includes(fence.state))
      throw new CommandConflict(
        "command_task_fenced",
        "A command may have changed this task; wait for proven quiescence and a fresh checkout observation.",
      );
  }

  recordStepEvidence(taskId: string, stepId: string): void {
    this.assertTaskUnfenced(taskId);
    const fence = this.fence(taskId);
    if (!fence) return;
    this.db
      .prepare(
        `INSERT INTO command_step_evidence(step_id,task_id,revision) VALUES(?,?,?)
       ON CONFLICT(step_id) DO UPDATE SET task_id=excluded.task_id,revision=excluded.revision`,
      )
      .run(stepId, taskId, fence.revision);
  }

  stepHasCurrentEvidence(taskId: string, stepId: string): boolean {
    const fence = this.fence(taskId);
    return (
      !fence ||
      !!this.db
        .prepare(
          "SELECT 1 FROM command_step_evidence WHERE step_id=? AND task_id=? AND revision=?",
        )
        .get(stepId, taskId, fence.revision)
    );
  }

  assertDeletionAllowed(filter: (execution: CommandExecution) => boolean): void {
    if (this.unsettled().some(filter))
      throw new CommandConflict(
        "command_evidence_unresolved",
        "Cancel and reconcile command executions before deleting their owner or target.",
      );
  }

  namespace(): string {
    return String(
      this.db
        .prepare("SELECT namespace FROM command_execution_namespace WHERE id=1")
        .get()!.namespace,
    );
  }

  exportBackup(): CommandExecutionBackup {
    const stored = Number(
      this.db
        .prepare(
          `SELECT
      (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM command_executions) +
      (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM command_execution_events) +
      (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM lead_prompt_deliveries) AS bytes`,
        )
        .get()!.bytes,
    );
    if (stored > HOST_ARCHIVE_BYTES) throw new BackupCapacityError();
    const backup = CommandExecutionBackupSchema.parse({
      version: 1,
      namespace: this.namespace(),
      executions: this.db
        .prepare("SELECT data FROM command_executions ORDER BY id")
        .all()
        .map((row) => CommandExecutionSchema.parse(JSON.parse(String(row.data)))),
      events: this.db
        .prepare(
          "SELECT data FROM command_execution_events ORDER BY execution_id,sequence",
        )
        .all()
        .map((row) => CommandOutputEventSchema.parse(JSON.parse(String(row.data)))),
      requests: this.db
        .prepare("SELECT * FROM command_request_tombstones ORDER BY lead_id,request_key")
        .all()
        .map((row) => ({
          leadId: row.lead_id,
          requestKey: row.request_key,
          executionId: row.execution_id,
          digest: row.digest,
          createdAt: row.created_at,
          revoked: Boolean(row.revoked),
        })),
      attempts: this.db
        .prepare("SELECT * FROM command_attempt_tombstones ORDER BY execution_id")
        .all()
        .map((row) => ({
          executionId: row.execution_id,
          attemptId: row.attempt_id,
          digest: row.digest,
          nodeId: row.node_id,
          hostId: row.host_id,
          retiredAt: row.retired_at,
          startVersion: row.start_version,
          cancelled: Boolean(row.cancelled),
          receipt: row.receipt === null ? null : JSON.parse(String(row.receipt)),
        })),
      fences: this.db
        .prepare("SELECT data FROM command_task_fences ORDER BY task_id")
        .all()
        .map((row) => CommandFenceSchema.parse(JSON.parse(String(row.data)))),
      evidence: this.db
        .prepare("SELECT * FROM command_step_evidence ORDER BY step_id")
        .all()
        .map((row) => ({
          stepId: row.step_id,
          taskId: row.task_id,
          revision: row.revision,
        })),
      prompts: this.db
        .prepare("SELECT data FROM lead_prompt_deliveries ORDER BY id")
        .all()
        .map((row) =>
          CommandPromptRecordSchema.parse(this.parsePrompt(String(row.data))),
        ),
      notifications: this.db
        .prepare("SELECT * FROM command_notification_states ORDER BY execution_id")
        .all()
        .map((row) => ({
          executionId: row.execution_id,
          phase: row.phase,
        })),
      clocks: this.db
        .prepare("SELECT * FROM command_preparation_clocks ORDER BY execution_id")
        .all()
        .map((row) => ({
          executionId: row.execution_id,
          hostTime: row.host_time,
          acceptedAt: row.accepted_at,
          elapsedMs: row.elapsed_ms,
        })),
    });
    assertHostArchiveSize(backup);
    return backup;
  }

  importBackup(input?: CommandExecutionBackup): void {
    this.assertRestoreAllowed();
    const archive =
      input === undefined ? undefined : CommandExecutionBackupSchema.parse(input);
    if (archive) assertHostArchiveSize(archive);
    this.atomic(() => {
      if (archive) this.mergeBackup(archive);
      this.quarantine(true);
      if (
        this.lifecycleBytes() + this.unsettled().length * 32_768 >
        COMMAND_LIMITS.lifecycleReserveBytes
      )
        throw new CommandConflict("lifecycle_storage_pressure");
      const outputBytes = Number(
        this.db.prepare("SELECT stored_bytes FROM command_output_usage WHERE id=1").get()!
          .stored_bytes,
      );
      if (outputBytes > COMMAND_LIMITS.hostLogBytes)
        throw new CommandConflict("command_output_storage_pressure");
      this.exportBackup();
    });
  }

  private mergeBackup(archive: CommandExecutionBackup): void {
    const conflict = (kind: string): never => {
      throw new CommandConflict(
        "command_backup_conflict",
        `Conflicting ${kind} evidence; restore was not applied.`,
      );
    };
    const unique = <T>(values: T[], key: (value: T) => string, kind: string) => {
      const seen = new Set<string>();
      for (const value of values) {
        const id = key(value);
        if (seen.has(id)) conflict(kind);
        seen.add(id);
      }
    };
    unique(archive.executions, (entry) => entry.id, "execution");
    unique(archive.events, (entry) => `${entry.executionId}:${entry.sequence}`, "output");
    unique(
      archive.requests,
      (entry) => JSON.stringify([entry.leadId, entry.requestKey]),
      "request key",
    );
    unique(archive.attempts, (entry) => entry.executionId, "attempt");
    unique(archive.fences, (entry) => entry.taskId, "fence");
    unique(archive.evidence, (entry) => entry.stepId, "verification");
    unique(archive.prompts, (entry) => entry.delivery.deliveryId, "delivery");
    unique(
      archive.prompts,
      (entry) => JSON.stringify([entry.delivery.sessionId, entry.key]),
      "delivery key",
    );
    unique(archive.notifications, (entry) => entry.executionId, "notification");
    unique(archive.clocks, (entry) => entry.executionId, "clock");
    for (const execution of archive.executions) {
      const terminal = terminalCommandExecutionStates.has(execution.state);
      if (
        !CommandReceiptSchema.safeParse({
          executionId: execution.id,
          attemptId: execution.attemptId,
          digest: execution.descriptor?.digest ?? execution.requestDigest,
          state: execution.state,
          ownership: execution.ownership,
          exitCode: execution.exitCode,
          reason: execution.reasonCode,
          outcomeKnown: execution.outcomeKnown,
          descendantCleanupForced: execution.descendantCleanupForced,
          startedAt: execution.startedAt,
          settledAt: execution.settledAt,
          finalOutputSeq: execution.finalOutputSeq,
          gaps: execution.gaps,
        }).success ||
        (terminal && (!execution.settledAt || execution.finalOutputSeq === undefined)) ||
        (!terminal && execution.settledAt) ||
        (execution.ownership === "not_started" &&
          (execution.startedAt || execution.exitCode !== null)) ||
        (execution.ownership !== "not_started" && !execution.descriptor)
      )
        conflict("execution lifecycle");
      const descriptor = execution.descriptor;
      if (
        descriptor &&
        (descriptor.executionId !== execution.id ||
          descriptor.attemptId !== execution.attemptId ||
          descriptor.hostId !== execution.hostId ||
          descriptor.nodeId !== execution.nodeId ||
          descriptor.leadSessionId !== execution.leadSessionId ||
          descriptor.requestedPath !== execution.requestedPath ||
          descriptor.command !== execution.command ||
          descriptor.shell !== execution.shell ||
          descriptor.reason !== execution.reason ||
          descriptor.requestKey !== execution.requestKey ||
          descriptor.timeoutMs !== execution.timeoutMs ||
          descriptor.taskId !== execution.taskId ||
          descriptor.createdAt !== execution.createdAt ||
          descriptor.expiresAt !== execution.expiresAt ||
          !isDeepStrictEqual(descriptor.target, execution.target) ||
          createHash("sha256").update(commandDigestPayload(descriptor)).digest("hex") !==
            descriptor.digest)
      )
        conflict("prepared command descriptor");
      const current = this.get(execution.id);
      if (current) {
        const identity = (entry: CommandExecution) => ({
          attemptId: entry.attemptId,
          hostId: entry.hostId,
          nodeId: entry.nodeId,
          leadSessionId: entry.leadSessionId,
          taskId: entry.taskId,
          requestDigest: entry.requestDigest,
          target: entry.target,
          requestedPath: entry.requestedPath,
          command: entry.command,
          shell: entry.shell,
          reason: entry.reason,
          requestKey: entry.requestKey,
          timeoutMs: entry.timeoutMs,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        });
        if (
          !isDeepStrictEqual(identity(current), identity(execution)) ||
          (current.descriptor &&
            execution.descriptor &&
            !isDeepStrictEqual(current.descriptor, execution.descriptor))
        )
          conflict("execution identity");
        if (
          terminalCommandExecutionStates.has(current.state) &&
          current.ownership === "not_started" &&
          execution.ownership === "quiescent"
        )
          conflict("no-start versus executed outcome");
        if (
          terminalCommandExecutionStates.has(current.state) &&
          terminalCommandExecutionStates.has(execution.state)
        ) {
          const outcome = (entry: CommandExecution) => ({
            state: entry.state,
            ownership: entry.ownership,
            exitCode: entry.exitCode,
            outcomeKnown: entry.outcomeKnown,
            descendantCleanupForced: entry.descendantCleanupForced,
            startedAt: entry.startedAt,
            settledAt: entry.settledAt,
            finalOutputSeq: entry.finalOutputSeq,
          });
          if (!isDeepStrictEqual(outcome(current), outcome(execution)))
            conflict("terminal outcome");
        }
        if (
          !terminalCommandExecutionStates.has(current.state) &&
          (terminalCommandExecutionStates.has(execution.state) ||
            execution.ownership === "active" ||
            execution.ownership === "unknown")
        ) {
          this.update(current.id, current.version, {
            ...execution,
            version: current.version,
          });
        } else if (!current.descriptor && execution.descriptor)
          this.update(current.id, current.version, { descriptor: execution.descriptor });
        const merged = this.get(current.id)!;
        const gaps = mergeCommandGaps([...merged.gaps, ...execution.gaps]);
        if (
          merged.finalOutputSeq !== undefined &&
          gaps.some((gap) => gap.to > merged.finalOutputSeq!)
        )
          conflict("output gap watermark");
        if (!isDeepStrictEqual(gaps, merged.gaps))
          this.update(merged.id, merged.version, { gaps });
      } else
        this.db
          .prepare(
            "INSERT INTO command_executions(id,lead_id,node_id,task_id,version,data) VALUES(?,?,?,?,?,?)",
          )
          .run(
            execution.id,
            execution.leadSessionId,
            execution.nodeId,
            execution.taskId ?? null,
            execution.version,
            JSON.stringify(execution),
          );
    }
    for (const request of archive.requests) {
      const existing = this.db
        .prepare(
          "SELECT * FROM command_request_tombstones WHERE lead_id=? AND request_key=?",
        )
        .get(request.leadId, request.requestKey);
      if (
        existing &&
        (existing.execution_id !== request.executionId ||
          existing.digest !== request.digest ||
          existing.created_at !== request.createdAt)
      )
        conflict("request key");
      const execution = this.get(request.executionId);
      if (
        execution &&
        (execution.leadSessionId !== request.leadId ||
          execution.requestKey !== request.requestKey ||
          execution.requestDigest !== request.digest)
      )
        conflict("request owner");
      this.db
        .prepare(
          `INSERT INTO command_request_tombstones(lead_id,request_key,execution_id,digest,created_at,revoked)
        VALUES(?,?,?,?,?,1) ON CONFLICT(lead_id,request_key) DO UPDATE SET revoked=1`,
        )
        .run(
          request.leadId,
          request.requestKey,
          request.executionId,
          request.digest,
          request.createdAt,
        );
    }
    for (const execution of archive.executions) {
      const request = this.db
        .prepare(
          "SELECT execution_id,digest FROM command_request_tombstones WHERE lead_id=? AND request_key=?",
        )
        .get(execution.leadSessionId, execution.requestKey);
      if (
        !request ||
        request.execution_id !== execution.id ||
        request.digest !== execution.requestDigest
      )
        conflict("missing request identity");
    }
    for (const attempt of archive.attempts) {
      const existing = this.attempt(attempt.executionId);
      const execution = this.get(attempt.executionId);
      if (!execution && !attempt.retiredAt)
        conflict("missing execution for an unretired attempt");
      if (
        existing &&
        (existing.attempt_id !== attempt.attemptId ||
          existing.node_id !== attempt.nodeId ||
          existing.host_id !== attempt.hostId ||
          (existing.start_version !== null && existing.digest !== attempt.digest) ||
          (existing.start_version !== null &&
            attempt.startVersion !== null &&
            existing.start_version !== attempt.startVersion))
      )
        conflict("attempt identity");
      if (
        execution &&
        (execution.attemptId !== attempt.attemptId ||
          execution.nodeId !== attempt.nodeId ||
          execution.hostId !== attempt.hostId ||
          (attempt.startVersion !== null &&
            execution.descriptor?.digest !== attempt.digest) ||
          (attempt.digest !== execution.descriptor?.digest &&
            attempt.digest !== execution.requestDigest))
      )
        conflict("attempt owner");
      if (
        attempt.receipt &&
        (attempt.receipt.executionId !== attempt.executionId ||
          attempt.receipt.attemptId !== attempt.attemptId ||
          attempt.receipt.digest !== attempt.digest)
      )
        conflict("receipt identity");
      const previous = existing?.receipt
        ? (JSON.parse(
            String(existing.receipt),
          ) as CommandExecutionBackup["attempts"][number]["receipt"])
        : null;
      if (previous && attempt.receipt) {
        if (
          previous &&
          terminalCommandExecutionStates.has(previous.state) &&
          terminalCommandExecutionStates.has(attempt.receipt.state)
        ) {
          const { gaps: _oldGaps, ...oldOutcome } = previous;
          const { gaps: _newGaps, ...newOutcome } = attempt.receipt;
          if (!isDeepStrictEqual(oldOutcome, newOutcome)) conflict("terminal receipt");
        }
      }
      let receipt =
        previous && terminalCommandExecutionStates.has(previous.state)
          ? previous
          : attempt.receipt && terminalCommandExecutionStates.has(attempt.receipt.state)
            ? attempt.receipt
            : (previous ?? attempt.receipt);
      if (
        receipt &&
        previous &&
        attempt.receipt &&
        terminalCommandExecutionStates.has(previous.state) &&
        terminalCommandExecutionStates.has(attempt.receipt.state)
      )
        receipt = {
          ...receipt,
          gaps: mergeCommandGaps([...previous.gaps, ...attempt.receipt.gaps]),
        };
      const digest =
        existing?.start_version != null
          ? String(existing.digest)
          : (receipt?.digest ?? attempt.digest);
      this.db
        .prepare(
          `INSERT INTO command_attempt_tombstones
        (execution_id,attempt_id,digest,node_id,host_id,retired_at,start_version,cancelled,receipt) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(execution_id) DO UPDATE SET
        cancelled=MAX(cancelled,excluded.cancelled),start_version=coalesce(start_version,excluded.start_version),
        digest=excluded.digest,receipt=excluded.receipt`,
        )
        .run(
          attempt.executionId,
          attempt.attemptId,
          digest,
          attempt.nodeId,
          attempt.hostId,
          attempt.retiredAt,
          attempt.startVersion,
          attempt.cancelled ? 1 : 0,
          receipt ? JSON.stringify(receipt) : null,
        );
    }
    const touched = new Set(archive.executions.map((execution) => execution.id));
    for (const event of archive.events) {
      const execution = this.get(event.executionId);
      const bytes = Buffer.from(event.data, "base64").length;
      if (
        !execution ||
        execution.attemptId !== event.attemptId ||
        bytes > COMMAND_LIMITS.chunkBytes ||
        (execution.finalOutputSeq !== undefined &&
          event.sequence > execution.finalOutputSeq)
      )
        conflict("output owner or watermark");
      const existing = this.db
        .prepare(
          "SELECT data FROM command_execution_events WHERE execution_id=? AND sequence=?",
        )
        .get(event.executionId, event.sequence);
      const encoded = JSON.stringify(event);
      if (existing && existing.data !== encoded) conflict("output sequence");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO command_execution_events(execution_id,sequence,bytes,data) VALUES(?,?,?,?)",
        )
        .run(event.executionId, event.sequence, bytes, encoded);
      touched.add(event.executionId);
    }
    for (const executionId of touched) {
      const execution = this.get(executionId)!;
      const output = this.db
        .prepare(
          "SELECT coalesce(sum(bytes),0) AS bytes,coalesce(max(sequence),0) AS last FROM command_execution_events WHERE execution_id=?",
        )
        .get(executionId)!;
      if (Number(output.bytes) > COMMAND_LIMITS.outputBytes)
        conflict("per-execution output capacity");
      this.refreshOutput(
        this.update(executionId, execution.version, {
          outputBytes: Number(output.bytes),
          lastOutputSeq: Math.max(execution.lastOutputSeq, Number(output.last)),
        }),
      );
    }
    for (const fence of archive.fences) {
      const existing = this.fence(fence.taskId);
      if (
        existing &&
        existing.revision === fence.revision &&
        existing.executionId !== fence.executionId
      )
        conflict("fence revision");
      if (!existing || fence.revision > existing.revision) this.putFence(fence);
    }
    for (const evidence of archive.evidence) {
      const existing = this.db
        .prepare("SELECT task_id FROM command_step_evidence WHERE step_id=?")
        .get(evidence.stepId);
      if (existing && existing.task_id !== evidence.taskId)
        conflict("verification owner");
      this.db
        .prepare(
          `INSERT INTO command_step_evidence(step_id,task_id,revision) VALUES(?,?,?)
        ON CONFLICT(step_id) DO UPDATE SET revision=MAX(revision,excluded.revision)`,
        )
        .run(evidence.stepId, evidence.taskId, evidence.revision);
    }
    for (const prompt of archive.prompts) {
      const existing = this.prompt(prompt.delivery.deliveryId);
      const keyOwner = this.db
        .prepare(
          "SELECT id FROM lead_prompt_deliveries WHERE lead_id=? AND logical_key=?",
        )
        .get(prompt.delivery.sessionId, prompt.key);
      if (keyOwner && keyOwner.id !== prompt.delivery.deliveryId)
        conflict("delivery key");
      if (
        prompt.receipt &&
        (prompt.receipt.deliveryId !== prompt.delivery.deliveryId ||
          prompt.receipt.sessionId !== prompt.delivery.sessionId)
      )
        conflict("delivery receipt");
      if (
        existing &&
        (existing.nodeId !== prompt.nodeId ||
          existing.key !== prompt.key ||
          existing.delivery.sessionId !== prompt.delivery.sessionId)
      )
        conflict("delivery owner");
      const retired = (state: PromptRecord["state"]) =>
        ["settled", "rejected", "orphaned"].includes(state);
      if (
        existing &&
        !retired(existing.state) &&
        !retired(prompt.state) &&
        !isDeepStrictEqual(existing.delivery, prompt.delivery)
      )
        conflict("delivery payload");
      const nativeBound = (receipt: LeadPromptReceipt | undefined) =>
        receipt &&
        ["accepted", "uncertain", "settled"].includes(receipt.state) &&
        receipt.nativeSessionId &&
        receipt.attemptId;
      if (
        nativeBound(existing?.receipt) &&
        nativeBound(prompt.receipt) &&
        (existing!.receipt!.nativeSessionId !== prompt.receipt!.nativeSessionId ||
          existing!.receipt!.attemptId !== prompt.receipt!.attemptId)
      )
        conflict("native delivery attempt");
      if (!existing) {
        const imported: PromptRecord = { ...prompt, state: "orphaned" };
        const sizes = this.promptSizes(imported);
        this.db
          .prepare(
            "INSERT INTO lead_prompt_deliveries(id,lead_id,logical_key,state,data,payload_bytes,metadata_bytes) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            imported.delivery.deliveryId,
            imported.delivery.sessionId,
            imported.key,
            imported.state,
            sizes.encoded,
            sizes.payloadBytes,
            sizes.metadataBytes,
          );
        this.updatePrompt(imported);
      } else if (
        prompt.receipt &&
        (!existing.receipt ||
          (nativeBound(prompt.receipt) && !nativeBound(existing.receipt)) ||
          (prompt.receipt.state === "settled" && existing.receipt.state !== "settled"))
      )
        this.updatePrompt({ ...existing, receipt: prompt.receipt });
    }
    const phaseRank = { approval: 0, closed: 1, completion: 2 };
    for (const notification of archive.notifications) {
      const phase = this.notificationPhase(notification.executionId);
      if (!phase || phaseRank[notification.phase] > phaseRank[phase])
        this.recordNotificationPhase(notification.executionId, notification.phase);
    }
    for (const clock of archive.clocks) {
      const existing = this.preparationClock(clock.executionId);
      if (existing && existing.hostTime !== clock.hostTime)
        conflict("preparation timestamp");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO command_preparation_clocks(execution_id,host_time,accepted_at,elapsed_ms) VALUES(?,?,?,?)",
        )
        .run(clock.executionId, clock.hostTime, clock.acceptedAt, clock.elapsedMs);
    }
  }

  assertRestoreAllowed(): void {
    if (this.unsettled().some((execution) => execution.ownership !== "not_started"))
      throw new CommandConflict(
        "command_restore_blocked",
        "Cancel and reconcile command ownership before replacing Host identity or catalog data.",
      );
  }

  prompt(id: string): PromptRecord | undefined {
    const row = this.db
      .prepare("SELECT data FROM lead_prompt_deliveries WHERE id=?")
      .get(id);
    return row ? this.parsePrompt(String(row.data)) : undefined;
  }

  prompts(leadId?: string): PromptRecord[] {
    return this.db
      .prepare(
        `SELECT data FROM lead_prompt_deliveries WHERE state NOT IN ('settled','rejected','orphaned')
       AND (? IS NULL OR lead_id=?) ORDER BY rowid`,
      )
      .all(leadId ?? null, leadId ?? null)
      .map((row) => this.parsePrompt(String(row.data)));
  }

  private parsePrompt(data: string): PromptRecord {
    const record = JSON.parse(data) as PromptRecord;
    if (/^\d+$/.test(record.retryAfter))
      return {
        ...record,
        retryAfter: record.receipt?.at ?? record.createdAt,
        retryAfterSeq: Number(record.retryAfter),
      };
    return record;
  }

  reserved(leadId: string): PromptRecord | undefined {
    return this.prompts(leadId).find((record) =>
      ["reserved", "accepted", "uncertain"].includes(record.state),
    );
  }

  enqueuePrompt(
    input: Omit<PromptRecord, "state" | "createdAt" | "retryAfter" | "delivery"> & {
      delivery: Omit<LeadPromptDelivery, "deliveryId">;
    },
  ): PromptRecord {
    return this.atomic(() => {
      const existing = this.db
        .prepare(
          "SELECT data FROM lead_prompt_deliveries WHERE lead_id=? AND logical_key=?",
        )
        .get(input.delivery.sessionId, input.key);
      if (existing) return this.parsePrompt(String(existing.data));
      const pending = this.prompts(input.delivery.sessionId);
      if (pending.length >= 100) throw new CommandConflict("lead_prompt_queue_full");
      const record: PromptRecord = CommandPromptRecordSchema.parse({
        ...input,
        delivery: { ...input.delivery, deliveryId: randomUUID() },
        state: "pending",
        createdAt: new Date().toISOString(),
        retryAfter: "",
      });
      const sizes = this.promptSizes(record);
      const payloadBytes = Number(
        this.db
          .prepare(
            "SELECT coalesce(sum(payload_bytes),0) AS bytes FROM lead_prompt_deliveries",
          )
          .get()!.bytes,
      );
      if (payloadBytes + sizes.payloadBytes > LEAD_PROMPT_PAYLOAD_BYTES)
        throw new CommandConflict("lead_prompt_payload_pressure");
      if (
        this.lifecycleBytes() +
          sizes.metadataBytes +
          this.unsettled().length * 32_768 +
          (this.prompts().length + 1) * PROMPT_RECEIPT_RESERVE_BYTES >
        COMMAND_LIMITS.lifecycleReserveBytes
      )
        throw new CommandConflict("lead_prompt_storage_pressure");
      this.db
        .prepare(
          "INSERT INTO lead_prompt_deliveries(id,lead_id,logical_key,state,data,payload_bytes,metadata_bytes) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          record.delivery.deliveryId,
          record.delivery.sessionId,
          record.key,
          record.state,
          sizes.encoded,
          sizes.payloadBytes,
          sizes.metadataBytes,
        );
      return record;
    });
  }

  updatePrompt(record: PromptRecord): void {
    if (["settled", "rejected", "orphaned"].includes(record.state)) {
      const { attachments: _attachments, ...delivery } = record.delivery;
      record = {
        ...record,
        delivery: {
          ...delivery,
          prompt: "[retired prompt; delivery identity retained]",
        },
      };
    }
    const sizes = this.promptSizes(record);
    this.db
      .prepare(
        "UPDATE lead_prompt_deliveries SET state=?,data=?,payload_bytes=?,metadata_bytes=? WHERE id=?",
      )
      .run(
        record.state,
        sizes.encoded,
        sizes.payloadBytes,
        sizes.metadataBytes,
        record.delivery.deliveryId,
      );
  }

  private promptSizes(record: PromptRecord) {
    const encoded = JSON.stringify(record);
    const bytes = Buffer.byteLength(encoded, "utf8");
    const payloadBytes = Buffer.byteLength(JSON.stringify(record.delivery), "utf8");
    const metadataBytes = bytes - payloadBytes;
    if (bytes > LEAD_PROMPT_SERIALIZED_BYTES)
      throw new CommandConflict("lead_prompt_too_large");
    if (metadataBytes > PROMPT_RECEIPT_RESERVE_BYTES)
      throw new CommandConflict("lead_prompt_metadata_limit");
    return { encoded, payloadBytes, metadataBytes };
  }

  quarantine(restored = false): void {
    this.atomic(() => {
      if (restored) {
        this.revokeSessionGrants();
        this.db.exec("UPDATE command_request_tombstones SET revoked=1");
        this.db
          .prepare("UPDATE command_execution_namespace SET namespace=? WHERE id=1")
          .run(randomUUID());
        for (const row of this.db.prepare("SELECT data FROM command_task_fences").all()) {
          const fence = JSON.parse(String(row.data)) as CommandFence;
          if (fence.state !== "clear")
            this.putFence({
              ...fence,
              revision: fence.revision + 1,
              state: "observation_required",
              changedAt: new Date().toISOString(),
            });
        }
      }
      for (const execution of this.unsettled()) {
        if (
          ["starting", "running", "cancelling", "reconciliation_required"].includes(
            execution.state,
          )
        ) {
          this.update(execution.id, execution.version, {
            state: "reconciliation_required",
            ownership: "unknown",
            reasonCode: restored ? "restore_reconciliation" : "host_restart",
            ...(restored ? { cancelRequested: true, delivery: "orphaned" as const } : {}),
          });
        } else if (restored) {
          this.update(execution.id, execution.version, {
            state: "expired",
            settledAt: new Date().toISOString(),
            ownership: "not_started",
            reasonCode: "restore_authority_revoked",
            delivery: "orphaned",
            finalOutputSeq: 0,
            outputComplete: true,
          });
        }
      }
      if (restored) {
        this.db.prepare("UPDATE command_attempt_tombstones SET cancelled=1").run();
        this.db
          .prepare(
            "UPDATE command_preparation_clocks SET accepted_at=NULL,elapsed_ms=NULL",
          )
          .run();
        for (const execution of this.list({ limit: 10_000 })) {
          if (execution.delivery !== "orphaned")
            this.update(execution.id, execution.version, { delivery: "orphaned" });
        }
      }
      for (const record of this.prompts()) {
        if (restored || ["reserved", "accepted"].includes(record.state))
          this.updatePrompt({ ...record, state: restored ? "orphaned" : "uncertain" });
      }
    });
  }

  sweep(now: number): void {
    this.atomic(() => {
      for (const execution of this.list({ limit: 10_000 })) {
        if (!terminalCommandExecutionStates.has(execution.state) || !execution.settledAt)
          continue;
        const age = now - Date.parse(execution.settledAt);
        if (
          age >= COMMAND_LIMITS.replayMs &&
          !execution.outputComplete &&
          execution.finalOutputSeq !== undefined
        ) {
          const rows = this.db
            .prepare(
              "SELECT sequence FROM command_execution_events WHERE execution_id=? ORDER BY sequence",
            )
            .all(execution.id);
          const gaps: CommandOutputGap[] = [];
          let next = 1;
          for (const row of rows) {
            const seq = Number(row.sequence);
            if (seq > next) gaps.push({ from: next, to: seq - 1 });
            next = seq + 1;
          }
          if (next <= execution.finalOutputSeq)
            gaps.push({ from: next, to: execution.finalOutputSeq });
          this.refreshOutput(
            this.update(execution.id, execution.version, {
              gaps: mergeCommandGaps([...execution.gaps, ...gaps]),
            }),
          );
        }
        if (
          age >= COMMAND_LIMITS.retentionMs &&
          ["settled", "orphaned", "none"].includes(execution.delivery)
        ) {
          const fence = execution.taskId ? this.fence(execution.taskId) : undefined;
          if (fence?.executionId === execution.id && fence.state !== "clear") continue;
          this.db
            .prepare("DELETE FROM command_execution_events WHERE execution_id=?")
            .run(execution.id);
          this.db
            .prepare(
              "UPDATE command_attempt_tombstones SET retired_at=? WHERE execution_id=?",
            )
            .run(new Date(now).toISOString(), execution.id);
          this.db.prepare("DELETE FROM command_executions WHERE id=?").run(execution.id);
        }
      }
    });
  }
}
