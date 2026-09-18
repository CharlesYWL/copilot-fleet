import { z } from "zod";

const id = z.string().trim().min(1).max(512);
const text = z.string().min(1).max(8_192);
const time = z.string().datetime();
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const count = z.number().int().nonnegative().max(1_000_000);
const ref = z
  .string()
  .min(12)
  .max(1_024)
  .startsWith("refs/heads/")
  .refine(
    (value) =>
      !/[\s~^:?*[\]\\]/.test(value) &&
      [...value].every(
        (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
      ) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock")),
    "Use a complete, valid, case-sensitive refs/heads/... ref",
  );
const repositoryId = id;
const repository = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[^/\s]+\/[^/\s]+$/)
  .transform((value) => value.toLowerCase());

export const PR_MAINTENANCE_SCHEMA_VERSION = 1;
export const PR_MAINTENANCE_CADENCE_MS = 30 * 60 * 1_000;
export const PR_MAINTENANCE_WAKE_LIMITS = Object.freeze({
  visits: 5,
  requests: 40,
  milliseconds: 120_000,
});
export const PrMaintenanceIdentitySchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .transform((value) => value.toLowerCase().replace(/\.$/, ""))
      .refine(
        (value) =>
          value
            .split(".")
            .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
        "Use a GitHub hostname, without a URL or port",
      ),
    repositoryId,
    repository,
    prNumber: z.number().int().positive().max(2_147_483_647),
    headRepositoryId: repositoryId,
    headRepository: repository,
    headRef: ref,
    baseRepositoryId: repositoryId,
    baseRepository: repository,
    baseRef: ref,
  })
  .strict();
export type PrMaintenanceIdentity = z.infer<typeof PrMaintenanceIdentitySchema>;

export const PrMaintenanceScopeSchema = z
  .object({
    baseline: text,
    verification: text,
    publicationAuthorized: z.literal(true),
    replies: z.boolean().default(true),
    resolveThreads: z.boolean().default(true),
    reviewers: z.array(id).max(20).default([]),
    retryChecks: z.boolean().default(false),
  })
  .strict();
export type PrMaintenanceScope = z.infer<typeof PrMaintenanceScopeSchema>;

export const PrMaintenanceBudgetsSchema = z
  .object({
    repairBatches: z.number().int().min(1).max(30).default(3),
    answerBatches: z.number().int().min(1).max(30).default(3),
    mutationAttempts: z.number().int().min(1).max(1_000).default(100),
  })
  .strict();
export type PrMaintenanceBudgets = z.infer<typeof PrMaintenanceBudgetsSchema>;

export const PrMaintenanceEnableSchema = z
  .object({
    taskId: id,
    workerSessionId: id,
    identity: PrMaintenanceIdentitySchema,
    scope: PrMaintenanceScopeSchema,
    budgets: PrMaintenanceBudgetsSchema.default(() =>
      PrMaintenanceBudgetsSchema.parse({}),
    ),
    headSha: sha,
    eligibilityEvidence: text,
  })
  .strict();
export type PrMaintenanceEnable = z.infer<typeof PrMaintenanceEnableSchema>;

export const PrMaintenanceProposalSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    leadSessionId: id,
    registration: PrMaintenanceEnableSchema,
    createdAt: time,
    updatedAt: time,
  })
  .strict();
export type PrMaintenanceProposal = z.infer<typeof PrMaintenanceProposalSchema>;

export const PrMaintenanceSourceSchema = z
  .object({
    id,
    revision: id,
    groupKey: id,
    evidence: text,
  })
  .strict();
export const PrMaintenanceFindingSchema = z
  .object({
    source: PrMaintenanceSourceSchema,
    outcome: z.enum([
      "addressed",
      "already_satisfied",
      "needs_human",
      "failed",
      "superseded",
      "incomplete",
    ]),
    stage: z.enum([
      "not_attempted",
      "inspected",
      "modified",
      "verified",
      "committed",
      "published",
      "replied",
      "resolved",
    ]),
    evidence: z.array(text).max(20).default([]),
    repairCommit: sha.optional(),
    publishedCommit: sha.optional(),
    verifiedHeadSha: sha.optional(),
    responseRequired: z.boolean().default(true),
    responseIds: z.array(id).max(20).default([]),
    nextAction: text.optional(),
    progress: z.boolean().default(false),
  })
  .strict();
export type PrMaintenanceFinding = z.infer<typeof PrMaintenanceFindingSchema>;

export const PrMaintenanceEffectSchema = z
  .object({
    key: id,
    kind: z.enum([
      "push",
      "reply",
      "resolve",
      "review_request",
      "notification",
      "ci_retry",
    ]),
    state: z.enum(["reserved", "known", "uncertain", "not_performed"]),
    headSha: sha,
    recipient: id.optional(),
    actor: id,
    actionIdentity: id,
    providerId: id.optional(),
    evidence: text.optional(),
    attempts: z.number().int().min(1).max(1_000).default(1),
    usedAttempts: z.number().int().min(0).max(1_000).optional(),
  })
  .strict();
export type PrMaintenanceEffect = z.infer<typeof PrMaintenanceEffectSchema>;

