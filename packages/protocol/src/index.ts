import { z } from "zod";

export const sessionStates = [
  "queued",
  "starting",
  "running",
  "idle",
  "cancelling",
  "offline",
  "stopped",
  "completed",
  "failed",
] as const;
export const SessionStateSchema = z.enum(sessionStates);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const terminalSessionStates = new Set<SessionState>([
  "stopped",
  "completed",
  "failed",
]);

export const NodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.array(z.string()),
  maxSessions: z.number().int().positive(),
  activeSessions: z.number().int().nonnegative(),
  lastHeartbeat: z.string().datetime(),
  online: z.boolean(),
  /** The node's home directory, used to seed placement paths in the UI. */
  homeDir: z.string().default(""),
});
export type FleetNode = z.infer<typeof NodeSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  createdAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const PlacementSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  nodeId: z.string().min(1),
  localPath: z.string().min(1),
  workspaceName: z.string().optional(),
  nodeName: z.string().optional(),
});
export type Placement = z.infer<typeof PlacementSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  placementId: z.string().min(1),
  nodeId: z.string().min(1),
  nodeName: z.string().min(1),
  state: SessionStateSchema,
  /**
   * Operator-chosen label. Empty means "no name yet", and readers fall back to
   * the initial prompt — a default copied from the prompt at creation would
   * freeze the first sentence of a long prompt as a name nobody chose.
   */
  name: z.string().default(""),
  initialPrompt: z.string().min(1),
  currentActivity: z.string(),
  lastText: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Copilot's own ACP session id, needed to resume the conversation. */
  agentSessionId: z.string().default(""),
  /** Runs Copilot with --allow-all: no permission prompts for this session. */
  yolo: z.boolean().default(false),
});
export type FleetSession = z.infer<typeof SessionSchema>;

/** Long enough for a descriptive label, short enough to render in a tree row. */
export const SESSION_NAME_MAX_LENGTH = 120;

export const PermissionOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
});

export const SessionEventSchema = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.enum([
    "state",
    "agent_text",
    "agent_thought",
    "tool",
    "permission",
    "permission_result",
    "turn_complete",
    "error",
    "system",
    "agent_session",
  ]),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventType = SessionEvent["type"];

/**
 * What each event type carries.
 *
 * `payload` stays an open record on the wire on purpose: a node running a newer
 * build must not have its socket closed over a field this Host has not heard of
 * yet. These schemas describe the same payloads for whoever *reads* them, so a
 * consumer can say which field it wants and be told when it is not there,
 * instead of coercing a missing value to an empty string and rendering nothing.
 *
 * Every field is optional because producers legitimately omit them — a tool
 * update carries no title until the tool has one.
 */
const text = z.string().optional();

export const sessionEventPayloadSchemas = {
  state: z.object({ state: SessionStateSchema.optional(), activity: text }),
  agent_text: z.object({ text }),
  agent_thought: z.object({ text }),
  tool: z.object({ toolCallId: text, title: text, status: text }),
  permission: z.object({
    requestId: text,
    title: text,
    toolCallId: text,
    // A malformed option list must not cost the reader the title as well.
    options: z.array(PermissionOptionSchema).optional().catch(undefined),
  }),
  permission_result: z.object({ requestId: text, outcome: text }),
  turn_complete: z.object({ stopReason: text }),
  error: z.object({ message: text }),
  system: z.object({ text }),
  agent_session: z.object({ agentSessionId: text }),
} as const;

export type SessionEventPayload<T extends SessionEventType> = z.infer<
  (typeof sessionEventPayloadSchemas)[T]
>;

/**
 * The payload of `event`, if it is of `type` and its payload is well formed.
 *
 * Returning `undefined` rather than a half-filled object means a payload that
 * changed shape shows up as a missing block, not as a block that quietly lost
 * its text.
 */
export function eventPayload<T extends SessionEventType>(
  event: SessionEvent,
  type: T,
): SessionEventPayload<T> | undefined {
  if (event.type !== type) return undefined;
  const parsed = sessionEventPayloadSchemas[type].safeParse(event.payload);
  // The lookup type widens to the union of all payloads once `type` is a type
  // parameter; the value came from that exact key, so it is the narrower one.
  return parsed.success ? (parsed.data as SessionEventPayload<T>) : undefined;
}

