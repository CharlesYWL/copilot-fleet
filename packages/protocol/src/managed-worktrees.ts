import { z } from "zod";

export const MANAGED_WORKTREES_CAPABILITY = "managed-worktrees-v1";
export const PORTABLE_WORKTREE_RESULTS_CAPABILITY = "portable-worktree-results-v1";
export const WORKSPACE_ARTIFACT_CHUNK_BYTES = 256 * 1024;
export const WORKSPACE_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export const WORKSPACE_RESULT_MAX_PER_RUN = 64;
export const WORKSPACE_RESULT_MAX_BYTES_PER_RUN = 2 * 1024 * 1024 * 1024;
export const WORKSPACE_RESULT_MAX_BYTES_PER_HOST = 20 * 1024 * 1024 * 1024;
export const WorkspaceModeSchema = z.enum(["auto", "legacy", "managed"]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;
export const AccessIntentSchema = z.enum(["checkout", "no-checkout"]);
export const GitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const identity = z.string().min(1).max(4096);

export const RunWorkspaceBindingSchema = z
  .object({
    requestedMode: WorkspaceModeSchema.default("legacy"),
    effectiveMode: z.enum(["legacy", "managed"]).default("legacy"),
    resolutionSource: z
      .enum(["explicit", "app_default", "historical", "no_checkout"])
      .default("historical"),
    sourcePlacementId: z.string().default(""),
    originatingPlacementId: z.string().default(""),
    repositoryIdentity: z.string().default(""),
    repositoryObjectFormat: z.enum(["sha1", "sha256"]).optional(),
    accessIntent: AccessIntentSchema.default("checkout"),
    managedWorktreeId: z.string().default(""),
    generation: z.number().int().nonnegative().default(0),
    baseSha: z.union([GitShaSchema, z.literal("")]).default(""),
    checkoutKey: z.string().default(""),
    resolvedPath: z.string().default(""),
    initialization: z
      .enum(["not_required", "pending", "reserved", "ready", "blocked", "quarantined"])
      .default("not_required"),
    setupState: z
      .enum(["not_required", "pending", "running", "succeeded", "failed"])
      .default("not_required"),
    setupAttempt: z.number().int().nonnegative().default(0),
    setupCode: z.string().default(""),
    setupSummary: z.string().default(""),
    setupStartedAt: z.string().default(""),
    setupCompletedAt: z.string().default(""),
    setupResumeState: z
      .enum(["awaiting_approval", "planning", "running", "awaiting_lead"])
      .default("running"),
    baseRef: z.string().default(""),
    integrationBaseRef: z.string().default(""),
    integrationTargetRef: z.string().default(""),
    integrationRemote: z.string().default(""),
    integrationUsername: z.string().max(320).default(""),
    allowGitHooks: z.boolean().default(false),
    aggregationState: z
      .enum(["not_started", "in_progress", "attention", "completed"])
      .default("not_started"),
    aggregationPhase: z
      .enum([
        "idle",
        "preview",
        "integrate",
        "validate",
        "await_publish_approval",
        "publish",
        "quiesce",
        "retain",
        "cleanup",
        "done",
      ])
      .default("idle"),
    aggregationAttempt: z.number().int().nonnegative().default(0),
    aggregationAutomaticRetries: z.number().int().nonnegative().default(0),
    aggregationCode: z.string().default(""),
    aggregationSummary: z.string().default(""),
    aggregationTargetRef: z.string().default(""),
    aggregationUpdatedAt: z.string().default(""),
    finalizationOutcome: z
      .enum(["completed", "failed", "cancelled"])
      .default("completed"),
    finalizationReason: z.string().default(""),
    error: z.string().default(""),
  })
  .transform((value) => ({
    ...value,
    originatingPlacementId: value.originatingPlacementId || value.sourcePlacementId,
  }));
export type RunWorkspaceBinding = z.infer<typeof RunWorkspaceBindingSchema>;

export function resolveWorkspaceMode(
  requested: WorkspaceMode | undefined,
  enabled: boolean,
  accessIntent: "checkout" | "no-checkout" = "checkout",
): RunWorkspaceBinding {
  return RunWorkspaceBindingSchema.parse({
    requestedMode: requested ?? "legacy",
    effectiveMode:
      accessIntent === "no-checkout"
        ? "legacy"
        : requested === "managed" || (requested === "auto" && enabled)
          ? "managed"
          : "legacy",
    resolutionSource:
      accessIntent === "no-checkout"
        ? "no_checkout"
        : requested === undefined
          ? "historical"
          : requested === "auto"
            ? "app_default"
            : "explicit",
    accessIntent,
    initialization:
      accessIntent === "checkout" &&
      (requested === "managed" || (requested === "auto" && enabled))
        ? "pending"
        : "not_required",
    setupState:
      accessIntent === "checkout" &&
      (requested === "managed" || (requested === "auto" && enabled))
        ? "pending"
        : "not_required",
    setupAttempt:
      accessIntent === "checkout" &&
      (requested === "managed" || (requested === "auto" && enabled))
        ? 1
        : 0,
  });
}

export const CheckoutIdentitySchema = z.object({
  key: identity,
  path: identity,
  machineId: identity,
  volume: identity,
  fileId: identity,
});
export type CheckoutIdentity = z.infer<typeof CheckoutIdentitySchema>;

export const ExecutionBindingSchema = z.object({
  worktreeId: z.string().default(""),
  generation: z.number().int().nonnegative().default(0),
  sourcePlacementId: identity,
  cwd: identity,
  checkoutKey: identity,
  accessClass: z.enum(["shell", "no-checkout"]).default("shell"),
  // Host dispatch fencing token, not process identity. An authenticated resume
  // may rotate it on the same conversation/checkout; prompts must match exactly.
  leaseAttempt: identity,
  quarantined: z.boolean().default(false),
});
export type ExecutionBinding = z.infer<typeof ExecutionBindingSchema>;

export const ManagedWorktreePolicySchema = z.object({
  retentionDays: z.number().int().min(1).max(365).default(7),
  maxPerRepository: z.number().int().min(1).max(128).default(8),
  maxPerNode: z.number().int().min(1).max(1024).default(32),
  freeSpaceFloorBytes: z.number().int().nonnegative().default(1_073_741_824),
  byteBudget: z.number().int().positive().default(10_737_418_240),
  cleanupIgnoredOnly: z.boolean().default(false),
});
export type ManagedWorktreePolicy = z.infer<typeof ManagedWorktreePolicySchema>;

export const RepositoryFeaturesSchema = z.object({
  sparseCheckout: z.boolean().default(false),
  sparseCone: z.boolean().default(false),
  sparsePaths: z.array(z.string()).max(10_000).default([]),
  submodules: z.boolean().default(false),
  gitLfs: z.boolean().default(false),
  partialClone: z.boolean().default(false),
  estimatedBytesReliable: z.boolean().default(true),
});
export type RepositoryFeatures = z.infer<typeof RepositoryFeaturesSchema>;

export const RepositoryExecutionPolicySchema = z.object({
  version: z.literal(1).default(1),
  hooks: z.enum(["disabled", "approved_exact"]).default("disabled"),
  hooksDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .default("0".repeat(64)),
  filters: z.enum(["disabled", "git_lfs"]).default("disabled"),
  filtersDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .default("0".repeat(64)),
  submodules: z.enum(["disabled", "node_local"]).default("disabled"),
  fsmonitor: z.literal("disabled").default("disabled"),
  credentialHelpers: z.literal("publication_only").default("publication_only"),
  credentialHelpersDigest: z
    .string()
    .regex(/^(?:[a-f0-9]{64})?$/)
    .default(""),
  configurationDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .default("0".repeat(64)),
});
export type RepositoryExecutionPolicy = z.infer<typeof RepositoryExecutionPolicySchema>;

export const IntegrationBasePolicySchema = z.enum([
  "pinned",
  "latest-target",
  "repository-policy",
]);
export const IntegrationStrategySchema = z.enum([
  "merge",
  "squash",
  "linear",
  "repository-policy",
]);
export const PublicationPolicySchema = z.object({
  mode: z.enum(["none", "branch"]).default("branch"),
  approval: z.literal("ask").default("ask"),
  remote: z.string().default(""),
  targetRef: z.string().default(""),
  createOnly: z.boolean().default(true),
});
export const RunWorkspaceSpecSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  requestedMode: WorkspaceModeSchema,
  effectiveMode: z.enum(["legacy", "managed"]),
  repositoryIdentity: z.string().default(""),
  repositoryObjectFormat: z.enum(["sha1", "sha256"]).optional(),
  executionBaseRef: z.string().default(""),
  executionBaseSha: z.union([GitShaSchema, z.literal("")]).default(""),
  sourceProvenance: z.object({
    placementId: z.string().default(""),
    workspaceId: z.string().default(""),
  }),
  workspacePolicy: ManagedWorktreePolicySchema.optional(),
  integrationBasePolicy: IntegrationBasePolicySchema.default("latest-target"),
  integrationBaseRef: z.string().default(""),
  integrationStrategy: IntegrationStrategySchema.default("merge"),
  publicationPolicy: PublicationPolicySchema.default(() =>
    PublicationPolicySchema.parse({}),
  ),
  repositoryExecutionPolicy: RepositoryExecutionPolicySchema.optional(),
  hookPolicy: z.enum(["disabled", "approved_exact"]).default("disabled"),
  createdAt: z.string().datetime(),
});
export type RunWorkspaceSpec = z.infer<typeof RunWorkspaceSpecSchema>;

