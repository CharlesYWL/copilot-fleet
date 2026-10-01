import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
  PR_MAINTENANCE_RECOVERY_LIMITS,
  PR_MAINTENANCE_WAKE_LIMITS,
  COMMAND_LIMITS,
  CommandReceiptSchema,
  commandDigestPayload,
  nextHeartbeat,
  prMaintenanceObservationFresh,
  prMaintenanceProviderKey,
  isWritingCategory,
  terminalRunStepStates,
  PrMaintenanceAdmissionSchema,
  PrMaintenanceBackupSchema,
  PrMaintenanceCheckpointSchema,
  PrMaintenanceDecisionInputSchema,
  PrMaintenanceEnableSchema,
  PrMaintenanceManualCommandSchema,
  PrMaintenanceManualOwnerSchema,
  PrMaintenanceOperatorActionSchema,
  PrMaintenanceObservationSchema,
  PrMaintenanceHelperSnapshotIdentitySchema,
  PrMaintenanceProposalSchema,
  PrMaintenanceRegistrationSchema,
  PrMaintenanceScanSchema,
  PrMaintenanceWakeSchema,
  type PrMaintenanceAdmission,
  type PrMaintenanceApproval,
  type PrMaintenanceBackup,
  type PrMaintenanceBatch,
  type PrMaintenanceCheckpoint,
  type PrMaintenanceEffect,
  type PrMaintenanceIdentity,
  type PrMaintenanceIncident,
  type PrMaintenanceManualCommand,
  type PrMaintenanceManualOwner,
  type PrMaintenanceObservation,
  type PrMaintenanceOperatorAction,
  type PrMaintenanceProposal,
  type PrMaintenanceRegistration,
  type CommandExecution,
} from "@fleet/protocol";
import type { FleetStore } from "./store.js";
import { notificationAttemptKey } from "./notifications/service.js";

const outstanding = new Set(["prepared", "accepted", "reconciling", "uncertain"]);
const undispatchedBatch = (batch: PrMaintenanceBatch) =>
  batch.state === "prepared" && !batch.stepId && batch.effects.length === 0;
const unsettledEffect = (effect: PrMaintenanceEffect) =>
  effect.state === "reserved" || effect.state === "uncertain";
const neverSentEffect = (effect: PrMaintenanceEffect) =>
  effect.state === "not_performed" && effect.usedAttempts === 0;
const nowIso = () => new Date().toISOString();
/** Only if the heartbeat schedule has no future time at all. */
const ROUTINE_CHECK_FALLBACK_MS = 60 * 60_000;
const emptyCounters = () => ({
  repairBatches: 0,
  answerBatches: 0,
  mutationAttempts: 0,
  consecutiveFailures: 0,
  totalFailures: 0,
  scanStalls: 0,
  reconciliationStalls: 0,
});
const actorSchema = z.string().trim().min(1).max(512);
const wakeIdSchema = z.string().min(1).max(512);
const atSchema = z.string().datetime();
const sameIdentity = (left: PrMaintenanceIdentity, right: PrMaintenanceIdentity) =>
  isDeepStrictEqual(
    { ...left, provider: left.provider ?? "github" },
    { ...right, provider: right.provider ?? "github" },
  );
const helperError = (observation: PrMaintenanceObservation) => {
  const state = observation.helperState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  const error = state.error;
  return error && typeof error === "object" && !Array.isArray(error) ? error : undefined;
};
const observationError = (observation: PrMaintenanceObservation) => {
  const message = helperError(observation)?.message;
  return typeof message === "string" && message ? message : observation.evidence;
};
const listSchema = z
  .object({
    leadSessionId: actorSchema.optional(),
    taskId: actorSchema.optional(),
    retainedOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: actorSchema.optional(),
  })
  .strict();
export type PrMaintenanceListInput = z.input<typeof listSchema>;
export type PrMaintenanceAdmissionResult = {
  allowed: boolean;
  reason?: string;
  recordId?: string;
  decisionId?: string;
};
export type PrMaintenanceOperationalReview = {
  recordId: string;
  leadSessionId: string;
  expectedVersion: number;
};
export type SupervisorCommand = {
  id: string;
  digest: string;
  kind: "prompt" | "resume_session";
  operatorId: string;
};

export class PrMaintenanceError extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function refuse(code: string, message: string): never {
  throw new PrMaintenanceError(code, message);
}
export function prMaintenanceUnsettled(record: PrMaintenanceRegistration): boolean {
  return (
    record.batches.some((batch) => batch.state === "prepared") ||
    prMaintenanceInFlight(record)
  );
}

function prMaintenanceInFlight(record: PrMaintenanceRegistration): boolean {
  return (
    Boolean(
      record.manualControl?.commands.some((command) =>
        ["unknown", "accepted"].includes(command.state),
      ),
    ) ||
    record.incidents.some(
      (incident) => incident.kind === "effects" && !incident.resolvedAt,
    ) ||
    record.batches.some(
      (batch) =>
        (outstanding.has(batch.state) && !undispatchedBatch(batch)) ||
        (batch.stepId && !batch.executionSettled) ||
        batch.effects.some(unsettledEffect),
    ) ||
    record.actions.some(unsettledEffect)
  );
}

