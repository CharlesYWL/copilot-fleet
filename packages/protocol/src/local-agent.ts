import { z } from "zod";

/**
 * The local agent API: a loopback-only surface a program on the Host machine
 * uses to hand work to, and ask about work held by, the orchestrators an
 * administrator exposed to it. See docs/local-agent-api-plan.md.
 *
 * Not 8788: that is where a Node's own config page listens (and it walks up
 * from there when busy), and a Node usually runs beside the Host.
 */
export const LOCAL_AGENT_DEFAULT_PORT = 8786;
/** The header every request must carry; a browser cannot send it without a preflight. */
export const LOCAL_AGENT_HEADER = "x-fleet-local-agent";
export const LOCAL_AGENT_API_VERSION = "v1";

export const LOCAL_AGENT_LIMITS = {
  bodyBytes: 64 * 1024,
  textChars: 16_000,
  nameChars: 200,
  objectiveChars: 16_000,
  clientLabelChars: 80,
  listDefault: 20,
  listMax: 100,
  transcriptDefault: 50,
  transcriptMax: 200,
  transcriptBytes: 256 * 1024,
  notesMax: 50,
  noteChars: 4_000,
  scopeMax: 100,
  writesPerMinute: 30,
  unresolvedPerLead: 20,
  ledgerMax: 100_000,
  requestTimeoutMs: 10_000,
} as const;

const Id = z.string().min(1).max(200);

export const LocalAgentConfigSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65_535),
    allowedLeadSessionIds: z.array(Id).max(LOCAL_AGENT_LIMITS.scopeMax),
    allowedWorkspaceIds: z.array(Id).max(LOCAL_AGENT_LIMITS.scopeMax),
    /** Bumped on every change, so an editor can refuse to overwrite a newer one. */
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type LocalAgentConfig = z.infer<typeof LocalAgentConfigSchema>;

export const LocalAgentConfigUpdateSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65_535),
    allowedLeadSessionIds: z.array(Id).max(LOCAL_AGENT_LIMITS.scopeMax),
    allowedWorkspaceIds: z.array(Id).max(LOCAL_AGENT_LIMITS.scopeMax),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type LocalAgentConfigUpdate = z.infer<typeof LocalAgentConfigUpdateSchema>;

export const LocalAgentListenerStateSchema = z.enum([
  "disabled",
  "starting",
  "listening",
  "error",
  "stopping",
]);
export type LocalAgentListenerState = z.infer<typeof LocalAgentListenerStateSchema>;

export const LocalAgentListenerStatusSchema = z
  .object({
    state: LocalAgentListenerStateSchema,
    /** The address actually bound, e.g. `http://127.0.0.1:8786`. */
    url: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export type LocalAgentListenerStatus = z.infer<typeof LocalAgentListenerStatusSchema>;

/**
 * Where a local request stands, projected from its ledger row and, once
 * accepted into a lead's durable queue, from that queue record.
 */
export const LocalAgentRequestStateSchema = z.enum([
  /** A created task whose brief the orchestrator has not been sent yet. */
  "waiting_for_brief",
  "pending",
  "rejected_busy",
  "reserved",
  "accepted",
  "settled",
  "uncertain",
  "rejected",
  "orphaned",
  /** An administrator gave up on it; see `disposition`. */
  "abandoned",
]);
export type LocalAgentRequestState = z.infer<typeof LocalAgentRequestStateSchema>;

export const LocalAgentRequestKindSchema = z.enum([
  "create_task",
  "question",
  "guidance",
]);
export type LocalAgentRequestKind = z.infer<typeof LocalAgentRequestKindSchema>;

export const LocalAgentRequestSchema = z
  .object({
    operationId: z.string(),
    kind: LocalAgentRequestKindSchema,
    state: LocalAgentRequestStateSchema,
    leadSessionId: z.string(),
    taskId: z.string(),
    clientLabel: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Increments on every disposition; an abandon names the version it saw. */
    version: z.number().int().positive(),
    /** Whether the prompt was ever handed to the orchestrator's agent. */
    dispatchEverReserved: z.boolean(),
    /** For a brief still owed: the digest an abandon must name. */
    briefDigest: z.string().optional(),
    disposition: z
      .object({
        action: z.enum(["abandoned", "abandoned_unknown"]),
        reason: z.string(),
        at: z.string(),
      })
      .strict()
      .optional(),
    /** Why the lead refused it, when it did. */
    detail: z.string().optional(),
  })
  .strict();
export type LocalAgentRequest = z.infer<typeof LocalAgentRequestSchema>;

const OperationId = z.uuid();
const ClientLabel = z.string().trim().min(1).max(LOCAL_AGENT_LIMITS.clientLabelChars);

export const LocalAgentCreateTaskSchema = z
  .object({
    operationId: OperationId,
    workspaceId: Id,
    sourcePlacementId: Id.optional(),
    name: z.string().trim().min(1).max(LOCAL_AGENT_LIMITS.nameChars),
    objective: z.string().trim().min(1).max(LOCAL_AGENT_LIMITS.objectiveChars),
    clientLabel: ClientLabel.optional(),
  })
  .strict();
export type LocalAgentCreateTask = z.infer<typeof LocalAgentCreateTaskSchema>;

export const LocalAgentMessageSchema = z
  .object({
    operationId: OperationId,
    /** The orchestrator the caller believes owns the task; a transfer makes this stale. */
    expectedLeadSessionId: Id,
    intent: z.enum(["question", "guidance"]),
    text: z.string().trim().min(1).max(LOCAL_AGENT_LIMITS.textChars),
    clientLabel: ClientLabel.optional(),
  })
  .strict();
export type LocalAgentMessage = z.infer<typeof LocalAgentMessageSchema>;

export const LocalAgentDispositionSchema = z
  .object({
    action: z.literal("abandon"),
    reason: z.string().trim().min(1).max(1_000),
    expectedRequestVersion: z.number().int().positive(),
    expectedBriefDigest: z.string().min(1).max(128).optional(),
  })
  .strict();
export type LocalAgentDisposition = z.infer<typeof LocalAgentDispositionSchema>;

/** Stable codes a local agent can branch on. */
export const localAgentErrorCodes = [
  "bad_request",
  "not_found",
  "forbidden_transport",
  "method_not_allowed",
  "unsupported_media_type",
  "payload_too_large",
  "rate_limited",
  "too_many_unresolved",
  "idempotency_conflict",
  "receipt_storage_full",
  "lead_unavailable",
  "lead_requires_resume",
  "lead_stopping",
  "stale_owner",
  "reopen_required",
  "human_review_required",
  "source_required",
  "source_mismatch",
  "workspace_unreachable",
  "lead_prompt_queue_full",
  "invalid_cursor",
  "stale_request",
  "request_resolved",
  "quiescence_required",
  "command_task_fenced",
  "api_disabled",
  "internal_error",
] as const;
export type LocalAgentErrorCode = (typeof localAgentErrorCodes)[number];
