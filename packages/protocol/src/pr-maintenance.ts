import { z } from "zod";
import { SessionActorSchema } from "./session-actor.js";

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
export const PR_MAINTENANCE_WAKE_LIMITS = Object.freeze({
  visits: 5,
  requests: 40,
  milliseconds: 300_000,
});
/**
 * Routine checks follow the orchestrator heartbeat schedule rather than a
 * constant here; `evidenceAgeMs` is how old evidence may be and still justify
 * a repair, readiness or a new effect.
 */
export const PR_MAINTENANCE_RECOVERY_LIMITS = Object.freeze({
  incidents: 20,
  attempts: 3,
  evidenceAgeMs: 30 * 60 * 1_000,
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
      "Pass the helper observation.identity unchanged, not its provider-native snapshot or discovery pr object.",
  );
export type PrMaintenanceIdentity = z.infer<typeof PrMaintenanceIdentitySchema>;

/** Native GitHub helper v1 identity, normalized only at its observation/receipt boundary. */
export const PrMaintenanceGithubSnapshotIdentitySchema = githubIdentity
  .omit({ prNumber: true })
  .extend({
    number: githubIdentity.shape.prNumber,
    prId: id,
    url: z.string().max(4_096),
  })
  .superRefine((value, ctx) => {
    if (
      value.url.toLowerCase() !==
      prMaintenanceUrl({ ...value, prNumber: value.number }).toLowerCase()
    )
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "GitHub snapshot URL must match its exact PR identity.",
      });
  })
  .transform(({ number, prId: _prId, url: _url, ...identity }) =>
    githubIdentity.parse({ ...identity, prNumber: number }),
  );

export const PrMaintenanceHelperSnapshotIdentitySchema = z.union([
  PrMaintenanceGithubSnapshotIdentitySchema,
  adoIdentity,
]);

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

/** Pending attention only; authorization still reads the exact stored proposal. */
export const PrMaintenanceApprovalSchema = z.object({
  proposalId: id,
  version: z.number().int().positive(),
  taskId: id,
  leadSessionId: id,
  identity: PrMaintenanceIdentitySchema,
  mode: z.literal("repair"),
  createdAt: time,
});
export type PrMaintenanceApproval = z.infer<typeof PrMaintenanceApprovalSchema>;

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
      .enum(["observation", "alternate_observation", "operator_resume", "lead_resume"])
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
    baseSha: sha.optional(),
    conflictResolution: z.boolean().optional(),
    prompt: z.string().min(1).max(32_768),
    scope: text,
    reservedMutations: z.number().int().min(0).max(1_000),
  })
  .strict();
export const PrMaintenanceBatchSchema = PrMaintenancePreparedBatchSchema.extend({
  generation: z.number().int().positive(),
  authorizationId: id,
  state: PrMaintenanceBatchStateSchema,
  /** Present when the Host rendered `prompt` from a prm.work-order/1. */
  workOrder: z.record(z.string(), z.unknown()).optional(),
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
      kind: z.literal("prepare_work_order"),
      plan: z
        .object({
          batchId: id,
          summary: text,
          conflictResolution: z.boolean().default(false),
          reservedMutations: z.number().int().min(0).max(1_000),
          findings: z
            .array(
              z
                .object({
                  sourceId: id,
                  revision: id,
                  task: z.enum(["repair", "answer"]),
                  instructions: text,
                })
                .strict(),
            )
            .min(1)
            .max(50),
        })
        .strict(),
    })
    .strict()
    .describe(
      "Preferred preparation: the Host renders the immutable prm.work-order/1 worker prompt from current sources and the grant; dispatch it with fleet_follow_up using only the maintenance reference.",
    ),
  z
    .object({
      kind: z.literal("work_report"),
      batchId: id,
      generation: z.number().int().positive(),
      report: z
        .unknown()
        .optional()
        .describe(
          "prm.work-report/1 object. Omit it to have the Host read the worker's tagged <prm-work-report> from the settled attempt.",
        ),
    })
    .strict()
    .describe(
      "Settle a work-order batch from the worker's prm.work-report/1 after its attempt completed. The Host validates it against the stored work order and applies the normal settlement guards.",
    ),
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
  z
    .object({
      kind: z.literal("review_done"),
      summary: text.describe(
        "What the review found: why nothing is actionable now, or what it is waiting for.",
      ),
    })
    .strict()
    .describe(
      "Conclude the current review with no routine work to dispatch and no design decision: the job becomes Idle until the next heartbeat, manual review or provider change.",
    ),
]);
export type PrMaintenanceCheckpoint = z.infer<typeof PrMaintenanceCheckpointSchema>;

export const PrMaintenanceOperatorActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"), reason: text }).strict(),
  z
    .object({
      action: z.literal("work"),
      requestId: z.string().uuid(),
      direction: text,
    })
    .strict()
    .describe(
      "Queue routine work for the retained worker and start a review immediately. Idempotent by requestId.",
    ),
  z
    .object({
      action: z.literal("review"),
      requestId: z.string().uuid(),
    })
    .strict()
    .describe(
      "Review now: refresh provider metadata and classify current feedback, regardless of the heartbeat interval. Idempotent by requestId.",
    ),
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
      action: z.literal("direction"),
      decisionId: id,
      decisionVersion: z.number().int().positive(),
      direction: text,
    })
    .strict()
    .describe(
      "Answer the pending design decision. Recording it resumes maintenance with a fresh review; no separate Resume is needed.",
    ),
]);
export type PrMaintenanceOperatorAction = z.infer<
  typeof PrMaintenanceOperatorActionSchema
>;

export const PrMaintenanceManualCommandSchema = z
  .object({
    id,
    digest: id,
    kind: z.enum(["prompt", "resume_session"]),
    operatorId: id.optional(),
    actor: SessionActorSchema.optional(),
    eventSeqFrom: z.number().int().nonnegative(),
    state: z.enum(["unknown", "accepted", "settled", "rejected"]),
    createdAt: time,
    handback: z.enum(["ongoing", "after_turn"]).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.actor || value.operatorId),
    "A control actor is required",
  );
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
    /** Historical v1 allowances, retained for audit and no longer enforced. */
    budgets: PrMaintenanceBudgetsSchema,
    eligibilityEvidence: text.optional(),
    sourceProposal: z
      .object({ id, version: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();

const workRequestSchema = z
  .object({
    id: z.string().uuid(),
    operatorId: id,
    direction: text,
    createdAt: time,
    state: z.enum(["pending", "completed", "cancelled"]),
    batchId: id.optional(),
    settledAt: time.optional(),
    reason: text.optional(),
  })
  .strict();

/**
 * The exceptional conditions that stop worker dispatch and new effects.
 *
 * A hold is only ever set by an explicit act (operator/lead Pause, a worker or
 * task Stop, a manual takeover) or by a provider fact Fleet cannot work around
 * (authentication/permission denial, a changed identity). Nothing else pauses
 * maintenance: stale evidence, timing, task review and orchestrator restarts
 * are handled by refreshing, not by holding.
 */
export const PrMaintenanceHoldKindSchema = z.enum([
  "stopped",
  "paused",
  "access",
  "identity",
  "manual_control",
]);
export type PrMaintenanceHoldKind = z.infer<typeof PrMaintenanceHoldKindSchema>;

const holdSchema = z
  .object({
    kind: PrMaintenanceHoldKindSchema,
    reason: z.string().min(1).max(8_192),
    actor: z.enum(["lead", "operator", "node_console", "system"]),
    actorId: id,
    at: time,
  })
  .strict();
export type PrMaintenanceHold = z.infer<typeof holdSchema>;

export const PrMaintenanceReviewSourceSchema = z.enum([
  "enable",
  "heartbeat",
  "manual",
  "worker_result",
  "direction",
  "resume",
  "handback",
  "recovery",
  "migration",
]);
export type PrMaintenanceReviewSource = z.infer<typeof PrMaintenanceReviewSourceSchema>;

/**
 * One owed review: refresh provider state, then decide whether there is routine
 * work, a genuine design decision, or nothing to do.
 *
 * At most one review is open per registration. Further requests coalesce into
 * it, which is what keeps a heartbeat and a manual trigger from producing two
 * reviews or two batches. A manual request never changes the heartbeat
 * schedule; it only opens (or reuses) this request.
 */
const reviewSchema = z
  .object({
    id,
    source: PrMaintenanceReviewSourceSchema,
    requestedAt: time,
    actorId: id.optional(),
    /** Durable lead-prompt key that delivered this review, once queued. */
    wakeKey: z.string().max(512).optional(),
    wakeQueuedAt: time.optional(),
    /** Set when a fresh observation for this review is recorded. */
    claimedAt: time.optional(),
    concludedAt: time.optional(),
    outcome: z
      .enum(["working", "decision", "idle", "terminal", "failed", "held", "abandoned"])
      .optional(),
    summary: z.string().max(8_192).optional(),
  })
  .strict();
export type PrMaintenanceReview = z.infer<typeof reviewSchema>;

const PrMaintenanceRegistrationV2Schema = z
  .object({
    schemaVersion: z.literal(2),
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
    /** Provider terminal state; `active` covers every working phase. */
    lifecycle: z.enum(["active", "merged", "closed"]),
    hold: holdSchema.optional(),
    holdHistory: z.array(holdSchema).max(100).default([]),
    review: reviewSchema.optional(),
    reviewHistory: z.array(reviewSchema).max(50).default([]),
    renewedAt: time,
    ownershipReleasedAt: time.optional(),
    retentionReleasedBy: id.optional(),
    workRequests: z.array(workRequestSchema).max(100).default([]),
    manualControl: z
      .object({
        operatorId: id.optional(),
        actor: SessionActorSchema.optional(),
        takenAt: time,
        endedAt: time.optional(),
        commands: z.array(PrMaintenanceManualCommandSchema).max(1_000),
      })
      .strict()
      .refine(
        (value) => Boolean(value.actor || value.operatorId),
        "A control actor is required",
      )
      .optional(),
    authorization: authorizationSchema,
    authorizationHistory: z.array(authorizationSchema).max(100).default([]),
    decision: PrMaintenanceDecisionSchema.optional(),
    decisionHistory: z.array(PrMaintenanceDecisionSchema).max(100).default([]),
    observation: PrMaintenanceObservationSchema.optional(),
    observationHostAt: time.optional(),
    lastAttempt: PrMaintenanceObservationSchema.optional(),
    lastAttemptAt: time.optional(),
    lastAttemptLatestAt: time.optional(),
    lastSuccessAt: time.optional(),
    lastError: text.optional(),
    incidentCursor: z.number().int().nonnegative().default(0),
    incidents: z
      .array(PrMaintenanceIncidentSchema)
      .max(PR_MAINTENANCE_RECOVERY_LIMITS.incidents)
      .default([]),
    lastReconciliationEvidence: text.optional(),
    /** Next unattended heartbeat check. Manual reviews never write it. */
    nextCheckAt: time,
    readyFingerprint: id.optional(),
    counters: z
      .object({
        repairBatches: count.default(0),
        answerBatches: count.default(0),
        mutationAttempts: count.default(0),
        consecutiveFailures: count.default(0),
        totalFailures: count.default(0),
        /** Batches dispatched since the last human direction (activity only, never a limit). */
        dispatchesSinceDirection: count.default(0),
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
    /** v1 continuation, resume and pause audit, preserved verbatim on upgrade. */
    legacyAudit: z.record(z.string(), z.unknown()).optional(),
    createdAt: time,
    updatedAt: time,
  })
  .strict();

/** The stored v1 registration, accepted only to upgrade it. */
const legacyRegistrationSchema = z
  .object({ schemaVersion: z.literal(1) })
  .passthrough()
  .transform((value) => upgradeLegacyRegistration(value as Record<string, unknown>));

/** Holds the v1 `pauseReason` strings map onto. Unknown reasons become `paused`. */
const legacyHoldKind = (reason: string): PrMaintenanceHoldKind =>
  reason === "stopped"
    ? "stopped"
    : reason === "authorization_failed"
      ? "access"
      : ["remote_identity_changed", "continuation_identity_changed"].includes(reason)
        ? "identity"
        : reason === "manual_control"
          ? "manual_control"
          : "paused";

/**
 * Converts a v1 registration. Explicit pauses stay held until one Resume;
 * human-decision pauses become `waiting_for_decision` without a second hold.
 * Continuations, resume history and pause origin move to `legacyAudit`.
 */
export function upgradeLegacyRegistration(
  legacy: Record<string, unknown>,
): z.input<typeof PrMaintenanceRegistrationV2Schema> {
  const {
    schemaVersion: _schemaVersion,
    lifecycle,
    pauseReason,
    pauseOrigin,
    pausedAt,
    pausedNoticeAt,
    continuation,
    continuationHistory,
    resumeHistory,
    counters,
    ...rest
  } = legacy as Record<string, unknown> & {
    lifecycle: string;
    pauseReason?: string;
    pauseOrigin?: { actor: string; actorId: string; at: string };
    pausedAt?: string;
    counters?: Record<string, number>;
  };
  const decision = legacy.decision as { state?: string } | undefined;
  // The decision schema defaults a missing state to pending.
  const decisionPending =
    Boolean(decision) && (decision!.state ?? "pending") === "pending";
  const reason = pauseReason ?? "";
  const holdKind =
    lifecycle === "paused" &&
    !(decisionPending && ["wait_for_human", "finding_needs_human"].includes(reason))
      ? legacyHoldKind(reason)
      : undefined;
  const at =
    pauseOrigin?.at ??
    pausedAt ??
    (legacy.updatedAt as string) ??
    new Date(0).toISOString();
  const legacyAudit = Object.fromEntries(
    Object.entries({
      lifecycle,
      pauseReason: reason || undefined,
      pauseOrigin,
      pausedAt,
      pausedNoticeAt,
      continuation,
      continuationHistory,
      resumeHistory,
      scanStalls: counters?.scanStalls,
      reconciliationStalls: counters?.reconciliationStalls,
    }).filter(([, value]) => value !== undefined),
  );
  return {
    ...(rest as object),
    schemaVersion: 2,
    lifecycle: lifecycle === "merged" || lifecycle === "closed" ? lifecycle : "active",
    ...(holdKind
      ? {
          hold: {
            kind: holdKind,
            reason: reason || "Paused before the v2 upgrade",
            actor: (["lead", "operator", "node_console", "system"].includes(
              pauseOrigin?.actor ?? "",
            )
              ? pauseOrigin!.actor
              : "system") as PrMaintenanceHold["actor"],
            actorId: pauseOrigin?.actorId ?? "host",
            at,
          },
        }
      : {}),
    counters: {
      repairBatches: counters?.repairBatches ?? 0,
      answerBatches: counters?.answerBatches ?? 0,
      mutationAttempts: counters?.mutationAttempts ?? 0,
      consecutiveFailures: counters?.consecutiveFailures ?? 0,
      totalFailures: counters?.totalFailures ?? 0,
      dispatchesSinceDirection: 0,
    },
    ...(Object.keys(legacyAudit).length ? { legacyAudit } : {}),
  } as z.input<typeof PrMaintenanceRegistrationV2Schema>;
}

export const PrMaintenanceRegistrationSchema = z
  .union([legacyRegistrationSchema, z.unknown()])
  .pipe(PrMaintenanceRegistrationV2Schema);
export type PrMaintenanceRegistration = z.infer<typeof PrMaintenanceRegistrationV2Schema>;

export function prMaintenanceObservationFresh(
  observation: PrMaintenanceObservation | undefined,
  nowMs = Date.now(),
  hostAttemptedAt = observation?.attemptedAt,
): boolean {
  if (!observation || !hostAttemptedAt) return false;
  const age = nowMs - Date.parse(hostAttemptedAt);
  return age >= 0 && age <= PR_MAINTENANCE_RECOVERY_LIMITS.evidenceAgeMs;
}

/** Batch states that still need execution or reconciliation. */
export const prMaintenanceOutstandingBatchStates: ReadonlySet<string> = new Set([
  "prepared",
  "accepted",
  "reconciling",
  "uncertain",
]);

export function prMaintenanceWorkSources(
  record: Pick<PrMaintenanceRegistration, "workRequests">,
): z.infer<typeof PrMaintenanceSourceSchema>[] {
  return record.workRequests
    .filter((request) => request.state === "pending")
    .map((request) => ({
      id: `operator-work:${request.id}`,
      revision: request.id,
      groupKey: `operator-work:${request.id}`,
      evidence: request.direction,
    }));
}

export function prMaintenanceSources(
  record: Pick<PrMaintenanceRegistration, "workRequests" | "observation">,
): z.infer<typeof PrMaintenanceSourceSchema>[] {
  return [
    ...(record.observation?.sources ?? []).filter(
      (source) => !source.id.startsWith("operator-work:"),
    ),
    ...prMaintenanceWorkSources(record),
  ];
}

/**
 * Execution or an external effect whose outcome is not yet known. While true,
 * PRM refuses new effects and new batches until the evidence is reconciled.
 */
export function prMaintenanceReconciling(record: PrMaintenanceRegistration): boolean {
  return (
    record.incidents.some(
      (incident) => incident.kind === "effects" && !incident.resolvedAt,
    ) ||
    record.batches.some(
      (batch) =>
        batch.state === "uncertain" ||
        batch.state === "reconciling" ||
        (Boolean(batch.stepId) &&
          !batch.executionSettled &&
          !prMaintenanceOutstandingBatchStates.has(batch.state)),
    ) ||
    [...record.actions, ...record.batches.flatMap((batch) => batch.effects)].some(
      (effect) => effect.state === "uncertain" || effect.state === "reserved",
    )
  );
}

/** The phases a user sees. Holds are reported beside the phase, never instead of it. */
export const PrMaintenancePhaseSchema = z.enum([
  "reviewing",
  "working",
  "idle",
  "waiting_for_decision",
  "merged",
  "closed",
  "released",
]);
export type PrMaintenancePhase = z.infer<typeof PrMaintenancePhaseSchema>;

export const PrMaintenanceStatusSchema = z
  .object({
    phase: PrMaintenancePhaseSchema,
    hold: PrMaintenanceHoldKindSchema.or(
      z.enum(["reconciling", "binding", "permission"]),
    ).optional(),
    label: z.string(),
    reason: z.string(),
    action: z.string(),
    /** The single operator control that moves the job forward, when one exists. */
    operatorAction: z.enum(["resume", "direction", "review"]).optional(),
  })
  .strict();
export type PrMaintenanceStatus = z.infer<typeof PrMaintenanceStatusSchema>;

export const prMaintenancePhaseLabels: Record<PrMaintenancePhase, string> = {
  reviewing: "Reviewing",
  working: "Working",
  idle: "Idle",
  waiting_for_decision: "Waiting for Design Decision",
  merged: "Merged",
  closed: "Closed",
  released: "Released",
};

const holdLabels: Record<NonNullable<PrMaintenanceStatus["hold"]>, string> = {
  stopped: "Stopped",
  paused: "Paused",
  access: "Access needed",
  identity: "PR identity changed",
  manual_control: "Manual control",
  reconciling: "Reconciling",
  binding: "Worker unavailable",
  permission: "Permission pending",
};

/** The batch currently running on the retained worker, if any. */
export function prMaintenanceActiveBatch(
  record: Pick<PrMaintenanceRegistration, "batches">,
): PrMaintenanceBatch | undefined {
  return record.batches.find(
    (batch) =>
      batch.state === "accepted" && Boolean(batch.stepId) && !batch.executionSettled,
  );
}

/**
 * The one authoritative description of a registration.
 *
 * `overlay` carries facts only the Host can see — a broken retained binding or
 * a pending session permission. Everything else is derived from the record, so
 * the browser, the orchestrator and admission can never disagree.
 */
export function prMaintenanceStatus(
  record: PrMaintenanceRegistration,
  overlay: { binding?: string | undefined; permission?: boolean | undefined } = {},
): PrMaintenanceStatus {
  const make = (
    phase: PrMaintenancePhase,
    reason: string,
    action: string,
    hold?: PrMaintenanceStatus["hold"],
    operatorAction?: PrMaintenanceStatus["operatorAction"],
  ): PrMaintenanceStatus => ({
    phase,
    ...(hold ? { hold } : {}),
    label: hold
      ? `${prMaintenancePhaseLabels[phase]} · ${holdLabels[hold]}`
      : prMaintenancePhaseLabels[phase],
    reason,
    action,
    ...(operatorAction ? { operatorAction } : {}),
  });
  // A provider terminal state is the useful fact even after ownership auto-releases.
  if (record.lifecycle === "merged" || record.lifecycle === "closed")
    return make(
      record.lifecycle,
      `The PR was ${record.lifecycle} on the provider. Maintenance stopped; it never merges.`,
      prMaintenanceReconciling(record)
        ? "Outstanding effects are still being reconciled."
        : "Nothing further to do.",
      prMaintenanceReconciling(record) ? "reconciling" : undefined,
    );
  if (record.ownershipReleasedAt)
    return make(
      "released",
      "Ownership was released; history is retained for audit.",
      "Enable maintenance again to resume work on a PR.",
    );
  const active = prMaintenanceActiveBatch(record);
  const phase: PrMaintenancePhase =
    record.decision?.state === "pending"
      ? "waiting_for_decision"
      : active
        ? "working"
        : record.review && !record.review.concludedAt
          ? "reviewing"
          : "idle";
  if (record.hold) {
    const hold = record.hold;
    const actions: Record<PrMaintenanceHoldKind, string> = {
      stopped: "Resume maintenance to continue with the same worker.",
      paused: "Resume maintenance, or answer the pending decision.",
      access:
        "Restore provider sign-in or permissions on the Node, then Resume maintenance.",
      identity:
        "The PR or its source branch changed identity. Confirm it is still the same PR, then Resume, or release it.",
      manual_control:
        "A person is driving the retained worker. Hand back, or Resume maintenance when done.",
    };
    return make(phase, hold.reason, actions[hold.kind], hold.kind, "resume");
  }
  if (overlay.binding)
    return make(
      phase,
      `The retained worker or checkout is unavailable (${overlay.binding}).`,
      "Restore the original worker session or checkout; maintenance never replaces it.",
      "binding",
    );
  if (overlay.permission)
    return make(
      phase,
      "A session permission request is waiting for an answer.",
      "Answer it in the requesting session.",
      "permission",
    );
  if (prMaintenanceReconciling(record))
    return make(
      phase,
      "An execution or external effect has an unknown outcome.",
      "Fleet reconciles it from provider evidence before any new effect; nothing is replayed.",
      "reconciling",
    );
  if (phase === "waiting_for_decision")
    return make(
      phase,
      record.decision!.proposal,
      "Give direction in the PR maintenance panel or tell the orchestrator. Maintenance resumes automatically.",
      undefined,
      "direction",
    );
  if (phase === "working")
    return make(
      phase,
      "The retained worker is applying routine fixes.",
      "Its result wakes the orchestrator to review the PR again.",
    );
  if (phase === "reviewing")
    return make(
      phase,
      "Refreshing PR state and deciding what, if anything, needs doing.",
      record.review?.claimedAt
        ? "The orchestrator is reviewing now."
        : "Queued for the orchestrator's next turn.",
    );
  return make(
    "idle",
    record.review?.summary ?? "No actionable feedback and no pending decision.",
    "The next heartbeat checks again. Use Review now to check immediately.",
    undefined,
    "review",
  );
}

/** The registration a task view should describe: retained active work before history. */
export function currentPrMaintenance<
  T extends Pick<PrMaintenanceRegistration, "ownershipReleasedAt" | "createdAt">,
>(records: readonly T[]): T | undefined {
  const retained = records.filter((record) => !record.ownershipReleasedAt);
  return (retained.length ? retained : records).reduce<T | undefined>(
    (latest, record) =>
      !latest || record.createdAt > latest.createdAt ? record : latest,
    undefined,
  );
}

/**
 * A task's retained PR maintenance, reduced to what a task list needs.
 *
 * The Host computes this for the snapshot so a list can say a task is maintaining
 * a PR without fetching every full registration. Task details read the record.
 */
export const PrMaintenanceTaskStatusSchema = z.object({
  taskId: id,
  recordId: id,
  workerSessionId: id.optional(),
  prUrl: z.string().min(1),
  status: PrMaintenanceStatusSchema,
});
export type PrMaintenanceTaskStatus = z.infer<typeof PrMaintenanceTaskStatusSchema>;

export function prMaintenanceTaskStatuses(
  records: readonly PrMaintenanceRegistration[],
  overlay: (
    record: PrMaintenanceRegistration,
  ) => Parameters<typeof prMaintenanceStatus>[1] = () => ({}),
): PrMaintenanceTaskStatus[] {
  const byTask = new Map<string, PrMaintenanceRegistration[]>();
  for (const record of records)
    byTask.set(record.taskId, [...(byTask.get(record.taskId) ?? []), record]);
  return [...byTask.values()].flatMap((taskRecords) => {
    const record = currentPrMaintenance(taskRecords);
    if (!record) return [];
    return [
      {
        taskId: record.taskId,
        recordId: record.id,
        workerSessionId: record.workerSessionId,
        prUrl: prMaintenanceUrl(record.identity),
        status: prMaintenanceStatus(record, overlay(record)),
      },
    ];
  });
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

export const PrMaintenanceObservationClaimRefSchema = z
  .object({ recordId: id, generation: z.number().int().positive(), wakeId: id })
  .strict();

export const PrMaintenanceWakeSchema = z
  .object({
    leadSessionId: id,
    wakeId: id,
    startedAt: time,
    visits: count,
    requests: count,
    milliseconds: count,
    visitedIds: z.array(id).max(5),
    observationClaims: z
      .array(
        z
          .object({
            recordId: id,
            generation: z.number().int().positive(),
            recordVersion: z.number().int().positive(),
            scopeKey: sha,
            claimedAt: time,
            deadlineAt: time,
            requests: z.number().int().min(1).max(40),
            executionId: z.string().uuid().optional(),
            attemptId: z.string().uuid().optional(),
            receiptHash: sha.optional(),
          })
          .strict(),
      )
      .max(5)
      .default([]),
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
