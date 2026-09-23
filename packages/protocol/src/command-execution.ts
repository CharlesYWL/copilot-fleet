import { z } from "zod";
import { CheckoutIdentitySchema, ExecutionBindingSchema } from "./managed-worktrees.js";
import { PromptAttachmentsSchema } from "./attachments.js";
import { PrMaintenanceObservationClaimRefSchema } from "./pr-maintenance.js";

export const COMMAND_EXECUTION_CAPABILITY = "remote-command-execution-v1";
export const COMMAND_PERMISSIONS_CAPABILITY = "command-permissions-v1";
export const DURABLE_LEAD_DELIVERY_CAPABILITY = "durable-lead-delivery-v1";
export const COMMAND_ADMISSION_VERSION = 1;
export const COMMAND_LIMITS = {
  scriptBytes: 16 * 1024,
  outputBytes: 10 * 1024 * 1024,
  pageBytes: 64 * 1024,
  chunkBytes: 24 * 1024,
  queueBytes: 1024 * 1024,
  defaultTimeoutMs: 300_000,
  maxTimeoutMs: 3_600_000,
  approvalMs: 1_800_000,
  retryMs: 86_400_000,
  replayMs: 7 * 86_400_000,
  retentionMs: 30 * 86_400_000,
  maxLeadPending: 10,
  maxNodePending: 32,
  hostLogBytes: 512 * 1024 * 1024,
  nodeLogBytes: 128 * 1024 * 1024,
  lifecycleReserveBytes: 16 * 1024 * 1024,
  clockUncertaintyMs: 5_000,
  clockDriftMs: 1_000,
} as const;

const id = z.string().min(1).max(200);
const uuid = z.string().uuid();
const timestamp = z.string().datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const detail = z.string().max(4_000);
const path = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes("\0"));
export const CommandShellSchema = z.literal("windows-powershell-5.1");
export type CommandShell = z.infer<typeof CommandShellSchema>;
export const CommandTextSchema = z
  .string()
  .min(1)
  .max(COMMAND_LIMITS.scriptBytes)
  .refine(
    (value) =>
      !value.includes("\0") &&
      new TextEncoder().encode(value).byteLength <= COMMAND_LIMITS.scriptBytes,
    "Command must be NUL-free and at most 16 KiB in UTF-8",
  );
export const CommandTargetSchema = z.union([
  z.object({ placementId: id }).strict(),
  z.object({ worktreeId: id, generation: z.number().int().positive() }).strict(),
]);
export type CommandTarget = z.infer<typeof CommandTargetSchema>;
export const RunCommandSchema = z
  .object({
    target: CommandTargetSchema,
    command: CommandTextSchema,
    shell: CommandShellSchema,
    reason: z.string().trim().min(1).max(2_000),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(COMMAND_LIMITS.maxTimeoutMs)
      .default(COMMAND_LIMITS.defaultTimeoutMs),
    requestKey: z.string().min(1).max(200),
    taskId: id.optional(),
    maintenanceObservation: PrMaintenanceObservationClaimRefSchema.optional(),
  })
  .strict();
export type RunCommand = z.infer<typeof RunCommandSchema>;

export const CommandObservationBudgetSchema = z
  .object({
    deadlineAt: timestamp,
    requests: z.number().int().min(0).max(40),
  })
  .strict();

export const CommandPreparationSchema = RunCommandSchema.extend({
  executionId: uuid,
  attemptId: uuid,
  hostId: id,
  nodeId: id,
  leadSessionId: id,
  requestedPath: path,
  createdAt: timestamp,
  expiresAt: timestamp,
  hostTime: timestamp,
  observationBudget: CommandObservationBudgetSchema.optional(),
});
export type CommandPreparation = z.infer<typeof CommandPreparationSchema>;

