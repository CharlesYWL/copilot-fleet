import { z } from "zod";

/**
 * Versioned contracts for the portable PR-maintenance skill.
 *
 * These schemas are the single source of truth: the CLI validates with them at
 * runtime and the build emits the published JSON Schemas from them with
 * `z.toJSONSchema`. Rules JSON Schema cannot express (cross-field and state
 * transition checks) stay in `engine.ts` and are covered by tests.
 */

export const STORE_SCHEMA_VERSION = 1;
export const WORK_ORDER_SCHEMA = "prm.work-order/1";
export const WORK_REPORT_SCHEMA = "prm.work-report/1";

/** Per-pass allowance, matching Fleet's existing wake limits. */
export const PASS_LIMITS = Object.freeze({
  visits: 5,
  requests: 40,
  milliseconds: 300_000,
  helperMilliseconds: 120_000,
});

/** Per-registration execution budgets, matching Fleet's defaults. */
export const JOB_BUDGET_DEFAULTS = Object.freeze({
  repairBatches: 3,
  answerBatches: 3,
  mutationAttempts: 100,
});

export const STORE_LIMITS = Object.freeze({
  bytes: 16 * 1024 * 1024,
  jobs: 100,
  batchesPerJob: 50,
  receipts: 2_000,
  receiptAgeMs: 30 * 24 * 60 * 60 * 1_000,
  bodyExcerpt: 4_000,
  obligations: 200,
});

/** Evidence older than this cannot justify a new work order. */
export const EVIDENCE_MAX_AGE_MS = 30 * 60 * 1_000;

const id = z.string().trim().min(1).max(512);
const text = z.string().min(1).max(8_192);
const time = z.iso.datetime();
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const count = z.number().int().nonnegative();

export const ModeSchema = z
  .enum(["observe", "answer", "repair"])
  .describe(
    "observe: read and report only. answer: also reply to threads. repair: also change code, verify, commit and push to the PR head ref.",
  );
export type Mode = z.infer<typeof ModeSchema>;

export const LifecycleSchema = z.enum(["active", "paused", "merged", "closed"]);

export const HoldSchema = z
  .object({
    holdId: id,
    kind: z.enum([
      "design",
      "human",
      "auth",
      "failures",
      "no_progress",
      "uncertain_effect",
      "policy_violation",
      "budget",
      "ownership_conflict",
    ]),
    reason: text,
    createdAt: time,
    sourceIds: z.array(id).max(200).default([]),
  })
  .strict();
export type Hold = z.infer<typeof HoldSchema>;

/** Provider evidence returned by the bundled helper, reduced to what the loop needs. */
export const ObservationSchema = z
  .object({
    attemptedAt: time,
    complete: z.boolean(),
    requestsConsumed: count.default(0),
    elapsedMs: count.default(0),
    helperState: z.unknown().optional(),
    checksComplete: z.boolean().default(false),
    reviewsComplete: z.boolean().default(false),
    identity: z.record(z.string(), z.unknown()).optional(),
    headSha: sha.optional(),
    baseSha: sha.optional(),
    state: z.enum(["open", "merged", "closed"]).optional(),
    draft: z.boolean().optional(),
    fingerprint: id.optional(),
    mergeability: z.enum(["mergeable", "conflicting", "unknown"]).default("unknown"),
    checks: z
      .array(
        z.looseObject({
          key: id,
          state: z.enum(["pending", "passed", "failed", "unknown"]),
          evidence: z.string(),
        }),
      )
      .default([]),
    reviews: z
      .array(
        z.looseObject({
          key: id,
          reviewer: id,
          state: z.enum([
            "required",
            "requested",
            "approved",
            "changes_requested",
            "dismissed",
          ]),
          evidence: z.string(),
        }),
      )
      .default([]),
    sources: z
      .array(z.looseObject({ id, revision: id, groupKey: id, evidence: z.string() }))
      .default([]),
    knownSelfEffectIds: z.array(id).default([]),
    failure: z.string().optional(),
    retryAfter: time.optional(),
    evidence: z.string(),
  })
  .loose();
export type Observation = z.infer<typeof ObservationSchema>;

/** One actionable item the lead must triage, with the provider text it needs. */
export const ObligationSchema = z
  .object({
    sourceId: id,
    kind: id,
    revision: id,
    groupKey: id,
    change: z.enum(["new", "changed", "carried"]),
    author: z.string().max(512).optional(),
    url: z.string().max(4_096).optional(),
    path: z.string().max(4_096).optional(),
    line: z.number().int().optional(),
    body: z.string().max(STORE_LIMITS.bodyExcerpt).optional(),
    bodyTruncated: z.boolean().default(false),
    contentHash: z.string().max(128).optional(),
    matchesRecordedEffect: z.boolean().default(false),
    awaitingPublication: z
      .boolean()
      .optional()
      .describe(
        "A batch reported this fixed and pushed, but the PR still shows the head it was planned on. Do not re-plan; confirm the push.",
      ),
    evidence: z.string(),
    lastDisposition: z
      .object({ outcome: id, stage: id, batchId: id })
      .strict()
      .optional(),
  })
  .strict();
