import { z } from "zod";

/**
 * Why a queued orchestration step has not started, as the scheduler decided it.
 *
 * The codes come from the same pass that decides dispatch, so an explanation
 * cannot contradict what the engine actually did. `scheduling` means no pass
 * has looked at the step since the Host started.
 */
export const StepAdmissionCodeSchema = z.enum([
  "scheduling",
  "session_busy",
  "parallel_limit",
  "node_headroom",
  "node_capacity",
  "dependencies",
  "workspace_not_ready",
  "nodes_unknown",
  "no_placement",
  "checkout_busy",
  "node_offline",
  "stop_pending",
  "dismissed",
  "cleanup_pending",
  "task_held",
  "maintenance_hold",
  "command_fence",
  "resume_approval",
  "resuming",
  "dispatched",
  "running",
]);
export type StepAdmissionCode = z.infer<typeof StepAdmissionCodeSchema>;

/**
 * The only restriction "Resume now" may ask a person to override.
 *
 * The Host keeps one slot free on a multi-slot Node so ordinary dispatch never
 * fills it to its hard limit. Spending that reserved slot once is a bounded
 * scheduling exception; the Node's own hard capacity, checkout exclusivity,
 * task budgets and every hold stay enforced.
 */
export const WorkerResumeRestrictionSchema = z.enum(["node_headroom"]);
export type WorkerResumeRestriction = z.infer<typeof WorkerResumeRestrictionSchema>;

/** Waiting on ordinary capacity or ordering; Fleet starts these by itself. */
export const queuedStepAdmissionCodes: ReadonlySet<StepAdmissionCode> = new Set([
  "scheduling",
  "session_busy",
  "parallel_limit",
  "node_headroom",
  "node_capacity",
  "dependencies",
  "workspace_not_ready",
  "nodes_unknown",
  "no_placement",
]);

export const StepAdmissionConflictSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().default(""),
  state: z.string().default(""),
  runId: z.string().default(""),
  taskName: z.string().default(""),
  role: z.string().default(""),
  /** A session of the same task, rather than someone else's work. */
  sameTask: z.boolean().default(false),
});
export type StepAdmissionConflict = z.infer<typeof StepAdmissionConflictSchema>;

/**
 * What a step is waiting on, derived at read time and never persisted.
 *
 * `queued` waits on ordinary scheduling and starts by itself; `blocked` needs
 * something other than capacity to change; `awaiting_approval` has a pending
 * "Resume now" exception; `starting` has been sent and awaits the Node's
 * acknowledgement; `running` has been acknowledged by the Node.
 */
export const StepAdmissionSchema = z.object({
  state: z.enum(["queued", "blocked", "awaiting_approval", "starting", "running"]),
  code: StepAdmissionCodeSchema,
  detail: z.string(),
  nodeId: z.string().default(""),
  nodeName: z.string().default(""),
  localPath: z.string().default(""),
  conflicts: z.array(StepAdmissionConflictSchema).default([]),
  /** Present when "Resume now" can request approval to override this restriction. */
  exception: WorkerResumeRestrictionSchema.optional(),
  /** A queued follow-up in a retained worker, which "Resume now" applies to. */
  resumable: z.boolean().default(false),
  /** The active "Resume now" request for this step, if one exists. */
  requestId: z.string().optional(),
});
export type StepAdmission = z.infer<typeof StepAdmissionSchema>;

export const WorkerResumeRequestStateSchema = z.enum([
  "awaiting_approval",
  "approved",
  "launching",
  "launched",
  "cancelled",
  "expired",
  "stale",
  "failed",
]);
export type WorkerResumeRequestState = z.infer<typeof WorkerResumeRequestStateSchema>;

/** States that still hold the step's one active request slot. */
export const activeWorkerResumeRequestStates: ReadonlySet<WorkerResumeRequestState> =
  new Set(["awaiting_approval", "approved", "launching"]);