export const CommandApprovalScopeSchema = z.enum(["once", "session", "always"]);
export type CommandApprovalScope = z.infer<typeof CommandApprovalScopeSchema>;
export const EXACT_SCRIPT_PERMISSION_PREFIX = "exact-script:sha256:";
export function isExactScriptPermissionKey(value: string): boolean {
  return /^exact-script:sha256:[a-f0-9]{64}$/.test(value);
}
export const CommandPermissionMatchModeSchema = z.enum(["command", "exact", "pattern"]);
export const CommandPermissionEntrySchema = z.union([
  z
    .object({
      command: CommandTextSchema,
      path,
      match: CommandPermissionMatchModeSchema.optional(),
      hostId: id.optional(),
    })
    .strict(),
  z
    .object({
      legacyKey: z.string().min(1).max(200),
      path,
      hostId: id.optional(),
    })
    .strict(),
]);
export type CommandPermissionEntry = z.infer<typeof CommandPermissionEntrySchema>;
export const CommandPermissionRuleSchema = z.object({
  id: z.string().min(1).max(200),
  commandKey: z.string().trim().min(1).max(200),
  command: CommandTextSchema.optional(),
  match: CommandPermissionMatchModeSchema.optional(),
  path: z.string().min(1).max(32_768),
  hostId: id.optional(),
  builtin: z.boolean().default(false),
});
export type CommandPermissionRule = z.infer<typeof CommandPermissionRuleSchema>;
export const CommandPermissionMatchSchema = z.object({
  reusable: z.boolean(),
  commandKey: z.string().min(1).max(200).optional(),
  path,
  explanation: detail,
  policyVersion: z.number().int().nonnegative(),
  grantedBy: z.enum(["builtin", "session", "always"]).optional(),
  ruleId: z.string().min(1).max(200).optional(),
});
export type CommandPermissionMatch = z.infer<typeof CommandPermissionMatchSchema>;

export const PreparedCommandTargetSchema = z.object({
  cwd: path,
  checkout: CheckoutIdentitySchema,
  repository: CheckoutIdentitySchema,
  shellPath: path,
  admissionVersion: z.literal(COMMAND_ADMISSION_VERSION),
  preparedAt: timestamp,
  clockUncertaintyMs: z.number().min(0).max(COMMAND_LIMITS.clockUncertaintyMs),
  hostClockOffsetMs: z.number().finite(),
  permission: CommandPermissionMatchSchema.optional(),
});
export type PreparedCommandTarget = z.infer<typeof PreparedCommandTargetSchema>;
export const PreparedCommandBodySchema = CommandPreparationSchema.extend({
  prepared: PreparedCommandTargetSchema,
});
export const PreparedCommandSchema = PreparedCommandBodySchema.extend({ digest });
export type PreparedCommand = z.infer<typeof PreparedCommandSchema>;

// Only Node runtime supplies this environment value, from the approved descriptor.
export const COMMAND_OBSERVATION_CLOCK_ENV = "FLEET_MAINTENANCE_CLOCK";
export const CommandObservationClockSchema = z
  .object({
    executionId: uuid,
    attemptId: uuid,
    digest,
    claim: PrMaintenanceObservationClaimRefSchema,
    budget: CommandObservationBudgetSchema,
    hostTime: timestamp,
    preparedAt: timestamp,
    hostClockOffsetMs: z.number().finite(),
    clockUncertaintyMs: z.literal(COMMAND_LIMITS.clockUncertaintyMs),
    nodeTime: timestamp,
    monotonicNs: z.string().regex(/^\d{1,24}$/),
  })
  .strict()
  .superRefine((clock, ctx) => {
    if (
      Date.parse(clock.preparedAt) + clock.hostClockOffsetMs !==
        Date.parse(clock.hostTime) ||
      clock.nodeTime !== clock.preparedAt
    )
      ctx.addIssue({
        code: "custom",
        message: "Inconsistent approved preparation clock.",
      });
  });

export function commandObservationClock(
  descriptor: PreparedCommand,
  nodeTime: string,
  monotonicNs: string,
) {
  if (!descriptor.maintenanceObservation && !descriptor.observationBudget)
    return undefined;
  return CommandObservationClockSchema.parse({
    executionId: descriptor.executionId,
    attemptId: descriptor.attemptId,
    digest: descriptor.digest,
    claim: descriptor.maintenanceObservation,
    budget: descriptor.observationBudget,
    hostTime: descriptor.hostTime,
    preparedAt: descriptor.prepared.preparedAt,
    hostClockOffsetMs: descriptor.prepared.hostClockOffsetMs,
    clockUncertaintyMs: descriptor.prepared.clockUncertaintyMs,
    nodeTime,
    monotonicNs,
  });
}