export type Obligation = z.infer<typeof ObligationSchema>;

export const OutcomeSchema = z.enum([
  "addressed",
  "already_satisfied",
  "needs_human",
  "failed",
  "superseded",
  "incomplete",
]);
export const StageSchema = z.enum([
  "not_attempted",
  "inspected",
  "modified",
  "verified",
  "committed",
  "published",
  "replied",
  "resolved",
]);

export const DispositionSchema = z
  .object({
    sourceId: id,
    revision: id,
    outcome: OutcomeSchema,
    stage: StageSchema,
    batchId: id,
    reason: z.string().max(8_192).optional(),
    verifiedHeadSha: sha.optional(),
    publishedCommit: sha.optional(),
    responseIds: z.array(id).max(20).default([]),
    recordedAt: time,
  })
  .strict();
export type Disposition = z.infer<typeof DispositionSchema>;

/** A remote action the skill (as worker) performed, recorded so it is never mistaken for new feedback. */
export const RecordedEffectSchema = z
  .object({
    effectId: id,
    batchId: id,
    kind: z.enum(["push", "thread_comment", "discussion", "review", "thread_resolution"]),
    state: z.enum(["known", "uncertain", "not_performed"]),
    providerId: id.optional(),
    actor: id.optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    commit: sha.optional(),
    recordedAt: time,
  })
  .strict();
export type RecordedEffect = z.infer<typeof RecordedEffectSchema>;

