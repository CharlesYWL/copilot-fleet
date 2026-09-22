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
  .startsWith("refs/heads/", "Use a complete, case-sensitive refs/heads/... ref")
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
  )
  .describe("Complete case-sensitive branch ref, for example refs/heads/main.");
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
export const PR_MAINTENANCE_RECOVERY_LIMITS = Object.freeze({
  incidents: 20,
  attempts: 3,
  evidenceAgeMs: PR_MAINTENANCE_CADENCE_MS,
});
const hostname = z
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
    "Use a hostname, without a URL or port",
  );
const organization = z
  .string()
  .regex(/^[a-z\d][a-z\d-]{0,49}$/i)
  .toLowerCase();
const guid = z
  .string()
  .regex(
    /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i,
    "Use the provider-observed Azure DevOps GUID, not a display name or GitHub ID",
  )
  .toLowerCase()
  .describe("Provider-observed Azure DevOps GUID; normalized to lowercase.");
const pathSegment = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !/[\\/?#]/.test(value) &&
      [...value].every(
        (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
      ),
    "Use one nonempty project or repository name, not a path",
  );
const adoRepository = z
  .string()
  .max(512)
  .refine((value) => {
    const parts = value.split("/");
    return (
      parts.length === 2 && parts.every((part) => pathSegment.safeParse(part).success)
    );
  }, "Use Project/Repo display names in the pinned project, not a bare repo name or URL")
  .describe(
    "Case-preserved Project/Repo display names, for example MyProject/MyRepo. " +
      "The Project prefix must exactly equal identity.project; GUIDs belong in the corresponding ID fields.",
  );
const githubIdentity = z
  .object({
    provider: z.literal("github").optional(),
    host: hostname.refine(
      (value) => value !== "dev.azure.com" && !value.endsWith(".visualstudio.com"),
      "Azure DevOps identities require provider: azure-devops and organization/project IDs",
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
const adoIdentity = githubIdentity
  .extend({
    provider: z.literal("azure-devops"),
    host: z.literal("dev.azure.com"),
    organization,
    project: pathSegment.describe(
      "Case-preserved provider project display name, not its GUID or Project/Repo path.",
    ),
    projectId: guid,
    repositoryId: guid,
    repository: adoRepository,
    headRepositoryId: guid,
    headRepository: adoRepository,
    baseRepositoryId: guid,
    baseRepository: adoRepository,
  })
  .superRefine((value, ctx) => {
    if (value.repositoryId !== value.baseRepositoryId) {
      ctx.addIssue({
        code: "custom",
        path: ["baseRepositoryId"],
        message: "Azure DevOps PR repositoryId and baseRepositoryId must match",
      });
    }
    if (value.repository !== value.baseRepository)
      ctx.addIssue({
        code: "custom",
        path: ["baseRepository"],
        message: "Azure DevOps PR repository and baseRepository display names must match",
      });
    for (const field of ["repository", "headRepository", "baseRepository"] as const)
      if (value[field].split("/")[0] !== value.project)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message:
            "The Project prefix must exactly match the pinned project display name",
        });
  });
export const PrMaintenanceIdentitySchema = z
  .discriminatedUnion("provider", [githubIdentity, adoIdentity])
  .describe(
    "Use provider: azure-devops with host: dev.azure.com, organization, project display name, " +
      "projectId and repository GUIDs, Project/Repo display names, prNumber and full refs. " +
      "GitHub uses owner/repo and opaque node IDs; omitted provider is legacy GitHub only. " +
      "Pass the helper snapshot.identity unchanged, not its discovery pr object.",
  );
export type PrMaintenanceIdentity = z.infer<typeof PrMaintenanceIdentitySchema>;

/** Existing GitHub index keys stay unchanged; ADO IDs are scoped to their organization. */
export function prMaintenanceProviderKey(identity: PrMaintenanceIdentity): string {
  return identity.provider === "azure-devops"
    ? `azure-devops:${identity.host}/${identity.organization}`
    : identity.host;
}

export function prMaintenanceProviderLabel(identity: PrMaintenanceIdentity): string {
  return identity.provider === "azure-devops"
    ? `Azure DevOps · ${identity.organization} / ${identity.project}`
    : `GitHub · ${identity.host}`;
}

export function prMaintenanceUrl(identity: PrMaintenanceIdentity): string {
  if (identity.provider === "azure-devops") {
    return `https://dev.azure.com/${encodeURIComponent(identity.organization)}/${encodeURIComponent(identity.project)}/_git/${encodeURIComponent(identity.repository.slice(identity.repository.indexOf("/") + 1))}/pullrequest/${identity.prNumber}`;
  }
  return `https://${identity.host}/${identity.repository.split("/").map(encodeURIComponent).join("/")}/pull/${identity.prNumber}`;
}

export type PrMaintenanceUrl =
  | {
      provider: "github";
      host: string;
      owner: string;
      repo: string;
      number: number;
      url: string;
    }
  | {
      provider: "azure-devops";
      host: "dev.azure.com";
      organization: string;
      project: string;
      repo: string;
      number: number;
      url: string;
    };

/** URL discovery is not authorization: GUIDs, refs and HEAD still require provider evidence. */
export function parsePrMaintenanceUrl(value: string): PrMaintenanceUrl {
  if (value.length > 4_096 || /[\s\\]/.test(value))
    throw new Error("Use an encoded PR URL without whitespace or backslashes.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    value.includes("\\") ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(value)
  )
    throw new Error(
      "Use an exact HTTPS PR URL without credentials, query, fragment or port.",
    );
  const host = hostname.parse(url.hostname);
  const parts = url.pathname
    .replace(/\/$/, "")
    .split("/")
    .slice(1)
    .map((part) => pathSegment.parse(decodeURIComponent(part)));
  const number = Number(parts.at(-1));
  if (
    !/^[1-9]\d*$/.test(parts.at(-1) ?? "") ||
    !Number.isSafeInteger(number) ||
    number > 2_147_483_647
  )
    throw new Error("Use a positive PR number.");
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    const org = organization.parse(
      host === "dev.azure.com"
        ? parts.shift()
        : host.slice(0, -".visualstudio.com".length),
    );
    if (host !== "dev.azure.com" && parts[0]?.toLowerCase() === "defaultcollection")
      parts.shift();
    if (
      parts.length !== 5 ||
      parts[1] !== "_git" ||
      parts[3]?.toLowerCase() !== "pullrequest"
    )
      throw new Error(
        "Use an Azure DevOps organization/project/_git/repository/pullrequest/ID URL.",
      );
    const project = pathSegment.parse(parts[0]);
    const repo = pathSegment.parse(parts[2]);
    return {
      provider: "azure-devops",
      host: "dev.azure.com",
      organization: org,
      project,
      repo,
      number,
      url: `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${number}`,
    };
  }
  if (
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    !parts.slice(0, 2).every((part) => /^[a-z\d_.-]+$/i.test(part))
  )
    throw new Error("Use a GitHub owner/repository/pull/ID URL.");
  const owner = pathSegment.parse(parts[0]).toLowerCase();
  const repo = pathSegment.parse(parts[1]).toLowerCase();
  return {
    provider: "github",
    host,
    owner,
    repo,
    number,
    url: `https://${host}/${owner}/${repo}/pull/${number}`,
  };
}

// Stored grants retain their original defaults; parsing history never grants new rights.
const legacyScopeSchema = z
  .object({
    baseline: text,
    verification: text,
    publicationAuthorized: z.boolean().default(false),
    replies: z.boolean().optional(),
    resolveThreads: z.boolean().optional(),
    reviewers: z.array(id).max(20).default([]),
    retryChecks: z.boolean().default(false),
  })
  .strict()
  .transform((scope) => ({
    ...scope,
    replies: scope.replies ?? scope.publicationAuthorized,
    resolveThreads: scope.resolveThreads ?? scope.publicationAuthorized,
  }))
  .superRefine((scope, ctx) => {
    if (
      !scope.publicationAuthorized &&
      (scope.replies ||
        scope.resolveThreads ||
        scope.reviewers.length ||
        scope.retryChecks)
    )
      ctx.addIssue({
        code: "custom",
        path: ["publicationAuthorized"],
        message:
          "Read-only maintenance cannot authorize replies, thread resolution, reviewer requests or CI retries.",
      });
  });
export const PrMaintenanceScopeSchema = z
  .object({
    baseline: text,
    verification: text,
    publicationAuthorized: z.boolean().refine((value) => value, {
      message:
        "Observation-only maintenance is unsupported. Prepare a repair proposal for authenticated authorization.",
    }),
    replies: z.boolean().default(false),
    resolveThreads: z.boolean().default(false),
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

const legacyEnableSchema = z
  .object({
    taskId: id,
    workerSessionId: id,
    identity: PrMaintenanceIdentitySchema,
    scope: legacyScopeSchema,
    budgets: PrMaintenanceBudgetsSchema.default(() =>
      PrMaintenanceBudgetsSchema.parse({}),
    ),
    headSha: sha,
    eligibilityEvidence: text,
  })
  .strict();
export const PrMaintenanceEnableSchema = legacyEnableSchema.extend({
  scope: PrMaintenanceScopeSchema,
});
export type PrMaintenanceEnable = z.infer<typeof PrMaintenanceEnableSchema>;

export const PrMaintenanceProposalSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    leadSessionId: id,
    registration: legacyEnableSchema,
    reauthorization: z
      .object({
        recordId: id,
        version: z.number().int().positive(),
        generation: z.number().int().positive(),
      })
      .strict()
      .optional(),
    binding: z
      .object({
        placementId: id,
        checkoutKey: id,
        bindingGeneration: count,
      })
      .strict()
      .optional(),
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
    draft: z.boolean().optional(),
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
      .enum([
        "capability",
        "network",
        "auth",
        "permission",
        "rate_limit",
        "budget",
        "incomplete",
      ])
      .optional(),
    retryAfter: time.optional(),
    evidence: text,
  })
  .strict()
  .superRefine((value, ctx) => {
    const helperError =
      value.helperState &&
      typeof value.helperState === "object" &&
      !Array.isArray(value.helperState) &&
      value.helperState.error !== undefined &&
      value.helperState.error !== null;
    if (
      value.complete &&
      (!value.identity ||
        !value.snapshotId ||
        !value.headSha ||
        !value.state ||
        !value.fingerprint ||
        value.failure ||
        helperError)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Complete observations need identity, snapshot, HEAD, state and fingerprint, without failure",
      });
    }
  });