/** Both peers hash this schema-ordered payload; no Node-only crypto enters the browser. */
export function commandDigestPayload(
  value: z.input<typeof PreparedCommandBodySchema>,
): string {
  return JSON.stringify(PreparedCommandBodySchema.strip().parse(value));
}

export const CommandExecutionStateSchema = z.enum([
  "preparing",
  "awaiting_approval",
  "queued",
  "starting",
  "running",
  "cancelling",
  "reconciliation_required",
  "succeeded",
  "failed",
  "denied",
  "expired",
  "cancelled",
  "timed_out",
  "interrupted",
]);
export type CommandExecutionState = z.infer<typeof CommandExecutionStateSchema>;
export const terminalCommandExecutionStates = new Set<CommandExecutionState>([
  "succeeded",
  "failed",
  "denied",
  "expired",
  "cancelled",
  "timed_out",
  "interrupted",
]);
export const CommandOwnershipSchema = z.enum([
  "not_started",
  "active",
  "quiescent",
  "unknown",
]);
export type CommandOwnership = z.infer<typeof CommandOwnershipSchema>;
export const CommandOutputGapSchema = z
  .object({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  })
  .refine((value) => value.from <= value.to);
export type CommandOutputGap = z.infer<typeof CommandOutputGapSchema>;

export const CommandOutputEventSchema = z.object({
  executionId: uuid,
  attemptId: uuid,
  sequence: z.number().int().positive(),
  stream: z.enum(["stdout", "stderr"]),
  data: z
    .string()
    .max((COMMAND_LIMITS.chunkBytes * 4) / 3)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  at: timestamp,
});
export type CommandOutputEvent = z.infer<typeof CommandOutputEventSchema>;
export const CommandReceiptSchema = z
  .object({
    executionId: uuid,
    attemptId: uuid,
    digest,
    state: CommandExecutionStateSchema,
    ownership: CommandOwnershipSchema,
    exitCode: z.number().int().nullable(),
    reason: detail,
    descendantCleanupForced: z.boolean().default(false),
    outcomeKnown: z.boolean().default(false),
    startedAt: timestamp.optional(),
    settledAt: timestamp.optional(),
    finalOutputSeq: z.number().int().nonnegative().optional(),
    gaps: z.array(CommandOutputGapSchema).max(128).default([]),
  })
  .superRefine((value, context) => {
    if (
      (value.state === "interrupted" || value.state === "timed_out") &&
      value.ownership !== "quiescent"
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownership"],
        message: "Interrupted or timed-out execution requires proven quiescence",
      });
    }
    if (
      terminalCommandExecutionStates.has(value.state) &&
      value.ownership !== "quiescent" &&
      value.ownership !== "not_started"
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownership"],
        message: "Terminal command outcomes require proven quiescence or no start",
      });
    }
    if (
      value.state === "succeeded" &&
      (value.exitCode !== 0 ||
        !value.outcomeKnown ||
        value.descendantCleanupForced ||
        value.ownership !== "quiescent")
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message:
          "Success requires an observed zero exit without forced descendant cleanup",
      });
    }
  });
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
export const CommandDeliveryStateSchema = z.enum([
  "none",
  "pending",
  "reserved",
  "accepted",
  "rejected_busy",
  "uncertain",
  "settled",
  "orphaned",
]);
export const CommandExecutionSchema = RunCommandSchema.extend({
  id: uuid,
  attemptId: uuid,
  version: z.number().int().nonnegative(),
  hostId: id,
  nodeId: id,
  nodeName: z.string().max(200),
  leadSessionId: id,
  requestedPath: path,
  requestDigest: digest,
  descriptor: PreparedCommandSchema.optional(),
  state: CommandExecutionStateSchema,
  ownership: CommandOwnershipSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: timestamp,
  approvedBy: z.string().max(200).optional(),
  approvedAt: timestamp.optional(),
  approvalScope: CommandApprovalScopeSchema.optional(),
  automaticApproval: z.boolean().optional(),
  cancelRequested: z.boolean().default(false),
  exitCode: z.number().int().nullable().default(null),
  outcomeKnown: z.boolean().default(false),
  descendantCleanupForced: z.boolean().default(false),
  reasonCode: z.string().max(200).default(""),
  error: detail.default(""),
  startedAt: timestamp.optional(),
  settledAt: timestamp.optional(),
  lastOutputSeq: z.number().int().nonnegative().default(0),
  finalOutputSeq: z.number().int().nonnegative().optional(),
  outputComplete: z.boolean().default(false),
  outputBytes: z.number().int().nonnegative().default(0),
  gaps: z.array(CommandOutputGapSchema).max(128).default([]),
  delivery: CommandDeliveryStateSchema.default("none"),
  deliveryId: uuid.optional(),
});
export type CommandExecution = z.infer<typeof CommandExecutionSchema>;
export const CommandExecutionPageSchema = z.object({
  execution: CommandExecutionSchema,
  events: z.array(CommandOutputEventSchema).max(512),
  nextSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  outputComplete: z.boolean(),
});
export type CommandExecutionPage = z.infer<typeof CommandExecutionPageSchema>;
export const CommandDecisionSchema = z
  .object({
    decision: z.enum(["allow_once", "allow_session", "allow_always", "deny"]),
    expectedVersion: z.number().int().nonnegative(),
    digest,
  })
  .strict();