const WorkOrderFindingSchema = z
  .object({
    sourceId: id,
    kind: id,
    revision: id,
    groupKey: id,
    task: z.enum(["repair", "answer"]),
    instructions: text,
    author: z.string().max(512).optional(),
    url: z.string().max(4_096).optional(),
    path: z.string().max(4_096).optional(),
    line: z.number().int().optional(),
    body: z.string().max(STORE_LIMITS.bodyExcerpt).optional(),
    evidence: z.string(),
    previous: z
      .object({
        outcome: OutcomeSchema,
        stage: StageSchema,
        publishedCommit: sha.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WorkOrderSchema = z
  .object({
    schema: z.literal(WORK_ORDER_SCHEMA),
    batchId: id,
    jobId: id,
    generation: z.number().int().positive(),
    createdAt: time,
    pr: z
      .object({
        url: z.string().max(4_096),
        provider: z.enum(["github", "azure-devops"]),
        headSha: sha,
        baseSha: sha,
        headRepository: z.string().max(512),
        headRef: z.string().max(1_024),
        baseRef: z.string().max(1_024),
        identity: z.record(z.string(), z.unknown()),
      })
      .strict(),
    checkout: z.string().max(4_096).nullable(),
    mode: ModeSchema,
    permissions: z
      .object({
        modifyCode: z.boolean(),
        push: z.boolean(),
        reply: z.boolean(),
        resolveThreads: z.boolean(),
      })
      .strict(),
    baseline: z.string().max(8_192).nullable(),
    verification: z.array(z.string().min(1).max(2_048)).max(20),
    conflictResolution: z.boolean(),
    summary: text,
    findings: z.array(WorkOrderFindingSchema).min(1).max(50),
    allowances: z
      .object({
        repairBatchesRemaining: count,
        answerBatchesRemaining: count,
        mutationAttemptsRemaining: count,
      })
      .strict(),
    rules: z.array(z.string()).max(30),
    reportSchema: z.literal(WORK_REPORT_SCHEMA),
  })
  .strict();
export type WorkOrder = z.infer<typeof WorkOrderSchema>;

/** Input to `prm triage`: decisions that need no work batch. */
export const TriageInputSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            sourceId: id,
            decision: z
              .enum(["no_action", "needs_human"])
              .describe(
                "no_action: verified that nothing needs doing (bot noise, already satisfied, informational). needs_human: reported to the user; waits for their decision.",
              ),
            reason: text,
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type TriageInput = z.infer<typeof TriageInputSchema>;

/** Input to `prm plan`: the lead's triage of current obligations. */
export const PlanInputSchema = z
  .object({
    summary: text,
    conflictResolution: z.boolean().default(false),
    findings: z
      .array(
        z
          .object({
            sourceId: id,
            task: z.enum(["repair", "answer"]),
            instructions: text,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type PlanInput = z.infer<typeof PlanInputSchema>;

export const WorkReportSchema = z
  .object({
    schema: z.literal(WORK_REPORT_SCHEMA),
    batchId: id,
    summary: text,
    mutationAttempts: count.max(1_000),
    findings: z
      .array(
        z
          .object({
            sourceId: id,
            revision: id,
            outcome: OutcomeSchema,
            stage: StageSchema,
            verifiedHeadSha: sha.optional(),
            repairCommit: sha.optional(),
            publishedCommit: sha.optional(),
            responseIds: z.array(id).max(20).default([]),
            evidence: z.array(text).max(20).default([]),
            nextAction: text.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    effects: z
      .array(
        z
          .object({
            kind: z.enum([
              "push",
              "thread_comment",
              "discussion",
              "review",
              "thread_resolution",
            ]),
            state: z.enum(["known", "uncertain", "not_performed"]),
            providerId: id.optional(),
            actor: id.optional(),
            body: z.string().max(65_536).optional(),
            commit: sha.optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type WorkReport = z.infer<typeof WorkReportSchema>;

export const BatchSchema = z
  .object({
    batchId: id,
    state: z.enum([
      "prepared",
      "accepted",
      "succeeded",
      "partial",
      "failed",
      "cancelled",
      "uncertain",
    ]),
    kind: z.enum(["repair", "answer"]),
    workOrder: WorkOrderSchema,
    report: WorkReportSchema.optional(),
    createdAt: time,
    acceptedAt: time.optional(),
    settledAt: time.optional(),
  })
  .strict();
export type Batch = z.infer<typeof BatchSchema>;

const counter = z.object({ limit: count, used: count }).strict();

export const JobSchema = z
  .object({
    jobId: id,
    generation: z.number().int().positive(),
    url: z.string().max(4_096),
    provider: z.enum(["github", "azure-devops"]),
    identity: z.record(z.string(), z.unknown()).optional(),
    mode: ModeSchema,
    resolveThreads: z.boolean().default(false),
    checkIntervalMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(15),
    lifecycle: LifecycleSchema,
    pauseReason: z.string().max(8_192).optional(),
    released: z.boolean().default(false),
    checkout: z.string().max(4_096).nullable(),
    baseline: z.string().max(8_192).nullable(),
    verification: z.array(z.string().min(1).max(2_048)).max(20),
    executor: z
      .object({
        kind: z.enum(["current-session"]),
        launcher: z.string().max(64).optional(),
        sessionId: z.string().max(512).optional(),
      })
      .strict(),
    budgets: z
      .object({
        repairBatches: counter,
        answerBatches: counter,
        mutationAttempts: counter,
      })
      .strict(),
    failures: z.object({ consecutive: count, cumulative: count }).strict(),
    nextCheckAt: time,
    createdAt: time,
    updatedAt: time,
    lastAttempt: ObservationSchema.optional(),
    lastObservation: ObservationSchema.optional(),
    observedInPass: id.optional(),
    obligations: z.array(ObligationSchema).max(STORE_LIMITS.obligations).default([]),
    dispositions: z.record(z.string(), DispositionSchema).default({}),
    effects: z.array(RecordedEffectSchema).max(1_000).default([]),
    batches: z.array(BatchSchema).max(STORE_LIMITS.batchesPerJob).default([]),
    groupBatchCounts: z.record(z.string(), count).default({}),
    holds: z.array(HoldSchema).max(50).default([]),
    history: z
      .array(
        z
          .object({ at: time, event: id, detail: z.string().max(2_048).optional() })
          .strict(),
      )
      .max(200)
      .default([]),
    ready: z.object({ fingerprint: id, at: time, headSha: sha }).strict().optional(),
  })
  .strict();
export type Job = z.infer<typeof JobSchema>;

export const PassSchema = z
  .object({
    passId: id,
    startedAt: time,
    deadlineAt: time,
    visitsRemaining: count,
    requestsRemaining: count,
    visited: z.array(id).max(PASS_LIMITS.visits).default([]),
    due: z.array(id).max(STORE_LIMITS.jobs).default([]),
    owner: z
      .object({ hostname: z.string().max(512), pid: count, label: z.string().max(512) })
      .strict(),
  })
  .strict();
export type Pass = z.infer<typeof PassSchema>;

export const ReceiptSchema = z
  .object({
    operationId: id,
    command: id,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: count,
    at: time,
    result: z.unknown(),
  })
  .strict();
export type Receipt = z.infer<typeof ReceiptSchema>;

export const StoreSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    storeId: id,
    revision: count,
    createdAt: time,
    binding: z
      .object({
        bindingId: id,
        profile: z.literal("json-local"),
        stateRoot: z.string().max(4_096),
        hostname: z.string().max(512),
      })
      .strict(),
    activePass: PassSchema.nullable(),
    scan: z.object({ carried: z.array(id).max(STORE_LIMITS.jobs).default([]) }).strict(),
    jobs: z.record(z.string(), JobSchema),
    receipts: z.record(z.string(), ReceiptSchema).default({}),
  })
  .strict();
export type Store = z.infer<typeof StoreSchema>;

/** Schemas published in the skill's `schemas/` folder. */
export const PUBLISHED_SCHEMAS = {
  "store.schema.json": StoreSchema,
  "work-order.schema.json": WorkOrderSchema,
  "work-report.schema.json": WorkReportSchema,
  "plan-input.schema.json": PlanInputSchema,
  "triage-input.schema.json": TriageInputSchema,
} as const;