export type PrMaintenanceObservation = z.infer<typeof PrMaintenanceObservationSchema>;

export const PrMaintenanceProvenanceSchema = z
  .object({ source: id, method: id, evidenceRef: text })
  .strict();
export const PrMaintenanceIncidentSchema = z
  .object({
    id,
    sequence: z.number().int().positive(),
    kind: z.enum(["capability", "provider_denial", "identity", "effects"]),
    error: text,
    lastError: text,
    helperError: z.json().optional(),
    effectKeys: z.array(id).max(200).default([]),
    observationKey: id,
    lastObservationKey: id,
    createdAt: time,
    updatedAt: time,
    wakeQueuedAt: time.optional(),
    resolvedAt: time.optional(),
    resolution: z
      .enum(["observation", "alternate_observation", "operator_resume"])
      .optional(),
    attempts: z
      .array(
        z
          .object({
            id,
            wakeId: id,
            provenance: PrMaintenanceProvenanceSchema,
            requests: z.number().int().min(1).max(40),
            reservedAt: time,
            state: z.enum(["reserved", "incomplete", "resolved", "rejected"]),
            receivedAt: time.optional(),
            observationKey: id.optional(),
            attemptedAt: time.optional(),
            complete: z.boolean().optional(),
            error: text.optional(),
          })
          .strict(),
      )
      .max(PR_MAINTENANCE_RECOVERY_LIMITS.attempts)
      .default([]),
  })
  .strict();
