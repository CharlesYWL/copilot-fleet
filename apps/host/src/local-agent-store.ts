import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  LOCAL_AGENT_LIMITS,
  type LocalAgentRequest,
  type LocalAgentRequestKind,
  type LocalAgentRequestState,
  type Run,
  terminalRunStates,
} from "@fleet/protocol";
import type { PromptRecord } from "./command-execution-store.js";

/** A refusal with the HTTP status and stable code the local agent API answers with. */
export class LocalAgentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalAgentError";
  }
}

/** What the ledger row itself knows; the rest is read from the delivery record. */
type Phase = "waiting_for_brief" | "queued" | "abandoned";

export type LocalAgentLedgerEntry = {
  operationId: string;
  kind: LocalAgentRequestKind;
  leadSessionId: string;
  taskId: string;
  workspaceId: string;
  payloadDigest: string;
  phase: Phase;
  deliveryId?: string | undefined;
  /** sha256 of the brief as created, and its length: it stays a prefix of what is owed. */
  briefDigest?: string | undefined;
  briefLength?: number | undefined;
  clientLabel?: string | undefined;
  dispatchEverReserved: boolean;
  version: number;
  disposition?: LocalAgentRequest["disposition"];
  createdAt: string;
  updatedAt: string;
};

/** States that still hold the task open: a transfer, or another request, must wait. */
const UNRESOLVED = new Set<LocalAgentRequestState>([
  "waiting_for_brief",
  "pending",
  "rejected_busy",
  "reserved",
  "accepted",
  "uncertain",
  "orphaned",
]);