export const NodeCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start_session"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    localPath: z.string().min(1),
    prompt: z.string().min(1),
    /** Launches Copilot with --allow-all; decided by the Host. */
    yolo: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("resume_session"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    localPath: z.string().min(1),
    agentSessionId: z.string().min(1),
    /** Continues the host's event sequence so replayed rows stay ordered. */
    sequenceOffset: z.number().int().nonnegative().default(0),
    yolo: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("prompt"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    prompt: z.string().min(1),
  }),
  z.object({
    type: z.literal("cancel"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("stop"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("permission_response"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    outcome: z.enum(["allow_once", "deny"]),
    optionId: z.string().optional(),
  }),
]);
export type NodeCommand = z.infer<typeof NodeCommandSchema>;

export const NodeToHostMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    nodeId: z.string().min(1),
    secret: z.string().min(1),
    os: z.string().min(1),
    arch: z.string().min(1),
    version: z.string().min(1),
    capabilities: z.array(z.string()),
    maxSessions: z.number().int().positive(),
    homeDir: z.string().default(""),
    /** Sessions still running on this Node; used to resurrect offline rows. */
    activeSessionIds: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("heartbeat"),
    activeSessionIds: z.array(z.string()),
    sentAt: z.string().datetime(),
  }),
  z.object({
    type: z.literal("event"),
    event: SessionEventSchema,
  }),
  z.object({
    type: z.literal("command_result"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
]);
export type NodeToHostMessage = z.infer<typeof NodeToHostMessageSchema>;

export const HostToNodeMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), nodeId: z.string().min(1) }),
  z.object({ type: z.literal("command"), command: NodeCommandSchema }),
  /**
   * The Host's address changed and this is where to find it next time.
   *
   * Sent over the connection the Node already has, so a rotated tunnel URL no
   * longer strands every machine behind the URL it enrolled with. Only Nodes
   * advertising {@link HOST_URL_SYNC_CAPABILITY} may be sent this: an older
   * agent validates every frame against its own copy of this union and hangs up
   * on anything it does not recognise, so announcing to one would cost it the
   * connection it was told to keep.
   */
  z.object({ type: z.literal("host_url"), hostUrl: z.string().min(1) }),
]);
export type HostToNodeMessage = z.infer<typeof HostToNodeMessageSchema>;

/** A Node that understands `host_url` and can follow the Host to a new address. */
export const HOST_URL_SYNC_CAPABILITY = "host-url-sync";

/**
 * A Host URL reduced to what actually decides where a Node dials.
 *
 * Nodes build `new URL("/ws/node", hostUrl)`, so a trailing slash, a stray
 * uppercase host, or an explicit default port all name the same Host — and
 * comparing the raw strings would announce a "change" that moves nobody, or
 * store the same address twice in a fallback list.
 */
export function normalizeHostUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function sameHostUrl(left: string, right: string): boolean {
  return normalizeHostUrl(left) === normalizeHostUrl(right);
}

/**
 * Everything a freshly connected browser needs to render the fleet.
 *
 * Spelled out rather than left as an open record so the UI can consume it
 * without asserting its way from `unknown` to the four lists it actually gets.
 */
export const SnapshotSchema = z.object({
  nodes: z.array(NodeSchema),
  workspaces: z.array(WorkspaceSchema),
  placements: z.array(PlacementSchema),
  sessions: z.array(SessionSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const BrowserMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), data: SnapshotSchema }),
  z.object({ type: z.literal("node"), node: NodeSchema }),
  z.object({ type: z.literal("session"), session: SessionSchema }),
  z.object({ type: z.literal("event"), event: SessionEventSchema }),
  /**
   * Workspaces and placements after any change to either.
   *
   * Sent whole rather than per-entity because a deletion has no entity left to
   * describe, and because the two are edited together often enough that
   * reconciling separate messages would cost more than resending two short
   * lists. Nodes may now edit these from their own config page, so a browser
   * that only refreshed on its own writes would show stale paths.
   */
  z.object({
    type: z.literal("catalog"),
    workspaces: z.array(WorkspaceSchema),
    placements: z.array(PlacementSchema),
  }),
]);
export type BrowserMessage = z.infer<typeof BrowserMessageSchema>;

export const RegisterNodeSchema = z.object({
  enrollmentToken: z.string().min(1),
  name: z.string().min(1).max(100),
  os: z.string().min(1),
  arch: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.array(z.string()),
  maxSessions: z.number().int().min(1).max(64),
  homeDir: z.string().max(4096).default(""),
});

export const RenameNodeSchema = z.object({
  name: z.string().min(1).max(100),
});

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
});
export const UpdateWorkspaceSchema = CreateWorkspaceSchema;

export const CreatePlacementSchema = z.object({
  workspaceId: z.string().min(1),
  nodeId: z.string().min(1),
  localPath: z.string().min(1).max(4096),
});

export const UpdatePlacementSchema = z.object({
  localPath: z.string().min(1).max(4096),
});

export const CreateSessionSchema = z.object({
  placementId: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  /** Omitted means "use the Host default". */
  yolo: z.boolean().optional(),
  name: z.string().max(SESSION_NAME_MAX_LENGTH).default(""),
});

/** Empty clears the name, so the label falls back to the initial prompt. */
export const RenameSessionSchema = z.object({
  name: z.string().max(SESSION_NAME_MAX_LENGTH),
});

export const UpdateDefaultsSchema = z.object({
  yolo: z.boolean(),
});

export const PromptSchema = z.object({
  prompt: z.string().min(1).max(100_000),
});

export const PermissionResponseSchema = z.object({
  requestId: z.string().min(1),
  outcome: z.enum(["allow_once", "deny"]),
  optionId: z.string().optional(),
});

