import type { DatabaseSync } from "node:sqlite";
import {
  activeWorkerResumeRequestStates,
  WorkerResumeRequestSchema,
  type WorkerResumeRequest,
} from "@fleet/protocol";

/** A refused "Resume now" operation, with the record as it now stands when there is one. */
export class WorkerResumeConflict extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code: string,
    message: string,
    readonly request?: WorkerResumeRequest,
  ) {
    super(message);
  }
}

const ACTIVE_STATES = [...activeWorkerResumeRequestStates];
/** Settled requests stay readable for a while; the audit log and task notes keep the rest. */
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Durable "Resume now" requests.
 *
 * One active request per step: the partial unique index makes a second active
 * row impossible, so two clicks, a tool retry or two browsers racing cannot
 * create two approvals for the same queued work. Every write moves `version`,
 * which is what a decision has to name.
 */
export class WorkerResumeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(work: () => T) => T,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_resume_requests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
        step_attempt INTEGER NOT NULL, session_id TEXT NOT NULL,
        requester_kind TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS worker_resume_request_active
        ON worker_resume_requests(step_id)
        WHERE state IN ('awaiting_approval','approved','launching');
      CREATE INDEX IF NOT EXISTS worker_resume_request_run
        ON worker_resume_requests(run_id,created_at);
    `);
  }

  get(id: string): WorkerResumeRequest | undefined {
    const row = this.db
      .prepare("SELECT data FROM worker_resume_requests WHERE id=?")
      .get(id);
    return row ? parse(row.data) : undefined;
  }

  /** The step's one request still waiting, approved or launching. */
  active(stepId: string): WorkerResumeRequest | undefined {
    const row = this.db
      .prepare(
        `SELECT data FROM worker_resume_requests
         WHERE step_id=? AND state IN (${ACTIVE_STATES.map(() => "?").join(",")})`,
      )
      .get(stepId, ...ACTIVE_STATES);
    return row ? parse(row.data) : undefined;
  }

  listActive(): WorkerResumeRequest[] {
    return this.db
      .prepare(
        `SELECT data FROM worker_resume_requests
         WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")})
         ORDER BY created_at,id`,
      )
      .all(...ACTIVE_STATES)
      .map((row) => parse(row.data));
  }

  /** Newest first: what the task and session views show beside the step. */
  list(input: { runId?: string; limit?: number } = {}): WorkerResumeRequest[] {
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200);
    const rows = input.runId
      ? this.db
          .prepare(
            "SELECT data FROM worker_resume_requests WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
          )
          .all(input.runId, limit)
      : this.db
          .prepare(
            "SELECT data FROM worker_resume_requests ORDER BY created_at DESC,id DESC LIMIT ?",
          )
          .all(limit);
    return rows.map((row) => parse(row.data));
  }

  /** The most recent request an orchestrator made for this exact attempt. */
  latestFromOrchestrator(
    stepId: string,
    attempt: number,
  ): WorkerResumeRequest | undefined {
    const row = this.db
      .prepare(
        `SELECT data FROM worker_resume_requests
         WHERE step_id=? AND step_attempt=? AND requester_kind='orchestrator'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
      )
      .get(stepId, attempt);
    return row ? parse(row.data) : undefined;
  }

  insert(request: WorkerResumeRequest): WorkerResumeRequest {
    const parsed = WorkerResumeRequestSchema.parse(request);
    try {
      this.db
        .prepare(
          `INSERT INTO worker_resume_requests
           (id,run_id,step_id,step_attempt,session_id,requester_kind,state,version,data,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          parsed.id,
          parsed.runId,
          parsed.stepId,
          parsed.stepAttempt,
          parsed.sessionId,
          parsed.requestedBy.kind,
          parsed.state,
          parsed.version,
          JSON.stringify(parsed),
          parsed.requestedAt,
          parsed.updatedAt,
        );
    } catch (error) {
      const existing = this.active(parsed.stepId);
      if (existing)
        throw new WorkerResumeConflict(
          "request_exists",
          "A resume request for this queued follow-up is already open.",
          existing,
        );
      throw error;
    }
    return parsed;
  }

  /**
   * Moves a request forward only from the version the caller read.
   *
   * A stale version is a conflict, never a merge: the caller decided against
   * facts that have since changed.
   */
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<WorkerResumeRequest, "id" | "version">>,
  ): WorkerResumeRequest {
    return this.atomic(() => {
      const current = this.get(id);
      if (!current || current.version !== expectedVersion)
        throw new WorkerResumeConflict(
          "approval_conflict",
          "This resume request changed after it was read.",
          current,
        );
      const next = WorkerResumeRequestSchema.parse({
        ...current,
        ...patch,
        id,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      });
      const result = this.db
        .prepare(
          `UPDATE worker_resume_requests SET state=?,version=?,data=?,updated_at=?
           WHERE id=? AND version=?`,
        )
        .run(
          next.state,
          next.version,
          JSON.stringify(next),
          next.updatedAt,
          id,
          expectedVersion,
        );
      if (Number(result.changes) !== 1)
        throw new WorkerResumeConflict(
          "approval_conflict",
          "This resume request changed while it was being updated.",
          this.get(id),
        );
      return next;
    });
  }

  /** Drops settled history past its retention; active requests are never pruned. */
  prune(nowMs = Date.now()): number {
    const cutoff = new Date(nowMs - SETTLED_RETENTION_MS).toISOString();
    const result = this.db
      .prepare(
        `DELETE FROM worker_resume_requests
         WHERE updated_at<? AND state NOT IN (${ACTIVE_STATES.map(() => "?").join(",")})`,
      )
      .run(cutoff, ...ACTIVE_STATES);
    return Number(result.changes);
  }

  /** Restored runs never inherit an approval: it belonged to the fleet that granted it. */
  clear(): void {
    this.db.exec("DELETE FROM worker_resume_requests");
  }
}

function parse(data: unknown): WorkerResumeRequest {
  return WorkerResumeRequestSchema.parse(JSON.parse(String(data)));
}