export const WORKER_RESUME_LIMITS = {
  /** How long a request waits for a person before it expires. */
  approvalMs: 10 * 60_000,
  /** How long an approval may wait for its launch before it lapses. */
  launchMs: 2 * 60_000,
  /** After a person cancels or ignores an orchestrator's request, it may not ask again for this long. */
  requesterCooldownMs: 30 * 60_000,
  promptPreviewChars: 4_000,
  reasonChars: 1_000,
} as const;

/** A live session the approval dialog shows beside the one being resumed. */
export const WorkerResumeSessionSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().default(""),
  state: z.string(),
  runId: z.string().default(""),
  taskName: z.string().default(""),
  role: z.string().default(""),
  localPath: z.string().default(""),
  readOnly: z.boolean().default(false),
});
export type WorkerResumeSession = z.infer<typeof WorkerResumeSessionSchema>;

/**
 * One "Resume now" request for a queued follow-up in a retained worker.
 *
 * Bound to the exact step attempt, conversation, Node, checkout, queued prompt
 * and the admission facts it overrides (`fingerprint`). Approval is one-shot
 * and expiring; the Host revalidates the binding at approval and again at
 * launch, and a change makes the request `stale` rather than launching it.
 */
export const WorkerResumeRequestSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  state: WorkerResumeRequestStateSchema,
  runId: z.string().min(1),
  taskName: z.string().default(""),
  stepId: z.string().min(1),
  stepKey: z.string().default(""),
  stepTitle: z.string().default(""),
  stepAttempt: z.number().int().positive(),
  sessionId: z.string().min(1),
  sessionName: z.string().default(""),
  agentSessionId: z.string().default(""),
  nodeId: z.string().min(1),
  nodeName: z.string().default(""),
  placementId: z.string().default(""),
  localPath: z.string().default(""),
  checkoutKey: z.string().default(""),
  /** The queued follow-up, bounded for display; `promptDigest` binds the whole text. */
  queuedPrompt: z.string().default(""),
  promptDigest: z.string().min(1),
  restriction: WorkerResumeRestrictionSchema,
  restrictionDetail: z.string().default(""),
  risk: z.string().default(""),
  capacity: z.object({
    kind: z.enum(["writing", "read-only"]),
    reserved: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
  }),
  activeSessions: z.array(WorkerResumeSessionSchema).default([]),
  fingerprint: z.string().min(1),
  reason: z.string().default(""),
  requestedBy: z.object({
    kind: z.enum(["operator", "orchestrator"]),
    id: z.string().default(""),
  }),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  decidedBy: z.string().default(""),
  decidedAt: z.string().default(""),
  /** An approved request that has not launched by then lapses. */
  launchBy: z.string().default(""),
  launchedAt: z.string().default(""),
  acknowledgedAt: z.string().default(""),
  outcome: z.string().default(""),
  updatedAt: z.string().datetime(),
});
export type WorkerResumeRequest = z.infer<typeof WorkerResumeRequestSchema>;

/**
 * A person's answer to one request.
 *
 * Both fields beside the decision are what the dialog displayed: a request that
 * changed after it was shown refuses the decision instead of applying it.
 */
export const WorkerResumeDecisionSchema = z
  .object({
    decision: z.enum(["approve_once", "cancel"]),
    expectedVersion: z.number().int().positive(),
    fingerprint: z.string().min(1),
  })
  .strict();
export type WorkerResumeDecision = z.infer<typeof WorkerResumeDecisionSchema>;

/** What "Resume now" did, for the button that asked. */
export const WorkerResumeOutcomeSchema = z.object({
  status: z.enum(["starting", "running", "queued", "blocked", "awaiting_approval"]),
  admission: StepAdmissionSchema.optional(),
  request: WorkerResumeRequestSchema.optional(),
  message: z.string(),
});
export type WorkerResumeOutcome = z.infer<typeof WorkerResumeOutcomeSchema>;