export const tunnelProviders = ["cloudflare", "tailscale", "ngrok", "bore"] as const;
export const TunnelProviderSchema = z.enum(tunnelProviders);
export type TunnelProvider = z.infer<typeof TunnelProviderSchema>;

export const TunnelStatusSchema = z.enum(["off", "starting", "on", "stopping", "error"]);
export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

export const TunnelProviderInfoSchema = z.object({
  id: TunnelProviderSchema,
  label: z.string().min(1),
  binary: z.string().min(1),
  binaryPresent: z.boolean(),
  installHint: z.string(),
  caveat: z.string().optional(),
});
export type TunnelProviderInfo = z.infer<typeof TunnelProviderInfoSchema>;

export const TunnelInfoSchema = z.object({
  provider: TunnelProviderSchema,
  enabled: z.boolean(),
  status: TunnelStatusSchema,
  publicUrl: z.string().min(1),
  error: z.string().nullable(),
  binaryPresent: z.boolean(),
  /** Every supported provider plus whether its CLI is installed. */
  providers: z.array(TunnelProviderInfoSchema),
  /**
   * True when the tunnel runs as its own process outside the Host, so the URL
   * survives Host restarts and the Host must not try to start or stop it.
   */
  external: z.boolean().default(false),
});
export type TunnelInfo = z.infer<typeof TunnelInfoSchema>;

export const UpdateTunnelSchema = z.object({
  enabled: z.boolean(),
  provider: TunnelProviderSchema.optional(),
});

const transitions: Record<SessionState, ReadonlySet<SessionState>> = {
  queued: new Set(["starting", "failed", "offline", "stopped"]),
  // Idle is reachable because a resumed session lands in starting and then
  // waits for the operator's next prompt instead of running one immediately.
  starting: new Set(["running", "idle", "failed", "offline", "stopped"]),
  running: new Set(["idle", "cancelling", "failed", "offline", "stopped", "completed"]),
  idle: new Set(["running", "failed", "offline", "stopped", "completed"]),
  cancelling: new Set(["idle", "failed", "offline", "stopped"]),
  // Idle is the reconnect landing state; the next agent event can move it on.
  // Starting is the resume landing state; session/load re-attaches the agent.
  offline: new Set(["stopped", "failed", "idle", "starting"]),
  stopped: new Set(["starting"]),
  completed: new Set(["starting"]),
  failed: new Set(["starting"]),
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || transitions[from].has(to);
}

/*
 * WebSocket close codes the Host uses to explain itself to a Node. They live
 * here because both sides must agree on them: the Host picks the code and the
 * Node decides whether to retry, re-enroll, or give up. Generic 1008 stays
 * reserved for protocol violations, which carry no such instruction.
 */

/** Another Node connection took over this identity. */
export const SUPERSEDED_CLOSE_CODE = 4001;

/** The presented secret is unknown; the Node must enroll again to recover. */
export const AUTH_FAILED_CLOSE_CODE = 4003;

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function tryParseJson(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Invalid JSON") };
  }
}

/** A peer sent bytes that are not JSON at all. */
export const MALFORMED_JSON_CLOSE_CODE = 1007;

/** A peer sent JSON that does not match the agreed schema. */
export const INVALID_MESSAGE_CLOSE_CODE = 1008;

export type FrameDecodeFailure = {
  ok: false;
  /** Close code to hang up with. */
  code: typeof MALFORMED_JSON_CLOSE_CODE | typeof INVALID_MESSAGE_CLOSE_CODE;
  /** Short close reason; goes on the wire, so it stays generic. */
  reason: string;
  /** Full diagnostic for the local log. */
  detail: string;
};

export type DecodedFrame<T> = { ok: true; value: T } | FrameDecodeFailure;

/**
 * Parses and validates one WebSocket frame.
 *
 * Host and Node ran identical "parse, validate, close 1007/1008" ladders on
 * every inbound frame; keeping the two in step by hand meant a fix on one side
 * silently left the other accepting frames the peer had stopped sending.
 */
export function decodeFrame<Schema extends z.ZodType>(
  raw: string,
  schema: Schema,
): DecodedFrame<z.infer<Schema>> {
  const parsed = tryParseJson(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      code: MALFORMED_JSON_CLOSE_CODE,
      reason: "Malformed JSON",
      detail: parsed.error,
    };
  }
  const result = schema.safeParse(parsed.value);
  if (!result.success) {
    return {
      ok: false,
      code: INVALID_MESSAGE_CLOSE_CODE,
      reason: "Invalid message",
      detail: result.error.message,
    };
  }
  return { ok: true, value: result.data as z.infer<Schema> };
}

/**
 * The message to show for a thrown value.
 *
 * Both services and the UI hand-rolled `error instanceof Error ? ... : ...`,
 * which drifted: some spots stringified an object into "[object Object]" while
 * others dropped the cause entirely.
 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback ?? String(error);
}
