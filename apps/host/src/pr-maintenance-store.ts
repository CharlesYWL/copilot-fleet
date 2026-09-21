import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
  PR_MAINTENANCE_CADENCE_MS,
  PR_MAINTENANCE_RECOVERY_LIMITS,
  PR_MAINTENANCE_WAKE_LIMITS,
  prMaintenanceObservationFresh,
  prMaintenanceProviderKey,
  PrMaintenanceAdmissionSchema,
  PrMaintenanceBackupSchema,
  PrMaintenanceCheckpointSchema,
  PrMaintenanceDecisionInputSchema,
  PrMaintenanceEnableSchema,
  PrMaintenanceOperatorActionSchema,
  PrMaintenanceProposalSchema,
  PrMaintenanceRegistrationSchema,
  PrMaintenanceScanSchema,
  PrMaintenanceWakeSchema,
  type PrMaintenanceAdmission,
  type PrMaintenanceBackup,
  type PrMaintenanceBatch,
  type PrMaintenanceCheckpoint,
  type PrMaintenanceEffect,
  type PrMaintenanceIdentity,
  type PrMaintenanceIncident,
  type PrMaintenanceObservation,
  type PrMaintenanceOperatorAction,
  type PrMaintenanceProposal,
  type PrMaintenanceRegistration,
} from "@fleet/protocol";
import type { FleetStore } from "./store.js";

const outstanding = new Set(["prepared", "accepted", "reconciling", "uncertain"]);
const unsettledEffect = (effect: PrMaintenanceEffect) =>
  effect.state === "reserved" || effect.state === "uncertain";
const neverSentEffect = (effect: PrMaintenanceEffect) =>
  effect.state === "not_performed" && effect.usedAttempts === 0;