export const ManagedWorkspaceKindSchema = z.enum([
  "primary",
  "step",
  "derived",
  "integration",
]);
export type ManagedWorkspaceKind = z.infer<typeof ManagedWorkspaceKindSchema>;

export const CompositionPredecessorSchema = z.object({
  stepId: identity,
  stepKey: identity,
  position: z.number().int().nonnegative(),
  worktreeId: identity,
  resultSha: GitShaSchema,
  workspaceResultId: z.string().optional(),
});
export type CompositionPredecessor = z.infer<typeof CompositionPredecessorSchema>;

export const WorktreeCompositionSchema = z.object({
  baseSha: GitShaSchema,
  baseRef: z.string().default(""),
  dependencyResolution: z.enum(["explicit", "phase_fallback"]).default("explicit"),
  implicitDependencyFallback: z.boolean().default(false),
  predecessors: z.array(CompositionPredecessorSchema).default([]),
  coveredPredecessorStepIds: z.array(identity).default([]),
  state: z
    .enum(["not_required", "pending", "composing", "ready", "conflicted", "blocked"])
    .default("not_required"),
  resultSha: z.union([GitShaSchema, z.literal("")]).default(""),
  conflicts: z.array(z.string()).default([]),
  error: z.string().default(""),
  startedAt: z.string().default(""),
  completedAt: z.string().default(""),
});
export type WorktreeComposition = z.infer<typeof WorktreeCompositionSchema>;