export type CommandDecision = z.infer<typeof CommandDecisionSchema>;
export const GetCommandExecutionSchema = z.object({
  executionId: uuid,
  afterSeq: z.number().int().nonnegative().default(0),
  limitBytes: z.number().int().positive().max(COMMAND_LIMITS.pageBytes).default(16_384),
  format: z.enum(["text", "raw"]).default("text"),
});
export const CancelCommandExecutionSchema = z.object({ executionId: uuid });

export const CommandReadinessSchema = z.object({
  enabled: z.boolean(),
  supported: z.boolean(),
  reason: detail,
  shells: z.array(CommandShellSchema).max(1),
  admissionVersion: z.number().int().nonnegative(),
});
export type CommandReadiness = z.infer<typeof CommandReadinessSchema>;
export const LeadPromptDeliverySchema = z.object({
  deliveryId: uuid,
  sessionId: id,
  prompt: z
    .string()
    .min(1)
    .max(128 * 1024),
  executionBinding: ExecutionBindingSchema.optional(),
  attachments: PromptAttachmentsSchema.optional(),
});
export type LeadPromptDelivery = z.infer<typeof LeadPromptDeliverySchema>;
export const LeadPromptReceiptSchema = z.object({
  deliveryId: uuid,
  sessionId: id,
  state: z.enum(["accepted", "rejected_busy", "uncertain", "settled", "rejected"]),
  detail: detail.default(""),
  at: timestamp,
  nativeSessionId: id.optional(),
  attemptId: uuid.optional(),
});
export type LeadPromptReceipt = z.infer<typeof LeadPromptReceiptSchema>;