export function isUnresolvedLocalRequest(state: LocalAgentRequestState): boolean {
  return UNRESOLVED.has(state);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Key order does not change a payload's meaning, so it must not change its digest. */
export function canonicalDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The receipts for work a local agent handed in.
 *
 * Host-local by design: a backup does not carry it and a restore leaves it as
 * it was, because a receipt names delivery records and runs on this Host, and
 * replaying one somewhere else would re-send a person's words to an agent they
 * never meant them for. A row's live state is not stored here; it is projected
 * from the lead's durable delivery record, so there is one authority for
 * "was this handed to the agent", not two that can disagree.
 */
export class LocalAgentStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(work: () => T) => T,
    private readonly lookups: {
      prompt(deliveryId: string): PromptRecord | undefined;
      prompts(leadId: string): PromptRecord[];
      run(runId: string): Run | undefined;
    },
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_agent_requests (
        operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        lead_session_id TEXT NOT NULL, task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
        phase TEXT NOT NULL, delivery_id TEXT, brief_digest TEXT, brief_length INTEGER,
        client_label TEXT, dispatch_ever_reserved INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL, disposition TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_agent_requests_task
        ON local_agent_requests(task_id, phase);
      CREATE INDEX IF NOT EXISTS local_agent_requests_lead
        ON local_agent_requests(lead_session_id, phase);
      CREATE INDEX IF NOT EXISTS local_agent_requests_delivery
        ON local_agent_requests(delivery_id);
      CREATE INDEX IF NOT EXISTS local_agent_requests_created
        ON local_agent_requests(created_at, operation_id);
    `);
  }

  get(operationId: string): LocalAgentLedgerEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM local_agent_requests WHERE operation_id=?")
      .get(operationId);
    return row ? entry(row) : undefined;
  }

  byDelivery(deliveryId: string): LocalAgentLedgerEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM local_agent_requests WHERE delivery_id=?")
      .get(deliveryId);
    return row ? entry(row) : undefined;
  }

  count(): number {
    return Number(
      this.db.prepare("SELECT count(*) AS n FROM local_agent_requests").get()!.n,
    );
  }

  /**
   * Records a request. Must run in the same commit as the work it receipts —
   * the task it created or the delivery it queued — so neither can exist
   * without the other.
   */
  insert(
    input: Omit<
      LocalAgentLedgerEntry,
      "version" | "dispatchEverReserved" | "createdAt" | "updatedAt" | "disposition"
    >,
  ): LocalAgentLedgerEntry {
    return this.atomic(() => {
      if (this.count() >= LOCAL_AGENT_LIMITS.ledgerMax) {
        throw new LocalAgentError(
          507,
          "receipt_storage_full",
          "The Host's local request ledger is full. An administrator must clear it before more requests are accepted.",
        );
      }
      const at = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO local_agent_requests (operation_id,kind,lead_session_id,task_id,
             workspace_id,payload_digest,phase,delivery_id,brief_digest,brief_length,
             client_label,dispatch_ever_reserved,version,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1,?,?)`,
        )
        .run(
          input.operationId,
          input.kind,
          input.leadSessionId,
          input.taskId,
          input.workspaceId,
          input.payloadDigest,
          input.phase,
          input.deliveryId ?? null,
          input.briefDigest ?? null,
          input.briefLength ?? null,
          input.clientLabel ?? null,
          at,
          at,
        );
      return this.get(input.operationId)!;
    });
  }

  /**
   * Ties each brief still owed for a task to the delivery that now carries it.
   * Called inside the commit that clears the run's owed prompt and queues it;
   * `delivered` is the text queued, which a brief must still head.
   */
  linkWaitingBriefs(runId: string, deliveryId: string, delivered: string): void {
    const at = new Date().toISOString();
    for (const row of this.waiting(runId)) {
      if (!briefOwedBy(row, delivered)) continue;
      this.db
        .prepare(
          `UPDATE local_agent_requests SET phase='queued', delivery_id=?, updated_at=?
           WHERE operation_id=? AND phase='waiting_for_brief'`,
        )
        .run(deliveryId, at, row.operationId);
    }
  }

  /** Whether a task still owes a brief a local agent is waiting on a receipt for. */
  waitingBriefOwed(runId: string): boolean {
    const owed = this.lookups.run(runId)?.pendingPrompt ?? "";
    return this.waiting(runId).some((row) => briefOwedBy(row, owed));
  }

  /** Briefs this Host has already delivered or abandoned; a restore must not resend them. */
  retiredBriefs(): LocalAgentLedgerEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM local_agent_requests WHERE kind='create_task'
           AND phase<>'waiting_for_brief' AND brief_digest IS NOT NULL`,
      )
      .all()
      .map(entry);
  }

  private waiting(runId: string): LocalAgentLedgerEntry[] {
    return this.db
      .prepare(
        "SELECT * FROM local_agent_requests WHERE task_id=? AND phase='waiting_for_brief'",
      )
      .all(runId)
      .map(entry);
  }

  /** Remembers, for good, that a delivery was handed to the agent. */
  markReserved(deliveryId: string): void {
    this.db
      .prepare(
        "UPDATE local_agent_requests SET dispatch_ever_reserved=1 WHERE delivery_id=?",
      )
      .run(deliveryId);
  }

  /**
   * Whether a lead's queue may hand this record to its agent now. Only local
   * requests are ever held — anything an administrator abandoned, guidance a
   * task can no longer take, and a message about a task whose own brief or
   * owed prompt has not gone out yet — and nothing else the queue carries is
   * ours to gate.
   */
  admits(record: PromptRecord): boolean {
    const row = this.byDelivery(record.delivery.deliveryId);
    if (!row) return true;
    if (row.phase === "abandoned") return false;
    if (row.kind === "create_task") return true;
    const run = this.lookups.run(row.taskId);
    return guidanceHold(row, run) === undefined && this.owedHold(row) === undefined;
  }

  /**
   * Why a message must wait for what the task already owes its lead.
   *
   * The queue hands out the oldest admissible record, and a brief is only
   * queued once the lead is idle — so a question sent while the lead was busy
   * would otherwise reach it before the brief that tells it the task exists.
   */
  owedHold(
    row: Pick<LocalAgentLedgerEntry, "kind" | "taskId" | "leadSessionId">,
  ): string | undefined {
    if (row.kind === "create_task") return undefined;
    const run = this.lookups.run(row.taskId);
    if (!run || run.leadSessionId !== row.leadSessionId) return undefined;
    const prefix = `run-prompt:${run.id}:`;
    const queued = this.lookups
      .prompts(row.leadSessionId)
      .some(
        (entry) =>
          entry.key.startsWith(prefix) &&
          (entry.state === "pending" || entry.state === "rejected_busy"),
      );
    return run.pendingPrompt || queued
      ? "Waiting for the task's own brief or update to reach the orchestrator first."
      : undefined;
  }

  /** Requests on a task or lead that have not been abandoned. */
  open(filter: { taskId?: string; leadSessionId?: string }): LocalAgentLedgerEntry[] {
    const rows = filter.taskId
      ? this.db
          .prepare(
            "SELECT * FROM local_agent_requests WHERE task_id=? AND phase<>'abandoned'",
          )
          .all(filter.taskId)
      : this.db
          .prepare(
            "SELECT * FROM local_agent_requests WHERE lead_session_id=? AND phase<>'abandoned'",
          )
          .all(filter.leadSessionId ?? "");
    return rows.map(entry);
  }

  /** Newest first, `limit` at a time, from before `(createdAt, operationId)`. */
  list(
    options: {
      limit?: number;
      before?: { createdAt: string; operationId: string } | undefined;
      taskId?: string | undefined;
    } = {},
  ): LocalAgentLedgerEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const before = options.before;
    return this.db
      .prepare(
        `SELECT * FROM local_agent_requests
         WHERE (? IS NULL OR task_id=?)
           AND (? IS NULL OR created_at<? OR (created_at=? AND operation_id<?))
         ORDER BY created_at DESC, operation_id DESC LIMIT ?`,
      )
      .all(
        options.taskId ?? null,
        options.taskId ?? null,
        before?.createdAt ?? null,
        before?.createdAt ?? null,
        before?.createdAt ?? null,
        before?.operationId ?? null,
        limit,
      )
      .map(entry);
  }

  /** Gives up on a request, if it is still the version the caller looked at. */
  abandon(
    operationId: string,
    expectedVersion: number,
    disposition: NonNullable<LocalAgentRequest["disposition"]>,
  ): LocalAgentLedgerEntry {
    return this.atomic(() => {
      const result = this.db
        .prepare(
          `UPDATE local_agent_requests SET phase='abandoned', disposition=?,
             version=version+1, updated_at=?
           WHERE operation_id=? AND version=? AND phase<>'abandoned'`,
        )
        .run(JSON.stringify(disposition), disposition.at, operationId, expectedVersion);
      if (Number(result.changes) !== 1) {
        throw new LocalAgentError(
          409,
          "stale_request",
          "The request changed since it was read. Reload it and try again.",
        );
      }
      return this.get(operationId)!;
    });
  }

  /**
   * Where a request stands now. Read rather than stored, from the delivery
   * record for anything queued and from the run for a brief still owed.
   */
  project(row: LocalAgentLedgerEntry): LocalAgentRequest {
    const base = {
      operationId: row.operationId,
      kind: row.kind,
      leadSessionId: row.leadSessionId,
      taskId: row.taskId,
      ...(row.clientLabel ? { clientLabel: row.clientLabel } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
      dispatchEverReserved: row.dispatchEverReserved,
    };
    if (row.phase === "abandoned") {
      return {
        ...base,
        state: "abandoned",
        ...(row.disposition ? { disposition: row.disposition } : {}),
      };
    }
    if (row.phase === "waiting_for_brief") {
      if (this.briefStillOwed(row)) {
        return {
          ...base,
          state: "waiting_for_brief",
          ...(row.briefDigest ? { briefDigest: row.briefDigest } : {}),
        };
      }
      return {
        ...base,
        state: "orphaned",
        detail: "The brief was retired without a recorded delivery.",
      };
    }
    const record = row.deliveryId ? this.lookups.prompt(row.deliveryId) : undefined;
    if (!record) {
      return {
        ...base,
        state: "orphaned",
        detail: "This Host has no delivery record for the request.",
      };
    }
    const detail =
      record.receipt?.detail ??
      (record.state === "pending"
        ? (guidanceHold(row, this.lookups.run(row.taskId)) ?? this.owedHold(row))
        : undefined);
    return {
      ...base,
      state: record.state,
      dispatchEverReserved:
        row.dispatchEverReserved ||
        record.receipt !== undefined ||
        !["pending", "orphaned"].includes(record.state),
      ...(detail ? { detail } : {}),
    };
  }

  /** The brief as created is still the head of what the run owes its lead. */
  briefStillOwed(row: LocalAgentLedgerEntry): boolean {
    return briefOwedBy(row, this.lookups.run(row.taskId)?.pendingPrompt ?? "");
  }

  /** Every request on a task that still holds it, projected. */
  unresolvedForTask(taskId: string): LocalAgentRequest[] {
    return this.open({ taskId })
      .map((row) => this.project(row))
      .filter((request) => isUnresolvedLocalRequest(request.state));
  }

  unresolvedForLead(leadSessionId: string): LocalAgentRequest[] {
    return this.open({ leadSessionId })
      .map((row) => this.project(row))
      .filter((request) => isUnresolvedLocalRequest(request.state));
  }
}

/**
 * Why guidance cannot reach the orchestrator yet, if it cannot.
 *
 * Checked again just before each delivery, not only at acceptance: a task can
 * close or stop for a person's review while guidance waits its turn, and
 * guidance must not talk the orchestrator past either. Questions are never held.
 */
export function guidanceHold(
  row: Pick<LocalAgentLedgerEntry, "kind" | "leadSessionId">,
  run: Run | undefined,
): string | undefined {
  if (row.kind !== "guidance") return undefined;
  if (!run) return "The task no longer exists.";
  if (run.leadSessionId !== row.leadSessionId)
    return "The task now belongs to another orchestrator.";
  if (terminalRunStates.has(run.state))
    return "The task is closed. Guidance is held; a person must reopen the task.";
  if (run.state === "awaiting_human" || run.state === "awaiting_approval")
    return "The task is waiting for a person's review. Guidance is held until they act.";
  return undefined;
}

/**
 * Whether `owed` begins with the brief this request created.
 *
 * A prefix, not equality: reopening, sending back and maintenance direction
 * append to what a run owes (`owedPrompt`), so the brief stays at the head
 * until the whole thing is delivered or an administrator retires it.
 */
export function briefOwedBy(row: LocalAgentLedgerEntry, owed: string): boolean {
  if (row.briefDigest === undefined || row.briefLength === undefined) return false;
  return (
    owed.length >= row.briefLength &&
    sha256(owed.slice(0, row.briefLength)) === row.briefDigest
  );
}

/** `owed` with the leading brief, and the separator `owedPrompt` put after it, removed. */
export function withoutBrief(owed: string, briefLength: number): string {
  const rest = owed.slice(briefLength);
  return rest.startsWith("\n\n") ? rest.slice(2) : rest;
}

function entry(row: Record<string, unknown>): LocalAgentLedgerEntry {
  const optional = (value: unknown) =>
    value === null || value === undefined ? undefined : String(value);
  return {
    operationId: String(row.operation_id),
    kind: String(row.kind) as LocalAgentRequestKind,
    leadSessionId: String(row.lead_session_id),
    taskId: String(row.task_id),
    workspaceId: String(row.workspace_id),
    payloadDigest: String(row.payload_digest),
    phase: String(row.phase) as Phase,
    deliveryId: optional(row.delivery_id),
    briefDigest: optional(row.brief_digest),
    briefLength:
      row.brief_length === null || row.brief_length === undefined
        ? undefined
        : Number(row.brief_length),
    clientLabel: optional(row.client_label),
    dispatchEverReserved: Number(row.dispatch_ever_reserved) === 1,
    version: Number(row.version),
    disposition: row.disposition
      ? (JSON.parse(String(row.disposition)) as LocalAgentRequest["disposition"])
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