export const WorktreeLifecycleSchema = z.enum([
  "reserved",
  "creating",
  "ready",
  "retained",
  "removing",
  "removed",
  "creation_failed",
  "missing",
  "unavailable",
  "needs_reconciliation",
  "quarantined",
]);
export const IntegrationStateSchema = z.enum([
  "not_requested",
  "not_ready",
  "ready",
  "integrating",
  "validating",
  "integrated",
  "no_changes",
  "conflicted",
  "resolving",
  "aborting",
  "aborted",
  "uncertain",
  "needs_reconciliation",
]);

export const WorktreeObservationSchema = z.object({
  generation: z.number().int().positive(),
  observedAt: z.string().datetime(),
  head: z.string().default(""),
  ref: z.string().default(""),
  staged: z.boolean().nullable().default(null),
  unstaged: z.boolean().nullable().default(null),
  untracked: z.boolean().nullable().default(null),
  ignored: z.boolean().nullable().default(null),
  dirty: z.boolean().nullable().default(null),
  ahead: z.number().int().nonnegative().nullable().default(null),
  behind: z.number().int().nonnegative().nullable().default(null),
  registered: z.boolean().nullable().default(null),
  pathExists: z.boolean().nullable().default(null),
  locked: z.boolean().nullable().default(null),
  prunable: z.boolean().nullable().default(null),
  lockHolder: z.string().default(""),
  approximateBytes: z.number().nonnegative().nullable().default(null),
  freeBytes: z.number().nonnegative().nullable().default(null),
});
export type WorktreeObservation = z.infer<typeof WorktreeObservationSchema>;