export const CommandPromptRecordSchema = z.object({
  delivery: LeadPromptDeliverySchema,
  nodeId: id,
  key: z.string().min(1).max(1000),
  state: z.enum([
    "pending",
    "reserved",
    "accepted",
    "rejected_busy",
    "uncertain",
    "settled",
    "rejected",
    "orphaned",
  ]),
  executions: z.array(uuid).max(100),
  createdAt: timestamp,
  retryAfter: z.union([z.literal(""), timestamp]),
  receipt: LeadPromptReceiptSchema.optional(),
});
export const CommandFenceSchema = z.object({
  taskId: id,
  executionId: uuid,
  revision: z.number().int().nonnegative(),
  state: z.enum(["executing", "observation_required", "verification_required", "clear"]),
  changedAt: timestamp,
  previousVerificationAt: timestamp.optional(),
});
export const CommandExecutionBackupSchema = z.object({
  version: z.literal(1),
  namespace: uuid,
  executions: z.array(CommandExecutionSchema).max(10_000),
  events: z.array(CommandOutputEventSchema).max(100_000),
  requests: z
    .array(
      z.object({
        leadId: id,
        requestKey: z.string().min(1).max(200),
        executionId: uuid,
        digest,
        createdAt: timestamp,
        revoked: z.boolean(),
      }),
    )
    .max(100_000),
  attempts: z
    .array(
      z.object({
        executionId: uuid,
        attemptId: uuid,
        digest,
        nodeId: id,
        hostId: id,
        retiredAt: z.union([z.literal(""), timestamp]),
        startVersion: z.number().int().nonnegative().nullable(),
        cancelled: z.boolean(),
        receipt: CommandReceiptSchema.nullable(),
      }),
    )
    .max(100_000),
  fences: z.array(CommandFenceSchema).max(10_000),
  evidence: z
    .array(
      z.object({
        stepId: id,
        taskId: id,
        revision: z.number().int().nonnegative(),
      }),
    )
    .max(100_000),
  prompts: z.array(CommandPromptRecordSchema).max(100_000),
  notifications: z
    .array(
      z.object({
        executionId: uuid,
        phase: z.enum(["approval", "closed", "completion"]),
      }),
    )
    .max(100_000),
  clocks: z
    .array(
      z.object({
        executionId: uuid,
        hostTime: timestamp,
        acceptedAt: timestamp.nullable(),
        elapsedMs: z.number().nonnegative().nullable(),
      }),
    )
    .max(10_000),
});
export type CommandExecutionBackup = z.infer<typeof CommandExecutionBackupSchema>;

export const CommandExecutionHostSchemas = [
  z.object({
    type: z.literal("prepare_command_execution"),
    request: CommandPreparationSchema,
  }),
  z.object({
    type: z.literal("start_command_execution"),
    descriptor: PreparedCommandSchema,
    approvedBy: id,
    approvedAt: timestamp,
    version: z.number().int().nonnegative(),
    approvalScope: CommandApprovalScopeSchema.optional(),
    automaticApproval: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("revoke_command_session_grants"),
    hostId: id,
    leadSessionId: id,
  }),
  z.object({
    type: z.literal("cancel_command_execution"),
    hostId: id,
    executionId: uuid,
    attemptId: uuid,
    reason: detail,
  }),
  z.object({
    type: z.literal("reconcile_command_executions"),
    hostId: id,
    executions: z
      .array(
        z.object({
          executionId: uuid,
          attemptId: uuid,
          afterSeq: z.number().int().nonnegative(),
        }),
      )
      .max(128),
  }),
  z.object({
    type: z.literal("command_execution_ack"),
    executionId: uuid,
    attemptId: uuid,
    digest,
    throughSeq: z.number().int().nonnegative(),
    terminal: z.boolean(),
  }),
  z.object({
    type: z.literal("deliver_lead_prompt"),
    delivery: LeadPromptDeliverySchema,
  }),
] as const;
export const CommandExecutionNodeSchemas = [
  z
    .object({
      type: z.literal("command_execution_prepared"),
      executionId: uuid,
      attemptId: uuid,
      ok: z.boolean(),
      descriptor: PreparedCommandSchema.optional(),
      error: detail.optional(),
    })
    .refine((value) => !value.ok || value.descriptor !== undefined),
  z.object({
    type: z.literal("command_execution_output"),
    event: CommandOutputEventSchema,
  }),
  z.object({
    type: z.literal("command_execution_update"),
    receipt: CommandReceiptSchema,
  }),
  z.object({
    type: z.literal("command_execution_inventory"),
    readiness: CommandReadinessSchema,
    executions: z.array(CommandReceiptSchema).max(128),
  }),
  z.object({ type: z.literal("lead_prompt_receipt"), receipt: LeadPromptReceiptSchema }),
] as const;
export const CommandExecutionHostMessageSchema = z.discriminatedUnion(
  "type",
  CommandExecutionHostSchemas,
);
export type CommandExecutionHostMessage = z.infer<
  typeof CommandExecutionHostMessageSchema
>;
export const CommandExecutionNodeMessageSchema = z.discriminatedUnion(
  "type",
  CommandExecutionNodeSchemas,
);
export type CommandExecutionNodeMessage = z.infer<
  typeof CommandExecutionNodeMessageSchema
>;
