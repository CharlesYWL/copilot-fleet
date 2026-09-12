import { z } from "zod";

export const MANAGED_WORKTREES_CAPABILITY = "managed-worktrees-v1";
export const WorkspaceModeSchema = z.enum(["auto", "legacy", "managed"]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;
export const AccessIntentSchema = z.enum(["checkout", "no-checkout"]);
export const GitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const identity = z.string().min(1).max(4096);

export const RunWorkspaceBindingSchema = z.object({
  requestedMode: WorkspaceModeSchema.default("legacy"),
  effectiveMode: z.enum(["legacy", "managed"]).default("legacy"),
  resolutionSource: z
    .enum(["explicit", "app_default", "historical", "no_checkout"])
    .default("historical"),
  sourcePlacementId: z.string().default(""),
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
  allowGitHooks: z.boolean().default(false),
  error: z.string().default(""),
});
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
});
export type ManagedWorktreePolicy = z.infer<typeof ManagedWorktreePolicySchema>;

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

export const ManagedWorktreeSchema = z.object({
  id: identity,
  runId: identity,
  taskKey: identity,
  sourcePlacementId: identity,
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
  state: WorktreeLifecycleSchema,
  integrationState: IntegrationStateSchema.default("not_requested"),
  integrationStrategy: z.literal("merge").default("merge"),
  allowGitHooks: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  retainedAt: z.string().default(""),
  expiresAt: z.string().default(""),
  removedAt: z.string().default(""),
  abandonedAt: z.string().default(""),
  error: z.string().default(""),
  observation: WorktreeObservationSchema.optional(),
});
export type ManagedWorktree = z.infer<typeof ManagedWorktreeSchema>;

export const IntegrationPreviewSchema = z.object({
  id: identity,
  worktreeId: identity,
  generation: z.number().int().positive(),
  taskSha: GitShaSchema,
  diffIdentity: identity,
  diff: z.string().max(1_000_000),
  targetPlacementId: identity,
  target: CheckoutIdentitySchema,
  targetRef: identity,
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
  conflicts: z.array(z.string()).default([]),
  validationState: z.enum(["not_run", "running", "passed", "failed"]).default("not_run"),
  validationSummary: z.string().default(""),
  validatedAt: z.string().default(""),
  error: z.string().default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorktreeIntegration = z.infer<typeof WorktreeIntegrationSchema>;

export const WorktreeOperationKindSchema = z.enum([
  "reserve",
  "create",
  "observe",
  "reconcile",
  "retain",
  "quiesce",
  "integration_preview",
  "integrate",
  "continue",
  "abort",
  "cleanup",
  "abandon",
]);
export const WorktreeOperationRequestSchema = z.object({
  operationId: z.string().uuid(),
  kind: WorktreeOperationKindSchema,
  worktreeId: identity,
  runId: identity,
  sourcePlacementId: identity,
  workspaceId: identity,
  sourcePath: identity,
  nodeId: identity,
  hostInstallationId: identity,
  expectedVersion: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  expectedPath: z.string().default(""),
  expectedBranchRef: z.string().default(""),
  expectedBaseSha: z.string().default(""),
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
  confirm: z.string().optional(),
  commit: z.boolean().default(false),
  deleteBranch: z.boolean().default(false),
});
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
  acknowledgedAt: z.string().datetime(),
});
export type WorktreeOperationResult = z.infer<typeof WorktreeOperationResultSchema>;

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
