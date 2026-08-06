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
  initialPrompt: z.string().min(1),
  currentActivity: z.string(),
  lastText: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FleetSession = z.infer<typeof SessionSchema>;

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
  ]),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const NodeCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start_session"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    localPath: z.string().min(1),
    prompt: z.string().min(1),
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
]);
export type HostToNodeMessage = z.infer<typeof HostToNodeMessageSchema>;

export const BrowserMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), data: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("node"), node: NodeSchema }),
  z.object({ type: z.literal("session"), session: SessionSchema }),
  z.object({ type: z.literal("event"), event: SessionEventSchema }),
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
});

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
});

export const CreatePlacementSchema = z.object({
  workspaceId: z.string().min(1),
  nodeId: z.string().min(1),
  localPath: z.string().min(1).max(4096),
});

export const CreateSessionSchema = z.object({
  placementId: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
});

export const PromptSchema = z.object({
  prompt: z.string().min(1).max(100_000),
});

export const PermissionResponseSchema = z.object({
  requestId: z.string().min(1),
  outcome: z.enum(["allow_once", "deny"]),
  optionId: z.string().optional(),
});

const transitions: Record<SessionState, ReadonlySet<SessionState>> = {
  queued: new Set(["starting", "failed", "offline", "stopped"]),
  starting: new Set(["running", "failed", "offline", "stopped"]),
  running: new Set(["idle", "cancelling", "failed", "offline", "stopped", "completed"]),
  idle: new Set(["running", "failed", "offline", "stopped", "completed"]),
  cancelling: new Set(["idle", "failed", "offline", "stopped"]),
  offline: new Set(["stopped", "failed"]),
  stopped: new Set(),
  completed: new Set(),
  failed: new Set(),
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || transitions[from].has(to);
}

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function tryParseJson(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}