export type PrMaintenanceIncident = z.infer<typeof PrMaintenanceIncidentSchema>;

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
  executionNotDispatched: z.boolean().optional(),
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
    .object({
      kind: z.literal("fallback"),
      error: text,
      observation: PrMaintenanceObservationSchema.refine(
        (observation) => !observation.complete,
        "Fallback records failed or incomplete observations, not success",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("alternate_attempt"),
      incidentId: id,
      resolutionId: id,
      provenance: PrMaintenanceProvenanceSchema,
      requests: z.number().int().min(1).max(40),
    })
    .strict(),
  z
    .object({
      kind: z.literal("alternate_observation"),
      incidentId: id,
      resolutionId: id,
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

export const PrMaintenanceManualCommandSchema = z
  .object({
    id,
    digest: id,
    kind: z.enum(["prompt", "resume_session"]),
    operatorId: id,
    eventSeqFrom: count,
    state: z.enum(["unknown", "accepted", "settled", "rejected"]),
    createdAt: time,
  })
  .strict();
export type PrMaintenanceManualCommand = z.infer<typeof PrMaintenanceManualCommandSchema>;

export const PrMaintenanceManualOwnerSchema = z
  .object({
    sessionId: id,
    taskId: z.string().max(512),
    placementId: z.string().max(512),
    nodeId: z.string().max(512),
    workspaceId: z.string().max(512),
    checkoutKey: z.string().max(512),
  })
  .strict();
export type PrMaintenanceManualOwner = z.infer<typeof PrMaintenanceManualOwnerSchema>;

const authorizationSchema = z
  .object({
    id,
    operatorId: id,
    issuedAt: time,
    headSha: sha,
    scope: legacyScopeSchema,
    budgets: PrMaintenanceBudgetsSchema,
    eligibilityEvidence: text.optional(),
    sourceProposal: z
      .object({ id, version: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();

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
    manualControl: z
      .object({
        operatorId: id,
        takenAt: time,
        endedAt: time.optional(),
        commands: z.array(PrMaintenanceManualCommandSchema).max(1_000),
      })
      .strict()
      .optional(),
    authorization: authorizationSchema,
    authorizationHistory: z.array(authorizationSchema).max(100).default([]),
    decision: PrMaintenanceDecisionSchema.optional(),
    decisionHistory: z.array(PrMaintenanceDecisionSchema).max(100).default([]),
    observation: PrMaintenanceObservationSchema.optional(),
    lastAttempt: PrMaintenanceObservationSchema.optional(),
    lastAttemptAt: time.optional(),
    lastSuccessAt: time.optional(),
    lastError: text.optional(),
    incidentCursor: z.number().int().nonnegative().default(0),
    incidents: z
      .array(PrMaintenanceIncidentSchema)
      .max(PR_MAINTENANCE_RECOVERY_LIMITS.incidents)
      .default([]),
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

export function prMaintenanceObservationFresh(
  observation: PrMaintenanceObservation | undefined,
  nowMs = Date.now(),
): boolean {
  if (!observation) return false;
  const age = nowMs - Date.parse(observation.attemptedAt);
  return age >= 0 && age <= PR_MAINTENANCE_RECOVERY_LIMITS.evidenceAgeMs;
}

export type PrMaintenanceStage =
  | "released"
  | "merged"
  | "closed"
  | "human_hold"
  | "reconciling"
  | "authorization_required"
  | "paused"
  | "recovering"
  | "blocked"
  | "addressing_review"
  | "triage"
  | "waiting_checks"
  | "waiting_review"
  | "ready"
  | "checking";

/** Current facts, not budget reservations or provider review iteration numbers. */
export function prMaintenanceProgress(
  record: PrMaintenanceRegistration,
  nowMs = Date.now(),
): { stage: PrMaintenanceStage; completedIterations: number } {
  const outstanding = new Set(["prepared", "accepted", "reconciling", "uncertain"]);
  const completedIterations = new Set(
    record.batches
      .filter(
        (batch) =>
          batch.stepId &&
          batch.attempt &&
          batch.executionSettled &&
          !outstanding.has(batch.state) &&
          !batch.executionNotDispatched,
      )
      .map((batch) => `${batch.stepId}:${batch.attempt}`),
  ).size;
  const result = (stage: PrMaintenanceStage) => ({ stage, completedIterations });
  if (record.lifecycle === "merged" || record.lifecycle === "closed")
    return result(record.lifecycle);
  if (record.ownershipReleasedAt) return result("released");
  if (
    record.decision?.state === "pending" ||
    (record.lifecycle === "paused" && record.pauseReason === "task_human_hold")
  )
    return result("human_hold");
  if (
    record.incidents.some(
      (incident) => incident.kind === "effects" && !incident.resolvedAt,
    ) ||
    record.batches.some(
      (batch) =>
        batch.state === "uncertain" ||
        batch.state === "reconciling" ||
        (batch.stepId && !batch.executionSettled && !outstanding.has(batch.state)) ||
        (batch.state === "accepted" && batch.cancellationRequestedAt),
    ) ||
    [...record.actions, ...record.batches.flatMap((batch) => batch.effects)].some(
      (effect) => effect.state === "uncertain" || effect.state === "reserved",
    )
  )
    return result("reconciling");
  if (
    !record.authorization.scope.publicationAuthorized &&
    (!record.manualControl || record.manualControl.endedAt)
  )
    return result("authorization_required");
  if (record.lifecycle === "paused")
    return result(
      ["authorization_failed", "remote_identity_changed"].includes(record.pauseReason)
        ? "blocked"
        : "paused",
    );
  if (record.lastAttempt?.draft || record.lastAttempt?.mergeability === "conflicting")
    return result("blocked");
  const incident = record.incidents.find((entry) => !entry.resolvedAt);
  if (incident)
    return result(
      incident.kind === "capability" &&
        incident.attempts.length < PR_MAINTENANCE_RECOVERY_LIMITS.attempts
        ? "recovering"
        : "blocked",
    );
  const observation = record.observation;
  if (
    record.lastAttempt?.failure ||
    (record.lastAttempt && !record.lastAttempt.complete) ||
    (record.lastAttempt?.complete &&
      observation?.complete &&
      (record.lastAttempt.headSha !== observation.headSha ||
        record.lastAttempt.snapshotId !== observation.snapshotId))
  )
    return result("blocked");
  if (record.batches.some((batch) => batch.state === "accepted"))
    return result("addressing_review");
  if (
    !observation?.complete ||
    !record.lastAttempt?.complete ||
    !prMaintenanceObservationFresh(observation, nowMs)
  )
    return result("checking");
  if (observation.draft || observation.mergeability === "conflicting")
    return result("blocked");
  if (
    observation.sources.some(
      (source) =>
        !record.findings.some(
          (finding) =>
            finding.source.id === source.id &&
            finding.source.revision === source.revision &&
            (finding.verifiedHeadSha ?? finding.publishedCommit) ===
              observation.headSha &&
            ["addressed", "already_satisfied"].includes(finding.outcome),
        ),
    )
  )
    return result("triage");
  if (
    !observation.checksComplete ||
    observation.checks.some(
      (check) => check.state !== "passed" || check.headSha !== observation.headSha,
    )
  )
    return result("waiting_checks");
  if (
    !observation.reviewsComplete ||
    observation.reviews.some(
      (review) => review.state !== "approved" || review.headSha !== observation.headSha,
    )
  )
    return result("waiting_review");
  return result(
    observation.state === "open" &&
      observation.mergeability === "mergeable" &&
      !record.batches.some((batch) => outstanding.has(batch.state)) &&
      record.readyFingerprint === observation.fingerprint
      ? "ready"
      : "checking",
  );
}

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
    manualCommands: z
      .array(
        z.object({ sessionId: id, command: PrMaintenanceManualCommandSchema }).strict(),
      )
      .default([]),
    manualConflicts: z
      .array(
        z.object({ sessionId: id, command: PrMaintenanceManualCommandSchema }).strict(),
      )
      .default([]),
    manualOwners: z.array(PrMaintenanceManualOwnerSchema).default([]),
  })
  .strict();
export type PrMaintenanceBackup = z.infer<typeof PrMaintenanceBackupSchema>;