/** Facts and admission on the Host's existing SQLite connection, never a scheduler. */
export class PrMaintenanceStore {
  private directionTaskId: string | undefined;
  constructor(
    private readonly store: FleetStore,
    private readonly db: DatabaseSync,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pr_maintenance_schema (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO pr_maintenance_schema VALUES (1,1);
      CREATE TABLE IF NOT EXISTS pr_maintenance (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, generation INTEGER NOT NULL,
        host TEXT NOT NULL, repository_id TEXT NOT NULL, pr_number INTEGER NOT NULL,
        head_repository_id TEXT NOT NULL, head_ref TEXT NOT NULL COLLATE BINARY,
        lead_session_id TEXT NOT NULL, task_id TEXT NOT NULL, worker_session_id TEXT NOT NULL,
        placement_id TEXT NOT NULL, checkout_key TEXT NOT NULL, released_at TEXT,
        next_check_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pr_maintenance_pr_owner
        ON pr_maintenance(host,repository_id,pr_number) WHERE released_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS pr_maintenance_ref_owner
        ON pr_maintenance(host,head_repository_id,head_ref) WHERE released_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS pr_maintenance_worker_owner
        ON pr_maintenance(worker_session_id) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS pr_maintenance_lead_due
        ON pr_maintenance(lead_session_id,next_check_at,id);
      CREATE INDEX IF NOT EXISTS pr_maintenance_task ON pr_maintenance(task_id);
      CREATE TABLE IF NOT EXISTS pr_maintenance_wakes (
        lead_session_id TEXT NOT NULL, wake_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(lead_session_id,wake_id)
      );
      CREATE TABLE IF NOT EXISTS pr_maintenance_scans (
        lead_session_id TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pr_maintenance_proposals (
        task_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pr_maintenance_manual_commands (
        session_id TEXT NOT NULL, command_id TEXT NOT NULL,
        state TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(session_id,command_id)
      );
      CREATE INDEX IF NOT EXISTS pr_maintenance_manual_pending
        ON pr_maintenance_manual_commands(session_id,state);
      CREATE TABLE IF NOT EXISTS pr_maintenance_manual_conflicts (
        session_id TEXT NOT NULL, command_id TEXT NOT NULL, claim_hash TEXT NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(session_id,command_id,claim_hash)
      );
      CREATE TABLE IF NOT EXISTS pr_maintenance_manual_owners (
        session_id TEXT NOT NULL, task_id TEXT NOT NULL, placement_id TEXT NOT NULL,
        node_id TEXT NOT NULL, workspace_id TEXT NOT NULL, checkout_key TEXT NOT NULL,
        PRIMARY KEY(session_id,task_id,placement_id,node_id,workspace_id,checkout_key)
      );
      CREATE INDEX IF NOT EXISTS pr_maintenance_manual_task
        ON pr_maintenance_manual_owners(task_id,session_id);
      CREATE INDEX IF NOT EXISTS pr_maintenance_manual_placement
        ON pr_maintenance_manual_owners(placement_id,session_id);
      CREATE INDEX IF NOT EXISTS pr_maintenance_manual_node
        ON pr_maintenance_manual_owners(node_id,session_id);
      CREATE INDEX IF NOT EXISTS pr_maintenance_manual_workspace
        ON pr_maintenance_manual_owners(workspace_id,session_id);
    `);
    const version = Number(
      db.prepare("SELECT version FROM pr_maintenance_schema").get()?.version,
    );
    if (![1, 2, 3].includes(version))
      refuse(
        "schema_version",
        "This Host does not support the maintenance registry schema.",
      );
    if (version < 3)
      this.store.writeAtomically(() => {
        const records = db
          .prepare("SELECT data FROM pr_maintenance ORDER BY rowid")
          .all()
          .map((row) =>
            PrMaintenanceRegistrationSchema.parse(JSON.parse(String(row.data))),
          );
        for (const row of db
          .prepare("SELECT session_id,data FROM pr_maintenance_manual_commands")
          .all())
          this.importManualCommand(String(row.session_id), JSON.parse(String(row.data)));
        for (const record of records) {
          this.rememberManualOwner(record.workerSessionId, record);
          for (const command of record.manualControl?.commands ?? [])
            this.importManualCommand(record.workerSessionId, command);
        }
        for (const row of db
          .prepare("SELECT DISTINCT session_id FROM pr_maintenance_manual_commands")
          .all())
          this.rememberManualOwner(String(row.session_id));
        for (const record of records) {
          this.archiveManualCommands(record);
          db.prepare("UPDATE pr_maintenance SET data=? WHERE id=?").run(
            JSON.stringify(record),
            record.id,
          );
        }
        db.exec("UPDATE pr_maintenance_schema SET version=3");
      });
  }

  get(id: string, leadSessionId?: string): PrMaintenanceRegistration | undefined {
    const row = this.db.prepare("SELECT data FROM pr_maintenance WHERE id=?").get(id);
    if (!row) return undefined;
    const record = PrMaintenanceRegistrationSchema.parse(JSON.parse(String(row.data)));
    if (leadSessionId !== undefined && record.leadSessionId !== leadSessionId)
      refuse("ownership", "Maintenance registration belongs to another lead.");
    return record;
  }

  list(input: PrMaintenanceListInput = {}): {
    records: PrMaintenanceRegistration[];
    nextCursor?: string;
  } {
    const parsed = listSchema.parse(input);
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    if (parsed.leadSessionId) {
      where.push("lead_session_id=?");
      values.push(parsed.leadSessionId);
    }
    if (parsed.taskId) {
      where.push("task_id=?");
      values.push(parsed.taskId);
    }
    if (parsed.retainedOnly) where.push("released_at IS NULL");
    if (parsed.cursor) {
      where.push("id>?");
      values.push(parsed.cursor);
    }
    const rows = this.db
      .prepare(
        `SELECT data FROM pr_maintenance
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`,
      )
      .all(...values, parsed.limit + 1);
    const records = rows
      .slice(0, parsed.limit)
      .map((row) => PrMaintenanceRegistrationSchema.parse(JSON.parse(String(row.data))));
    return {
      records,
      ...(rows.length > parsed.limit ? { nextCursor: records.at(-1)!.id } : {}),
    };
  }

  private retained(): PrMaintenanceRegistration[] {
    return this.db
      .prepare("SELECT data FROM pr_maintenance WHERE released_at IS NULL")
      .all()
      .map((row) => PrMaintenanceRegistrationSchema.parse(JSON.parse(String(row.data))));
  }

  getProposal(taskId: string, leadSessionId?: string): PrMaintenanceProposal | undefined {
    const row = this.db
      .prepare("SELECT data FROM pr_maintenance_proposals WHERE task_id=?")
      .get(taskId);
    if (!row) return undefined;
    const proposal = PrMaintenanceProposalSchema.parse(JSON.parse(String(row.data)));
    if (leadSessionId !== undefined && proposal.leadSessionId !== leadSessionId)
      refuse("ownership", "Maintenance proposal belongs to another lead.");
    return proposal;
  }

  listApprovals(): PrMaintenanceApproval[] {
    return this.db
      .prepare(
        `SELECT p.data FROM pr_maintenance_proposals p
         JOIN runs r ON r.id=p.task_id
         WHERE json_extract(p.data,'$.registration.scope.publicationAuthorized')=1
         ORDER BY r.created_at,p.task_id`,
      )
      .all()
      .map((row) => PrMaintenanceProposalSchema.parse(JSON.parse(String(row.data))))
      .map((proposal) => {
        return {
          proposalId: proposal.id,
          version: proposal.version,
          taskId: proposal.registration.taskId,
          leadSessionId: proposal.leadSessionId,
          identity: proposal.registration.identity,
          mode: "repair" as const,
          createdAt: proposal.createdAt,
        };
      });
  }

  private consumeProposal(taskId: string, approved = false): void {
    const proposal = this.getProposal(taskId);
    if (!proposal) return;
    this.store.appendRunNote(
      taskId,
      this.store.getRun(taskId)!.phaseIndex,
      JSON.stringify(proposal),
      {
        summary: approved
          ? "Approved PR maintenance proposal; prerequisite evidence retained"
          : proposal.registration.scope.publicationAuthorized
            ? "Superseded repair proposal; not repair authorization"
            : "Superseded legacy observation-only proposal; not repair authorization",
        kind: "decision",
        source: approved ? "operator" : "orchestrator",
        sessionId: proposal.leadSessionId,
      },
    );
    this.db.prepare("DELETE FROM pr_maintenance_proposals WHERE task_id=?").run(taskId);
  }

  private archiveAuthorization(record: PrMaintenanceRegistration) {
    if (
      record.authorization.eligibilityEvidence !== undefined &&
      record.authorization.eligibilityEvidence !== record.eligibilityEvidence
    )
      refuse(
        "eligibility_evidence_conflict",
        "Record and grant prerequisite evidence disagree; reconcile them without discarding either before changing authorization.",
      );
    const previous = {
      ...record.authorization,
      // Old observation/initial grants used the record field. Do not assign lost
      // prerequisites to an already-reauthorized historical repair grant.
      eligibilityEvidence:
        record.authorization.eligibilityEvidence ??
        (!record.authorization.scope.publicationAuthorized ||
        record.authorizationHistory.length === 0
          ? record.eligibilityEvidence
          : undefined),
    };
    record.authorizationHistory.push(previous);
    return previous;
  }

  propose(
    leadSessionId: string,
    input: z.input<typeof PrMaintenanceEnableSchema>,
    expectedVersion?: number,
  ): PrMaintenanceProposal {
    const registration = PrMaintenanceEnableSchema.parse(input);
    return this.store.writeAtomically(() => {
      const { task, worker, lead } = this.ownedWorker(
        registration.taskId,
        registration.workerSessionId,
      );
      if (lead.id !== leadSessionId)
        refuse("ownership", "Only the task's owning lead can propose maintenance.");
      const retained = this.retained().find((record) => record.taskId === task.id);
      if (retained?.authorization.scope.publicationAuthorized)
        refuse(
          "already_registered",
          "This task already retains maintenance; use its existing registration.",
        );
      if (retained) this.assertReauthorization(retained, registration);
      const binding = {
        placementId: worker.placementId,
        checkoutKey:
          worker.executionBinding?.checkoutKey ?? `placement:${worker.placementId}`,
        bindingGeneration: worker.executionBinding?.generation ?? 0,
      };
      const bindingReason = this.binding({
        taskId: task.id,
        workerSessionId: worker.id,
        leadSessionId,
        ...binding,
      });
      if (bindingReason)
        refuse(bindingReason, "This worker binding cannot be proposed for maintenance.");
      if (
        !["running", "awaiting_lead", "completed"].includes(task.state) ||
        worker.stopRequested ||
        !(
          worker.state === "idle" ||
          (["completed", "stopped"].includes(worker.state) && worker.agentSessionId)
        ) ||
        this.store
          .listRunSteps(task.id)
          .some(
            (step) =>
              step.sessionId === worker.id &&
              !["succeeded", "failed", "cancelled", "skipped"].includes(step.state),
          )
      )
        refuse(
          "proposal_not_ready",
          "Settle existing work and task approvals before proposing maintenance.",
        );
      const previous = this.getProposal(task.id, leadSessionId);
      if (
        previous &&
        isDeepStrictEqual(previous.registration, registration) &&
        isDeepStrictEqual(previous.binding, binding) &&
        previous.reauthorization?.recordId === retained?.id &&
        previous.reauthorization?.version === retained?.version
      )
        return previous;
      if (previous?.version !== expectedVersion)
        refuse(
          "version_conflict",
          "Read the current proposal and supply its version before replacing it.",
        );
      if (
        !previous &&
        Number(
          this.db.prepare("SELECT COUNT(*) count FROM pr_maintenance_proposals").get()
            ?.count,
        ) >= 10_000
      )
        refuse(
          "proposal_overflow",
          "The bounded proposal registry is full; remove obsolete tasks before proposing more maintenance.",
        );
      const now = nowIso();
      const proposal = PrMaintenanceProposalSchema.parse({
        id: previous?.id ?? randomUUID(),
        version: (previous?.version ?? 0) + 1,
        leadSessionId,
        registration,
        ...(retained
          ? {
              reauthorization: {
                recordId: retained.id,
                version: retained.version,
                generation: retained.generation,
              },
            }
          : {}),
        binding,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      this.consumeProposal(task.id);
      this.db
        .prepare(
          `INSERT INTO pr_maintenance_proposals(task_id,data) VALUES (?,?)
        ON CONFLICT(task_id) DO UPDATE SET data=excluded.data`,
        )
        .run(task.id, JSON.stringify(proposal));
      return proposal;
    });
  }

  authorizeProposal(
    taskId: string,
    proposalId: string,
    expectedVersion: number,
    actorId: string,
  ): PrMaintenanceRegistration {
    return this.store.writeAtomically(() => {
      const proposal = this.getProposal(taskId);
      if (!proposal || proposal.id !== proposalId || proposal.version !== expectedVersion)
        refuse(
          "version_conflict",
          "The proposal changed or was already handled. Refresh and review it again.",
        );
      const registration = PrMaintenanceEnableSchema.parse(proposal.registration);
      if (this.store.getRun(taskId)?.leadSessionId !== proposal.leadSessionId)
        refuse(
          "ownership",
          "The task owner changed; its current lead must prepare a new proposal.",
        );
      if (!proposal.binding)
        refuse(
          "proposal_binding_required",
          "This legacy proposal has no reviewed checkout binding. Prepare and review a new proposal before authorization.",
        );
      const worker = this.store.getSession(proposal.registration.workerSessionId);
      if (
        !worker ||
        worker.placementId !== proposal.binding.placementId ||
        (worker.executionBinding?.checkoutKey ?? `placement:${worker.placementId}`) !==
          proposal.binding.checkoutKey ||
        (worker.executionBinding?.generation ?? 0) !== proposal.binding.bindingGeneration
      )
        refuse(
          "proposal_binding_changed",
          "The worker placement, checkout or binding generation changed after preparation. Prepare and review a new proposal.",
        );
      if (proposal.reauthorization) {
        const record = this.required(
          proposal.reauthorization.recordId,
          proposal.leadSessionId,
          proposal.reauthorization.version,
        );
        if (record.generation !== proposal.reauthorization.generation)
          refuse("stale_generation", "Prepare a new repair authorization proposal.");
        this.assertReauthorization(record, registration);
        const operatorId = actorSchema.parse(actorId);
        this.archiveAuthorization(record);
        record.eligibilityEvidence = registration.eligibilityEvidence;
        record.authorization = {
          id: randomUUID(),
          operatorId,
          issuedAt: nowIso(),
          headSha: registration.headSha,
          scope: registration.scope,
          budgets: registration.budgets,
          eligibilityEvidence: registration.eligibilityEvidence,
          sourceProposal: { id: proposal.id, version: proposal.version },
        };
        // Reauthorization grants scope, not permission to resume old paused/finished work.
        if (record.lifecycle === "active")
          this.pause(record, "repair_authorized_requires_explicit_resume", undefined, {
            actor: "operator",
            actorId: operatorId,
          });
        else delete record.readyFingerprint;
        const saved = this.save(record);
        this.consumeProposal(taskId, true);
        return saved;
      }
      return this.enable(registration, actorId, proposal);
    });
  }

  private assertReauthorization(
    record: PrMaintenanceRegistration,
    registration: z.infer<typeof PrMaintenanceEnableSchema>,
  ): void {
    if (
      record.ownershipReleasedAt ||
      !["active", "paused"].includes(record.lifecycle) ||
      record.authorization.scope.publicationAuthorized ||
      record.taskId !== registration.taskId ||
      record.workerSessionId !== registration.workerSessionId ||
      !sameIdentity(record.identity, registration.identity)
    )
      refuse(
        "reauthorization_scope",
        "Repair authorization must retain the exact PR and worker of a nonterminal legacy job.",
      );
    if (
      prMaintenanceUnsettled(record) ||
      this.hasPendingManualExecution(record.workerSessionId)
    )
      refuse(
        "unsettled",
        "Settle execution and unknown effects before preparing repair authorization.",
      );
    if (record.decision?.state === "pending")
      refuse(
        "wait_for_human",
        "Record direction for the existing decision before repair authorization.",
      );
    const reason = this.binding(record);
    if (reason)
      refuse(reason, "The retained binding is not eligible for repair authorization.");
    const { task, worker } = this.ownedWorker(record.taskId, record.workerSessionId);
    if (
      !["running", "awaiting_lead", "completed"].includes(task.state) ||
      worker.stopRequested ||
      !["idle", "completed", "stopped"].includes(worker.state) ||
      this.store
        .listRunSteps(task.id)
        .some(
          (step) =>
            step.sessionId === worker.id &&
            !["succeeded", "failed", "cancelled", "skipped"].includes(step.state),
        )
    )
      refuse(
        "proposal_not_ready",
        "Settle existing work and task approvals before repair authorization.",
      );
  }

  private required(
    id: string,
    leadSessionId?: string,
    version?: number,
  ): PrMaintenanceRegistration {
    const record = this.get(id, leadSessionId);
    if (!record) refuse("not_found", "Maintenance registration not found.");
    if (version !== undefined && record.version !== version)
      refuse(
        "version_conflict",
        "Maintenance changed; reread the record and reconcile before retrying.",
      );
    return record;
  }

  private write(
    record: PrMaintenanceRegistration,
    insert = false,
  ): PrMaintenanceRegistration {
    if (
      record.batches.length > 100 ||
      record.findings.length > 200 ||
      record.findingAttempts.length > 200 ||
      record.actions.length > 200 ||
      record.decisionHistory.length > 100 ||
      (record.resumeHistory?.length ?? 0) > 100
    )
      refuse(
        "checkpoint_overflow",
        "The bounded checkpoint is full; settle pending work and archive its history explicitly, without discarding pending findings.",
      );
    this.archiveManualCommands(record);
    const parsed = PrMaintenanceRegistrationSchema.parse(record);
    if (
      parsed.ownershipReleasedAt &&
      (prMaintenanceUnsettled(parsed) || parsed.decision?.state === "pending")
    )
      refuse(
        "unsettled",
        "Released ownership cannot contain outstanding work, effects or human decisions.",
      );
    const data = JSON.stringify(parsed);
    if (Buffer.byteLength(data) > 2 * 1024 * 1024)
      refuse(
        "checkpoint_overflow",
        "Maintenance checkpoint exceeds 2 MiB; settle pending work and archive history explicitly.",
      );
    try {
      if (insert) {
        this.db
          .prepare(
            `INSERT INTO pr_maintenance
          (id,version,generation,host,repository_id,pr_number,head_repository_id,head_ref,
           lead_session_id,task_id,worker_session_id,placement_id,checkout_key,released_at,next_check_at,data)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            parsed.id,
            parsed.version,
            parsed.generation,
            prMaintenanceProviderKey(parsed.identity),
            parsed.identity.repositoryId,
            parsed.identity.prNumber,
            parsed.identity.headRepositoryId,
            parsed.identity.headRef,
            parsed.leadSessionId,
            parsed.taskId,
            parsed.workerSessionId,
            parsed.placementId,
            parsed.checkoutKey,
            parsed.ownershipReleasedAt ?? null,
            parsed.nextCheckAt,
            data,
          );
      } else {
        const updated = this.db
          .prepare(
            `UPDATE pr_maintenance
          SET version=?,released_at=?,next_check_at=?,data=? WHERE id=? AND version=?`,
          )
          .run(
            parsed.version,
            parsed.ownershipReleasedAt ?? null,
            parsed.nextCheckAt,
            data,
            parsed.id,
            parsed.version - 1,
          );
        if (!updated.changes)
          refuse("version_conflict", "Maintenance changed; reread the checkpoint.");
      }
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message))
        refuse(
          "ownership_conflict",
          "This PR, full remote head ref, or worker is already reserved, including paused/draining work.",
        );
      throw error;
    }
    return parsed;
  }

  private save(record: PrMaintenanceRegistration): PrMaintenanceRegistration {
    record.version++;
    record.updatedAt = nowIso();
    return this.write(record);
  }

  private binding(
    record: Pick<
      PrMaintenanceRegistration,
      | "taskId"
      | "workerSessionId"
      | "leadSessionId"
      | "placementId"
      | "checkoutKey"
      | "bindingGeneration"
    >,
  ): string | undefined {
    const task = this.store.getRun(record.taskId);
    const worker = this.store.getSession(record.workerSessionId);
    const lead = this.store.getSession(record.leadSessionId);
    if (
      !task ||
      !worker ||
      !lead ||
      task.leadSessionId !== lead.id ||
      lead.runRole !== "lead" ||
      worker.runId !== task.id ||
      worker.runRole !== "worker"
    )
      return "binding_unavailable";
    if (!this.store.listRunSteps(task.id).some((step) => step.sessionId === worker.id))
      return "worker_not_owned";
    if (
      worker.placementId !== record.placementId ||
      !this.store.getPlacement(record.placementId)
    )
      return "binding_changed";
    const execution = worker.executionBinding;
    if (
      execution?.quarantined ||
      execution?.accessClass === "no-checkout" ||
      (execution?.checkoutKey ?? `placement:${worker.placementId}`) !==
        record.checkoutKey ||
      (execution?.generation ?? 0) !== record.bindingGeneration
    )
      return "binding_changed";
    if (task.workspaceBinding?.accessIntent === "no-checkout")
      return "binding_unavailable";
    const steps = this.store
      .listRunSteps(task.id)
      .filter((step) => step.sessionId === worker.id);
    if (
      steps.some(
        (step) =>
          step.resultSha ||
          step.workspaceState === "completed" ||
          step.workspaceState === "quarantined" ||
          step.workspaceState === "blocked",
      )
    )
      return "sealed_managed_result";
    if (task.workspaceBinding?.effectiveMode === "managed") {
      const treeId = execution?.worktreeId;
      const tree = treeId ? this.store.getAnyManagedWorkspace(treeId) : undefined;
      if (
        !tree ||
        tree.resultSha ||
        !["ready", "in_use"].includes(tree.state) ||
        task.workspaceBinding.aggregationState !== "not_started"
      )
        return "unsupported_managed_binding";
      if (
        this.store
          .listWorktreeOperations(tree.id)
          .some(
            (operation) =>
              ["cleanup", "abandon"].includes(operation.request.kind) &&
              operation.state !== "acknowledged",
          )
      )
        return "cleanup_in_flight";
    }
    if (worker.cleanupRequested || lead.cleanupRequested) return "cleanup_in_flight";
    return undefined;
  }

  private ownedWorker(taskId: string, workerSessionId: string) {
    const task = this.store.getRun(taskId);
    const worker = this.store.getSession(workerSessionId);
    const lead = task && this.store.getSession(task.leadSessionId);
    if (
      !task ||
      !worker ||
      !lead ||
      lead.runRole !== "lead" ||
      worker.runId !== task.id ||
      worker.runRole !== "worker" ||
      !this.store.listRunSteps(task.id).some((step) => step.sessionId === worker.id)
    )
      refuse(
        "ownership",
        "Enablement requires the task's existing lead-owned worker, not a standalone or replacement session.",
      );
    this.store.assertRunMutable(task.id);
    this.store.assertSessionMutable(lead.id);
    this.store.assertSessionMutable(worker.id);
    if (
      !this.store
        .listRunSteps(task.id)
        .some((step) => step.sessionId === worker.id && isWritingCategory(step.category))
    )
      refuse(
        "read_only_task",
        "Repair maintenance requires the task's existing writing worker; read-only categories cannot be upgraded.",
      );
    return { task, worker, lead };
  }

  /** This is an operator-route seam; never expose it as an MCP/model capability. */
  enableFromOperator(
    input: z.input<typeof PrMaintenanceEnableSchema>,
    actorId: string,
  ): PrMaintenanceRegistration {
    return this.enable(input, actorId);
  }

  private enable(
    input: z.input<typeof PrMaintenanceEnableSchema>,
    actorId: string,
    approvedProposal?: PrMaintenanceProposal,
  ): PrMaintenanceRegistration {
    const parsed = PrMaintenanceEnableSchema.parse(input);
    const operatorId = actorSchema.parse(actorId);
    return this.store.writeAtomically(() => {
      const { task, worker, lead } = this.ownedWorker(
        parsed.taskId,
        parsed.workerSessionId,
      );
      const retained = this.retained();
      const previous = retained.find(
        (entry) =>
          prMaintenanceProviderKey(entry.identity) ===
            prMaintenanceProviderKey(parsed.identity) &&
          entry.identity.repositoryId === parsed.identity.repositoryId &&
          entry.identity.prNumber === parsed.identity.prNumber,
      );
      if (previous) {
        if (
          previous.taskId === parsed.taskId &&
          previous.workerSessionId === parsed.workerSessionId &&
          previous.leadSessionId === lead.id &&
          sameIdentity(previous.identity, parsed.identity) &&
          previous.authorization.headSha === parsed.headSha &&
          previous.eligibilityEvidence === parsed.eligibilityEvidence &&
          isDeepStrictEqual(previous.authorization.scope, parsed.scope) &&
          isDeepStrictEqual(previous.authorization.budgets, parsed.budgets)
        )
          return previous;
        refuse(
          "ownership_conflict",
          "Existing maintenance owns this PR; enablement cannot adopt, rebind or renew it.",
        );
      }
      if (retained.some((entry) => entry.taskId === task.id)) {
        refuse(
          "task_already_registered",
          "This task is already reserved for PR maintenance. V1 supports one PR per task; release it before registering another.",
        );
      }
      if (
        !["idle", "completed", "stopped"].includes(worker.state) ||
        this.hasPendingManualExecution(worker.id) ||
        this.store
          .listRunSteps(task.id)
          .some(
            (step) =>
              step.sessionId === worker.id &&
              !["succeeded", "failed", "cancelled", "skipped"].includes(step.state),
          )
      ) {
        refuse(
          "worker_busy",
          "Wait for the existing worker attempt to settle before enabling maintenance; untracked execution cannot be adopted.",
        );
      }
      const generation =
        Number(
          this.db
            .prepare(
              `SELECT MAX(generation) generation FROM pr_maintenance
        WHERE host=? AND repository_id=? AND pr_number=?`,
            )
            .get(
              prMaintenanceProviderKey(parsed.identity),
              parsed.identity.repositoryId,
              parsed.identity.prNumber,
            )?.generation ?? 0,
        ) + 1;
      if (
        Number(
          this.db.prepare("SELECT COUNT(*) count FROM pr_maintenance").get()?.count,
        ) >= 10_000
      )
        refuse(
          "registry_overflow",
          "The bounded registry is full; explicitly archive settled history before adding registrations.",
        );
      const now = nowIso();
      const record: PrMaintenanceRegistration = {
        schemaVersion: 1,
        id: randomUUID(),
        version: 1,
        generation,
        identity: parsed.identity,
        taskId: task.id,
        leadSessionId: lead.id,
        workerSessionId: worker.id,
        placementId: worker.placementId,
        checkoutKey:
          worker.executionBinding?.checkoutKey ?? `placement:${worker.placementId}`,
        bindingGeneration: worker.executionBinding?.generation ?? 0,
        eligibilityEvidence: parsed.eligibilityEvidence,
        authorization: {
          id: randomUUID(),
          operatorId,
          issuedAt: now,
          headSha: parsed.headSha,
          scope: parsed.scope,
          budgets: parsed.budgets,
          eligibilityEvidence: parsed.eligibilityEvidence,
          ...(approvedProposal
            ? {
                sourceProposal: {
                  id: approvedProposal.id,
                  version: approvedProposal.version,
                },
              }
            : {}),
        },
        authorizationHistory: [],
        resumeHistory: [],
        lifecycle: "active",
        pauseReason: "",
        renewedAt: now,
        nextCheckAt: now,
        counters: emptyCounters(),
        incidentCursor: 0,
        incidents: [],
        decisionHistory: [],
        batches: [],
        findings: [],
        findingAttempts: [],
        actions: [],
        createdAt: now,
        updatedAt: now,
      };
      const reason =
        this.binding(record) ??
        (task.state === "awaiting_human"
          ? "task_human_hold"
          : ["awaiting_approval", "blocked", "failed", "aggregating"].includes(task.state)
            ? "task_not_eligible"
            : worker.stopRequested || task.state === "cancelled"
              ? "stopped"
              : undefined);
      if (reason) this.pause(record, reason, now);
      const saved = this.write(record, true);
      this.consumeProposal(task.id, Boolean(approvedProposal));
      return saved;
    });
  }

  private pause(
    record: PrMaintenanceRegistration,
    reason: string,
    at = nowIso(),
    origin: {
      actor: "lead" | "operator" | "system";
      actorId: string;
    } = { actor: "system", actorId: "host" },
  ): void {
    if (record.lifecycle === "active") {
      record.lifecycle = "paused";
      record.pausedAt = at;
    }
    record.pauseReason = reason;
    record.pauseOrigin = { ...origin, at };
    delete record.readyFingerprint;
    for (const batch of record.batches) {
      if (!outstanding.has(batch.state)) continue;
      batch.cancellationRequestedAt ??= at;
      if (batch.state === "prepared") {
        batch.state = "cancelled";
        batch.executionSettled = true;
        batch.reason = reason;
        batch.evidence =
          "Dispatch was not accepted; cancelled transactionally before admission.";
        batch.findings = batch.sources.map((source) => ({
          source,
          outcome: "incomplete",
          stage: "not_attempted",
          evidence: [],
          responseRequired: true,
          responseIds: [],
          nextAction: "Wait for authorized continuation.",
          progress: false,
        }));
        this.refund(record, batch, 0, false);
      }
    }
  }

  pauseForSession(sessionId: string, reason = "Session stopped or removed"): void {
    this.store.writeAtomically(() => {
      for (const record of this.retained().filter(
        (entry) =>
          entry.workerSessionId === sessionId || entry.leadSessionId === sessionId,
      )) {
        this.pause(record, reason);
        this.save(record);
      }
    });
  }

  pauseForTask(taskId: string, reason = "Task stopped or removed"): void {
    this.store.writeAtomically(() => {
      for (const record of this.retained().filter((entry) => entry.taskId === taskId)) {
        this.pause(record, reason);
        this.save(record);
      }
    });
  }

  /**
   * Moves a task's maintenance to the lead the task now belongs to.
   *
   * Maintenance is driven by lead wakes and `takeDue` claims only a lead's own
   * registrations, so leaving them behind would split one task across two
   * heartbeats — or, with the previous lead stopped, leave the PR with none.
   * Released history moves too, because task discovery reads it by lead. The
   * version bump, and the owner inside every observation scope, invalidate
   * whatever the previous lead read or reserved before the change.
   */
  transferTask(taskId: string, leadSessionId: string): PrMaintenanceRegistration[] {
    actorSchema.parse(leadSessionId);
    return this.store.writeAtomically(() => {
      const moved: PrMaintenanceRegistration[] = [];
      const versions = new Map<string, { before: number; after: number }>();
      for (const row of this.db
        .prepare("SELECT data FROM pr_maintenance WHERE task_id=? ORDER BY id")
        .all(taskId)) {
        const record = PrMaintenanceRegistrationSchema.parse(
          JSON.parse(String(row.data)),
        );
        if (record.leadSessionId === leadSessionId) continue;
        const previous = record.leadSessionId;
        const before = record.version;
        record.leadSessionId = leadSessionId;
        // The previous owner's own pause is the owning lead's pause, not an
        // operator's or the Host's, so whichever lead owns the task may lift it.
        if (
          record.pauseOrigin?.actor === "lead" &&
          record.pauseOrigin.actorId === previous
        )
          record.pauseOrigin = { ...record.pauseOrigin, actorId: leadSessionId };
        const saved = this.save(record);
        this.db
          .prepare("UPDATE pr_maintenance SET lead_session_id=? WHERE id=?")
          .run(leadSessionId, saved.id);
        versions.set(saved.id, { before, after: saved.version });
        moved.push(saved);
      }
      const proposal = this.getProposal(taskId);
      if (proposal && proposal.leadSessionId !== leadSessionId) {
        /*
         * A pending proposal is the operator's to judge, and moving the task
         * does not change what it says. A reauthorization pinned to the record
         * this transfer just re-versioned follows it; any other change still
         * makes the proposal stale, as it would have without the transfer.
         */
        const pinned = proposal.reauthorization
          ? versions.get(proposal.reauthorization.recordId)
          : undefined;
        const reauthorization =
          proposal.reauthorization &&
          pinned &&
          pinned.before === proposal.reauthorization.version
            ? { ...proposal.reauthorization, version: pinned.after }
            : proposal.reauthorization;
        this.db.prepare("UPDATE pr_maintenance_proposals SET data=? WHERE task_id=?").run(
          JSON.stringify(
            PrMaintenanceProposalSchema.parse({
              ...proposal,
              leadSessionId,
              ...(reauthorization ? { reauthorization } : {}),
              updatedAt: nowIso(),
            }),
          ),
          taskId,
        );
      }
      return moved;
    });
  }

  manualRecord(sessionId: string): PrMaintenanceRegistration | undefined {
    return this.retained().find((record) => record.workerSessionId === sessionId);
  }

  manualCommand(
    sessionId: string,
    commandId: string,
  ): PrMaintenanceManualCommand | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM pr_maintenance_manual_commands WHERE session_id=? AND command_id=? AND state NOT IN ('ambiguous_pending','ambiguous_settled')",
      )
      .get(sessionId, commandId);
    return row
      ? PrMaintenanceManualCommandSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }

  hasManualHistory(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM pr_maintenance_manual_commands WHERE session_id=? LIMIT 1",
        )
        .get(sessionId),
    );
  }

  manualConflicts(sessionId: string, commandId: string): PrMaintenanceManualCommand[] {
    return this.db
      .prepare(
        `SELECT c.data FROM pr_maintenance_manual_conflicts c
       JOIN pr_maintenance_manual_commands m ON m.session_id=c.session_id AND m.command_id=c.command_id
       WHERE c.session_id=? AND c.command_id=? AND m.state IN ('ambiguous_pending','ambiguous_settled') ORDER BY c.claim_hash`,
      )
      .all(sessionId, commandId)
      .map((row) => PrMaintenanceManualCommandSchema.parse(JSON.parse(String(row.data))));
  }

  assertManualOperationUnambiguous(sessionId: string, commandId: string): void {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM pr_maintenance_manual_commands WHERE session_id=? AND command_id=? AND state IN ('ambiguous_pending','ambiguous_settled')",
        )
        .get(sessionId, commandId)
    )
      refuse(
        "manual_operation_ambiguous",
        `Manual operation ${commandId} has conflicting historical claims and is quarantined; it cannot be replayed. Inspect manualConflicts in the Host backup.`,
      );
  }

  hasPendingManualExecution(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM pr_maintenance_manual_commands WHERE session_id=? AND state IN ('unknown','accepted','ambiguous_pending') LIMIT 1",
        )
        .get(sessionId),
    );
  }

  private saveManualOwner(input: PrMaintenanceManualOwner): void {
    const owner = PrMaintenanceManualOwnerSchema.parse(input);
    if (
      ![
        owner.taskId,
        owner.placementId,
        owner.nodeId,
        owner.workspaceId,
        owner.checkoutKey,
      ].some(Boolean)
    )
      return;
    this.db
      .prepare("INSERT OR IGNORE INTO pr_maintenance_manual_owners VALUES (?,?,?,?,?,?)")
      .run(
        owner.sessionId,
        owner.taskId,
        owner.placementId,
        owner.nodeId,
        owner.workspaceId,
        owner.checkoutKey,
      );
  }

  private rememberManualOwner(
    sessionId: string,
    record?: PrMaintenanceRegistration,
  ): void {
    const session = this.store.getSession(sessionId);
    const placement = this.store.getPlacement(
      record?.placementId ?? session?.placementId ?? "",
    );
    this.saveManualOwner({
      sessionId,
      taskId: record?.taskId ?? session?.runId ?? "",
      placementId: record?.placementId ?? session?.placementId ?? "",
      nodeId: session?.nodeId ?? placement?.nodeId ?? "",
      workspaceId: session?.workspaceId ?? placement?.workspaceId ?? "",
      checkoutKey:
        record?.checkoutKey ??
        session?.executionBinding?.checkoutKey ??
        (session ? `placement:${session.placementId}` : ""),
    });
    for (const row of this.db
      .prepare("SELECT DISTINCT run_id FROM run_steps WHERE session_id=?")
      .all(sessionId)) {
      if (String(row.run_id) !== (record?.taskId ?? session?.runId))
        this.saveManualOwner({
          sessionId,
          taskId: String(row.run_id),
          placementId: placement?.id ?? "",
          nodeId: session?.nodeId ?? placement?.nodeId ?? "",
          workspaceId: session?.workspaceId ?? placement?.workspaceId ?? "",
          checkoutKey: record?.checkoutKey ?? "",
        });
    }
  }

  /** Historical ambiguity is evidence to quarantine, not an invalid new request. */
  private importManualCommand(
    sessionId: string,
    input: PrMaintenanceManualCommand,
  ): void {
    const command = PrMaintenanceManualCommandSchema.parse(input);
    const row = this.db
      .prepare(
        "SELECT state,data FROM pr_maintenance_manual_commands WHERE session_id=? AND command_id=?",
      )
      .get(sessionId, command.id);
    const ambiguous = row && String(row.state).startsWith("ambiguous_");
    const previous =
      row && !ambiguous
        ? PrMaintenanceManualCommandSchema.parse(JSON.parse(String(row.data)))
        : undefined;
    // Preserve source snapshots before coalescing the unambiguous index. If a
    // later claim conflicts, an earlier uncertain delivery must not disappear.
    const data = JSON.stringify(command);
    this.db
      .prepare("INSERT OR IGNORE INTO pr_maintenance_manual_conflicts VALUES (?,?,?,?)")
      .run(sessionId, command.id, createHash("sha256").update(data).digest("hex"), data);
    if (
      !ambiguous &&
      (!previous ||
        (previous.digest === command.digest &&
          previous.operatorId === command.operatorId &&
          previous.kind === command.kind))
    ) {
      this.saveManualCommand(sessionId, command);
      return;
    }
    this.quarantineManualOperation(sessionId, command.id);
  }

  private quarantineManualOperation(sessionId: string, commandId: string): void {
    const pending = Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM pr_maintenance_manual_conflicts WHERE session_id=? AND command_id=?
       AND json_extract(data,'$.state') IN ('unknown','accepted') LIMIT 1`,
        )
        .get(sessionId, commandId),
    );
    this.db
      .prepare(
        "UPDATE pr_maintenance_manual_commands SET state=?,data='null' WHERE session_id=? AND command_id=?",
      )
      .run(pending ? "ambiguous_pending" : "ambiguous_settled", sessionId, commandId);
  }

  pendingManualCommands(sessionId: string): PrMaintenanceManualCommand[] {
    return this.db
      .prepare(
        "SELECT data FROM pr_maintenance_manual_commands WHERE session_id=? AND state IN ('unknown','accepted')",
      )
      .all(sessionId)
      .map((row) => PrMaintenanceManualCommandSchema.parse(JSON.parse(String(row.data))));
  }

  private saveManualCommand(
    sessionId: string,
    input: PrMaintenanceManualCommand,
  ): PrMaintenanceManualCommand {
    let command = PrMaintenanceManualCommandSchema.parse(input);
    this.assertManualOperationUnambiguous(sessionId, command.id);
    const previous = this.manualCommand(sessionId, command.id);
    if (previous) {
      if (
        previous.digest !== command.digest ||
        previous.operatorId !== command.operatorId ||
        previous.kind !== command.kind
      )
        refuse(
          "manual_request_conflict",
          "This request key already identifies different manual input.",
        );
      // Pre-index backups may repeat an operation in different registrations.
      // Keep its original sequence boundary and never regress known receipts.
      const state =
        ["settled", "rejected"].includes(previous.state) || command.state === "unknown"
          ? previous.state
          : command.state;
      command = {
        ...(previous.eventSeqFrom <= command.eventSeqFrom ? previous : command),
        state,
      };
      if (isDeepStrictEqual(previous, command)) return previous;
    }
    this.db
      .prepare(
        `INSERT INTO pr_maintenance_manual_commands VALUES (?,?,?,?)
       ON CONFLICT(session_id,command_id) DO UPDATE SET state=excluded.state,data=excluded.data`,
      )
      .run(sessionId, command.id, command.state, JSON.stringify(command));
    return command;
  }

  private archiveManualCommands(record: PrMaintenanceRegistration): void {
    if (!record.manualControl) return;
    const commands = record.manualControl.commands.map((command) => {
      const ambiguous = this.db
        .prepare(
          "SELECT 1 FROM pr_maintenance_manual_commands WHERE session_id=? AND command_id=? AND state IN ('ambiguous_pending','ambiguous_settled')",
        )
        .get(record.workerSessionId, command.id);
      return ambiguous
        ? command
        : this.saveManualCommand(record.workerSessionId, command);
    });
    const recent = new Set(
      commands
        .filter((command) => ["settled", "rejected"].includes(command.state))
        .slice(-32)
        .map((command) => command.id),
    );
    record.manualControl.commands = commands.filter(
      (command) =>
        ["unknown", "accepted"].includes(command.state) || recent.has(command.id),
    );
  }

  private neverDispatched(record: PrMaintenanceRegistration, batch: PrMaintenanceBatch) {
    if (batch.state === "prepared") return true;
    const step = batch.stepId && this.store.getRunStep(batch.stepId);
    const worker = this.store.getSession(record.workerSessionId);
    return Boolean(
      batch.state === "accepted" &&
      !batch.effects.length &&
      step &&
      worker &&
      step.sessionId === worker.id &&
      step.attempts === batch.attempt &&
      step.state === "pending" &&
      !step.dispatchedAt &&
      this.store.getSessionDispatchAttempt(worker.id)?.attempt !==
        notificationAttemptKey(worker, { step, run: this.store.getRun(record.taskId) }),
    );
  }

  assertManualAvailable(sessionId: string): void {
    if (this.hasPendingManualExecution(sessionId))
      refuse(
        "execution_uncertain",
        "Wait for correlated execution and effect receipts before manual control; no work was replayed or stopped.",
      );
    const record = this.manualRecord(sessionId);
    if (!record) {
      this.assertAdmission({ sessionId, action: "prompt" });
      return;
    }
    const reason = this.binding(record);
    if (reason)
      refuse(reason, `Manual control cannot change the retained checkout: ${reason}.`);
    if (
      this.retained().some(
        (other) => other.id !== record.id && other.checkoutKey === record.checkoutKey,
      )
    )
      refuse(
        "resource_reserved",
        "Another retained registration reserves this checkout.",
      );
    if (
      record.manualControl?.commands.some((command) =>
        ["unknown", "accepted"].includes(command.state),
      ) ||
      record.incidents.some(
        (incident) => incident.kind === "effects" && !incident.resolvedAt,
      ) ||
      record.actions.some(unsettledEffect) ||
      record.batches.some(
        (batch) =>
          batch.effects.some(unsettledEffect) ||
          ((outstanding.has(batch.state) || (batch.stepId && !batch.executionSettled)) &&
            !this.neverDispatched(record, batch)),
      )
    )
      refuse(
        "execution_uncertain",
        "Wait for correlated execution and effect receipts before manual control; no work was replayed or stopped.",
      );
    const queuedSteps = new Set(
      record.batches
        .filter((batch) => this.neverDispatched(record, batch))
        .map((batch) => batch.stepId),
    );
    if (
      this.store
        .listRunSteps(record.taskId)
        .some(
          (step) =>
            step.sessionId === sessionId &&
            !["succeeded", "failed", "cancelled", "skipped"].includes(step.state) &&
            !queuedSteps.has(step.id),
        )
    )
      refuse(
        "worker_busy",
        "The retained worker still has an unsettled orchestration attempt.",
      );
  }

  /** Called only by trusted session routes, in the dispatch receipt transaction. */
  beginManualControl(
    sessionId: string,
    command: SupervisorCommand,
    eventSeqFrom: number,
  ): void {
    this.store.writeAtomically(() => {
      this.assertManualAvailable(sessionId);
      this.assertManualOperationUnambiguous(sessionId, command.id);
      const record = this.manualRecord(sessionId);
      if (this.manualCommand(sessionId, command.id))
        refuse(
          "manual_duplicate",
          "This manual request already has a receipt; do not replay it.",
        );
      const now = nowIso();
      this.rememberManualOwner(sessionId, record);
      const receipt = this.saveManualCommand(sessionId, {
        ...command,
        eventSeqFrom,
        state: "unknown",
        createdAt: now,
      });
      if (!record) return;
      for (const batch of record.batches) {
        if (!this.neverDispatched(record, batch) || !batch.stepId) continue;
        this.store.updateRunStep(batch.stepId, {
          state: "cancelled",
          output:
            "Supervisor took manual control before queued maintenance was dispatched.",
        });
        batch.state = "cancelled";
        batch.executionSettled = true;
        batch.executionNotDispatched = true;
        batch.cancellationRequestedAt = now;
        batch.updatedAt = now;
        batch.reason = "manual_control";
        batch.evidence =
          "Host queue and dispatch receipt prove this attempt was never sent.";
        this.refund(record, batch, 0, false);
      }
      this.pause(record, "manual_control", now, {
        actor: "operator",
        actorId: command.operatorId,
      });
      record.manualControl ??= {
        operatorId: command.operatorId,
        takenAt: now,
        commands: [],
      };
      delete record.manualControl.endedAt;
      record.manualControl.commands.push(receipt);
      this.save(record);
    });
  }

  recordManualReceipt(
    sessionId: string,
    commandId: string,
    state: "accepted" | "settled" | "rejected",
  ): boolean {
    return this.store.writeAtomically(() => {
      const command = this.manualCommand(sessionId, commandId);
      if (
        !command ||
        command.state === state ||
        ["settled", "rejected"].includes(command.state)
      )
        return false;
      command.state = state;
      this.saveManualCommand(sessionId, command);
      const record = this.manualRecord(sessionId);
      const cached = record?.manualControl?.commands.find(
        (entry) => entry.id === commandId,
      );
      if (record && cached) {
        cached.state = state;
        this.save(record);
      }
      return true;
    });
  }

  private assertResumeSafety(
    record: PrMaintenanceRegistration,
    decisionId?: string,
    decisionVersion?: number,
  ): void {
    if (record.ownershipReleasedAt)
      refuse("released", "Released maintenance needs explicit new enablement.");
    if (!record.authorization.scope.publicationAuthorized)
      refuse(
        "repair_authorization_required",
        "Observation-only maintenance is retired. Prepare and authenticate a repair proposal for this retained PR and worker.",
      );
    if (this.hasPendingManualExecution(record.workerSessionId))
      refuse(
        "execution_uncertain",
        "Settle the manual command receipt before changing maintenance control.",
      );
    if (record.decision) {
      if (record.decision.state === "pending")
        refuse(
          "wait_for_human",
          "Record authenticated direction, not an approval claim, for this decision.",
        );
      this.matchDecision(record, decisionId, decisionVersion);
    }
    if (record.lifecycle === "merged" || record.lifecycle === "closed")
      refuse(
        "terminal",
        "Terminal registrations cannot resume; settle and enable a new generation.",
      );
    if (
      record.incidents.some(
        (incident) => incident.kind === "effects" && !incident.resolvedAt,
      )
    )
      refuse(
        "unsettled",
        "Reconcile ambiguous effects with correlated receipts before resuming maintenance.",
      );
    const reason = this.binding(record);
    if (reason)
      refuse(
        reason,
        "Current worker binding is not eligible; an explicit supported handoff is required.",
      );
  }

  private applyResume(
    record: PrMaintenanceRegistration,
    actor: { actor: "lead" | "operator"; actorId: string },
    at: string,
  ): void {
    record.resumeHistory.push({
      ...actor,
      resumedAt: at,
      pauseReason: record.pauseReason,
      ...(record.pauseOrigin ? { pauseOrigin: record.pauseOrigin } : {}),
    });
    record.lifecycle = "active";
    if (record.manualControl) record.manualControl.endedAt = at;
    record.pauseReason = "";
    delete record.pauseOrigin;
    record.counters.scanStalls = 0;
    record.counters.reconciliationStalls = 0;
    record.nextCheckAt = at;
    record.renewedAt = at;
    delete record.pausedNoticeAt;
    for (const incident of record.incidents) {
      if (
        !incident.resolvedAt &&
        ["identity", "provider_denial"].includes(incident.kind)
      ) {
        incident.resolvedAt = at;
        incident.resolution = `${actor.actor}_resume`;
        delete record.lastAttempt;
        delete record.readyFingerprint;
      }
    }
  }

  private assertLeadResumeAllowed(
    record: PrMaintenanceRegistration,
    leadSessionId: string,
  ): void {
    if (record.pausedNoticeAt)
      refuse(
        "operator_required",
        "A long-paused registration requires authenticated operator review.",
      );
    if (
      record.counters.repairBatches >= record.authorization.budgets.repairBatches ||
      record.counters.answerBatches >= record.authorization.budgets.answerBatches ||
      record.counters.mutationAttempts >= record.authorization.budgets.mutationAttempts
    )
      refuse(
        "budget_exhausted",
        "An authenticated operator must renew the exhausted maintenance allowance.",
      );
    if (
      record.incidents.some(
        (incident) =>
          !incident.resolvedAt && ["identity", "provider_denial"].includes(incident.kind),
      )
    )
      refuse(
        "operator_required",
        "Provider access and identity holds require authenticated operator resume.",
      );
    const ownPause =
      record.pauseOrigin?.actor === "lead" &&
      record.pauseOrigin.actorId === leadSessionId;
    const directedHold =
      ["wait_for_human", "finding_needs_human"].includes(record.pauseReason) &&
      record.decision?.state === "directed";
    if (!ownPause && !directedHold)
      refuse(
        "operator_required",
        "The owning lead may resume only its own pause or a directed human-decision hold.",
      );
  }

  operatorAction(
    id: string,
    expectedVersion: number,
    input: z.input<typeof PrMaintenanceOperatorActionSchema>,
    actorId: string,
    writeDirection?: () => void,
  ): PrMaintenanceRegistration {
    const action: PrMaintenanceOperatorAction =
      PrMaintenanceOperatorActionSchema.parse(input);
    const operatorId = actorSchema.parse(actorId);
    return this.store.writeAtomically(() => {
      const record = this.required(id, undefined, expectedVersion);
      if (record.ownershipReleasedAt)
        refuse("released", "Released maintenance needs explicit new enablement.");
      if (
        !record.authorization.scope.publicationAuthorized &&
        (action.action === "resume" ||
          action.action === "renew" ||
          (action.action === "direction" && action.resume))
      )
        refuse(
          "repair_authorization_required",
          "Observation-only maintenance is retired. Prepare and authenticate a repair proposal for this retained PR and worker; direction without resume and manual supervisor control remain available.",
        );
      if (
        this.hasPendingManualExecution(record.workerSessionId) &&
        action.action !== "pause"
      )
        refuse(
          "execution_uncertain",
          "Settle the manual command receipt before changing maintenance control.",
        );
      const now = nowIso();
      if (action.action === "pause") {
        this.pause(record, action.reason, now, {
          actor: "operator",
          actorId: operatorId,
        });
      } else if (action.action === "release") {
        if (prMaintenanceUnsettled(record))
          refuse(
            "unsettled",
            "Reconcile accepted execution and unknown effects before releasing ownership.",
          );
        if (record.decision?.state === "pending") {
          this.matchDecision(record, action.decisionId, action.decisionVersion);
          record.decision = {
            ...record.decision,
            state: "withdrawn",
            operatorId,
            direction: action.reason,
            resolvedAt: now,
          };
        }
        this.pause(record, action.reason, now, {
          actor: "operator",
          actorId: operatorId,
        });
        record.ownershipReleasedAt = now;
        record.retentionReleasedBy = operatorId;
      } else if (action.action === "renew") {
        if (prMaintenanceUnsettled(record))
          refuse(
            "unsettled",
            "Settle the reserved allowance before budget or scope renewal.",
          );
        if (record.decision?.state === "pending")
          refuse(
            "wait_for_human",
            "Direction for the pending proposal is required before renewal.",
          );
        const previous = this.archiveAuthorization(record);
        record.authorization = {
          id: randomUUID(),
          operatorId,
          issuedAt: now,
          headSha: record.observation?.headSha ?? record.authorization.headSha,
          scope: action.scope ?? record.authorization.scope,
          budgets: action.budgets ?? record.authorization.budgets,
          eligibilityEvidence: previous.eligibilityEvidence,
          sourceProposal: previous.sourceProposal,
        };
        record.counters = emptyCounters();
        record.findingAttempts = [];
        record.renewedAt = now;
        delete record.pausedNoticeAt;
        if (record.lifecycle === "paused") {
          record.pausedAt = now;
          record.pauseOrigin = {
            actor: "operator",
            actorId: operatorId,
            at: now,
          };
        }
      } else {
        if (action.action === "direction") {
          this.matchDecision(record, action.decisionId, action.decisionVersion);
          record.decision = {
            ...record.decision!,
            state: "directed",
            operatorId,
            direction: action.direction,
            resolvedAt: now,
          };
          record.renewedAt = now;
          record.counters.reconciliationStalls = 0;
          record.counters.scanStalls = 0;
        }
        if (action.action !== "direction" || action.resume) {
          this.assertResumeSafety(record, action.decisionId, action.decisionVersion);
          this.applyResume(record, { actor: "operator", actorId: operatorId }, now);
        }
      }
      const saved = this.save(record);
      const priorDirectionTask = this.directionTaskId;
      try {
        if (action.action === "direction") this.directionTaskId = record.taskId;
        writeDirection?.();
      } finally {
        this.directionTaskId = priorDirectionTask;
      }
      return saved;
    });
  }

  private matchDecision(
    record: PrMaintenanceRegistration,
    id?: string,
    version?: number,
  ): void {
    if (
      !record.decision ||
      record.decision.id !== id ||
      record.decision.version !== version
    )
      refuse(
        "decision_conflict",
        "Direction must reference the exact recorded decision and proposal version.",
      );
  }

  /** The scoped model surface can pause and narrowly resume, but never mint a grant. */
  set(
    leadSessionId: string,
    input: {
      id: string;
      expectedVersion: number;
      action: "pause" | "enable" | "resume" | "release";
      reason?: string;
    },
  ): PrMaintenanceRegistration {
    const parsed = z
      .object({
        id: actorSchema,
        expectedVersion: z.number().int().positive(),
        action: z.enum(["pause", "enable", "resume", "release"]),
        reason: z.string().min(1).max(8_192).optional(),
      })
      .strict()
      .parse(input);
    return this.store.writeAtomically(() => {
      const record = this.required(parsed.id, leadSessionId, parsed.expectedVersion);
      if (!record.authorization.scope.publicationAuthorized && parsed.action !== "pause")
        refuse(
          "repair_authorization_required",
          "Legacy observation grants cannot activate maintenance. Prepare a repair proposal for authenticated authorization.",
        );
      if (
        parsed.action === "enable" &&
        record.lifecycle === "active" &&
        !record.ownershipReleasedAt
      )
        return record;
      if (parsed.action === "resume") {
        this.assertResumeSafety(record, record.decision?.id, record.decision?.version);
        this.assertLeadResumeAllowed(record, leadSessionId);
        this.applyResume(record, { actor: "lead", actorId: leadSessionId }, nowIso());
        return this.save(record);
      }
      if (parsed.action !== "pause")
        refuse(
          "operator_required",
          "Use the authenticated maintenance task action for enablement, direction or release.",
        );
      if (record.lifecycle === "merged" || record.lifecycle === "closed")
        refuse("terminal", "Terminal registrations cannot be paused by the lead.");
      if (
        record.lifecycle === "paused" &&
        (record.pauseOrigin?.actor !== "lead" ||
          record.pauseOrigin.actorId !== leadSessionId)
      )
        refuse(
          "operator_required",
          "A lead pause cannot replace an operator, system or legacy pause.",
        );
      this.pause(record, parsed.reason ?? "Paused by owning lead", undefined, {
        actor: "lead",
        actorId: leadSessionId,
      });
      return this.save(record);
    });
  }

  /** Review-only admission does not resume work or change any maintenance hold. */
  assertOperationalReview(taskId: string, input: PrMaintenanceOperationalReview): void {
    const record = this.required(
      input.recordId,
      input.leadSessionId,
      input.expectedVersion,
    );
    const task = this.store.getRun(taskId);
    if (record.taskId !== taskId || task?.leadSessionId !== input.leadSessionId)
      refuse("ownership", "The maintenance record must belong to this task and lead.");
    if (record.ownershipReleasedAt)
      refuse("released", "Cannot review released maintenance.");
    if (
      record.observation?.headSha ||
      record.decision?.state === "pending" ||
      task.state === "awaiting_human" ||
      task.state === "cancelled"
    )
      refuse(
        "review_conflict",
        "Operational review requires no observed HEAD, pending review or decision, or stopped task.",
      );
    this.store.assertRunMutable(taskId);
  }

  holdForDecision(
    leadSessionId: string,
    id: string,
    expectedVersion: number,
    input: z.input<typeof PrMaintenanceDecisionInputSchema>,
    writeReview: () => void,
  ): PrMaintenanceRegistration {
    const decision = PrMaintenanceDecisionInputSchema.parse(input);
    return this.store.writeAtomically(() => {
      const record = this.required(id, leadSessionId);
      if (record.decision?.state === "pending") {
        if (
          record.decision.id === decision.id &&
          record.decision.version === decision.version &&
          record.decision.proposal === decision.proposal &&
          record.decision.scope === decision.scope &&
          record.decision.headSha === decision.headSha
        )
          return record;
        refuse(
          "wait_for_human",
          "An existing maintenance decision must not be overwritten.",
        );
      }
      if (record.version !== expectedVersion)
        refuse("version_conflict", "Maintenance changed; reread before escalating.");
      if (record.ownershipReleasedAt)
        refuse("released", "Cannot hold released maintenance.");
      if (record.decision) record.decisionHistory.push(record.decision);
      record.decision = { ...decision, state: "pending" };
      this.pause(record, "wait_for_human");
      writeReview();
      if (this.store.getRun(record.taskId)?.state !== "awaiting_human")
        refuse(
          "review_required",
          "The existing task review must be recorded in the same transaction as its maintenance decision.",
        );
      return this.save(record);
    });
  }

  admission(input: PrMaintenanceAdmission): PrMaintenanceAdmissionResult {
    const action = PrMaintenanceAdmissionSchema.parse(input);
    const session = action.sessionId
      ? this.store.getSession(action.sessionId)
      : undefined;
    const checkoutKey =
      action.checkoutKey ??
      (session?.runRole !== "lead" ? session?.executionBinding?.checkoutKey : undefined);
    const placementId =
      action.placementId ??
      (session?.runRole !== "lead" ? session?.placementId : undefined);
    const records = this.retained().filter(
      (record) =>
        record.id === action.recordId ||
        record.taskId === action.taskId ||
        record.workerSessionId === action.sessionId ||
        (session?.runRole !== "lead" && record.taskId === session?.runId) ||
        record.checkoutKey === checkoutKey ||
        // Legacy placements identify the checkout; managed children have distinct keys.
        (record.placementId === placementId &&
          record.checkoutKey.startsWith("placement:")),
    );
    if (action.recordId && !records.some((record) => record.id === action.recordId))
      return { allowed: false, reason: "released_or_unknown", recordId: action.recordId };
    for (const record of records) {
      const denied = (reason: string): PrMaintenanceAdmissionResult => ({
        allowed: false,
        reason,
        recordId: record.id,
        ...(record.decision?.state === "pending"
          ? { decisionId: record.decision.id }
          : {}),
      });
      if (["cancel", "pause", "direction", "reconcile"].includes(action.action)) continue;
      if (action.action === "cleanup") return denied("maintenance_retention");
      if (action.leadSessionId && action.leadSessionId !== record.leadSessionId)
        return denied("ownership");
      if (record.decision?.state === "pending") return denied("wait_for_human");
      if (
        action.action === "reopen" &&
        this.directionTaskId === record.taskId &&
        record.decision?.state === "directed"
      )
        continue;
      if (record.lifecycle !== "active")
        return denied(record.lifecycle === "paused" ? "paused" : "terminal_draining");
      if (action.generation !== undefined && action.generation !== record.generation)
        return denied("stale_generation");
      const reason = this.binding(record);
      if (reason) return denied(reason);
      const task = this.store.getRun(record.taskId)!;
      const worker = this.store.getSession(record.workerSessionId)!;
      if (
        task.state === "awaiting_human" &&
        !(action.action === "reopen" && record.decision?.state === "directed")
      )
        return denied("wait_for_human");
      // Stop pauses the registration first. Only an operator action can make it
      // active again, after which the existing Run resume may clear Stop intent.
      if (!record.authorization.scope.publicationAuthorized)
        return denied("repair_authorization_required");
      if (action.action === "reopen") continue;
      if (worker.stopRequested || task.state === "cancelled") return denied("stopped");
      if (["awaiting_approval", "blocked", "failed", "aggregating"].includes(task.state))
        return denied("task_not_eligible");
      if (action.action === "discover") continue;
      if (
        ["approve", "advance", "submit", "aggregate"].includes(action.action) &&
        prMaintenanceUnsettled(record)
      )
        return denied("unsettled");
      if (
        ["dispatch", "execute", "prompt", "resume", "publish"].includes(action.action)
      ) {
        if (!record.authorization.scope.publicationAuthorized)
          return denied("publication_not_authorized");
        if (
          record.batches.some(
            (batch) =>
              batch.stepId && !batch.executionSettled && !outstanding.has(batch.state),
          )
        )
          return denied("execution_uncertain");
        if (task.state === "completed") return denied("task_completed_reopen_required");
        if (action.taskId && action.taskId !== record.taskId)
          return denied("resource_reserved");
        if (action.sessionId && action.sessionId !== record.workerSessionId)
          return denied("worker_reserved");
        if (
          action.recordId !== record.id ||
          action.generation !== record.generation ||
          !action.batchId
        )
          return denied("maintenance_batch_required");
        const batch = record.batches.find((entry) => entry.id === action.batchId);
        if (!batch || !outstanding.has(batch.state) || batch.cancellationRequestedAt)
          return denied("batch_not_admitted");
        if (batch.state === "uncertain" || batch.state === "reconciling")
          return denied("execution_uncertain");
        if (action.action === "dispatch" && batch.state !== "prepared")
          return denied("batch_already_accepted");
        if (
          ["execute", "prompt", "resume", "publish"].includes(action.action) &&
          batch.state !== "accepted"
        )
          return denied("batch_not_accepted");
        if (!record.lastAttempt?.complete || record.lastAttempt.failure)
          return denied("observation_incomplete");
        if (!record.observation?.complete || batch.headSha !== record.observation.headSha)
          return denied("stale_observation");
        if (
          record.lastAttempt.headSha !== record.observation.headSha ||
          record.lastAttempt.snapshotId !== record.observation.snapshotId
        )
          return denied("stale_observation");
        if (
          !prMaintenanceObservationFresh(
            record.observation,
            Date.now(),
            record.observationHostAt,
          )
        )
          return denied("stale_observation");
        if (record.observation.draft) return denied("draft");
        if (record.observation.mergeability === "conflicting")
          return denied("merge_conflict");
        if (record.incidents.some((incident) => !incident.resolvedAt))
          return denied("observation_recovery_required");
        if (
          action.action === "dispatch" &&
          !(
            worker.state === "idle" ||
            (["completed", "stopped"].includes(worker.state) && worker.agentSessionId)
          )
        )
          return denied("worker_unavailable");
      }
    }
    if (
      action.sessionId &&
      ["dispatch", "execute", "prompt", "resume"].includes(action.action) &&
      this.hasPendingManualExecution(action.sessionId)
    )
      return { allowed: false, reason: "manual_execution_unsettled" };
    return { allowed: true };
  }

  assertAdmission(input: PrMaintenanceAdmission): void {
    const result = this.admission(input);
    if (!result.allowed)
      refuse(
        result.reason!,
        `PR maintenance blocks ${input.action}: ${result.reason}${result.decisionId ? ` (${result.decisionId})` : ""}.`,
      );
  }

  /** Prevent plan replacement or ordinary retry from erasing reserved worker input. */
  assertPreparedStep(
    taskId: string,
    stepKey: string,
    prompt: string,
    placementId?: string,
    sessionId?: string,
  ): void {
    for (const record of this.list({ taskId, retainedOnly: true, limit: 100 }).records) {
      const batch = record.batches.find((entry) => entry.state === "prepared");
      if (!batch)
        refuse(
          "maintenance_batch_required",
          "Prepare a bounded maintenance batch before changing the retained worker's step.",
        );
      const step = this.store.getRunStepBySession(record.workerSessionId);
      if (
        !step ||
        step.stepKey !== stepKey ||
        batch.prompt !== prompt ||
        (placementId && placementId !== record.placementId) ||
        (sessionId && sessionId !== record.workerSessionId)
      )
        refuse(
          "worker_reserved",
          "The prepared exact prompt must continue the original retained step, worker and checkout.",
        );
      this.assertAdmission({
        action: "dispatch",
        taskId,
        sessionId: record.workerSessionId,
        recordId: record.id,
        generation: record.generation,
        batchId: batch.id,
      });
    }
  }

  /** Must be inside the same writeAtomically callback as the existing follow-up step write. */
  acceptBatch(
    leadSessionId: string,
    id: string,
    generation: number,
    batchId: string,
    stepId: string,
    attempt: number,
    prompt: string,
  ): PrMaintenanceRegistration {
    return this.store.writeAtomically(() => {
      const record = this.required(id, leadSessionId);
      const batch = record.batches.find((entry) => entry.id === batchId);
      if (record.generation !== generation || !batch)
        refuse(
          "stale_generation",
          "Batch does not belong to this registration generation.",
        );
      if (batch.prompt !== prompt)
        refuse("prompt_conflict", "Retry must use the exact prepared prompt.");
      if (batch.stepId) {
        if (batch.stepId === stepId && batch.attempt === attempt) return record;
        refuse(
          "batch_already_accepted",
          "Batch is already bound to a different step/attempt.",
        );
      }
      this.assertAdmission({
        action: "dispatch",
        leadSessionId,
        recordId: id,
        generation,
        batchId,
        taskId: record.taskId,
        sessionId: record.workerSessionId,
      });
      const step = this.store.getRunStep(stepId);
      if (
        !step ||
        step.runId !== record.taskId ||
        step.sessionId !== record.workerSessionId ||
        step.attempts !== attempt ||
        step.prompt !== prompt ||
        !["pending", "running"].includes(step.state)
      )
        refuse(
          "acceptance_mismatch",
          "Accepted step, retained worker, prompt and attempt must match the prepared batch.",
        );
      batch.state = "accepted";
      batch.stepId = stepId;
      batch.attempt = attempt;
      batch.updatedAt = nowIso();
      return this.save(record);
    });
  }

  referenceForStep(
    stepId: string,
    attempt?: number,
  ): { recordId: string; generation: number; batchId: string } | undefined {
    for (const record of this.retained()) {
      const batch = record.batches.find(
        (entry) =>
          entry.stepId === stepId &&
          (attempt === undefined || entry.attempt === attempt) &&
          outstanding.has(entry.state),
      );
      if (batch)
        return { recordId: record.id, generation: record.generation, batchId: batch.id };
    }
    return undefined;
  }

  checkpoint(
    leadSessionId: string,
    id: string,
    expectedVersion: number,
    input: z.input<typeof PrMaintenanceCheckpointSchema>,
    wakeId?: string,
  ): PrMaintenanceRegistration {
    const checkpoint: PrMaintenanceCheckpoint =
      PrMaintenanceCheckpointSchema.parse(input);
    return this.store.writeAtomically(() => {
      const record = this.required(id, leadSessionId, expectedVersion);
      if (record.ownershipReleasedAt)
        refuse("released", "Released history cannot admit new checkpoints or effects.");
      if (checkpoint.kind === "fallback") {
        const key = this.observationKey(checkpoint.observation, checkpoint.error);
        if (record.incidents.some((incident) => incident.lastObservationKey === key))
          return record;
        this.observe(record, checkpoint.observation, checkpoint.error);
      } else if (checkpoint.kind === "alternate_attempt") {
        if (!this.reserveAlternate(record, checkpoint, wakeId)) return record;
      } else if (checkpoint.kind === "alternate_observation") {
        if (!this.alternateObservation(record, checkpoint)) return record;
      } else if (checkpoint.kind === "observation") {
        this.observe(record, checkpoint.observation);
      } else if (checkpoint.kind === "prepare_batch") {
        if (!record.authorization.scope.publicationAuthorized)
          refuse(
            "publication_not_authorized",
            "Read-only maintenance cannot prepare repair or answer batches; an authenticated operator must explicitly authorize mutations.",
          );
        const prepared = checkpoint.batch;
        const prior = record.batches.find((batch) => batch.id === prepared.id);
        if (prior) {
          for (const key of [
            "kind",
            "sources",
            "headSha",
            "prompt",
            "scope",
            "reservedMutations",
          ] as const)
            if (!isDeepStrictEqual(prior[key], prepared[key]))
              refuse(
                "batch_conflict",
                "Batch key identifies immutable input; do not reconstruct its prompt.",
              );
          return record;
        }
        const admission = this.admission({
          action: "discover",
          recordId: id,
          leadSessionId,
        });
        if (!admission.allowed)
          refuse(admission.reason!, "Maintenance is held; cannot prepare repairs.");
        if (prMaintenanceUnsettled(record))
          refuse(
            "unsettled",
            "Reconcile the outstanding batch and lead effects before preparing new work.",
          );
        if (
          !record.observation?.complete ||
          !record.lastAttempt?.complete ||
          record.lastAttempt.failure ||
          record.lastAttempt.headSha !== record.observation.headSha ||
          record.lastAttempt.snapshotId !== record.observation.snapshotId ||
          !prMaintenanceObservationFresh(
            record.observation,
            Date.now(),
            record.observationHostAt,
          ) ||
          record.observation.state !== "open" ||
          prepared.headSha !== record.observation.headSha
        )
          refuse(
            "observation_incomplete",
            "Prepare requires a complete, consistent current-HEAD observation.",
          );
        if (
          record.observation.draft ||
          record.observation.mergeability === "conflicting" ||
          record.incidents.some((incident) => !incident.resolvedAt)
        )
          refuse(
            "observation_blocked",
            "Drafts, merge conflicts and unresolved observation incidents cannot admit repair or publication.",
          );
        const keys = new Set<string>();
        for (const source of prepared.sources) {
          const key = `${source.id}\0${source.revision}`;
          if (keys.has(key))
            refuse(
              "duplicate_source",
              "A batch cannot assign the same source revision twice.",
            );
          keys.add(key);
          if (
            !record.observation.sources.some(
              (entry) =>
                entry.id === source.id &&
                entry.revision === source.revision &&
                entry.evidence === source.evidence,
            )
          )
            refuse(
              "source_mismatch",
              "Batch sources must come from the current complete observation.",
            );
          const finding = record.findings.find(
            (entry) =>
              entry.source.id === source.id && entry.source.revision === source.revision,
          );
          if (
            finding &&
            ["addressed", "already_satisfied"].includes(finding.outcome) &&
            (finding.verifiedHeadSha ?? finding.publishedCommit) === prepared.headSha
          )
            refuse(
              "already_addressed",
              "Verified unchanged feedback must not dispatch again.",
            );
        }
        const budgetKey = prepared.kind === "repair" ? "repairBatches" : "answerBatches";
        if (
          record.counters[budgetKey] >= record.authorization.budgets[budgetKey] ||
          record.counters.mutationAttempts + prepared.reservedMutations >
            record.authorization.budgets.mutationAttempts
        )
          refuse(
            "budget_exhausted",
            "An authenticated operator must renew the exhausted maintenance allowance.",
          );
        record.counters[budgetKey]++;
        record.counters.mutationAttempts += prepared.reservedMutations;
        const now = nowIso();
        record.batches.push({
          ...prepared,
          generation: record.generation,
          authorizationId: record.authorization.id,
          state: "prepared",
          findings: [],
          effects: [],
          executionSettled: false,
          published: false,
          createdAt: now,
          updatedAt: now,
        });
      } else if (checkpoint.kind === "batch") {
        this.settleBatch(record, checkpoint);
      } else if (checkpoint.kind === "action") {
        this.effect(record, checkpoint.effect);
      } else if (checkpoint.kind === "ready") {
        if (
          !record.authorization.scope.publicationAuthorized ||
          record.lifecycle !== "active" ||
          record.decision?.state === "pending" ||
          prMaintenanceUnsettled(record) ||
          !record.observation?.complete ||
          !record.lastAttempt?.complete ||
          record.lastAttempt.failure ||
          record.lastAttempt.headSha !== record.observation.headSha ||
          record.lastAttempt.snapshotId !== record.observation.snapshotId ||
          !prMaintenanceObservationFresh(
            record.observation,
            Date.now(),
            record.observationHostAt,
          ) ||
          record.observation.draft ||
          record.observation.state !== "open" ||
          record.incidents.some((incident) => !incident.resolvedAt) ||
          record.observation.fingerprint !== checkpoint.fingerprint ||
          record.observation.mergeability !== "mergeable" ||
          !record.observation.checksComplete ||
          record.observation.checks.some(
            (check) =>
              check.state !== "passed" || check.headSha !== record.observation!.headSha,
          ) ||
          !record.observation.reviewsComplete ||
          record.observation.reviews.some(
            (review) =>
              review.state !== "approved" ||
              review.headSha !== record.observation!.headSha,
          ) ||
          record.observation.sources.some(
            (source) =>
              !record.findings.some(
                (finding) =>
                  finding.source.id === source.id &&
                  finding.source.revision === source.revision &&
                  (finding.verifiedHeadSha ?? finding.publishedCommit) ===
                    record.observation!.headSha &&
                  ["addressed", "already_satisfied"].includes(finding.outcome),
              ),
          )
        )
          refuse(
            "not_ready",
            "Readiness requires complete current-HEAD feedback/check/review/mergeability evidence, with no hold or unknown effects.",
          );
        record.readyFingerprint = checkpoint.fingerprint;
      } else {
        const progress =
          checkpoint.progress &&
          record.lastReconciliationEvidence !== checkpoint.evidence;
        record.counters.reconciliationStalls = progress
          ? 0
          : record.counters.reconciliationStalls + 1;
        record.lastReconciliationEvidence = checkpoint.evidence;
        if (record.counters.reconciliationStalls >= 3)
          this.pause(record, "reconciliation_stalled");
        if (checkpoint.immediateCheck && record.lifecycle === "active")
          record.nextCheckAt = nowIso();
      }
      if (
        checkpoint.kind !== "fallback" &&
        checkpoint.kind !== "alternate_attempt" &&
        checkpoint.kind !== "alternate_observation"
      )
        this.releaseTerminal(record);
      return this.save(record);
    });
  }

  private observationKey(observation: PrMaintenanceObservation, error?: string): string {
    return createHash("sha256")
      .update(JSON.stringify({ observation, error }))
      .digest("hex");
  }

  private incident(
    record: PrMaintenanceRegistration,
    observation: PrMaintenanceObservation,
    error: string,
    kind: PrMaintenanceIncident["kind"],
  ): PrMaintenanceIncident {
    const key = this.observationKey(observation, error);
    record.lastError = error;
    let incident = record.incidents.find(
      (entry) => entry.kind === kind && !entry.resolvedAt,
    );
    if (incident) {
      incident.lastError = error;
      incident.lastObservationKey = key;
      incident.updatedAt = nowIso();
      return incident;
    }
    if (record.incidents.length >= PR_MAINTENANCE_RECOVERY_LIMITS.incidents) {
      const archived = record.incidents.findIndex((entry) => entry.resolvedAt);
      if (archived < 0)
        refuse("incident_overflow", "Resolve existing incidents before recording more.");
      record.incidents.splice(archived, 1);
    }
    record.incidentCursor++;
    const effectKeys =
      kind === "effects"
        ? [
            ...new Set(
              [...record.actions, ...record.batches.flatMap((batch) => batch.effects)]
                .filter(
                  (effect) => effect.kind === "reply" && effect.state !== "not_performed",
                )
                .map((effect) => effect.key),
            ),
          ]
        : [];
    incident = {
      id: `${record.id}:${record.incidentCursor}`,
      sequence: record.incidentCursor,
      kind,
      error,
      lastError: error,
      ...(helperError(observation) ? { helperError: helperError(observation) } : {}),
      // Missing or oversized correlation remains held, never guessed from other receipts.
      effectKeys: effectKeys.length <= 200 ? effectKeys : [],
      observationKey: key,
      lastObservationKey: key,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      attempts: [],
    };
    record.incidents.push(incident);
    return incident;
  }

  private recoveryAllowed(record: PrMaintenanceRegistration): boolean {
    const task = this.store.getRun(record.taskId);
    const worker = this.store.getSession(record.workerSessionId);
    const lead = this.store.getSession(record.leadSessionId);
    return (
      record.authorization.scope.publicationAuthorized &&
      record.lifecycle === "active" &&
      !record.ownershipReleasedAt &&
      record.decision?.state !== "pending" &&
      !record.incidents.some(
        (incident) => !incident.resolvedAt && incident.kind !== "capability",
      ) &&
      !prMaintenanceInFlight(record) &&
      !this.binding(record) &&
      !!task &&
      ["running", "awaiting_lead", "completed"].includes(task.state) &&
      !!worker &&
      !worker.stopRequested &&
      !this.store.getSessionTransitionIntent(worker.id) &&
      !!lead &&
      !["stopped", "completed", "failed", "offline"].includes(lead.state) &&
      !lead.stopRequested &&
      !lead.dismissed &&
      !lead.cleanupRequested &&
      !this.store.getSessionTransitionIntent(lead.id)
    );
  }

  /** Claimed atomically with the existing durable lead queue, not a new scheduler. */
  pendingRecoveryWakes(): {
    recordId: string;
    leadSessionId: string;
    incidentId: string;
  }[] {
    return this.retained().flatMap((record) =>
      this.recoveryAllowed(record)
        ? record.incidents
            .filter(
              (incident) =>
                incident.kind === "capability" &&
                !incident.resolvedAt &&
                !incident.wakeQueuedAt &&
                incident.attempts.length < PR_MAINTENANCE_RECOVERY_LIMITS.attempts,
            )
            .map((incident) => ({
              recordId: record.id,
              leadSessionId: record.leadSessionId,
              incidentId: incident.id,
            }))
        : [],
    );
  }

  markRecoveryWake(recordId: string, incidentId: string, at = nowIso()): boolean {
    atSchema.parse(at);
    const record = this.required(recordId);
    const incident = record.incidents.find((entry) => entry.id === incidentId);
    if (
      !incident ||
      incident.resolvedAt ||
      incident.wakeQueuedAt ||
      incident.kind !== "capability" ||
      !this.recoveryAllowed(record) ||
      incident.attempts.length >= PR_MAINTENANCE_RECOVERY_LIMITS.attempts
    )
      return false;
    incident.wakeQueuedAt = at;
    record.nextCheckAt = at;
    this.save(record);
    return true;
  }

  private reserveAlternate(
    record: PrMaintenanceRegistration,
    checkpoint: Extract<PrMaintenanceCheckpoint, { kind: "alternate_attempt" }>,
    wakeId?: string,
  ): boolean {
    const incident = record.incidents.find((entry) => entry.id === checkpoint.incidentId);
    if (!incident)
      refuse("incident_unknown", "Read the current incident before recovery.");
    const previous = incident.attempts.find(
      (entry) => entry.id === checkpoint.resolutionId,
    );
    if (previous) {
      if (
        !isDeepStrictEqual(previous.provenance, checkpoint.provenance) ||
        previous.requests !== checkpoint.requests
      )
        refuse(
          "resolution_conflict",
          "An alternate attempt's provenance and allowance are immutable.",
        );
      return false;
    }
    if (
      incident.kind !== "capability" ||
      incident.resolvedAt ||
      !this.recoveryAllowed(record)
    )
      refuse(
        "recovery_held",
        "Recovery cannot clear a hold, authorization denial, Stop or uncertain execution.",
      );
    if (incident.attempts.length >= PR_MAINTENANCE_RECOVERY_LIMITS.attempts)
      refuse(
        "recovery_exhausted",
        "Alternate evidence attempts are exhausted; do not repeat them.",
      );
    if (!wakeId)
      refuse("wake_required", "Alternate evidence requires the Host-recorded lead turn.");
    const wake = this.wake(record.leadSessionId, wakeId);
    if (!wake.visitedIds.includes(record.id))
      refuse("visit_required", "Claim this registration in the bounded lead wake first.");
    this.chargeWake(record.leadSessionId, wakeId, {
      requests: checkpoint.requests,
      milliseconds: 0,
    });
    incident.attempts.push({
      id: checkpoint.resolutionId,
      wakeId,
      provenance: checkpoint.provenance,
      requests: checkpoint.requests,
      reservedAt: nowIso(),
      state: "reserved",
    });
    return true;
  }

  private alternateObservation(
    record: PrMaintenanceRegistration,
    checkpoint: Extract<PrMaintenanceCheckpoint, { kind: "alternate_observation" }>,
  ): boolean {
    const incident = record.incidents.find((entry) => entry.id === checkpoint.incidentId);
    const attempt = incident?.attempts.find(
      (entry) => entry.id === checkpoint.resolutionId,
    );
    if (!incident || !attempt)
      refuse(
        "resolution_not_reserved",
        "Reserve bounded alternate evidence before using any provider tool.",
      );
    const observation = checkpoint.observation;
    const key = this.observationKey(observation);
    if (attempt.observationKey) {
      if (attempt.observationKey !== key)
        refuse("resolution_conflict", "An alternate evidence receipt is immutable.");
      return false;
    }
    attempt.observationKey = key;
    attempt.attemptedAt = observation.attemptedAt;
    attempt.complete = observation.complete;
    attempt.receivedAt = nowIso();
    const reject = (error: string) => {
      attempt.state = "rejected";
      attempt.error = error;
      return true;
    };
    if (
      !prMaintenanceObservationFresh(observation) ||
      Date.parse(observation.attemptedAt) < Date.parse(attempt.reservedAt) ||
      ((record.lastAttemptLatestAt ?? record.lastAttemptAt) &&
        observation.attemptedAt < (record.lastAttemptLatestAt ?? record.lastAttemptAt)!)
    )
      return reject("stale_or_future_evidence");
    if (!observation.identity || !sameIdentity(observation.identity, record.identity)) {
      if (observation.identity) {
        this.incident(record, observation, observation.evidence, "identity");
        this.pause(record, "remote_identity_changed");
      }
      return reject("identity_mismatch");
    }
    if (
      observation.requestsConsumed > attempt.requests ||
      observation.elapsedMs > PR_MAINTENANCE_WAKE_LIMITS.milliseconds ||
      Date.now() - Date.parse(attempt.reservedAt) >
        PR_MAINTENANCE_WAKE_LIMITS.milliseconds ||
      this.remainingWake(record.leadSessionId, attempt.wakeId).milliseconds <= 0
    )
      return reject("alternate_allowance_exceeded");
    if (
      incident.resolvedAt ||
      incident.kind !== "capability" ||
      !this.recoveryAllowed(record)
    )
      return reject("recovery_held");
    this.observe(record, observation, undefined, true);
    attempt.state = incident.resolvedAt ? "resolved" : "incomplete";
    if (!observation.complete) attempt.error = observationError(observation);
    return true;
  }

  private observe(
    record: PrMaintenanceRegistration,
    observation: PrMaintenanceObservation,
    error = observationError(observation),
    alternate = false,
    hostAttemptedAt = observation.attemptedAt,
    hostLatestAt = hostAttemptedAt,
  ): void {
    if (!prMaintenanceObservationFresh(observation, Date.now(), hostAttemptedAt))
      refuse(
        "stale_observation",
        "Observation evidence must be no more than 30 minutes old and cannot be future-dated.",
      );
    if (
      (record.lastAttemptLatestAt ?? record.lastAttemptAt) &&
      hostAttemptedAt < (record.lastAttemptLatestAt ?? record.lastAttemptAt)!
    )
      refuse(
        "stale_observation",
        "An older observation cannot overwrite newer successful or incomplete evidence.",
      );
    const previous = record.lastAttempt;
    record.lastAttempt = observation;
    record.lastAttemptAt = hostAttemptedAt;
    if (hostLatestAt !== hostAttemptedAt) record.lastAttemptLatestAt = hostLatestAt;
    else delete record.lastAttemptLatestAt;
    record.nextCheckAt = new Date(
      Math.max(
        Date.parse(this.routineCheckAt(hostLatestAt)),
        observation.retryAfter
          ? Date.parse(observation.retryAfter) +
              Date.parse(hostAttemptedAt) -
              Date.parse(observation.attemptedAt)
          : 0,
      ),
    ).toISOString();
    const code = helperError(observation)?.code;
    if (
      code === "scope_changed" ||
      (observation.identity && !sameIdentity(observation.identity, record.identity))
    ) {
      this.incident(record, observation, error, "identity");
      this.pause(record, "remote_identity_changed");
      return;
    }
    if (code === "ambiguous_effect") {
      this.incident(record, observation, error, "effects");
      this.pause(record, "execution_or_effect_uncertain");
      return;
    }
    if (!observation.complete) {
      const failure = observation.failure;
      const providerDenied =
        failure === "auth" ||
        failure === "permission" ||
        [
          "authentication_required",
          "auth_required",
          "authentication",
          "permission_denied",
          "permission_required",
        ].includes(String(code));
      this.incident(
        record,
        observation,
        error,
        providerDenied ? "provider_denial" : "capability",
      );
      if (failure && failure !== "budget" && failure !== "incomplete") {
        record.counters.consecutiveFailures++;
        record.counters.totalFailures++;
      }
      const progress =
        observation.cursor &&
        (previous?.cursor !== observation.cursor ||
          previous?.revision !== observation.revision);
      record.counters.scanStalls = progress ? 0 : record.counters.scanStalls + 1;
      if (providerDenied) this.pause(record, "authorization_failed");
      else if (
        record.counters.consecutiveFailures >= 3 ||
        record.counters.totalFailures >= 10
      )
        this.pause(record, "observation_failures");
      else if (record.counters.scanStalls >= 3) this.pause(record, "scan_stalled");
      delete record.readyFingerprint;
      return;
    }
    record.observation = observation;
    if (hostAttemptedAt !== observation.attemptedAt)
      record.observationHostAt = hostAttemptedAt;
    else delete record.observationHostAt;
    record.lastSuccessAt = hostAttemptedAt;
    for (const batch of record.batches) {
      if (undispatchedBatch(batch) && batch.headSha !== observation.headSha)
        this.settleBatch(record, {
          kind: "batch",
          batchId: batch.id,
          generation: record.generation,
          state: "superseded",
          findings: batch.sources.map((source) => ({
            source,
            outcome: "superseded",
            stage: "not_attempted",
            evidence: [],
            responseRequired: true,
            responseIds: [],
            nextAction: "Prepare from the fresh observation at the new head.",
            progress: false,
          })),
          effects: [],
          executionSettled: true,
          usedMutations: 0,
          published: false,
          reason: "head_changed",
          evidence: "Observed head changed before dispatch; reserved allowance refunded.",
        });
    }
    if (!alternate) {
      record.counters.consecutiveFailures = 0;
      record.counters.scanStalls = 0;
      const effects = [
        ...record.actions,
        ...record.batches.flatMap((batch) => batch.effects),
      ];
      if (
        !record.batches.some((batch) => outstanding.has(batch.state)) &&
        !effects.some(unsettledEffect)
      ) {
        for (const incident of record.incidents) {
          if (
            incident.kind === "effects" &&
            !incident.resolvedAt &&
            incident.effectKeys.length > 0 &&
            incident.effectKeys.every(
              (key) =>
                observation.knownSelfEffectIds.includes(key) &&
                effects.some((effect) => effect.key === key && effect.state === "known"),
            )
          ) {
            incident.resolvedAt = nowIso();
            incident.resolution = "observation";
          }
        }
      }
    }
    if (
      this.recoveryAllowed(record) &&
      prMaintenanceObservationFresh(observation, Date.now(), hostAttemptedAt)
    ) {
      for (const incident of record.incidents) {
        if (
          incident.kind === "capability" &&
          !incident.resolvedAt &&
          observation.identity &&
          Date.parse(hostAttemptedAt) >= Date.parse(incident.createdAt)
        ) {
          incident.resolvedAt = nowIso();
          incident.resolution = alternate ? "alternate_observation" : "observation";
        }
      }
    }
    if (
      record.readyFingerprint !== observation.fingerprint ||
      observation.draft ||
      observation.mergeability !== "mergeable" ||
      !observation.checksComplete ||
      !observation.reviewsComplete ||
      observation.checks.some(
        (check) => check.state !== "passed" || check.headSha !== observation.headSha,
      ) ||
      observation.reviews.some(
        (review) => review.state !== "approved" || review.headSha !== observation.headSha,
      )
    )
      delete record.readyFingerprint;
    if (
      !alternate &&
      (observation.state === "merged" || observation.state === "closed")
    ) {
      record.lifecycle = observation.state;
      this.pause(record, "terminal_cancellation_requested", hostAttemptedAt);
      if (record.decision?.state === "pending") {
        record.decision = {
          ...record.decision,
          state: "withdrawn",
          direction: `Moot after verified PR ${observation.state}; not approved or fixed.`,
          resolvedAt: hostAttemptedAt,
        };
      }
    }
  }

  private refund(
    record: PrMaintenanceRegistration,
    batch: PrMaintenanceBatch,
    used: number,
    published: boolean,
  ): void {
    if (batch.usedMutations !== undefined) return;
    if (used > batch.reservedMutations)
      refuse(
        "allowance_exceeded",
        "Reported mutation attempts exceed the batch's reserved allowance.",
      );
    batch.usedMutations = used;
    if (batch.authorizationId === record.authorization.id) {
      record.counters.mutationAttempts -= batch.reservedMutations - used;
      if (batch.kind === "repair" && !published) record.counters.repairBatches--;
      if (batch.kind === "answer" && !batch.stepId) record.counters.answerBatches--;
    }
  }

  private settleBatch(
    record: PrMaintenanceRegistration,
    update: Extract<PrMaintenanceCheckpoint, { kind: "batch" }>,
  ): void {
    const batch = record.batches.find((entry) => entry.id === update.batchId);
    if (
      !batch ||
      update.generation !== record.generation ||
      batch.generation !== update.generation
    )
      refuse("stale_generation", "Batch receipt does not belong to this generation.");
    if (!outstanding.has(batch.state)) {
      if (
        batch.state === update.state &&
        isDeepStrictEqual(batch.findings, update.findings) &&
        isDeepStrictEqual(batch.effects, update.effects)
      )
        return;
      refuse("batch_settled", "A settled batch cannot be rewritten.");
    }
    if (
      batch.state === "prepared" &&
      !["failed", "cancelled", "superseded"].includes(update.state)
    )
      refuse("not_accepted", "A prepared batch is not execution evidence.");
    if (
      batch.state === "accepted" &&
      !["reconciling", "uncertain"].includes(update.state)
    )
      refuse(
        "reconciliation_required",
        "An accepted attempt must reconcile before final settlement.",
      );
    if (batch.executionSettled && !update.executionSettled)
      refuse("receipt_conflict", "A known execution receipt cannot become unknown.");
    if (update.executionSettled && batch.stepId) {
      const step = this.store.getRunStep(batch.stepId);
      const worker = this.store.getSession(record.workerSessionId);
      if (
        !step ||
        step.attempts !== batch.attempt ||
        !["succeeded", "failed", "cancelled", "skipped"].includes(step.state) ||
        !worker ||
        worker.stopRequested ||
        this.store.getSessionTransitionIntent(worker.id) ||
        !["idle", "completed", "stopped", "failed"].includes(worker.state)
      )
        refuse(
          "execution_unsettled",
          "A worker report or Stop request is not a correlated terminal RunStep receipt with a quiescent worker.",
        );
      if (["cancelled", "skipped"].includes(step.state) && !step.dispatchedAt)
        batch.executionNotDispatched = true;
    }
    if (batch.published && !update.published)
      refuse("receipt_conflict", "A verified published repair cannot be erased.");
    const verificationHeads = new Set([
      batch.headSha,
      ...update.findings.flatMap((finding) =>
        finding.publishedCommit ? [finding.publishedCommit] : [],
      ),
    ]);
    const findings = new Map<string, (typeof update.findings)[number]>();
    for (const finding of update.findings) {
      if (finding.verifiedHeadSha && !verificationHeads.has(finding.verifiedHeadSha))
        refuse(
          "verification_head_mismatch",
          "Verification must name this batch's base or an evidenced published commit.",
        );
      const key = `${finding.source.id}\0${finding.source.revision}`;
      if (
        findings.has(key) ||
        !batch.sources.some((source) => isDeepStrictEqual(source, finding.source))
      )
        refuse(
          "finding_mismatch",
          "Outcomes must uniquely match the batch's assigned source revisions.",
        );
      if (
        ["addressed", "already_satisfied"].includes(finding.outcome) &&
        (!finding.evidence.length ||
          (finding.responseRequired && !finding.responseIds.length))
      )
        refuse(
          "finding_evidence",
          "Completed findings require verification and their required response receipts.",
        );
      const old = batch.findings.find(
        (entry) =>
          entry.source.id === finding.source.id &&
          entry.source.revision === finding.source.revision,
      );
      const stages = [
        "not_attempted",
        "inspected",
        "modified",
        "verified",
        "committed",
        "published",
        "replied",
        "resolved",
      ];
      if (
        old &&
        ((old.publishedCommit && old.publishedCommit !== finding.publishedCommit) ||
          old.responseIds.some((response) => !finding.responseIds.includes(response)) ||
          stages.indexOf(old.stage) > stages.indexOf(finding.stage))
      )
        refuse(
          "receipt_conflict",
          "Do not erase verified intermediate commits or response receipts.",
        );
      findings.set(key, finding);
    }
    this.validateEffects(update.effects);
    this.preserveEffects(batch.effects, update.effects);
    const final = !outstanding.has(update.state);
    if (
      update.findings.some((finding) => finding.outcome === "needs_human") &&
      record.decision?.state !== "pending"
    )
      refuse(
        "human_decision_required",
        "Call maintenance-aware escalation to atomically record the question before checkpointing needs_human findings.",
      );
    if (
      final &&
      (!update.executionSettled ||
        update.effects.some(unsettledEffect) ||
        findings.size !== batch.sources.length ||
        update.usedMutations === undefined)
    )
      refuse(
        "unsettled",
        "Final settlement requires every finding, known effects, execution receipt and known allowance usage.",
      );
    if (
      update.state === "succeeded" &&
      update.findings.some(
        (finding) => !["addressed", "already_satisfied"].includes(finding.outcome),
      )
    )
      refuse(
        "incomplete_findings",
        "Worker completion does not establish all assigned findings were addressed.",
      );
    if (
      update.state === "partial" &&
      update.findings.some(
        (finding) =>
          !["addressed", "already_satisfied"].includes(finding.outcome) &&
          !finding.nextAction,
      )
    )
      refuse(
        "next_action_required",
        "Partial findings must retain explicit remaining stages and next actions.",
      );
    if (
      update.effects.reduce(
        (sum, effect) => sum + (effect.usedAttempts ?? effect.attempts),
        0,
      ) > batch.reservedMutations
    )
      refuse("allowance_exceeded", "Effects exceed the reserved worker allowance.");
    const knownPublications = new Set(
      record.batches.flatMap((entry) =>
        entry.findings.flatMap((finding) =>
          finding.publishedCommit ? [finding.publishedCommit] : [],
        ),
      ),
    );
    const published =
      update.published ||
      update.findings.some(
        (finding) =>
          finding.publishedCommit && !knownPublications.has(finding.publishedCommit),
      ) ||
      update.effects.some((effect) => effect.kind === "push" && effect.state === "known");
    const newPublication = published && !batch.published;
    if (
      final &&
      update.usedMutations! <
        update.effects.reduce(
          (sum, effect) => sum + (effect.usedAttempts ?? effect.attempts),
          0,
        )
    )
      refuse(
        "allowance_exceeded",
        "Known mutation attempts cannot be refunded as unused.",
      );
    if (final) this.refund(record, batch, update.usedMutations!, published);
    Object.assign(batch, {
      state: update.state,
      findings: update.findings,
      effects: update.effects,
      executionSettled: update.executionSettled,
      evidence: update.evidence,
      published,
      updatedAt: nowIso(),
      ...(update.reason ? { reason: update.reason } : {}),
    });
    for (const finding of update.findings) {
      const disposition = {
        ...finding,
        verifiedHeadSha:
          finding.verifiedHeadSha ??
          (published ? finding.publishedCommit : batch.headSha),
      };
      const index = record.findings.findIndex(
        (entry) =>
          entry.source.id === finding.source.id &&
          entry.source.revision === finding.source.revision,
      );
      if (index < 0) record.findings.push(disposition);
      else record.findings[index] = disposition;
    }
    if (update.findings.some((finding) => finding.outcome === "needs_human"))
      this.pause(record, "finding_needs_human");
    if (update.state === "uncertain") this.pause(record, "execution_or_effect_uncertain");
    if (final && batch.kind === "repair" && batch.stepId) {
      for (const groupKey of new Set(batch.sources.map((source) => source.groupKey))) {
        const group = update.findings.filter(
          (finding) => finding.source.groupKey === groupKey,
        );
        const revision = createHash("sha256")
          .update(
            record.observation?.fingerprint ??
              group
                .map((finding) => finding.source.revision)
                .sort()
                .join("|"),
          )
          .digest("hex");
        let prior = record.findingAttempts.find((entry) => entry.groupKey === groupKey);
        if (!prior) {
          prior = { groupKey, attempts: 0, revisions: [] };
          record.findingAttempts.push(prior);
        }
        prior.attempts = group.some((finding) => finding.progress)
          ? 0
          : prior.attempts + 1;
        prior.revisions = [...prior.revisions, revision].slice(-3);
        if (
          prior.attempts >= 2 ||
          (prior.revisions.length === 3 &&
            prior.revisions[0] === prior.revisions[2] &&
            prior.revisions[0] !== prior.revisions[1])
        )
          this.pause(record, "no_progress");
      }
    }
    if (newPublication) {
      // Retain historical evidence, but require a new observation attempt after a push.
      delete record.lastAttempt;
      delete record.readyFingerprint;
      record.nextCheckAt = nowIso();
    }
  }

  private validateEffects(effects: PrMaintenanceEffect[]): void {
    if (new Set(effects.map((effect) => effect.key)).size !== effects.length)
      refuse("duplicate_effect", "Effect keys must be unique.");
    for (const effect of effects) {
      if (
        effect.usedAttempts !== undefined &&
        (effect.usedAttempts > effect.attempts ||
          (effect.state === "known" && effect.usedAttempts === 0) ||
          (unsettledEffect(effect) && effect.usedAttempts !== effect.attempts))
      )
        refuse(
          "effect_usage",
          "Unused allowance may only be refunded from a known final outcome; a rejected request still consumes an attempt.",
        );
      if (effect.state === "known" && (!effect.evidence || !effect.providerId))
        refuse(
          "effect_evidence",
          "Known effects require provider identity and evidence.",
        );
      if (effect.state === "not_performed" && !effect.evidence)
        refuse("effect_evidence", "Refunds require evidence an effect did not occur.");
    }
  }

  private preserveEffects(
    previous: PrMaintenanceEffect[],
    next: PrMaintenanceEffect[],
  ): void {
    for (const old of previous) {
      const effect = next.find((entry) => entry.key === old.key);
      if (
        !effect ||
        old.kind !== effect.kind ||
        old.headSha !== effect.headSha ||
        old.recipient !== effect.recipient ||
        old.actor !== effect.actor ||
        old.actionIdentity !== effect.actionIdentity ||
        old.attempts !== effect.attempts ||
        (!unsettledEffect(old) &&
          (old.usedAttempts ?? old.attempts) !==
            (effect.usedAttempts ?? effect.attempts)) ||
        (old.providerId && old.providerId !== effect.providerId) ||
        (old.state === "known" && effect.state !== "known") ||
        (old.state === "not_performed" && effect.state !== "not_performed")
      )
        refuse(
          "effect_conflict",
          "Effect identity and known receipts are immutable; reconcile rather than repeat or forget them.",
        );
    }
  }

  private effect(record: PrMaintenanceRegistration, effect: PrMaintenanceEffect): void {
    this.validateEffects([effect]);
    const prior = record.actions.find((entry) => entry.key === effect.key);
    if (prior) {
      this.preserveEffects([prior], [effect]);
      if (isDeepStrictEqual(prior, effect)) return;
      if (unsettledEffect(prior) && !unsettledEffect(effect))
        record.counters.mutationAttempts -=
          prior.attempts - (effect.usedAttempts ?? prior.attempts);
      Object.assign(prior, effect);
      return;
    }
    if (!record.authorization.scope.publicationAuthorized)
      refuse(
        "publication_not_authorized",
        "Read-only maintenance cannot reserve provider mutations or new effects.",
      );
    if (effect.state !== "reserved")
      refuse(
        "effect_not_reserved",
        "Reserve a lead action before performing its external mutation.",
      );
    if (
      record.lifecycle !== "active" ||
      record.decision?.state === "pending" ||
      record.actions.some(unsettledEffect) ||
      record.batches.some(
        (batch) =>
          batch.stepId && !batch.executionSettled && !outstanding.has(batch.state),
      )
    )
      refuse(
        "held",
        "No new lead effect while maintenance is held or a previous result is unknown.",
      );
    if (
      !record.lastAttempt?.complete ||
      record.lastAttempt.failure ||
      effect.headSha !== record.observation?.headSha ||
      record.lastAttempt.headSha !== record.observation.headSha ||
      record.lastAttempt.snapshotId !== record.observation.snapshotId
    )
      refuse(
        "stale_observation",
        "Lead actions require a complete current-HEAD observation.",
      );
    if (
      !prMaintenanceObservationFresh(
        record.observation,
        Date.now(),
        record.observationHostAt,
      ) ||
      record.observation?.draft ||
      record.observation?.mergeability === "conflicting" ||
      record.incidents.some((incident) => !incident.resolvedAt)
    )
      refuse(
        "observation_blocked",
        "Fresh non-draft, non-conflicting evidence is required before new effects.",
      );
    const scope = record.authorization.scope;
    if (
      effect.kind === "review_request" &&
      (!effect.recipient || !scope.reviewers.includes(effect.recipient))
    )
      refuse(
        "reviewer_not_authorized",
        "Only explicitly configured reviewers may be requested.",
      );
    if (
      effect.kind === "ci_retry" &&
      (!scope.retryChecks ||
        record.actions.some(
          (entry) =>
            entry.kind === "ci_retry" &&
            entry.headSha === effect.headSha &&
            entry.actionIdentity === effect.actionIdentity &&
            !neverSentEffect(entry),
        ))
    )
      refuse(
        "retry_not_authorized",
        "Retry requires a grant and is allowed only once per HEAD/failure incident.",
      );
    if (!["review_request", "notification", "ci_retry"].includes(effect.kind))
      refuse(
        "worker_effect_required",
        "Pushes, replies and resolutions belong to a reserved worker batch.",
      );
    if (
      record.counters.mutationAttempts + effect.attempts >
      record.authorization.budgets.mutationAttempts
    )
      refuse(
        "budget_exhausted",
        "External mutation allowance exhausted; operator renewal required.",
      );
    if (
      record.actions.some(
        (entry) =>
          entry.kind === effect.kind &&
          entry.headSha === effect.headSha &&
          entry.recipient === effect.recipient &&
          entry.actionIdentity === effect.actionIdentity &&
          entry.state !== "not_performed",
      )
    )
      refuse(
        "obligation_already_attempted",
        "This substantive obligation already has a reserved or known action; reconcile its key.",
      );
    record.counters.mutationAttempts += effect.attempts;
    record.actions.push(effect);
  }

  private releaseTerminal(record: PrMaintenanceRegistration): void {
    if (
      ["merged", "closed"].includes(record.lifecycle) &&
      !prMaintenanceUnsettled(record) &&
      record.decision?.state !== "pending"
    ) {
      record.ownershipReleasedAt ??= nowIso();
      record.retentionReleasedBy ??= "verified_terminal_settlement";
    }
  }

  hasSessionRetentionBlockers(sessionId: string): boolean {
    if (this.hasPendingManualExecution(sessionId)) return true;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM pr_maintenance m
      LEFT JOIN sessions s ON s.id=?
      WHERE m.released_at IS NULL AND
        (m.worker_session_id=? OR m.lead_session_id=? OR m.task_id=s.run_id OR
          EXISTS(SELECT 1 FROM sessions required WHERE
            (required.id=m.worker_session_id OR required.id=m.lead_session_id)
            AND s.agent_session_id<>'' AND s.agent_session_id=required.agent_session_id
            AND s.node_id=required.node_id))
      LIMIT 1`,
        )
        .get(sessionId, sessionId, sessionId),
    );
  }

  assertTaskCleanupAllowed(taskId: string): void {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM pr_maintenance_manual_owners o JOIN pr_maintenance_manual_commands m ON m.session_id=o.session_id
       WHERE o.task_id=? AND m.state IN ('unknown','accepted','ambiguous_pending') LIMIT 1`,
        )
        .get(taskId)
    )
      refuse(
        "execution_uncertain",
        "Settle manual execution receipts before deleting its task or checkout.",
      );
    if (
      this.db
        .prepare(
          "SELECT 1 FROM pr_maintenance WHERE task_id=? AND released_at IS NULL LIMIT 1",
        )
        .get(taskId)
    )
      refuse(
        "maintenance_retention",
        "Release settled maintenance explicitly before deleting its task or checkout.",
      );
  }

  assertResourceCleanupAllowed(
    column: "workspace_id" | "placement_id" | "node_id",
    id: string,
  ): void {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM pr_maintenance_manual_owners o JOIN pr_maintenance_manual_commands m ON m.session_id=o.session_id
       WHERE o.${column}=? AND m.state IN ('unknown','accepted','ambiguous_pending') LIMIT 1`,
        )
        .get(id)
    )
      refuse(
        "maintenance_retention",
        "Unsettled manual execution retains its original task and checkout; preserve its receipts.",
      );
  }

  wakeEligibleLeadIds(): string[] {
    return [
      ...new Set(
        this.retained()
          .filter(
            (record) =>
              (!record.manualControl || Boolean(record.manualControl.endedAt)) &&
              ((record.lifecycle === "active" &&
                record.authorization.scope.publicationAuthorized) ||
                prMaintenanceUnsettled(record)) &&
              record.counters.reconciliationStalls < 3 &&
              record.counters.scanStalls < 3 &&
              !record.incidents.some(
                (incident) =>
                  !incident.resolvedAt &&
                  (incident.wakeQueuedAt ||
                    incident.attempts.length >= PR_MAINTENANCE_RECOVERY_LIMITS.attempts),
              ),
          )
          .map((record) => record.leadSessionId),
      ),
    ];
  }

  beginWake(
    leadSessionId: string,
    wakeId: string,
    at = nowIso(),
  ): z.infer<typeof PrMaintenanceWakeSchema> {
    actorSchema.parse(leadSessionId);
    wakeIdSchema.parse(wakeId);
    atSchema.parse(at);
    return this.store.writeAtomically(() => {
      const old = this.db
        .prepare(
          "SELECT data FROM pr_maintenance_wakes WHERE lead_session_id=? AND wake_id=?",
        )
        .get(leadSessionId, wakeId);
      if (old) return PrMaintenanceWakeSchema.parse(JSON.parse(String(old.data)));
      const wake = {
        leadSessionId,
        wakeId,
        startedAt: at,
        visits: 0,
        requests: 0,
        milliseconds: 0,
        visitedIds: [],
        observationClaims: [],
      };
      this.db
        .prepare("INSERT INTO pr_maintenance_wakes VALUES (?,?,?)")
        .run(leadSessionId, wakeId, JSON.stringify(wake));
      return wake;
    });
  }

  private wake(leadSessionId: string, wakeId: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM pr_maintenance_wakes WHERE lead_session_id=? AND wake_id=?",
      )
      .get(leadSessionId, wakeId);
    if (!row)
      refuse(
        "wake_required",
        "Begin the existing authenticated lead wake before charging maintenance work.",
      );
    return PrMaintenanceWakeSchema.parse(JSON.parse(String(row.data)));
  }

  private saveWake(wake: z.infer<typeof PrMaintenanceWakeSchema>): void {
    this.db
      .prepare(
        "UPDATE pr_maintenance_wakes SET data=? WHERE lead_session_id=? AND wake_id=?",
      )
      .run(
        JSON.stringify(PrMaintenanceWakeSchema.parse(wake)),
        wake.leadSessionId,
        wake.wakeId,
      );
  }

  private observationScope(record: PrMaintenanceRegistration): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          record.id,
          record.generation,
          record.identity,
          record.authorization.id,
          record.authorization.headSha,
          record.renewedAt,
          record.manualControl?.takenAt,
          record.leadSessionId,
          record.taskId,
          record.workerSessionId,
          record.placementId,
          record.checkoutKey,
          record.bindingGeneration,
        ]),
      )
      .digest("hex");
  }

  reserveObservation(
    leadSessionId: string,
    wakeId: string,
    recordId: string,
    requests: number,
  ) {
    return this.store.writeAtomically(() => {
      const record = this.required(recordId, leadSessionId);
      const before = this.wake(leadSessionId, wakeId);
      if (
        !before.visitedIds.includes(recordId) ||
        before.observationClaims.some((claim) => claim.recordId === recordId)
      )
        refuse(
          "visit_required",
          "Reserve observation once on the original claimed visit.",
        );
      this.chargeWake(leadSessionId, wakeId, { requests, milliseconds: 0 });
      const wake = this.wake(leadSessionId, wakeId);
      const claimedAt = nowIso();
      const deadlineAt = new Date(
        Math.min(
          Date.parse(wake.startedAt) + PR_MAINTENANCE_WAKE_LIMITS.milliseconds,
          Date.parse(claimedAt) +
            this.remainingWake(leadSessionId, wakeId, claimedAt).milliseconds,
        ),
      ).toISOString();
      wake.observationClaims.push({
        recordId,
        generation: record.generation,
        recordVersion: record.version,
        scopeKey: this.observationScope(record),
        claimedAt,
        deadlineAt,
        requests,
      });
      this.saveWake(wake);
      return { recordId, generation: record.generation, wakeId, deadlineAt };
    });
  }

  private observationExecution(execution: CommandExecution) {
    const ref = execution.maintenanceObservation;
    if (!ref)
      refuse(
        "receipt_unbound",
        "The execution was not bound to an observation reservation at creation.",
      );
    const record = this.required(ref.recordId, execution.leadSessionId);
    const wake = this.wake(execution.leadSessionId, ref.wakeId);
    const claim = wake.observationClaims.find((entry) => entry.recordId === record.id);
    if (
      !claim ||
      claim.generation !== ref.generation ||
      record.generation !== ref.generation ||
      claim.scopeKey !== this.observationScope(record) ||
      this.store.getRun(record.taskId)?.leadSessionId !== execution.leadSessionId ||
      this.binding(record)
    )
      refuse(
        "receipt_scope_changed",
        "Observation reservation owner, generation, authorization or binding no longer matches.",
      );
    return { ref, record, wake, claim };
  }

  bindObservationExecution(execution: CommandExecution): void {
    if (!execution.maintenanceObservation) return;
    const { ref, record, wake, claim } = this.observationExecution(execution);
    if (
      execution.taskId ||
      claim.executionId ||
      this.store.getSessionDispatchAttempt(execution.leadSessionId)?.commandId !==
        ref.wakeId ||
      claim.recordVersion !== record.version
    )
      refuse(
        "receipt_claim_conflict",
        "Bind exactly one separate helper execution to the unchanged reservation in its original lead turn.",
      );
    claim.executionId = execution.id;
    claim.attemptId = execution.attemptId;
    this.saveWake(wake);
    this.assertObservationExecution(execution);
  }

  assertObservationExecution(execution: CommandExecution): void {
    if (!execution.maintenanceObservation) return;
    const { record, claim } = this.observationExecution(execution);
    if (claim.executionId !== execution.id || claim.attemptId !== execution.attemptId)
      refuse(
        "receipt_claim_conflict",
        "This execution does not own the observation reservation.",
      );
    if (Date.now() >= Date.parse(claim.deadlineAt))
      refuse(
        "wake_exhausted",
        "The original helper deadline expired; do not restart it on command creation or approval.",
      );
    this.assertAdmission({
      action: "discover",
      recordId: record.id,
      leadSessionId: execution.leadSessionId,
    });
  }

  observationBudget(execution: CommandExecution) {
    const ref = execution.maintenanceObservation;
    if (!ref) return undefined;
    const claim = this.wake(execution.leadSessionId, ref.wakeId).observationClaims.find(
      (entry) =>
        entry.recordId === ref.recordId &&
        entry.generation === ref.generation &&
        entry.executionId === execution.id &&
        entry.attemptId === execution.attemptId,
    );
    if (!claim)
      refuse("receipt_claim_conflict", "Missing original command observation budget.");
    return { deadlineAt: claim.deadlineAt, requests: claim.requests };
  }

  checkpointObservationReceipt(
    leadSessionId: string,
    recordId: string,
    expectedVersion: number,
    executionId: string,
    input: PrMaintenanceObservation,
  ): PrMaintenanceRegistration {
    return this.store.writeAtomically(() => {
      const execution = this.store.commands.get(executionId);
      if (
        !execution ||
        execution.leadSessionId !== leadSessionId ||
        execution.maintenanceObservation?.recordId !== recordId
      )
        refuse(
          "receipt_owner",
          "Use the owned execution bound to this exact observation reservation.",
        );
      const { record, claim, wake } = this.observationExecution(execution);
      if (claim.executionId !== execution.id || claim.attemptId !== execution.attemptId)
        refuse(
          "receipt_claim_conflict",
          "Execution/attempt does not match the persisted observation claim.",
        );
      if (execution.outputBytes > 1_048_576)
        refuse("receipt_overflow", "Helper output exceeds 1 MiB.");
      if (
        !execution.approvedAt ||
        !this.store.commands.preparationClock(execution.id)?.acceptedAt ||
        !execution.descriptor ||
        !execution.settledAt ||
        execution.ownership !== "quiescent" ||
        !execution.outcomeKnown ||
        !execution.outputComplete ||
        execution.gaps.length ||
        execution.descendantCleanupForced ||
        !["succeeded", "failed"].includes(execution.state) ||
        ![0, 2].includes(execution.exitCode ?? -1)
      )
        refuse(
          "receipt_incomplete",
          "Require an approved, quiescent, known helper exit with complete bounded output and no gaps.",
        );
      const chunks: Buffer[] = [];
      let sequence = 0;
      let bytes = 0;
      for (;;) {
        const page = this.store.commands.page(
          execution.id,
          sequence,
          COMMAND_LIMITS.pageBytes,
        );
        for (const event of page.events) {
          if (event.sequence !== sequence + 1 || event.attemptId !== execution.attemptId)
            refuse(
              "receipt_incomplete",
              "Output must be contiguous and belong to the original attempt.",
            );
          sequence = event.sequence;
          const data = Buffer.from(event.data, "base64");
          bytes += data.length;
          if (bytes > 1_048_576)
            refuse("receipt_overflow", "Helper output exceeds 1 MiB.");
          if (event.stream === "stdout") chunks.push(data);
        }
        if (!page.hasMore) break;
        if (!page.events.length) refuse("receipt_incomplete", "Output made no progress.");
      }
      if (sequence !== execution.finalOutputSeq)
        refuse(
          "receipt_incomplete",
          "Output does not match the terminal receipt watermark.",
        );
      let json: unknown;
      try {
        json = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        );
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
        refuse(
          "receipt_invalid",
          "Helper stdout must be one complete UTF-8 JSON result.",
        );
      }
      const pending = [{ value: json, depth: 0 }];
      while (pending.length) {
        const { value, depth } = pending.pop()!;
        if (depth > 32 || (Array.isArray(value) && value.length > 200))
          refuse(
            "receipt_overflow",
            "Helper output exceeds the 200-item/32-depth bounds.",
          );
        if (value && typeof value === "object")
          for (const child of Object.values(value))
            pending.push({ value: child, depth: depth + 1 });
      }
      const parsed = z
        .object({
          schemaVersion: z.literal(1),
          complete: z.boolean(),
          requestsConsumed: z.number().int().nonnegative(),
          elapsedMs: z.number().int().nonnegative(),
          observation: z.unknown(),
          error: z.unknown().optional(),
          snapshot: z
            .object({
              generation: z.number().int().positive(),
              identity: PrMaintenanceHelperSnapshotIdentitySchema,
              headSha: PrMaintenanceObservationSchema.shape.headSha.unwrap(),
              baseSha: PrMaintenanceObservationSchema.shape.baseSha.unwrap(),
              state: PrMaintenanceObservationSchema.shape.state.unwrap(),
              isDraft: z.boolean(),
              actionableFingerprint:
                PrMaintenanceObservationSchema.shape.fingerprint.unwrap(),
            })
            .optional(),
        })
        .safeParse(json);
      if (!parsed.success)
        refuse(
          "receipt_invalid",
          "Helper stdout does not match the version-1 result contract.",
        );
      const result = parsed.data;
      const observation = PrMaintenanceObservationSchema.parse(input);
      if (
        !isDeepStrictEqual(result.observation, observation) ||
        result.complete !== observation.complete ||
        result.requestsConsumed !== observation.requestsConsumed ||
        result.elapsedMs !== observation.elapsedMs ||
        execution.exitCode !== (observation.complete ? 0 : 2) ||
        (observation.complete && !result.snapshot) ||
        (observation.complete && result.error !== undefined) ||
        (!observation.complete && result.snapshot) ||
        (!observation.complete &&
          (!observation.failure ||
            typeof helperError(observation)?.code !== "string" ||
            !isDeepStrictEqual(result.error, helperError(observation)))) ||
        (result.snapshot &&
          (result.snapshot.generation !== claim.generation ||
            !sameIdentity(result.snapshot.identity, record.identity) ||
            result.snapshot.headSha !== observation.headSha ||
            result.snapshot.baseSha !== observation.baseSha ||
            result.snapshot.state !== observation.state ||
            result.snapshot.isDraft !== observation.draft ||
            result.snapshot.actionableFingerprint !== observation.snapshotId ||
            result.snapshot.actionableFingerprint !== observation.fingerprint)) ||
        (observation.identity && !sameIdentity(observation.identity, record.identity))
      )
        refuse(
          "receipt_mismatch",
          "Checkpoint must equal the exact helper observation in this execution's stdout.",
        );
      const proof = this.store.commands.preparationClock(execution.id)!;
      const descriptor = execution.descriptor;
      const prepared = descriptor.prepared;
      const rawReceipt = this.store.commands.attempt(execution.id)?.receipt;
      const receipt =
        rawReceipt && CommandReceiptSchema.safeParse(JSON.parse(String(rawReceipt)));
      if (
        !receipt ||
        !receipt.success ||
        !receipt.data.settledAt ||
        proof.elapsedMs === null ||
        proof.elapsedMs < 0 ||
        proof.elapsedMs > COMMAND_LIMITS.clockUncertaintyMs ||
        proof.hostTime !== descriptor.hostTime ||
        prepared.clockUncertaintyMs !== COMMAND_LIMITS.clockUncertaintyMs ||
        Date.parse(prepared.preparedAt) + prepared.hostClockOffsetMs !==
          Date.parse(proof.hostTime) ||
        Date.parse(proof.acceptedAt!) < Date.parse(proof.hostTime) ||
        Date.parse(proof.acceptedAt!) - Date.parse(proof.hostTime) >
          COMMAND_LIMITS.clockUncertaintyMs ||
        Date.parse(execution.approvedAt) < Date.parse(proof.acceptedAt!) ||
        descriptor.observationBudget?.deadlineAt !== claim.deadlineAt ||
        descriptor.observationBudget.requests !== claim.requests ||
        createHash("sha256").update(commandDigestPayload(descriptor)).digest("hex") !==
          descriptor.digest ||
        receipt.data.digest !== descriptor.digest ||
        receipt.data.attemptId !== execution.attemptId
      )
        refuse(
          "receipt_clock",
          "The original approved command clock proof is missing or inconsistent.",
        );
      const rawAttempted = Date.parse(observation.attemptedAt);
      const rawFinished = rawAttempted + observation.elapsedMs;
      const attempted = rawAttempted + prepared.hostClockOffsetMs;
      const finished = attempted + observation.elapsedMs;
      const uncertainty = prepared.clockUncertaintyMs + COMMAND_LIMITS.clockDriftMs;
      const deadline = Date.parse(claim.deadlineAt);
      const settled = Date.parse(execution.settledAt);
      const late = finished + uncertainty > deadline;
      const earliest = Math.max(
        attempted - COMMAND_LIMITS.clockDriftMs,
        Date.parse(claim.claimedAt),
        Date.parse(execution.createdAt),
        Date.parse(execution.approvedAt),
      );
      const latest = Math.min(attempted + uncertainty, settled, Date.now());
      // An in-flight failure can finish late; the deadline still forbids new reads.
      if (
        observation.requestsConsumed > claim.requests ||
        earliest > latest ||
        rawAttempted < Date.parse(prepared.preparedAt) ||
        (receipt.data.startedAt && rawAttempted < Date.parse(receipt.data.startedAt)) ||
        rawFinished > Date.parse(receipt.data.settledAt!) ||
        finished - COMMAND_LIMITS.clockDriftMs > settled ||
        finished - COMMAND_LIMITS.clockDriftMs > Date.now() ||
        attempted + uncertainty < Date.parse(execution.approvedAt) ||
        Date.now() < Date.parse(proof.acceptedAt!) ||
        (observation.requestsConsumed > 0 && attempted >= deadline) ||
        (observation.complete && late)
      )
        refuse(
          "receipt_allowance",
          "Receipt usage/timing exceeds its original reservation; deadlines and charges never reset.",
        );
      const hash = this.observationKey(observation);
      if (claim.receiptHash) {
        if (claim.receiptHash !== hash)
          refuse("receipt_conflict", "This claim already saved a different result.");
        return record;
      }
      this.required(recordId, leadSessionId, expectedVersion);
      const admission = this.admission({ action: "discover", recordId, leadSessionId });
      const hostAttemptedAt = new Date(earliest).toISOString();
      const hostLatestAt = new Date(latest).toISOString();
      if (
        (record.lastAttemptLatestAt ?? record.lastAttemptAt) &&
        (record.lastAttemptLatestAt ?? record.lastAttemptAt)! >= hostAttemptedAt &&
        !isDeepStrictEqual(record.lastAttempt, observation)
      )
        refuse(
          "stale_observation",
          "Old command evidence cannot overwrite a newer attempt.",
        );
      if (
        !late &&
        helperError(observation)?.code !== "clock_unverified" &&
        admission.allowed &&
        !prMaintenanceInFlight(record) &&
        prMaintenanceObservationFresh(observation, Date.now(), hostAttemptedAt)
      ) {
        this.observe(
          record,
          observation,
          undefined,
          false,
          hostAttemptedAt,
          hostLatestAt,
        );
        this.releaseTerminal(record);
        if (
          observation.complete &&
          record.lifecycle === "active" &&
          !record.ownershipReleasedAt
        )
          record.nextCheckAt = nowIso();
      } else {
        // Settling exact evidence cannot revive a hold or promote late/stale feedback.
        record.lastAttempt = observation;
        record.lastAttemptAt = hostAttemptedAt;
        if (hostLatestAt !== hostAttemptedAt) record.lastAttemptLatestAt = hostLatestAt;
        else delete record.lastAttemptLatestAt;
        delete record.readyFingerprint;
      }
      const saved = this.save(record);
      claim.receiptHash = hash;
      this.saveWake(wake);
      return saved;
    });
  }

  remainingWake(leadSessionId: string, wakeId: string, at = nowIso()) {
    const wake = this.wake(leadSessionId, wakeId);
    return {
      visits: Math.max(0, PR_MAINTENANCE_WAKE_LIMITS.visits - wake.visits),
      requests: Math.max(0, PR_MAINTENANCE_WAKE_LIMITS.requests - wake.requests),
      milliseconds: Math.max(
        0,
        PR_MAINTENANCE_WAKE_LIMITS.milliseconds -
          Math.max(wake.milliseconds, Date.parse(at) - Date.parse(wake.startedAt)),
      ),
    };
  }

  chargeWake(
    leadSessionId: string,
    wakeId: string,
    charge: { requests: number; milliseconds: number },
    at = nowIso(),
  ) {
    const usage = z
      .object({
        requests: z.number().int().min(0).max(40),
        milliseconds: z
          .number()
          .int()
          .min(0)
          .max(PR_MAINTENANCE_WAKE_LIMITS.milliseconds),
      })
      .strict()
      .parse(charge);
    return this.store.writeAtomically(() => {
      const wake = this.wake(leadSessionId, wakeId);
      const remaining = this.remainingWake(leadSessionId, wakeId, at);
      if (
        remaining.requests <= 0 ||
        remaining.milliseconds <= 0 ||
        usage.requests > remaining.requests ||
        usage.milliseconds > remaining.milliseconds
      )
        refuse(
          "wake_exhausted",
          "End this maintenance pass; continue on the next existing lead wake.",
        );
      wake.requests += usage.requests;
      wake.milliseconds += usage.milliseconds;
      this.db
        .prepare(
          "UPDATE pr_maintenance_wakes SET data=? WHERE lead_session_id=? AND wake_id=?",
        )
        .run(JSON.stringify(wake), leadSessionId, wakeId);
      return this.remainingWake(leadSessionId, wakeId, at);
    });
  }

  /**
   * When a PR last read at `observedAt` is next due for a routine look: the
   * orchestrator's next heartbeat that is not right on top of that read. PRs
   * are only read on Lead wakes, so a finer cadence would only ever be spent by
   * unrelated wakes, re-reading a PR its worker is still busy with.
   */
  private routineCheckAt(observedAt: string): string {
    const observed = Date.parse(observedAt);
    return new Date(
      nextHeartbeat(this.store.getOrchestratorHeartbeatSchedule(), observed) ??
        observed + ROUTINE_CHECK_FALLBACK_MS,
    ).toISOString();
  }

  /**
   * The retained worker is still working an accepted batch. Reading its PR
   * meanwhile only sees the state the worker is about to change, and repair
   * turns routinely outlast an hour; the Host requests a check when the turn
   * completes, and the settled step wakes the Lead to reconcile it.
   */
  private repairInProgress(record: PrMaintenanceRegistration): boolean {
    return record.batches.some((batch) => {
      if (batch.state !== "accepted" || !batch.stepId || batch.executionSettled)
        return false;
      const step = this.store.getRunStep(batch.stepId);
      return Boolean(
        step && step.attempts === batch.attempt && !terminalRunStepStates.has(step.state),
      );
    });
  }

  takeDue(
    leadSessionId: string,
    wakeId: string,
    at = nowIso(),
  ): PrMaintenanceRegistration | undefined {
    atSchema.parse(at);
    return this.store.writeAtomically(() => {
      const wake = this.wake(leadSessionId, wakeId);
      const remaining = this.remainingWake(leadSessionId, wakeId, at);
      if (!remaining.visits || !remaining.requests || !remaining.milliseconds)
        return undefined;
      const row = this.db
        .prepare("SELECT data FROM pr_maintenance_scans WHERE lead_session_id=?")
        .get(leadSessionId);
      let scan = row
        ? PrMaintenanceScanSchema.parse(JSON.parse(String(row.data)))
        : undefined;
      const eligible = (record: PrMaintenanceRegistration) =>
        !record.ownershipReleasedAt &&
        (!record.manualControl || Boolean(record.manualControl.endedAt)) &&
        record.leadSessionId === leadSessionId &&
        ((record.lifecycle === "active" &&
          record.authorization.scope.publicationAuthorized) ||
          prMaintenanceUnsettled(record)) &&
        record.counters.scanStalls < 3 &&
        record.counters.reconciliationStalls < 3 &&
        !this.repairInProgress(record);
      if (!scan?.unservedIds.length) {
        const ids = this.retained()
          .filter(
            (record) =>
              eligible(record) &&
              (record.nextCheckAt <= at ||
                (this.recoveryAllowed(record) &&
                  record.incidents.some(
                    (incident) =>
                      incident.kind === "capability" &&
                      !incident.resolvedAt &&
                      incident.attempts.length < PR_MAINTENANCE_RECOVERY_LIMITS.attempts,
                  ))),
          )
          .sort(
            (a, b) =>
              a.nextCheckAt.localeCompare(b.nextCheckAt) || a.id.localeCompare(b.id),
          )
          .map((record) => record.id);
        scan = PrMaintenanceScanSchema.parse({
          leadSessionId,
          cutoff: at,
          unservedIds: ids,
        });
      }
      let chosen: PrMaintenanceRegistration | undefined;
      while (scan.unservedIds.length) {
        const id = scan.unservedIds[0]!;
        const record = this.get(id);
        if (record && eligible(record) && wake.visitedIds.includes(id)) break;
        scan.unservedIds.shift();
        if (!record || !eligible(record)) continue;
        chosen = record;
        wake.visits++;
        wake.visitedIds.push(record.id);
        break;
      }
      this.db
        .prepare(
          `INSERT INTO pr_maintenance_scans VALUES (?,?)
        ON CONFLICT(lead_session_id) DO UPDATE SET data=excluded.data`,
        )
        .run(leadSessionId, JSON.stringify(scan));
      this.db
        .prepare(
          "UPDATE pr_maintenance_wakes SET data=? WHERE lead_session_id=? AND wake_id=?",
        )
        .run(JSON.stringify(wake), leadSessionId, wakeId);
      return chosen;
    });
  }

  notifyLongPauses(
    at: string,
    notify: (record: PrMaintenanceRegistration) => void,
  ): number {
    atSchema.parse(at);
    return this.store.writeAtomically(() => {
      let count = 0;
      for (const record of this.retained()) {
        if (
          record.lifecycle !== "paused" ||
          record.pausedNoticeAt ||
          !record.pausedAt ||
          Date.parse(at) -
            Math.max(Date.parse(record.pausedAt), Date.parse(record.renewedAt)) <
            30 * 24 * 60 * 60 * 1_000
        )
          continue;
        record.pausedNoticeAt = at;
        notify(record);
        this.save(record);
        count++;
      }
      return count;
    });
  }

  exportBackup(): PrMaintenanceBackup {
    return PrMaintenanceBackupSchema.parse({
      schemaVersion: 1,
      registrations: this.db
        .prepare("SELECT data FROM pr_maintenance ORDER BY id")
        .all()
        .map((row) => JSON.parse(String(row.data))),
      wakes: this.db
        .prepare("SELECT data FROM pr_maintenance_wakes ORDER BY lead_session_id,wake_id")
        .all()
        .map((row) => JSON.parse(String(row.data))),
      scans: this.db
        .prepare("SELECT data FROM pr_maintenance_scans ORDER BY lead_session_id")
        .all()
        .map((row) => JSON.parse(String(row.data))),
      proposals: this.db
        .prepare("SELECT data FROM pr_maintenance_proposals ORDER BY task_id")
        .all()
        .map((row) => JSON.parse(String(row.data))),
      manualCommands: this.db
        .prepare(
          "SELECT session_id,data FROM pr_maintenance_manual_commands WHERE state NOT IN ('ambiguous_pending','ambiguous_settled') ORDER BY session_id,command_id",
        )
        .all()
        .map((row) => ({
          sessionId: String(row.session_id),
          command: JSON.parse(String(row.data)),
        })),
      manualConflicts: this.db
        .prepare(
          `SELECT c.session_id,c.data FROM pr_maintenance_manual_conflicts c
         JOIN pr_maintenance_manual_commands m ON m.session_id=c.session_id AND m.command_id=c.command_id
         WHERE m.state IN ('ambiguous_pending','ambiguous_settled') ORDER BY c.session_id,c.command_id,c.claim_hash`,
        )
        .all()
        .map((row) => ({
          sessionId: String(row.session_id),
          command: JSON.parse(String(row.data)),
        })),
      manualOwners: this.db
        .prepare(
          "SELECT * FROM pr_maintenance_manual_owners ORDER BY session_id,task_id,placement_id,node_id,workspace_id,checkout_key",
        )
        .all()
        .map((row) => ({
          sessionId: String(row.session_id),
          taskId: String(row.task_id),
          placementId: String(row.placement_id),
          nodeId: String(row.node_id),
          workspaceId: String(row.workspace_id),
          checkoutKey: String(row.checkout_key),
        })),
    });
  }

  /** Called inside the catalog restore transaction. Portable authority needs reconciling. */
  importBackup(input: PrMaintenanceBackup | undefined): void {
    const backup = input ? PrMaintenanceBackupSchema.parse(input) : undefined;
    this.db.exec(
      "DELETE FROM pr_maintenance; DELETE FROM pr_maintenance_wakes; DELETE FROM pr_maintenance_scans; DELETE FROM pr_maintenance_proposals; DELETE FROM pr_maintenance_manual_commands; DELETE FROM pr_maintenance_manual_conflicts; DELETE FROM pr_maintenance_manual_owners;",
    );
    for (const owner of backup?.manualOwners ?? []) this.saveManualOwner(owner);
    for (const { sessionId, command } of [
      ...(backup?.manualCommands ?? []),
      ...(backup?.manualConflicts ?? []),
    ]) {
      this.rememberManualOwner(sessionId);
      this.importManualCommand(sessionId, command);
    }
    for (const record of backup?.registrations ?? []) {
      this.rememberManualOwner(record.workerSessionId, record);
      for (const command of record.manualControl?.commands ?? [])
        this.importManualCommand(record.workerSessionId, command);
    }
    for (const { sessionId, command } of backup?.manualConflicts ?? [])
      this.quarantineManualOperation(sessionId, command.id);
    for (const record of backup?.registrations ?? []) {
      if (!record.ownershipReleasedAt) {
        if (record.lifecycle === "active") record.lifecycle = "paused";
        record.pauseReason = "portable_restore_requires_operator_reconciliation";
        const pausedAt = nowIso();
        record.pausedAt ??= pausedAt;
        record.pauseOrigin = {
          actor: "system",
          actorId: "host",
          at: pausedAt,
        };
        for (const batch of record.batches) {
          if (batch.state === "accepted") {
            batch.state = "uncertain";
            batch.cancellationRequestedAt ??= nowIso();
          }
        }
      }
      this.write(record, true);
    }
    for (const wake of backup?.wakes ?? [])
      this.db
        .prepare("INSERT INTO pr_maintenance_wakes VALUES (?,?,?)")
        .run(wake.leadSessionId, wake.wakeId, JSON.stringify(wake));
    for (const scan of backup?.scans ?? [])
      this.db
        .prepare("INSERT INTO pr_maintenance_scans VALUES (?,?)")
        .run(scan.leadSessionId, JSON.stringify(scan));
    for (const proposal of backup?.proposals ?? [])
      this.db
        .prepare("INSERT INTO pr_maintenance_proposals(task_id,data) VALUES (?,?)")
        .run(proposal.registration.taskId, JSON.stringify(proposal));
  }
}