export const ManagedWorktreeSchema = z
  .object({
    id: identity,
    runId: identity,
    taskKey: identity,
    sourcePlacementId: identity,
    originatingPlacementId: z.string().default(""),
    executionPlacementId: z.string().default(""),
    repositoryIdentity: z.string().default(""),
    repositoryObjectFormat: z.enum(["sha1", "sha256"]).optional(),
    workspaceId: identity,
    nodeId: identity,
    machineId: identity,
    hostInstallationId: identity,
    nodeInstallationId: identity,
    repository: CheckoutIdentitySchema,
    commonDirectory: CheckoutIdentitySchema,
    managedRoot: CheckoutIdentitySchema,
    generation: z.number().int().positive(),
    version: z.number().int().nonnegative(),
    path: identity,
    checkout: CheckoutIdentitySchema.optional(),
    branchRef: z.string().regex(/^refs\/heads\/fleet\/[a-z0-9-]+$/),
    pinRef: z.string().regex(/^refs\/fleet\/pins\/[a-z0-9-]+$/),
    baseSha: GitShaSchema,
    baseRef: z.string().default(""),
    workspaceKind: ManagedWorkspaceKindSchema.default("primary"),
    ownerStepId: z.string().default(""),
    resultSha: z.union([GitShaSchema, z.literal("")]).default(""),
    resultRecordedAt: z.string().default(""),
    fleetCheckpointSha: z.union([GitShaSchema, z.literal("")]).default(""),
    sealedFiles: z.array(z.string()).default([]),
    importedWorkspaceResults: z
      .array(
        z.object({
          id: identity,
          headSha: GitShaSchema,
          artifactId: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(128)
      .default([]),
    composition: WorktreeCompositionSchema.optional(),
    repositoryFeatures: RepositoryFeaturesSchema.default(() =>
      RepositoryFeaturesSchema.parse({}),
    ),
    repositoryExecutionPolicy: RepositoryExecutionPolicySchema.default(() =>
      RepositoryExecutionPolicySchema.parse({}),
    ),
    state: WorktreeLifecycleSchema,
    integrationState: IntegrationStateSchema.default("not_requested"),
    integrationStrategy: z.literal("merge").default("merge"),
    allowGitHooks: z.boolean().default(false),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    retainedAt: z.string().default(""),
    expiresAt: z.string().default(""),
    orphanedAt: z.string().default(""),
    orphanReason: z.string().default(""),
    removedAt: z.string().default(""),
    abandonedAt: z.string().default(""),
    error: z.string().default(""),
    observation: WorktreeObservationSchema.optional(),
  })
  .transform((value) => ({
    ...value,
    originatingPlacementId: value.originatingPlacementId || value.sourcePlacementId,
    executionPlacementId: value.executionPlacementId || value.sourcePlacementId,
  }));
export type ManagedWorktree = z.infer<typeof ManagedWorktreeSchema>;

export const WorkspaceInstanceSchema = z.object({
  workspaceId: identity,
  runId: identity,
  generation: z.number().int().positive(),
  kind: ManagedWorkspaceKindSchema,
  ownerStepId: z.string().default(""),
  assignedNodeId: identity,
  placementId: z.string().default(""),
  physicalIdentity: CheckoutIdentitySchema.optional(),
  localPath: z.string().default(""),
  lifecycleState: WorktreeLifecycleSchema,
  currentHead: z.union([GitShaSchema, z.literal("")]).default(""),
  resultId: z.string().default(""),
});
export type WorkspaceInstance = z.infer<typeof WorkspaceInstanceSchema>;

export const IntegrationPreviewSchema = z.object({
  id: identity,
  worktreeId: identity,
  integrationWorkspaceId: z.string().default(""),
  generation: z.number().int().positive(),
  taskSha: GitShaSchema,
  baseTree: z.union([GitShaSchema, z.literal("")]).default(""),
  taskTree: z.union([GitShaSchema, z.literal("")]).default(""),
  targetTree: z.union([GitShaSchema, z.literal("")]).default(""),
  diffIdentity: identity,
  diff: z.string().max(1_000_000),
  targetPlacementId: identity,
  target: CheckoutIdentitySchema,
  targetRef: identity,
  targetBaseRef: z.string().default(""),
  targetRemote: z.string().default(""),
  targetSha: GitShaSchema,
  taskDirty: z.boolean(),
  targetDirty: z.boolean(),
  hasCommittedChanges: z.boolean().default(true),
  baseContainedByTarget: z.boolean().default(false),
  targetAdvancedFromBase: z.boolean().default(false),
  alreadyIntegrated: z.boolean(),
  observedAt: z.string().datetime(),
});
export type IntegrationPreview = z.infer<typeof IntegrationPreviewSchema>;

export const WorktreeIntegrationSchema = z.object({
  id: identity,
  worktreeId: identity,
  generation: z.number().int().positive(),
  preview: IntegrationPreviewSchema,
  approvedTaskSha: GitShaSchema,
  approvedDiffIdentity: identity,
  strategy: z.literal("merge").default("merge"),
  state: IntegrationStateSchema,
  preState: z.string(),
  resultSha: z.string().default(""),
  mergeTree: z.string().default(""),
  finalTree: z.string().default(""),
  conflicts: z.array(z.string()).default([]),
  validationState: z.enum(["not_run", "running", "passed", "failed"]).default("not_run"),
  validationSummary: z.string().default(""),
  validationStartedAt: z.string().default(""),
  validatedAt: z.string().default(""),
  publishState: z
    .enum(["not_started", "awaiting_approval", "publishing", "published", "failed"])
    .default("not_started"),
  publicationBaseSha: z.union([GitShaSchema, z.literal("")]).default(""),
  publicationDiff: z.string().max(1_000_000).default(""),
  publicationFileCount: z.number().int().nonnegative().default(0),
  publicationCommitCount: z.number().int().nonnegative().default(0),
  publishedAt: z.string().default(""),
  error: z.string().default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorktreeIntegration = z.infer<typeof WorktreeIntegrationSchema>;

export const IntegrationAttemptSchema = z.object({
  attemptId: identity,
  runId: identity,
  attemptNumber: z.number().int().positive(),
  resultWorkspaceId: identity,
  resultGeneration: z.number().int().positive(),
  integrationBaseSha: z.union([GitShaSchema, z.literal("")]).default(""),
  targetRef: z.string().default(""),
  assignedNodeId: identity,
  phase: z.enum([
    "quiesce",
    "aggregate",
    "integrate",
    "validate",
    "publish",
    "retain",
    "cleanup",
    "done",
  ]),
  preview: IntegrationPreviewSchema.optional(),
  expectedTree: z.union([GitShaSchema, z.literal("")]).default(""),
  finalSha: z.union([GitShaSchema, z.literal("")]).default(""),
  status: z.enum(["in_progress", "attention", "completed"]).default("in_progress"),
  publishState: z
    .enum(["not_started", "awaiting_approval", "publishing", "published", "failed"])
    .default("not_started"),
  receiptIds: z.array(identity).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IntegrationAttempt = z.infer<typeof IntegrationAttemptSchema>;

export const PublicationApprovalSchema = z.object({
  approvalId: identity,
  runId: identity,
  integrationId: identity,
  targetRemote: identity,
  targetRef: identity,
  expectedRemoteSha: z.union([GitShaSchema, z.literal("")]).default(""),
  finalResultSha: GitShaSchema,
  finalTreeSha: GitShaSchema,
  approvedBy: identity,
  approvedAt: z.string().datetime(),
});
export type PublicationApproval = z.infer<typeof PublicationApprovalSchema>;

export const WorktreeOperationKindSchema = z.enum([
  "reserve",
  "create",
  "observe",
  "reconcile",
  "retain",
  "quiesce",
  "compose",
  "materialize",
  "finalize",
  "integration_preview",
  "integrate",
  "publish",
  "continue",
  "abort",
  "cleanup",
  "abandon",
]);
export const WorktreeOperationRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    kind: WorktreeOperationKindSchema,
    worktreeId: identity,
    runId: identity,
    sourcePlacementId: identity,
    originatingPlacementId: z.string().default(""),
    repositoryIdentity: z.string().default(""),
    repositoryObjectFormat: z.enum(["sha1", "sha256"]).optional(),
    workspaceId: identity,
    sourcePath: identity,
    nodeId: identity,
    hostInstallationId: identity,
    expectedVersion: z.number().int().nonnegative(),
    generation: z.number().int().positive(),
    expectedPath: z.string().default(""),
    expectedBranchRef: z.string().default(""),
    expectedBaseSha: z.string().default(""),
    expectedBaseRef: z.string().default(""),
    integrationBaseRef: z.string().default(""),
    integrationTargetRef: z.string().default(""),
    integrationRemote: z.string().default(""),
    actor: identity,
    allowGitHooks: z.boolean().default(false),
    attempt: z.number().int().positive().default(1),
    policy: ManagedWorktreePolicySchema.default(() =>
      ManagedWorktreePolicySchema.parse({}),
    ),
    targetPlacementId: z.string().optional(),
    targetPath: z.string().optional(),
    previewId: z.string().optional(),
    integrationId: z.string().optional(),
    reviewedTaskSha: GitShaSchema.optional(),
    reviewedDiffIdentity: z.string().optional(),
    publicationApproval: PublicationApprovalSchema.optional(),
    workspaceKind: ManagedWorkspaceKindSchema.default("primary"),
    ownerStepId: z.string().default(""),
    composition: WorktreeCompositionSchema.optional(),
    workspaceResults: z
      .array(z.lazy(() => WorkspaceResultSchema))
      .max(64)
      .default([]),
    confirm: z.string().optional(),
    commit: z.boolean().default(false),
    deleteBranch: z.boolean().default(false),
  })
  .transform((value) => ({
    ...value,
    originatingPlacementId: value.originatingPlacementId || value.sourcePlacementId,
  }));
export type WorktreeOperationRequest = z.infer<typeof WorktreeOperationRequestSchema>;

export const WorktreeOperationResultSchema = z.object({
  operationId: z.string().uuid(),
  worktreeId: identity,
  generation: z.number().int().positive(),
  nodeId: identity,
  hostInstallationId: identity,
  ok: z.boolean(),
  retryable: z.boolean().default(false),
  code: z.string().default(""),
  error: z.string().default(""),
  worktree: ManagedWorktreeSchema.optional(),
  preview: IntegrationPreviewSchema.optional(),
  integration: WorktreeIntegrationSchema.optional(),
  workspaceResult: z.lazy(() => WorkspaceResultSchema).optional(),
  acknowledgedAt: z.string().datetime(),
});
export type WorktreeOperationResult = z.infer<typeof WorktreeOperationResultSchema>;

export const RepositoryIdentitySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  objectFormat: z.enum(["sha1", "sha256"]),
  evidence: z.enum(["remote", "roots"]),
  remoteHash: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.literal("")]).default(""),
  rootHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;

export const PlacementRepositoryCapabilitySchema = z.object({
  placementId: identity,
  nodeId: identity,
  localPath: z.string().optional(),
  repositoryIdentity: RepositoryIdentitySchema,
  baseSha: GitShaSchema,
  baseAvailable: z.boolean(),
  baseMaterializable: z.boolean().default(false),
  portableResultsSupported: z.boolean().default(true),
  portabilityReason: z.string().default(""),
  verifiedAt: z.string().datetime(),
  error: z.string().default(""),
});
export type PlacementRepositoryCapability = z.infer<
  typeof PlacementRepositoryCapabilitySchema
>;

export const WorkspaceResultStateSchema = z.enum([
  "sealing",
  "uploading",
  "available",
  "corrupt",
  "expired",
]);
export const WorkspaceResultSchema = z.object({
  id: identity,
  runId: identity,
  ownerStepId: identity,
  repositoryIdentity: identity,
  baseSha: GitShaSchema,
  baseRef: z.string().default(""),
  headSha: GitShaSchema,
  finalTreeOid: GitShaSchema.optional(),
  includedFiles: z.array(z.string()).default([]),
  checkpointCreated: z.boolean().default(false),
  purpose: z.enum(["task_result", "recovery"]).default("task_result"),
  sourceWorktreeId: identity,
  sourceNodeId: identity,
  sourcePlacementId: identity,
  sourceGeneration: z.number().int().positive(),
  state: WorkspaceResultStateSchema,
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  artifactRef: z
    .string()
    .regex(/^refs\/fleet\/results\/[a-z0-9-]+$/)
    .optional(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactSize: z.number().int().nonnegative().max(WORKSPACE_ARTIFACT_MAX_BYTES),
  objectFormat: z.enum(["sha1", "sha256"]),
  portability: z.enum(["portable", "node_local"]).default("portable"),
  portabilityReason: z.string().default(""),
  createdAt: z.string().datetime(),
  verifiedAt: z.string().default(""),
  expiresAt: z.string().default(""),
  error: z.string().default(""),
  sealDurationMs: z.number().int().nonnegative().default(0),
  uploadDurationMs: z.number().int().nonnegative().default(0),
  downloadDurationMs: z.number().int().nonnegative().default(0),
  materializeDurationMs: z.number().int().nonnegative().default(0),
});
export type WorkspaceResult = z.infer<typeof WorkspaceResultSchema>;

export const RepositoryProbeRequestSchema = z.object({
  operationId: z.string().uuid(),
  runId: identity,
  placementId: identity,
  localPath: identity,
  baseSha: GitShaSchema,
  baseRef: z.string().default(""),
  remote: z.string().default(""),
  expectedRepositoryIdentity: z.string().default(""),
});
export type RepositoryProbeRequest = z.infer<typeof RepositoryProbeRequestSchema>;

export const RepositoryProbeResultSchema = z.object({
  operationId: z.string().uuid(),
  runId: identity,
  placementId: identity,
  nodeId: identity,
  ok: z.boolean(),
  capability: PlacementRepositoryCapabilitySchema.optional(),
  code: z.string().default(""),
  error: z.string().default(""),
});
export type RepositoryProbeResult = z.infer<typeof RepositoryProbeResultSchema>;

const artifactTransferBase = z.object({
  operationId: z.string().uuid(),
  resultId: identity,
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ArtifactUploadBeginSchema = artifactTransferBase.extend({
  result: WorkspaceResultSchema,
});
export const ArtifactUploadChunkSchema = artifactTransferBase.extend({
  offset: z.number().int().nonnegative(),
  data: z.string().max(Math.ceil((WORKSPACE_ARTIFACT_CHUNK_BYTES * 4) / 3) + 4),
});
export const ArtifactUploadCompleteSchema = artifactTransferBase.extend({
  size: z.number().int().nonnegative().max(WORKSPACE_ARTIFACT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ArtifactTransferAckSchema = artifactTransferBase.extend({
  ok: z.boolean(),
  offset: z.number().int().nonnegative().default(0),
  complete: z.boolean().default(false),
  code: z.string().default(""),
  error: z.string().default(""),
});
export const ArtifactDownloadRequestSchema = artifactTransferBase.extend({
  offset: z.number().int().nonnegative(),
});
export const ArtifactDownloadChunkSchema = artifactTransferBase.extend({
  offset: z.number().int().nonnegative(),
  data: z.string().max(Math.ceil((WORKSPACE_ARTIFACT_CHUNK_BYTES * 4) / 3) + 4),
  complete: z.boolean(),
  size: z.number().int().nonnegative().max(WORKSPACE_ARTIFACT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ArtifactUploadBegin = z.infer<typeof ArtifactUploadBeginSchema>;
export type ArtifactUploadChunk = z.infer<typeof ArtifactUploadChunkSchema>;
export type ArtifactUploadComplete = z.infer<typeof ArtifactUploadCompleteSchema>;
export type ArtifactTransferAck = z.infer<typeof ArtifactTransferAckSchema>;
export type ArtifactDownloadRequest = z.infer<typeof ArtifactDownloadRequestSchema>;
export type ArtifactDownloadChunk = z.infer<typeof ArtifactDownloadChunkSchema>;

export const WorktreeOperationSchema = z.object({
  request: WorktreeOperationRequestSchema,
  state: z.enum(["intent", "acknowledged", "uncertain", "quarantined"]),
  createdAt: z.string().datetime(),
  result: WorktreeOperationResultSchema.optional(),
});
export type WorktreeOperation = z.infer<typeof WorktreeOperationSchema>;

export const WorktreeTombstoneSchema = z.object({
  worktreeId: identity,
  runId: identity,
  generation: z.number().int().positive(),
  path: identity,
  branchRef: identity,
  nodeId: identity,
  state: z.enum(["pending", "reconciled", "abandoned", "quarantined"]),
  createdAt: z.string().datetime(),
  reconciledAt: z.string().default(""),
});
export type WorktreeTombstone = z.infer<typeof WorktreeTombstoneSchema>;

export class WorktreeConflict extends Error {
  readonly statusCode = 409;
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeConflict";
  }
}

export function checkoutLockKey(value: {
  placementId: string;
  executionBinding?: ExecutionBinding | undefined;
}): string {
  return value.executionBinding?.worktreeId
    ? value.executionBinding.checkoutKey
    : value.placementId;
}