const nowIso = () => new Date().toISOString();
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
    record.incidents.some(
      (incident) => incident.kind === "effects" && !incident.resolvedAt,
    ) ||
    record.batches.some(
      (batch) =>
        outstanding.has(batch.state) ||
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
    `);
    if (
      Number(db.prepare("SELECT version FROM pr_maintenance_schema").get()?.version) !== 1
    )
      refuse(
        "schema_version",
        "This Host does not support the maintenance registry schema.",
      );
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
      if (this.retained().some((record) => record.taskId === task.id))
        refuse(
          "already_registered",
          "This task already retains maintenance; use its existing registration.",
        );
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
        isDeepStrictEqual(previous.binding, binding)
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
        binding,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
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
      return this.enableFromOperator(proposal.registration, actorId);
    });
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
      record.decisionHistory.length > 100
    )
      refuse(
        "checkpoint_overflow",
        "The bounded checkpoint is full; settle pending work and archive its history explicitly, without discarding pending findings.",
      );
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
    return { task, worker, lead };
  }

  /** This is an operator-route seam; never expose it as an MCP/model capability. */
  enableFromOperator(
    input: z.input<typeof PrMaintenanceEnableSchema>,
    actorId: string,
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
        },
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
      this.db
        .prepare("DELETE FROM pr_maintenance_proposals WHERE task_id=?")
        .run(task.id);
      return saved;
    });
  }

  private pause(record: PrMaintenanceRegistration, reason: string, at = nowIso()): void {
    if (record.lifecycle === "active") {
      record.lifecycle = "paused";
      record.pausedAt = at;
    }
    record.pauseReason = reason;
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
      const now = nowIso();
      if (action.action === "pause") {
        this.pause(record, action.reason, now);
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
        this.pause(record, action.reason, now);
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
        record.authorization = {
          id: randomUUID(),
          operatorId,
          issuedAt: now,
          headSha: record.observation?.headSha ?? record.authorization.headSha,
          scope: action.scope ?? record.authorization.scope,
          budgets: action.budgets ?? record.authorization.budgets,
        };
        record.counters = emptyCounters();
        record.findingAttempts = [];
        record.renewedAt = now;
        delete record.pausedNoticeAt;
        if (record.lifecycle === "paused") record.pausedAt = now;
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
        } else if (record.decision) {
          if (record.decision.state === "pending")
            refuse(
              "wait_for_human",
              "Record authenticated direction, not an approval claim, for this decision.",
            );
          this.matchDecision(record, action.decisionId, action.decisionVersion);
        }
        if (record.lifecycle === "merged" || record.lifecycle === "closed")
          refuse(
            "terminal",
            "Terminal registrations cannot resume; settle and enable a new generation.",
          );
        if (action.action !== "direction" || action.resume) {
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
          record.lifecycle = "active";
          record.pauseReason = "";
          record.counters.scanStalls = 0;
          record.counters.reconciliationStalls = 0;
          record.nextCheckAt = now;
          record.renewedAt = now;
          delete record.pausedNoticeAt;
          for (const incident of record.incidents) {
            if (
              !incident.resolvedAt &&
              ["identity", "provider_denial"].includes(incident.kind)
            ) {
              incident.resolvedAt = now;
              incident.resolution = "operator_resume";
              delete record.lastAttempt;
              delete record.readyFingerprint;
            }
          }
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

  /** The scoped model surface can pause, but cannot mint or expand an operator grant. */
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
      if (
        parsed.action === "enable" &&
        record.lifecycle === "active" &&
        !record.ownershipReleasedAt
      )
        return record;
      if (parsed.action !== "pause")
        refuse(
          "operator_required",
          "Use the authenticated maintenance task action for enablement, direction, resume or release.",
        );
      this.pause(record, parsed.reason ?? "Paused by owning lead");
      return this.save(record);
    });
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
        if (!prMaintenanceObservationFresh(record.observation))
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
          !prMaintenanceObservationFresh(record.observation) ||
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
          record.lifecycle !== "active" ||
          record.decision?.state === "pending" ||
          prMaintenanceUnsettled(record) ||
          !record.observation?.complete ||
          !record.lastAttempt?.complete ||
          record.lastAttempt.failure ||
          record.lastAttempt.headSha !== record.observation.headSha ||
          record.lastAttempt.snapshotId !== record.observation.snapshotId ||
          !prMaintenanceObservationFresh(record.observation) ||
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
      record.lifecycle === "active" &&
      !record.ownershipReleasedAt &&
      record.decision?.state !== "pending" &&
      !record.incidents.some(
        (incident) => !incident.resolvedAt && incident.kind !== "capability",
      ) &&
      !prMaintenanceUnsettled(record) &&
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
      (record.lastAttemptAt && observation.attemptedAt < record.lastAttemptAt)
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
  ): void {
    if (!prMaintenanceObservationFresh(observation))
      refuse(
        "stale_observation",
        "Observation evidence must be no more than 30 minutes old and cannot be future-dated.",
      );
    if (record.lastAttemptAt && observation.attemptedAt < record.lastAttemptAt)
      refuse(
        "stale_observation",
        "An older observation cannot overwrite newer successful or incomplete evidence.",
      );
    const previous = record.lastAttempt;
    record.lastAttempt = observation;
    record.lastAttemptAt = observation.attemptedAt;
    record.nextCheckAt = new Date(
      Math.max(
        Date.parse(observation.attemptedAt) + PR_MAINTENANCE_CADENCE_MS,
        observation.retryAfter ? Date.parse(observation.retryAfter) : 0,
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
    record.lastSuccessAt = observation.attemptedAt;
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
    if (this.recoveryAllowed(record) && prMaintenanceObservationFresh(observation)) {
      for (const incident of record.incidents) {
        if (
          incident.kind === "capability" &&
          !incident.resolvedAt &&
          observation.identity &&
          Date.parse(observation.attemptedAt) >= Date.parse(incident.createdAt)
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
      this.pause(record, "terminal_cancellation_requested", observation.attemptedAt);
      if (record.decision?.state === "pending") {
        record.decision = {
          ...record.decision,
          state: "withdrawn",
          direction: `Moot after verified PR ${observation.state}; not approved or fixed.`,
          resolvedAt: observation.attemptedAt,
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
      !prMaintenanceObservationFresh(record.observation) ||
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
          "SELECT 1 FROM pr_maintenance WHERE task_id=? AND released_at IS NULL LIMIT 1",
        )
        .get(taskId)
    )
      refuse(
        "maintenance_retention",
        "Release settled maintenance explicitly before deleting its task or checkout.",
      );
  }

  wakeEligibleLeadIds(): string[] {
    return [
      ...new Set(
        this.retained()
          .filter(
            (record) =>
              (record.lifecycle === "active" || prMaintenanceUnsettled(record)) &&
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
        milliseconds: z.number().int().min(0).max(120_000),
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
        record.leadSessionId === leadSessionId &&
        (record.lifecycle === "active" || prMaintenanceUnsettled(record)) &&
        record.counters.scanStalls < 3 &&
        record.counters.reconciliationStalls < 3;
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
    });
  }

  /** Called inside the catalog restore transaction. Portable authority needs reconciling. */
  importBackup(input: PrMaintenanceBackup | undefined): void {
    const backup = input ? PrMaintenanceBackupSchema.parse(input) : undefined;
    this.db.exec(
      "DELETE FROM pr_maintenance; DELETE FROM pr_maintenance_wakes; DELETE FROM pr_maintenance_scans; DELETE FROM pr_maintenance_proposals;",
    );
    for (const record of backup?.registrations ?? []) {
      if (!record.ownershipReleasedAt) {
        if (record.lifecycle === "active") record.lifecycle = "paused";
        record.pauseReason = "portable_restore_requires_operator_reconciliation";
        record.pausedAt ??= nowIso();
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