export const PrMaintenanceObservationSchema = z
  .object({
    attemptedAt: time,
    complete: z.boolean(),
    requestsConsumed: z.number().int().min(0).max(40).default(0),
    elapsedMs: z.number().int().min(0).max(1_000_000).default(0),
    helperState: z
      .json()
      .refine(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1_048_576,
        "Helper continuation exceeds 1 MiB; use a smaller bounded scan.",
      )
      .optional(),
    checksComplete: z.boolean().default(false),
    reviewsComplete: z.boolean().default(false),
    identity: PrMaintenanceIdentitySchema.optional(),
    snapshotId: id.optional(),
    headSha: sha.optional(),
    baseSha: sha.optional(),
    state: z.enum(["open", "merged", "closed"]).optional(),
    fingerprint: id.optional(),
    mergeability: z.enum(["mergeable", "conflicting", "unknown"]).default("unknown"),
    checks: z
      .array(
        z
          .object({
            key: id,
            state: z.enum(["pending", "passed", "failed", "unknown"]),
            headSha: sha,
            evidence: text,
          })
          .strict(),
      )
      .max(200)
      .default([]),
    reviews: z
      .array(
        z
          .object({
            key: id,
            reviewer: id,
            state: z.enum([
              "required",
              "requested",
              "approved",
              "changes_requested",
              "dismissed",
            ]),
            headSha: sha,
            revision: id,
            evidence: text,
          })
          .strict(),
      )
      .max(200)
      .default([]),
    sources: z.array(PrMaintenanceSourceSchema).max(200).default([]),
    knownSelfEffectIds: z.array(id).max(200).default([]),
    cursor: z.string().max(4_096).optional(),
    revision: id.optional(),
    failure: z
      .enum(["network", "auth", "permission", "rate_limit", "budget", "incomplete"])
      .optional(),
    retryAfter: time.optional(),
    evidence: text,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.complete &&
      (!value.identity ||
        !value.snapshotId ||
        !value.headSha ||
        !value.state ||
        !value.fingerprint ||
        value.failure)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Complete observations need identity, snapshot, HEAD, state and fingerprint, without failure",
      });
    }
  });
export type PrMaintenanceObservation = z.infer<typeof PrMaintenanceObservationSchema>;

export const PrMaintenanceBatchStateSchema = z.enum([
  "prepared",
  "accepted",
  "reconciling",
  "uncertain",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "superseded",
]);
export const PrMaintenancePreparedBatchSchema = z
  .object({
    id,
    kind: z.enum(["repair", "answer"]),
    sources: z.array(PrMaintenanceSourceSchema).min(1).max(100),
    headSha: sha,
    prompt: z.string().min(1).max(32_768),
    scope: text,
    reservedMutations: z.number().int().min(0).max(1_000),
  })
  .strict();
export const PrMaintenanceBatchSchema = PrMaintenancePreparedBatchSchema.extend({
  generation: z.number().int().positive(),
  authorizationId: id,
  state: PrMaintenanceBatchStateSchema,
  findings: z.array(PrMaintenanceFindingSchema).max(100).default([]),
  effects: z.array(PrMaintenanceEffectSchema).max(200).default([]),
  stepId: id.optional(),
  attempt: z.number().int().positive().optional(),
  executionSettled: z.boolean().default(false),
  evidence: text.optional(),
  cancellationRequestedAt: time.optional(),
  reason: text.optional(),
  usedMutations: count.optional(),
  published: z.boolean().default(false),
  createdAt: time,
  updatedAt: time,
}).strict();
export type PrMaintenanceBatch = z.infer<typeof PrMaintenanceBatchSchema>;

export const PrMaintenanceDecisionSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    proposal: text,
    headSha: sha,
    scope: text,
    state: z.enum(["pending", "directed", "withdrawn"]).default("pending"),
    operatorId: id.optional(),
    direction: text.optional(),
    resolvedAt: time.optional(),
  })
  .strict();
export type PrMaintenanceDecision = z.infer<typeof PrMaintenanceDecisionSchema>;
export const PrMaintenanceDecisionInputSchema = PrMaintenanceDecisionSchema.pick({
  id: true,
  version: true,
  proposal: true,
  headSha: true,
  scope: true,
}).strict();

export const PrMaintenanceCheckpointSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observation"),
      observation: PrMaintenanceObservationSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("prepare_batch"), batch: PrMaintenancePreparedBatchSchema })
    .strict(),
  z
    .object({
      kind: z.literal("batch"),
      batchId: id,
      generation: z.number().int().positive(),
      state: PrMaintenanceBatchStateSchema.exclude(["prepared", "accepted"]),
      findings: z.array(PrMaintenanceFindingSchema).max(100),
      effects: z.array(PrMaintenanceEffectSchema).max(200),
      executionSettled: z.boolean(),
      evidence: text,
      reason: text.optional(),
      usedMutations: count.optional(),
      published: z.boolean().default(false),
    })
    .strict(),
  z.object({ kind: z.literal("action"), effect: PrMaintenanceEffectSchema }).strict(),
  z
    .object({
      kind: z.literal("reconcile"),
      evidence: text,
      progress: z.boolean(),
      immediateCheck: z.boolean().default(false),
    })
    .strict(),
  z.object({ kind: z.literal("ready"), fingerprint: id, evidence: text }).strict(),
]);
export type PrMaintenanceCheckpoint = z.infer<typeof PrMaintenanceCheckpointSchema>;

export const PrMaintenanceOperatorActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"), reason: text }).strict(),
  z
    .object({
      action: z.literal("resume"),
      decisionId: id.optional(),
      decisionVersion: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("release"),
      reason: text,
      decisionId: id.optional(),
      decisionVersion: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("renew"),
      scope: PrMaintenanceScopeSchema.optional(),
      budgets: PrMaintenanceBudgetsSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("direction"),
      decisionId: id,
      decisionVersion: z.number().int().positive(),
      direction: text,
      resume: z.boolean().default(true),
    })
    .strict(),
]);
export type PrMaintenanceOperatorAction = z.infer<
  typeof PrMaintenanceOperatorActionSchema
>;

export const PrMaintenanceRegistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    version: z.number().int().positive(),
    generation: z.number().int().positive(),
    identity: PrMaintenanceIdentitySchema,
    leadSessionId: id,
    taskId: id,
    workerSessionId: id,
    placementId: id,
    checkoutKey: id,
    bindingGeneration: count,
    eligibilityEvidence: text,
    lifecycle: z.enum(["active", "paused", "merged", "closed"]),
    pauseReason: z.string().max(8_192).default(""),
    pausedAt: time.optional(),
    renewedAt: time,
    pausedNoticeAt: time.optional(),
    ownershipReleasedAt: time.optional(),
    retentionReleasedBy: id.optional(),
    authorization: z
      .object({
        id,
        operatorId: id,
        issuedAt: time,
        headSha: sha,
        scope: PrMaintenanceScopeSchema,
        budgets: PrMaintenanceBudgetsSchema,
      })
      .strict(),
    decision: PrMaintenanceDecisionSchema.optional(),
    decisionHistory: z.array(PrMaintenanceDecisionSchema).max(100).default([]),
    observation: PrMaintenanceObservationSchema.optional(),
    lastAttempt: PrMaintenanceObservationSchema.optional(),
    lastAttemptAt: time.optional(),
    lastSuccessAt: time.optional(),
    lastReconciliationEvidence: text.optional(),
    nextCheckAt: time,
    readyFingerprint: id.optional(),
    counters: z
      .object({
        repairBatches: count.default(0),
        answerBatches: count.default(0),
        mutationAttempts: count.default(0),
        consecutiveFailures: count.default(0),
        totalFailures: count.default(0),
        scanStalls: count.default(0),
        reconciliationStalls: count.default(0),
      })
      .strict(),
    findings: z.array(PrMaintenanceFindingSchema).max(200).default([]),
    findingAttempts: z
      .array(
        z
          .object({ groupKey: id, attempts: count, revisions: z.array(id).max(3) })
          .strict(),
      )
      .max(200)
      .default([]),
    batches: z.array(PrMaintenanceBatchSchema).max(100).default([]),
    actions: z.array(PrMaintenanceEffectSchema).max(200).default([]),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
export type PrMaintenanceRegistration = z.infer<typeof PrMaintenanceRegistrationSchema>;

export const PrMaintenanceAdmissionSchema = z
  .object({
    action: z.enum([
      "discover",
      "reopen",
      "dispatch",
      "execute",
      "prompt",
      "resume",
      "advance",
      "submit",
      "approve",
      "publish",
      "aggregate",
      "pause",
      "cancel",
      "cleanup",
      "direction",
      "reconcile",
    ]),
    taskId: id.optional(),
    sessionId: id.optional(),
    placementId: id.optional(),
    checkoutKey: id.optional(),
    recordId: id.optional(),
    generation: z.number().int().positive().optional(),
    batchId: id.optional(),
    leadSessionId: id.optional(),
  })
  .strict();
export type PrMaintenanceAdmission = z.infer<typeof PrMaintenanceAdmissionSchema>;

export const PrMaintenanceWakeSchema = z
  .object({
    leadSessionId: id,
    wakeId: id,
    startedAt: time,
    visits: count,
    requests: count,
    milliseconds: count,
    visitedIds: z.array(id).max(5),
  })
  .strict();
export const PrMaintenanceScanSchema = z
  .object({
    leadSessionId: id,
    cutoff: time,
    unservedIds: z.array(id).max(10_000),
  })
  .strict();
export const PrMaintenanceBackupSchema = z
  .object({
    schemaVersion: z.literal(1),
    registrations: z.array(PrMaintenanceRegistrationSchema).max(10_000),
    wakes: z.array(PrMaintenanceWakeSchema).max(100_000),
    scans: z.array(PrMaintenanceScanSchema).max(10_000),
    proposals: z.array(PrMaintenanceProposalSchema).max(10_000).default([]),
  })
  .strict();
export type PrMaintenanceBackup = z.infer<typeof PrMaintenanceBackupSchema>;
