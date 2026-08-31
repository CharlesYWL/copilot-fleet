import { z } from "zod";

/**
 * Standard base64, bounded.
 *
 * Bounded because most of these are parsed before anybody has authenticated,
 * and standard rather than base64url because the values are DER keys, nonces
 * and tags that both ends round-trip through `Buffer`.
 *
 * The length check aborts, so an oversized value is refused without the pattern
 * ever scanning it. That is not a micro-optimisation: the largest of these is a
 * hundred-megabyte ciphertext field, and running a regular expression across
 * one an attacker chose the length of is itself the denial of service the bound
 * exists to prevent.
 */
const base64Field = (max: number) =>
  z
    .string()
    .min(1)
    .max(max, { abort: true })
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64");

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "expected a SHA-256 digest");

/** A DER-encoded Ed25519 or X25519 key is well under this, base64 and all. */
const MAX_KEY_LENGTH = 1_000;
/** Signatures are 64 bytes, tags 16, nonces 32; none of them approach this. */
const MAX_PROOF_LENGTH = 200;

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

/**
 * A Copilot agent definition a Node can put a session into.
 *
 * Reported upward like `capabilities` and a session's `commands`, because the
 * Host has to know what a machine can *be* before it sends work there. Without
 * it the Host names an agent and finds out on the machine, at runtime, that a
 * stale Node has never heard of it.
 */
export const NodeAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Agent names are file-safe ids, not sentences"),
  description: z.string().max(200).default(""),
});
export type NodeAgent = z.infer<typeof NodeAgentSchema>;

export const NodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1),
  version: z.string().min(1),
  /**
   * The commit the Node is running, or `""` from a build that predates this
   * field. Compared against the Host's own commit to decide staleness, because
   * `version` is a constant that never moves between deploys.
   */
  revision: z.string().default(""),
  capabilities: z.array(z.string()),
  /**
   * Agents this machine can put a session into.
   *
   * Defaulted, so a Node from a build that predates the catalog reads as "offers
   * none" rather than failing to register.
   */
  agents: z.array(NodeAgentSchema).default([]),
  maxSessions: z.number().int().positive(),
  activeSessions: z.number().int().nonnegative(),
  lastHeartbeat: z.string().datetime(),
  online: z.boolean(),
  /** The node's home directory, used to seed placement paths in the UI. */
  homeDir: z.string().default(""),
  /**
   * How this machine proves it is itself.
   *
   * Defaulted so that a row, an archive or a Node from before Node keys existed
   * reads as the shared-secret protocol it actually speaks. Settings shows the
   * split, because enforcing mutual authentication before every machine has
   * upgraded would lock the stragglers out of their own fleet.
   */
  authProtocol: z.enum(["legacy-secret", "mutual-auth-v1"]).default("legacy-secret"),
});
export type FleetNode = z.infer<typeof NodeSchema>;

/**
 * What a workspace is for, which decides what may be done to it.
 *
 * `project` is every workspace an operator creates: a repository, checked out
 * somewhere, that work can be written to. `chats` is the single reserved one
 * described by {@link CHATS_WORKSPACE_ID}.
 */
export const WorkspaceKindSchema = z.enum(["project", "chats"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

/**
 * The reserved workspace holding sessions that are not about a checkout.
 *
 * A question, a piece of research, a bit of reading on the web: work that wants
 * an agent and a machine but no repository. Before this it still needed both,
 * because a Session's working directory comes from a Placement and a Placement
 * belongs to a Workspace — so asking the fleet a question meant first inventing
 * a project for it to be asked in.
 *
 * It is a real workspace row rather than a null `workspaceId` on the session,
 * and that is the whole design. `workspaceId` is load-bearing in the sessions
 * foreign key, run pinning, capacity accounting, the sidebar tree, and backup;
 * making it optional would have touched every one of those to express something
 * only the UI cares about. A reserved row costs a `kind` column and some guards,
 * and everything downstream keeps working unchanged.
 *
 * The id is fixed rather than generated so a Host that restarts, restores a
 * backup, or is rebuilt from scratch keeps pointing history at the same row.
 */
export const CHATS_WORKSPACE_ID = "chats";
export const CHATS_WORKSPACE_NAME = "Chats";
export const CHATS_WORKSPACE_DESCRIPTION =
  "Questions and research that need no checkout. Sessions here run in each node's home directory.";

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  createdAt: z.string().datetime(),
  /**
   * Defaulted, so a workspace row written before Chats existed reads as the
   * ordinary project it has always been.
   */
  kind: WorkspaceKindSchema.default("project"),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/**
 * Whether an id names the reserved Chats workspace.
 *
 * Asked of the id rather than of a loaded row because most callers — a
 * placement, a session, a run — carry the id and would otherwise need a lookup
 * to answer a constant.
 */
export function isChatsWorkspace(workspaceId: string): boolean {
  return workspaceId === CHATS_WORKSPACE_ID;
}

export const PlacementSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  nodeId: z.string().min(1),
  localPath: z.string().min(1),
  workspaceName: z.string().optional(),
  nodeName: z.string().optional(),
});
export type Placement = z.infer<typeof PlacementSchema>;

/**
 * A slash command the agent offers, as reported over ACP.
 *
 * `hint` mirrors ACP's `input.hint`: present when the command takes arguments
 * ("model", "additional instructions"), absent for bare commands like
 * `/usage`. Clients use it to decide whether selecting the command should run
 * it or leave the caret waiting for an argument.
 */
export const SessionCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  hint: z.string().optional(),
});
export type SessionCommand = z.infer<typeof SessionCommandSchema>;

export const SessionConfigChoiceSchema = z.object({
  /*
   * Not `min(1)`. The empty string is a value ACP genuinely uses: Copilot's
   * `agent` picker spells "the default Copilot agent, no custom persona" as
   * `""`, and rejecting it cost the whole option list — see
   * {@link listOfOptional} for why one bad choice used to take four good
   * options down with it.
   */
  value: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
});
export type SessionConfigChoice = z.infer<typeof SessionConfigChoiceSchema>;

/**
 * A picker the agent exposes for the session: model, mode, reasoning effort.
 *
 * ACP calls these session config options and reports them with `session/new`
 * and again whenever one changes. They are the half of the slash-command story
 * that cannot be typed: `/model` with no argument opens a chooser in a terminal
 * UI, and over ACP that chooser is this list.
 *
 * `category` is ACP's own hint ("model", "mode", "thought_level") and is only
 * used to decide placement in the UI — an unknown one still renders.
 */
export const SessionConfigOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.string().default(""),
  currentValue: z.string().default(""),
  choices: z.array(SessionConfigChoiceSchema).default([]),
});
export type SessionConfigOption = z.infer<typeof SessionConfigOptionSchema>;

/**
 * A file riding along with a prompt.
 *
 * Bytes travel base64 in one piece rather than through an upload endpoint: the
 * agent is on another machine, often behind a tunnel, and giving it a URL to
 * fetch would mean the Node needs credentials and reachability back to the Host
 * for something that is already in the operator's hand. The size ceilings below
 * are what keep that honest.
 *
 * The Node decides how to present each one from `mimeType`: images become ACP
 * image blocks, everything else is embedded as text. Copilot reports both
 * `image` and `embeddedContext` support, and both are verified working.
 */
export const PromptAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  /** Base64, for text files too, so one field carries every kind. */
  data: z.string().min(1),
});
export type PromptAttachment = z.infer<typeof PromptAttachmentSchema>;

/**
 * What a prompt may carry, before base64 turns each byte into about 1.37.
 *
 * A screenshot is the common case and lands well under this; the ceiling exists
 * so one paste cannot sit in a WebSocket frame big enough to stall every other
 * session sharing that connection.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_PROMPT = 6;

/** Decoded size of base64, without allocating the bytes to find out. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** What the transcript keeps: enough to show the file, never its bytes. */
export const AttachmentSummarySchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type AttachmentSummary = z.infer<typeof AttachmentSummarySchema>;

export function attachmentSummary(attachment: PromptAttachment): AttachmentSummary {
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    bytes: base64Bytes(attachment.data),
  };
}

/**
 * The seat a session occupies in a run.
 *
 * Declared before `SessionSchema` because the session carries it. `""` is an
 * ordinary session an operator opened; the rest belong to the engine.
 */
export const RunRoleSchema = z.enum(["", "lead", "worker", "reviewer"]);
export type RunRole = z.infer<typeof RunRoleSchema>;

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
  /**
   * The slash commands and pickers this session's agent currently offers.
   *
   * Carried on the session rather than left in the event log because a browser
   * that opens a session has to render its composer immediately, and replaying
   * every event to find the last `commands` frame is work for something that
   * only ever has one current answer.
   */
  commands: z.array(SessionCommandSchema).default([]),
  configOptions: z.array(SessionConfigOptionSchema).default([]),
  /**
   * The run that owns this session, and the seat it occupies in it.
   *
   * Defaulted rather than nullable so a session row written before
   * orchestration existed still parses, and so `runRole` is a single
   * comparison at every gate: `""` means an operator opened this by hand, and
   * anything else means the engine owns it. `lead` is the only key to the MCP
   * facade — worker and reviewer sessions are never handed fleet tools, which
   * is what keeps orchestration from nesting.
   */
  runId: z.string().default(""),
  runRole: RunRoleSchema.default(""),
  /**
   * Whether this session was dispatched to read rather than to change things.
   *
   * The kind lives on the step's `category`, but capacity is decided from
   * sessions, and by then the step is a lookup away — so the fact is recorded
   * here at dispatch. Defaulted to `false` because that is the safe reading:
   * an operator's own session, and any session from a build before this field,
   * may write.
   */
  readOnly: z.boolean().default(false),
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
    "commands",
    "config",
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

/**
 * A list that drops only the entries it cannot read.
 *
 * `z.array(X).catch(undefined)` reads as "tolerate a bad entry" and does the
 * opposite: the array is validated as a unit, so one unreadable element
 * discards every good one beside it. That is not hypothetical. Copilot's
 * `agent` picker offers "" for its default persona, `value` demanded a
 * non-empty string, and the single rejected choice took the model, mode, and
 * reasoning pickers with it — a composer with no controls at all on the nodes
 * that had custom agents installed, and, on a node that had seen a good list
 * first, controls frozen at that stale list which snapped back from every
 * change the agent had in fact accepted.
 *
 * Parsing element by element keeps the readable ones. A non-array stays
 * `undefined`, and so does a non-empty list nothing survived: "the agent never
 * said" and "the agent offers none" have to stay distinguishable, because
 * readers persist an empty list as a deliberate clearing.
 */
function listOfOptional<T extends z.ZodTypeAny>(schema: T) {
  return z
    .unknown()
    .optional()
    .transform((value): z.infer<T>[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) return undefined;
      const kept = value.flatMap((entry) => {
        const parsed = schema.safeParse(entry);
        return parsed.success ? [parsed.data as z.infer<T>] : [];
      });
      if (kept.length === 0 && value.length > 0) return undefined;
      return kept;
    });
}

export const sessionEventPayloadSchemas = {
  state: z.object({ state: SessionStateSchema.optional(), activity: text }),
  agent_text: z.object({ text }),
  agent_thought: z.object({ text }),
  // `kind` and `detail` exist so a reader can render a tool call as one quiet
  // line — an icon for the category and a dimmed summary of what it ran on —
  // instead of a paragraph-sized block per step. `detail` is drawn from the
  // few short input fields a tool names (a command, a path, a query); tool
  // output and file contents are deliberately never carried here.
  tool: z.object({
    toolCallId: text,
    title: text,
    status: text,
    kind: text,
    detail: text,
  }),
  permission: z.object({
    requestId: text,
    title: text,
    toolCallId: text,
    // A malformed option list must not cost the reader the title as well.
    options: listOfOptional(PermissionOptionSchema),
  }),
  permission_result: z.object({ requestId: text, outcome: text }),
  turn_complete: z.object({ stopReason: text }),
  error: z.object({ message: text }),
  system: z.object({
    text,
    attachments: listOfOptional(AttachmentSummarySchema),
  }),
  agent_session: z.object({ agentSessionId: text }),
  // A single malformed entry must not cost the reader the whole list, and an
  // absent list is meaningfully different from an empty one: "this agent never
  // said" versus "this agent offers none".
  commands: z.object({
    commands: listOfOptional(SessionCommandSchema),
  }),
  config: z.object({
    options: listOfOptional(SessionConfigOptionSchema),
  }),
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

/**
 * How far a self-update has got, in the order the stages occur.
 *
 * Named stages rather than free text because the browser renders them and the
 * Host logs them; a message the Node phrased slightly differently on Windows
 * would otherwise be a different thing to everyone reading it.
 */
export const nodeUpdateStages = [
  "checking",
  "pulling",
  "installing",
  "building",
  "restarting",
  "up_to_date",
  "failed",
] as const;
export const NodeUpdateStageSchema = z.enum(nodeUpdateStages);
export type NodeUpdateStage = z.infer<typeof NodeUpdateStageSchema>;

/**
 * An MCP server a session should be given, in the one transport this needs.
 *
 * Narrower than ACP's own union on purpose: the Host only ever hands out its
 * own HTTP endpoint with a scoped token, and modelling stdio or SSE here would
 * be inventing wire surface for a case that does not exist.
 */
export const McpHttpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  headers: z.array(z.object({ name: z.string().min(1), value: z.string() })).default([]),
});
export type McpHttpServer = z.infer<typeof McpHttpServerSchema>;

/**
 * A picker the Host wants set before the session is asked anything.
 *
 * Values are matched loosely by the Node, because the Host does not know how
 * Copilot spells them: the mode picker's values are ACP URLs rather than the
 * word "agent". Sending the intent and resolving it where the choices actually
 * live beats hardcoding a URL from a protocol we do not own.
 *
 * Applied in the same window as the custom agent, and for the same reason: the
 * first prompt follows immediately, and a setting applied after it has already
 * missed the turn it was meant to govern.
 */
export const StartupConfigSchema = z.object({
  id: z.string().min(1).max(60),
  value: z.string().max(200),
});
export type StartupConfig = z.infer<typeof StartupConfigSchema>;

export const NodeCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start_session"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    localPath: z.string().min(1),
    prompt: z.string().min(1),
    /** Launches Copilot with --allow-all; decided by the Host. */
    yolo: z.boolean().default(false),
    /**
     * Tools this session may call back into the Host with.
     *
     * Defaulted to empty, which is what every ordinary session gets: tools are
     * injected per session in ACP, so a worker is not "denied" the fleet tools
     * — it is never given them, and cannot ask. Only an orchestrator is handed
     * a server here, with a token scoped to itself.
     */
    mcpServers: z.array(McpHttpServerSchema).default([]),
    /**
     * An agent from this Node's catalog to put the session into.
     *
     * A name, not a definition: the markdown ships with the Node, so the Host
     * chooses a role rather than transmitting one. Empty for every ordinary
     * session, which is the same role gate as `mcpServers` — a worker is not
     * denied an agent, it is never given one and no picker appears.
     */
    agent: z.string().max(40).default(""),
    /**
     * Work that only reads, which the Node counts against its own allowance.
     *
     * Sent so both sides split capacity the same way. If only the Host did, it
     * would dispatch work the machine then refuses, and a refusal at that point
     * costs the connection rather than the step.
     */
    readOnly: z.boolean().default(false),
    /** Pickers to set before the first prompt: mode, model, reasoning effort. */
    config: z.array(StartupConfigSchema).default([]),
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
    /**
     * Re-supplied on resume, because `session/load` takes its own `mcpServers`
     * and a session reloaded without them comes back with no tools — an
     * orchestrator that wakes up unable to dispatch anything.
     */
    mcpServers: z.array(McpHttpServerSchema).default([]),
    /**
     * Re-supplied for a different reason than `mcpServers`.
     *
     * The selection itself survives `session/load` — verified — but the file it
     * names has to still be on disk beneath the session, and a scratch
     * directory is exactly the kind of place something else may have cleaned up.
     */
    agent: z.string().max(40).default(""),
    /**
     * Work that only reads, which the Node counts against its own allowance.
     *
     * Sent so both sides split capacity the same way. If only the Host did, it
     * would dispatch work the machine then refuses, and a refusal at that point
     * costs the connection rather than the step.
     */
    readOnly: z.boolean().default(false),
    /** Pickers to set before the first prompt: mode, model, reasoning effort. */
    config: z.array(StartupConfigSchema).default([]),
  }),
  z.object({
    type: z.literal("prompt"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    prompt: z.string().min(1),
    attachments: z.array(PromptAttachmentSchema).default([]),
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
  /**
   * Change a session picker — the model, the mode, the reasoning effort.
   *
   * Separate from `prompt` even though Copilot also accepts `/model <id>` as
   * text: a prompt spends a turn and depends on the agent parsing prose, while
   * this is the typed ACP call that answers with the settled option list, so
   * the UI can show the change instead of inferring it from a reply.
   */
  z.object({
    type: z.literal("set_config_option"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    configId: z.string().min(1),
    // See SetSessionConfigSchema: "" is a real choice, not a missing one.
    value: z.string(),
  }),
]);
export type NodeCommand = z.infer<typeof NodeCommandSchema>;

/**
 * What a Node reports about itself when it arrives.
 *
 * Shared between the legacy `hello` and the sealed `ready` that replaces it,
 * because the inventory is the same question either way — what this machine is,
 * what it can do, and what it is still running — and two copies of it is two
 * copies to keep in step.
 */
const nodeInventoryShape = {
  os: z.string().min(1),
  arch: z.string().min(1),
  version: z.string().min(1),
  revision: z.string().default(""),
  capabilities: z.array(z.string()),
  agents: z.array(NodeAgentSchema).default([]),
  maxSessions: z.number().int().positive(),
  homeDir: z.string().default(""),
  /**
   * What this Node currently calls itself.
   *
   * A rename used to be a new identity: the Node re-registered under the new
   * name and left its placements and sessions behind on the old one. Carrying
   * the name here instead makes it a label on an identity the `nodeId`
   * already establishes, so renaming keeps the machine's history.
   */
  name: z.string().min(1).max(120).optional(),
  /**
   * The name this Node believes the Host has for it.
   *
   * Settles the case where both ends were renamed while the Node was offline.
   * Equal to `name` unless the operator edited it locally, so a difference
   * from what the Host holds tells the two apart: the Node is proposing a
   * rename only when the Host still has the name the Node last synced.
   */
  knownName: z.string().max(120).optional(),
  /** Sessions still running on this Node; used to resurrect offline rows. */
  activeSessionIds: z.array(z.string()).default([]),
  /**
   * The subset of `activeSessionIds` with a turn still in flight.
   *
   * Without it the Host has to guess what a reconnecting Node was doing, and
   * it guessed `idle` — which unlocks the composer over an agent that is
   * still working and cannot accept a second prompt.
   */
  busySessionIds: z.array(z.string()).default([]),
} as const;

/**
 * The first frame a Node holding a shared secret sends.
 *
 * Named on its own rather than left inline in the union because the gateway now
 * has to decide between this and {@link NodeClientHelloSchema} before either
 * has been accepted — a decision that cannot be expressed by a union whose only
 * other members are frames that arrive after authentication.
 */
export const NodeHelloSchema = z.object({
  type: z.literal("hello"),
  nodeId: z.string().min(1),
  secret: z.string().min(1),
  ...nodeInventoryShape,
});

/**
 * The same inventory, sent sealed, by a Node that has already proved itself.
 *
 * The mutual handshake authenticates a connection, not a machine's contents:
 * capabilities, agents and the sessions still running are things a Node
 * *claims*, and there is no reason to let it claim them before its key has been
 * checked. So `client_hello` says only who is dialing, and everything else
 * arrives here, inside the channel.
 */
export const NodeReadySchema = z.object({
  type: z.literal("ready"),
  ...nodeInventoryShape,
});
export type NodeReady = z.infer<typeof NodeReadySchema>;

export const NodeToHostMessageSchema = z.discriminatedUnion("type", [
  NodeHelloSchema,
  NodeReadySchema,
  z.object({
    type: z.literal("heartbeat"),
    activeSessionIds: z.array(z.string()),
    /** As on `hello`: which of those are mid-turn. */
    busySessionIds: z.array(z.string()).default([]),
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
    /**
     * Whether a failure ends the session.
     *
     * A command can be refused without anything being broken — prompting a
     * session that is already mid-turn is the operator being early, not the
     * agent dying — and failing the session over it destroys a live run. Older
     * Nodes never set this, so the default preserves their behaviour.
     */
    fatal: z.boolean().default(true),
  }),
  /**
   * Progress of a self-update, which belongs to the machine rather than to any
   * session — so it cannot travel as a `command_result`, whose every field is
   * about one session.
   */
  z.object({
    type: z.literal("update_status"),
    updateId: z.string().min(1),
    stage: NodeUpdateStageSchema,
    detail: z.string().default(""),
  }),
  /**
   * The public key a legacy Node has generated for itself.
   *
   * Sent over a connection the Node has *already* authenticated with its shared
   * secret, which is what makes it safe: the Host is not being asked to trust a
   * key from a stranger, it is being told which key an established Node will
   * use from now on. This is the whole of the migration path — the alternative
   * was re-enrolling every machine by hand.
   */
  z.object({
    type: z.literal("node_key"),
    publicKey: z.string().min(1).max(1_000),
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
  /**
   * Pull, rebuild and restart from the checkout this Node runs from.
   *
   * Node-scoped rather than a {@link NodeCommandSchema} variant because every
   * command there names the session it acts on, and an update acts on the
   * machine. Gated on {@link SELF_UPDATE_CAPABILITY} for the same reason
   * `host_url` is: a Node validates every frame against its own copy of this
   * union and hangs up on anything it does not recognise, so announcing this to
   * an older machine would cost it the connection instead of updating it.
   */
  z.object({ type: z.literal("update_node"), updateId: z.string().min(1) }),
  /**
   * The name the Host holds for this Node, which is the one that counts.
   *
   * Sent after a rename from either end: the Host owns the fleet-wide unique
   * name, so it answers a Node's proposal with the name that was actually
   * recorded — which is not the proposed one when another machine already had
   * it. Also pushed when a browser renames the Node, so the local config page
   * stops disagreeing with the fleet about what this machine is called. Gated
   * on {@link NODE_NAME_SYNC_CAPABILITY} for the same reason `host_url` is.
   */
  z.object({ type: z.literal("node_name"), name: z.string().min(1) }),
  /**
   * Asks a legacy Node to generate a key pair and report its public half.
   *
   * Carries the Host's identity and a proof of it keyed with `SHA-256(node
   * secret)` — the one thing this Host and this Node both know and a relay
   * does not. Without that the upgrade would be trust-on-first-use over a
   * connection the Node has never authenticated, which is precisely the hole
   * the key pair exists to close: a relay could pin its own key and impersonate
   * the Host to that machine forever.
   *
   * Sent only to a Node advertising {@link NODE_KEY_UPGRADE_CAPABILITY}, for the
   * same reason `host_url` is gated: an older Node validates every frame
   * against its own copy of this union and hangs up on anything it does not
   * recognise, so asking one to upgrade would cost it the connection instead.
   */
  z.object({
    type: z.literal("request_node_key"),
    hostId: z.string().min(1).max(200),
    hostPublicKey: base64Field(MAX_KEY_LENGTH),
    hostFingerprint: sha256Hex,
    proof: base64Field(MAX_PROOF_LENGTH),
  }),
  /**
   * Confirms which key the Host recorded, naming it.
   *
   * The second half of a two-phase migration, and the reason there is one. A
   * Node that wrote its key pair over its shared secret the moment it generated
   * one would be betting its only way back into the fleet on a frame arriving:
   * one dropped `node_key` and that machine holds a private key the Host has
   * never seen and no secret to prove itself with, on a box someone has to
   * visit. So the Node holds the proposal in memory, stays legacy, and promotes
   * only when this says the Host has the matching public half.
   *
   * The key is named rather than implied because a Host mid-migration may have
   * staged a key from an earlier attempt whose acknowledgement was lost, and an
   * unqualified "yes" would promote the Node onto the wrong one.
   */
  z.object({
    type: z.literal("node_key_accepted"),
    publicKey: base64Field(MAX_KEY_LENGTH),
  }),
]);
export type HostToNodeMessage = z.infer<typeof HostToNodeMessageSchema>;

/** A Node that understands `host_url` and can follow the Host to a new address. */
export const HOST_URL_SYNC_CAPABILITY = "host-url-sync";

/** A Node that can pull, rebuild and restart itself on `update_node`. */
export const SELF_UPDATE_CAPABILITY = "self-update";

/**
 * A Node that can generate an identity key pair and report it over an already
 * authenticated legacy connection. Absent from a Node that predates Node keys,
 * which is exactly the set that must not be asked.
 */
export const NODE_KEY_UPGRADE_CAPABILITY = "node-key-upgrade";

/**
 * A Node willing to launch Copilot with `--allow-all`.
 *
 * Named here rather than spelled as a literal at each check because the
 * orchestrator gates dispatch on it too, and a capability string that is
 * typed out in three places is a capability string that will be misspelled in
 * one of them.
 */
export const HOST_YOLO_CAPABILITY = "host-yolo";

/**
 * A Node that treats its name as a label on its `nodeId` rather than as its
 * identity: it proposes renames over `hello` and accepts `node_name` back.
 */
export const NODE_NAME_SYNC_CAPABILITY = "node-name-sync";

/**
 * A Node that reports which of its sessions are mid-turn, so the Host can
 * restore a reconnecting session to what it is actually doing instead of
 * assuming it is idle and waiting for a prompt.
 */
export const SESSION_ACTIVITY_CAPABILITY = "session-activity";

/**
 * A Node that reports the agent's slash commands and pickers, and accepts
 * `set_config_option` to change one.
 *
 * The Host checks this before offering a model chooser: an older Node validates
 * every frame against its own copy of {@link NodeCommandSchema} and hangs up on
 * anything it does not recognise, so sending one blindly costs the connection.
 */
export const SESSION_CONFIG_CAPABILITY = "session-config";

/**
 * Which name wins when a Node reconnects, and whether anyone has to be told.
 *
 * Names are unique fleet-wide and a browser can change one while the machine is
 * offline, so the two ends can disagree in both directions at once. The Node's
 * `knownName` — the last name it synced with the Host — is what separates them:
 * the Node is proposing a rename only when the Host still holds that name.
 * Anything else means the Host was renamed since, and the Host wins, because it
 * is the end that enforces uniqueness and the end an operator is looking at
 * when they rename a machine they cannot see.
 */
export function resolveNodeName(input: {
  /** The name the Host currently has recorded. */
  stored: string;
  /** What the Node calls itself now; absent from Nodes too old to send it. */
  reported?: string | undefined;
  /** The name the Node believes the Host has. */
  knownName?: string | undefined;
}): { name: string; renameStored: boolean; tellNode: boolean } {
  const reported = input.reported?.trim();
  // A Node too old to report a name cannot be told one either; it would hang up
  // on a message its copy of the union does not have.
  if (!reported) return { name: input.stored, renameStored: false, tellNode: false };
  const known = input.knownName?.trim() ?? "";
  // A Node that has never synced a name cannot claim the Host's is stale.
  const proposing = Boolean(known) && known === input.stored && reported !== input.stored;
  const name = proposing ? reported : input.stored;
  return {
    name,
    renameStored: name !== input.stored,
    // Told whenever either of the Node's two records is out of date: what it
    // calls itself, and what it believes the Host calls it. The second matters
    // as much as the first — `knownName` is how the next reconnect tells an
    // operator's rename apart from a stale copy of the Host's, so leaving it
    // behind would make the following local rename look like the stale one and
    // be refused.
    tellNode: name !== reported || name !== known,
  };
}

/**
 * Whether a Node is running the Host's code, and whether it can be told to.
 *
 * `unsupported` is deliberately distinct from `stale`: both need updating, but
 * only one can be updated from this screen, and offering a button that would
 * disconnect the machine is worse than saying so. `unknown` covers a checkout
 * that is not a git repository on either end, where any verdict would be a
 * guess dressed up as a fact.
 */
export type NodeUpdateState = "current" | "stale" | "unknown" | "unsupported";

export function nodeUpdateState(
  node: Pick<FleetNode, "revision" | "capabilities">,
  hostRevision: string,
): NodeUpdateState {
  if (!node.capabilities.includes(SELF_UPDATE_CAPABILITY)) return "unsupported";
  if (!hostRevision || !node.revision) return "unknown";
  return node.revision === hostRevision ? "current" : "stale";
}

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
 * What a run and its steps are allowed to consume before the engine gives the
 * decision back to a human.
 *
 * Every field has a default because a policy blob is stored as JSON and read
 * back by code that may be newer than the row.
 */
export const RunPolicySchema = z.object({
  maxParallel: z.number().int().positive().default(3),
  /** Cumulative sessions this run may spawn, the Lead included. */
  maxSessions: z.number().int().positive().default(8),
  maxWakes: z.number().int().positive().default(12),
  /** Cap on one step's output inside a wake envelope. */
  maxOutputChars: z.number().int().positive().default(8_000),
  yolo: z.boolean().default(true),
  onStepFailure: z.enum(["wake", "fail-fast", "continue"]).default("wake"),
  wakePolicy: z.enum(["on_any_settle", "none"]).default("none"),
  stepTimeoutMs: z.number().int().positive().default(3_600_000),
  /**
   * Bounds only the dispatch window — frame out, Copilot spawned, session
   * created — which is a different order of magnitude from how long the work
   * takes. Folding it into `stepTimeoutMs` would hold a placement's write lock
   * for an hour on a step that never started.
   */
  startingTimeoutMs: z.number().int().positive().default(120_000),
  staleAfterMs: z.number().int().positive().default(60_000),
});
export type RunPolicy = z.infer<typeof RunPolicySchema>;

export const RunStateSchema = z.enum([
  "awaiting_approval",
  "planning",
  "running",
  "awaiting_lead",
  /**
   * Every phase is done and the orchestrator has handed the result to a person.
   *
   * The one place a human is still in the loop. The orchestrator drives a task
   * from phase to phase on its own — it is what checks a worker's output and
   * decides whether that phase is finished — so the person is not a step in
   * the middle of the work; they are the sign-off at the end of it.
   */
  "awaiting_human",
  "aggregating",
  "completed",
  "failed",
  "cancelled",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const RunStepStateSchema = z.enum([
  "pending",
  /**
   * The receipt is written and the command is on its way out.
   *
   * A database transaction cannot hold a socket send, so there is always a
   * moment where the Host has promised a step but the Node has not confirmed
   * it. Naming that moment is what lets a failed send roll back and a Node
   * lost mid-dispatch be told apart from one that is merely slow. The session
   * state machine has carried the same state, for the same reason, since
   * before runs existed.
   */
  "starting",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);
export type RunStepState = z.infer<typeof RunStepStateSchema>;

/**
 * One thing that has to be true for a task to be finished.
 *
 * Stated as something observable rather than as an intention. "The feature
 * works" is a feeling; "`npm test -- auth` exits zero and the login route
 * answers 200" is a thing someone can go and check.
 *
 * The minimum lengths are not arbitrary. They are the cheapest available
 * approximation of the rule this exists to enforce — that a criterion nobody
 * could check is not a criterion — and they cost nothing to satisfy honestly
 * while making "verify it works" impossible to submit.
 */
export const RunCriterionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Criterion ids are file-safe handles, not sentences")
    .describe(
      'A short lowercase handle you will use again when reporting, e.g. "logout-clears-token".',
    ),
  /** What to do, with what inputs, and what counts as a pass. */
  scenario: z
    .string()
    .min(20)
    .describe(
      "What someone would do, and what should happen — concretely. " +
        'Not "auth works": "posting to /logout with a valid token, then reusing that token, returns 401".',
    ),
  /** The observable this produces: a command's output, a file, a status line. */
  expectedEvidence: z
    .string()
    .min(10)
    .describe(
      "What will show this is true. A command and its output, a test name, a file that exists. Not an opinion.",
    ),
  /**
   * Whether the task can be handed over without this one.
   *
   * Not every criterion is load-bearing. A task that must not ship without its
   * migration proven can still ship without its nice-to-have covered, and
   * saying which is which up front is what keeps the gate from becoming
   * something to route around.
   */
  essential: z
    .boolean()
    .default(true)
    .describe("False if the task can finish without this. Defaults to true."),
});
export type RunCriterion = z.infer<typeof RunCriterionSchema>;

/** How a criterion turned out, as the orchestrator accounts for it. */
export const CriterionOutcomeSchema = z.enum(["met", "unmet", "blocked"]);
export type CriterionOutcome = z.infer<typeof CriterionOutcomeSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  objective: z.string().min(1),
  state: RunStateSchema,
  leadSessionId: z.string().default(""),
  /**
   * The working surface this run was pinned to.
   *
   * Empty until the first side-effecting step lands, then fixed. A workspace
   * has one placement per node — separate checkouts on separate machines — so
   * re-picking between steps is what would hand a reviewer a stale tree.
   */
  placementId: z.string().default(""),
  // Zod does not re-parse a literal default, so the default is produced by
  // parsing an empty object — otherwise a run row with no policy would come
  // back as `{}` and every budget check would read `undefined`.
  policy: RunPolicySchema.default(() => RunPolicySchema.parse({})),
  /**
   * The stages this task goes through, named by the orchestrator when it plans
   * the task.
   *
   * Not a fixed set. "Plan, implement, review" suits a change; a question
   * needs one phase and a person's sign-off. Deciding how many there are is
   * part of the planning, so the shape is a list rather than an enum.
   *
   * Empty means the task was never planned in phases — the handwritten-DAG
   * fixture, and any task from before this existed.
   */
  phases: z.array(z.string()).default([]),
  /** Which phase is being worked on now; an index into {@link phases}. */
  phaseIndex: z.number().int().nonnegative().default(0),
  /**
   * What has to be observably true for this task to be finished.
   *
   * Written when the task is planned, before any work goes out, because a
   * definition of done arrived at afterwards is a description of what happened
   * rather than a test of it. Empty only for tasks planned before this existed.
   */
  successCriteria: z.array(RunCriterionSchema).default([]),
  /**
   * One line naming the exact observable state that ends this task.
   *
   * Separate from the criteria, which say what must be true, because a task can
   * satisfy every criterion and still not know when to stop looking. This is
   * the sentence that says "then walk away".
   */
  stopWhen: z.string().default(""),
  failureReason: z.string().default(""),
  /**
   * A message owed to the orchestrator, held until it is free to read it.
   *
   * Copilot refuses a prompt while a turn is in flight, and that refusal comes
   * back as a transcript notice rather than an error the sender can see. A
   * route that dispatched directly therefore had no way to know its brief had
   * been dropped — the task was created and the orchestrator was never told.
   * Writing it here makes the delivery owed rather than attempted: the engine
   * hands it over on the first tick where the lead is idle, and a restart in
   * between changes nothing.
   */
  pendingPrompt: z.string().default(""),
  /**
   * Monotonic counters, not timestamps.
   *
   * "Wake the Lead exactly once per settle" rests entirely on comparing these
   * two, and wall-clock strings lose that comparison to same-millisecond
   * settles, clock skew, and restarts.
   */
  settleSeq: z.number().int().nonnegative().default(0),
  wakeSeq: z.number().int().nonnegative().default(0),
  emptyWakeCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunStepSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  /**
   * The Lead's name for this unit of work.
   *
   * Unique within a run, and the Lead decides what it means: reusing a key is
   * how a retry says "this is the same step again" and gets `attempts`
   * incremented instead of a second row.
   */
  stepKey: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  category: z.string().default(""),
  dependsOn: z.array(z.string()).default([]),
  state: RunStepStateSchema,
  sessionId: z.string().default(""),
  placementId: z.string().default(""),
  output: z.string().default(""),
  /**
   * Where this step's output starts in its session's event stream.
   *
   * A session can be prompted again, so "every agent_text on this session" is
   * not this step's output; without a watermark the second wake would replay
   * the first one's work back to the Lead.
   */
  eventSeqFrom: z.number().int().nonnegative().default(0),
  attempts: z.number().int().nonnegative().default(0),
  /** Which phase of its task this step was dispatched in. */
  phaseIndex: z.number().int().nonnegative().default(0),
  /** When the step entered `starting`; the dispatch deadline counts from here. */
  dispatchedAt: z.string().default(""),
  position: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RunStep = z.infer<typeof RunStepSchema>;

/** A line the orchestrator wrote as a phase ended, for the person to read. */
export const RunNoteSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  phaseIndex: z.number().int().nonnegative().default(0),
  body: z.string().default(""),
  createdAt: z.string().datetime(),
});
export type RunNote = z.infer<typeof RunNoteSchema>;

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
  /** Defaulted so a browser talking to a Host without runs still parses. */
  runs: z.array(RunSchema).default([]),
  /**
   * The commit the Host is running, so a browser can mark Nodes that are behind
   * it. Sent with the fleet rather than fetched separately because the two are
   * only meaningful together — a node revision with nothing to compare it to
   * says nothing an operator can act on.
   */
  hostRevision: z.string().default(""),
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
  /**
   * Progress of a Node's self-update.
   *
   * Broadcast rather than stored on the node row because it describes a few
   * seconds of work, not a property of the machine: persisting it would leave
   * "building" on screen forever if the Host restarted mid-update.
   */
  z.object({
    type: z.literal("node_update"),
    nodeId: z.string().min(1),
    stage: NodeUpdateStageSchema,
    detail: z.string().default(""),
  }),
  /**
   * Something went wrong with one session without ending it.
   *
   * A prompt refused because the session is already mid-turn is the case this
   * exists for: the session is fine, the command was not, and the operator has
   * to be told — otherwise the message they typed disappears without a trace
   * and the only symptom is an agent that never answers.
   */
  z.object({
    type: z.literal("session_notice"),
    sessionId: z.string().min(1),
    message: z.string().min(1),
  }),
  /**
   * One run after any change to it.
   *
   * Runs go out on the browser channel rather than as SessionEvents because
   * orchestration progress is not something an agent said — no Node produces
   * it, and adding it to the Node wire union would break every Node that has
   * not been updated.
   */
  z.object({ type: z.literal("run"), run: RunSchema }),
  /** A run's steps, sent whole: a removed step has no row left to describe. */
  z.object({
    type: z.literal("run_steps"),
    runId: z.string().min(1),
    steps: z.array(RunStepSchema),
  }),
]);
export type BrowserMessage = z.infer<typeof BrowserMessageSchema>;

/**
 * What a Node says about itself when it enrolls.
 *
 * Separate from the token registration below because the bound enrollment
 * hashes exactly this object and both ends have to agree, byte for byte, on
 * what was hashed. A field that exists on one path and not the other is a
 * completion the Host would reject for a payload the Node thought it sent.
 */
export const NodeRegistrationPayloadSchema = z.object({
  name: z.string().min(1).max(100),
  os: z.string().min(1),
  arch: z.string().min(1),
  version: z.string().min(1),
  revision: z.string().default(""),
  capabilities: z.array(z.string()),
  agents: z.array(NodeAgentSchema).default([]),
  maxSessions: z.number().int().min(1).max(64),
  homeDir: z.string().max(4096).default(""),
});
export type NodeRegistrationPayload = z.infer<typeof NodeRegistrationPayloadSchema>;

export const RegisterNodeSchema = NodeRegistrationPayloadSchema.extend({
  enrollmentToken: z.string().min(1),
});

export const RenameNodeSchema = z.object({
  name: z.string().min(1).max(100),
});

// ---------------------------------------------------------------------------
// Node identity, enrollment and the authenticated channel.
//
// Everything below is a wire shape only: the cryptography that fills these
// fields lives in `@fleet/protocol/node-auth`, which the browser bundle must
// not pull in. Keeping the schemas here is what lets the Connect card and the
// Host routes agree on a contract without either importing `node:crypto`.
// ---------------------------------------------------------------------------

/** The channel version both ends name in every frame they authenticate. */
export const MUTUAL_AUTH_PROTOCOL = "mutual-auth-v1" as const;

/**
 * How a Node proves it is itself.
 *
 * `legacy-secret` is the shared secret that predates Node keys; it survives
 * only until every Node has upgraded, which is why the record names the
 * protocol rather than inferring it from which column is populated.
 */
export const nodeAuthProtocols = ["legacy-secret", MUTUAL_AUTH_PROTOCOL] as const;
export const NodeAuthProtocolSchema = z.enum(nodeAuthProtocols);
export type NodeAuthProtocol = z.infer<typeof NodeAuthProtocolSchema>;

/**
 * A ciphertext bound that fits the largest thing the protocol already carries.
 *
 * Six ten-megabyte attachments is the existing prompt ceiling, which is roughly
 * eighty megabytes of JSON before it is sealed and base64-encoded. The bound
 * exists so that a peer cannot make the Host allocate without limit; it is not
 * a policy about attachment size, which is enforced where attachments are.
 */
export const MAX_AUTHENTICATED_CIPHERTEXT_LENGTH = 120 * 1024 * 1024;

export const HostIdentitySchema = z.object({
  hostId: z.string().min(1).max(200),
  /** Base64 SPKI DER. The private half never leaves the Host. */
  publicKey: base64Field(MAX_KEY_LENGTH),
  fingerprint: sha256Hex,
});
export type HostIdentity = z.infer<typeof HostIdentitySchema>;

/**
 * What this Host currently is, from the point of view of "who may drive it".
 *
 * Named states rather than a pair of booleans because each one asks the browser
 * for something different, and a gate that cannot tell `entra-unconfigured`
 * from `unclaimed` shows a sign-in form that cannot possibly work.
 */
export const authStates = [
  "entra-unconfigured",
  "unclaimed",
  "legacy-password",
  "hybrid",
  "microsoft-only",
  "recovery",
] as const;
export const AuthStateSchema = z.enum(authStates);
export type AuthState = z.infer<typeof AuthStateSchema>;

/**
 * Whether this browser can finish an authorization-code sign-in where it is.
 *
 * Entra matches the registered `http://localhost/...` reply URL by name and
 * ignores the port, so any local port works and no other name does. The Host
 * answers with which case the caller is in, so the page can move itself to the
 * canonical name or explain the local forward — rather than starting a
 * transaction whose callback lands somewhere the transaction cookie is not.
 */
export const CodeLoginEndpointSchema = z.object({
  available: z.boolean(),
  /** The same Host under the name Entra will redirect back to. */
  canonicalUrl: z.string().max(2048).optional(),
  /** No local listener is reachable from here; a forward or device flow is needed. */
  localForwardRequired: z.boolean().default(false),
});
export type CodeLoginEndpoint = z.infer<typeof CodeLoginEndpointSchema>;

export const AuthStatusSchema = z.object({
  state: AuthStateSchema,
  authenticated: z.boolean(),
  passwordEnabled: z.boolean(),
  entraConfigured: z.boolean(),
  deviceFlowEnabled: z.boolean(),
  claimCodeRequired: z.boolean(),
  /** Whether this endpoint may carry a credential at all. */
  canSignIn: z.boolean(),
  codeLogin: CodeLoginEndpointSchema.default({
    available: true,
    localForwardRequired: false,
  }),
  /** Display metadata for the signed-in administrator; never an authorization input. */
  identity: z.object({ username: z.string(), displayName: z.string() }).optional(),
  /** The registration this Host authenticates against. Configuration, not a secret. */
  entra: z.object({ tenantId: z.string(), clientId: z.string() }).optional(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

/**
 * Why a Microsoft sign-in ended without a Fleet session.
 *
 * A closed set, because it travels back to the app in a URL: the page looks the
 * code up in its own table and shows its own words, so a crafted link cannot
 * put a stranger's sentence on Fleet's sign-in screen.
 */
export const authErrorCodes = [
  "claim-required",
  "already-claimed",
  "not-authorized",
  "pending-approval",
  "wrong-tenant",
  "expired",
  "device-blocked",
  "endpoint-refused",
  "provider-unavailable",
  "cancelled",
] as const;
export const AuthErrorCodeSchema = z.enum(authErrorCodes);
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;

export const AUTH_ERROR_PARAM = "auth_error";
export const AUTH_ERROR_MESSAGE_PARAM = "auth_error_message";
/** Long enough for a sentence, short enough that no provider output fits. */
export const MAX_AUTH_ERROR_MESSAGE_LENGTH = 300;

/**
 * Strips the characters that would let a message become markup or a new
 * parameter, and bounds it.
 *
 * The page renders this as text, so this is belt and braces — but the value
 * also lands in an address bar and a server log, and neither is a good place
 * for a caller's angle brackets.
 */
function safeAuthErrorMessage(message: string): string {
  return message
    .replace(/[<>"'`\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTH_ERROR_MESSAGE_LENGTH);
}

/**
 * Where the callback sends a browser whose sign-in did not produce a session.
 *
 * A refusal used to answer with a JSON body, which left the operator looking at
 * `{"error":...}` in the address bar with no way back to the console. The app
 * is the only thing that can explain a refusal and offer the next step, so
 * every outcome returns to it.
 */
export function authErrorRedirect(code: AuthErrorCode, message?: string): string {
  const params = new URLSearchParams({ [AUTH_ERROR_PARAM]: code });
  const safe = message ? safeAuthErrorMessage(message) : "";
  if (safe) params.set(AUTH_ERROR_MESSAGE_PARAM, safe);
  return `/?${params.toString()}`;
}

/** Reads back a redirect this build understands, or nothing. */
export function parseAuthError(
  search: string,
): { code: AuthErrorCode; message: string | undefined } | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const parsed = AuthErrorCodeSchema.safeParse(params.get(AUTH_ERROR_PARAM));
  if (!parsed.success) return undefined;
  const raw = params.get(AUTH_ERROR_MESSAGE_PARAM);
  const message = raw ? safeAuthErrorMessage(raw) : "";
  return { code: parsed.data, message: message || undefined };
}

/**
 * What the Connect card hands an operator to paste onto a new machine.
 *
 * The fleet-wide enrollment token is deliberately absent and stripped if
 * offered: a Node that has a Host id and fingerprint to pin has no use for a
 * reusable fleet credential, and carrying one here is how it would end up sent
 * to whatever answers the URL.
 */
export const ConnectCommandSchema = z
  .object({
    hostUrl: z.string().url().max(2048),
    hostId: z.string().min(1).max(200),
    hostFingerprint: sha256Hex,
    /** `<grant-id>.<grant-secret>`, one Node, fifteen minutes, one use. */
    enrollmentGrant: z.string().min(3).max(400),
    tunnelId: z.string().max(200).optional(),
  })
  .strip();
export type ConnectCommand = z.infer<typeof ConnectCommandSchema>;

export function formatEnrollmentGrant(id: string, secret: string): string {
  return `${id}.${secret}`;
}

/**
 * Splits a grant, or reports that it is not one.
 *
 * The id is public and the secret is a key, so they travel joined and are used
 * apart: the challenge endpoint is given only the id, and the secret never
 * leaves the Node except as an HMAC over a transcript.
 */
export function parseEnrollmentGrant(
  value: string,
): { id: string; secret: string } | undefined {
  const separator = value.indexOf(".");
  if (separator <= 0) return undefined;
  const id = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!id || !secret) return undefined;
  return { id, secret };
}

export const NodeEnrollmentChallengeSchema = z
  .object({
    grantId: z.string().min(1).max(200),
    nodeNonce: base64Field(MAX_PROOF_LENGTH),
    nodePublicKey: base64Field(MAX_KEY_LENGTH),
    /** SHA-256 of the canonical registration payload, committed to up front. */
    registrationHash: sha256Hex,
    /** The address the Node actually dialed, so a relay cannot rewrite it. */
    dialedHostUrl: z.string().url().max(2048),
  })
  .strip();
export type NodeEnrollmentChallenge = z.infer<typeof NodeEnrollmentChallengeSchema>;

export const NodeEnrollmentChallengeResponseSchema = z.object({
  challengeId: z.string().min(1).max(200),
  hostId: z.string().min(1).max(200),
  hostPublicKey: base64Field(MAX_KEY_LENGTH),
  hostFingerprint: sha256Hex,
  hostNonce: base64Field(MAX_PROOF_LENGTH),
  expiresAt: z.string().datetime(),
  signature: base64Field(MAX_PROOF_LENGTH),
});
export type NodeEnrollmentChallengeResponse = z.infer<
  typeof NodeEnrollmentChallengeResponseSchema
>;

export const EnrollNodeSchema = z.object({
  challengeId: z.string().min(1).max(200),
  registration: NodeRegistrationPayloadSchema,
  nodeSignature: base64Field(MAX_PROOF_LENGTH),
  /** HMAC-SHA256 under the grant digest, over the same transcript. */
  grantProof: base64Field(MAX_PROOF_LENGTH),
});
export type EnrollNode = z.infer<typeof EnrollNodeSchema>;

/**
 * What a newly enrolled Node is told, which is deliberately not a credential.
 *
 * The Node already holds the only secret in the exchange — its private key —
 * so there is nothing here to steal and nothing to replay.
 *
 * Signed over the transcript the challenge and the completion were signed over,
 * plus the id being issued. It is the last frame of enrolment and the first
 * thing the Node writes to disk: it names the Host key that machine pins
 * forever after, so an unsigned one would hand a relay the last word in an
 * exchange it could not otherwise touch.
 */
export const NodeEnrollmentReceiptSchema = z
  .object({
    nodeId: z.string().min(1).max(200),
    /** The challenge this answers, so a receipt cannot be moved to another. */
    challengeId: z.string().min(1).max(200),
    authProtocol: z.literal(MUTUAL_AUTH_PROTOCOL),
    hostId: z.string().min(1).max(200),
    hostPublicKey: base64Field(MAX_KEY_LENGTH),
    hostFingerprint: sha256Hex,
    signature: base64Field(MAX_PROOF_LENGTH),
  })
  .strip();
export type NodeEnrollmentReceipt = z.infer<typeof NodeEnrollmentReceiptSchema>;

export const NodeClientHelloSchema = z
  .object({
    type: z.literal("client_hello"),
    protocol: z.literal(MUTUAL_AUTH_PROTOCOL),
    nodeId: z.string().min(1).max(200),
    /** The Host this Node believes it is dialing, echoed back in the proof. */
    hostId: z.string().min(1).max(200),
    nodeNonce: base64Field(MAX_PROOF_LENGTH),
    nodeEphemeralPublicKey: base64Field(MAX_KEY_LENGTH),
    dialedHostUrl: z.string().max(2048).default(""),
  })
  .strip();
export type NodeClientHello = z.infer<typeof NodeClientHelloSchema>;

export const HostChallengeSchema = z.object({
  type: z.literal("host_challenge"),
  protocol: z.literal(MUTUAL_AUTH_PROTOCOL),
  hostId: z.string().min(1).max(200),
  hostPublicKey: base64Field(MAX_KEY_LENGTH),
  hostFingerprint: sha256Hex,
  hostNonce: base64Field(MAX_PROOF_LENGTH),
  connectionId: z.string().min(1).max(200),
  hostEphemeralPublicKey: base64Field(MAX_KEY_LENGTH),
  signature: base64Field(MAX_PROOF_LENGTH),
});
export type HostChallenge = z.infer<typeof HostChallengeSchema>;

export const NodeProofSchema = z.object({
  type: z.literal("node_proof"),
  signature: base64Field(MAX_PROOF_LENGTH),
});
export type NodeProof = z.infer<typeof NodeProofSchema>;

/**
 * Every frame either end sends once the handshake is done.
 *
 * The sequence is authenticated rather than merely present: it is part of the
 * additional data and of the nonce, so an envelope moved to another position in
 * the stream fails to open rather than arriving early.
 */
export const AuthenticatedEnvelopeSchema = z.object({
  type: z.literal("envelope"),
  connectionId: z.string().min(1).max(200),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ciphertext: base64Field(MAX_AUTHENTICATED_CIPHERTEXT_LENGTH),
  authenticationTag: base64Field(MAX_PROOF_LENGTH),
});
export type AuthenticatedEnvelope = z.infer<typeof AuthenticatedEnvelopeSchema>;

/**
 * The one frame the gateway has to read before it knows which protocol it is
 * speaking. Rejecting everything else here is what keeps a command or an event
 * from ever being read on an unauthenticated connection.
 */
export const NodeFirstFrameSchema = z.discriminatedUnion("type", [
  NodeHelloSchema,
  NodeClientHelloSchema,
]);
export type NodeFirstFrame = z.infer<typeof NodeFirstFrameSchema>;

/** What a Node may send while the Host is still waiting for its proof. */
export const NodeHandshakeFrameSchema = NodeProofSchema;

/** What a Node accepts from a Host it has not finished authenticating. */
export const HostHandshakeFrameSchema = z.discriminatedUnion("type", [
  HostChallengeSchema,
  AuthenticatedEnvelopeSchema,
]);
export type HostHandshakeFrame = z.infer<typeof HostHandshakeFrameSchema>;

/** Updating a busy Node is a deliberate act, so stopping its work is opt-in. */
export const UpdateNodeSchema = z.object({
  stopSessions: z.boolean().default(false),
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
  localPath: z.string().min(1).max(4096).optional(),
  /**
   * Moves the placement to a different workspace.
   *
   * The node and the path stay put: what changes is which project this checkout
   * is filed under, which is the only part of a placement that is a filing
   * decision rather than a fact about a machine.
   */
  workspaceId: z.string().min(1).optional(),
});

/**
 * The order an operator arranged placements into, for one workspace.
 *
 * The whole list travels rather than one id and an index: a move is two edits,
 * and sending them separately leaves a moment where two rows claim one slot.
 */
export const ReorderSessionsSchema = z.object({
  sessionIds: z.array(z.string().min(1)).max(2000),
});

export const ReorderWorkspacesSchema = z.object({
  workspaceIds: z.array(z.string().min(1)).max(500),
});

export const ReorderPlacementsSchema = z.object({
  workspaceId: z.string().min(1),
  placementIds: z.array(z.string().min(1)).max(500),
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
  yolo: z.boolean().optional(),
  /** Re-attach a session its Node lost, without waiting to be asked. */
  autoResume: z.boolean().optional(),
  /**
   * What new sessions start on. Empty means "whatever Copilot picks".
   *
   * Raw Copilot values rather than a list of our own, because these have to go
   * back to it — and a model list maintained here would go stale the week after
   * it was written.
   */
  model: z.string().max(120).optional(),
  reasoningEffort: z.string().max(60).optional(),
});

export const PromptSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  attachments: z
    .array(PromptAttachmentSchema)
    .max(MAX_ATTACHMENTS_PER_PROMPT)
    .default([]),
});

export const PermissionResponseSchema = z.object({
  requestId: z.string().min(1),
  outcome: z.enum(["allow_once", "deny"]),
  optionId: z.string().optional(),
});

/** What a browser sends to move a session picker to a different value. */
export const SetSessionConfigSchema = z.object({
  configId: z.string().min(1).max(200),
  // Not `min(1)`: "" is how ACP names the default choice of a picker, such as
  // Copilot's `agent` option, so an operator selecting it is a real request.
  value: z.string().max(500),
});

export const tunnelProviders = [
  "cloudflare",
  "tailscale",
  "ngrok",
  "bore",
  "devtunnel",
] as const;
export const TunnelProviderSchema = z.enum(tunnelProviders);
export type TunnelProvider = z.infer<typeof TunnelProviderSchema>;

export const TunnelStatusSchema = z.enum(["off", "starting", "on", "stopping", "error"]);
export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

/**
 * Who can reach a provider's URL before Fleet has authenticated anybody.
 *
 * `creator-private` means the provider itself demands a sign-in — the URL alone
 * reaches nothing. `public` means the URL is the whole address: it lands on
 * Fleet's own sign-in page, which is a defence, but a thinner one.
 */
export const tunnelAccessKinds = ["creator-private", "public"] as const;
export const TunnelAccessSchema = z.enum(tunnelAccessKinds);
export type TunnelAccess = z.infer<typeof TunnelAccessSchema>;

/**
 * What a Host offers first when nobody has chosen.
 *
 * The private provider, because the first thing a fresh Host publishes is a
 * claim screen: an anonymous public URL would put that screen — and the race to
 * claim the Host — in front of anyone who found the address.
 */
export const DEFAULT_TUNNEL_PROVIDER: TunnelProvider = "devtunnel";

export const TunnelProviderInfoSchema = z.object({
  id: TunnelProviderSchema,
  label: z.string().min(1),
  binary: z.string().min(1),
  binaryPresent: z.boolean(),
  installHint: z.string(),
  /** Ordered setup steps for this provider's help dialog. */
  setupSteps: z.array(z.string()).default([]),
  /** Upstream documentation link. */
  docsUrl: z.string().optional(),
  caveat: z.string().optional(),
  /** The scheme this provider publishes externally. */
  externalScheme: z.enum(["http", "https"]).default("https"),
  access: TunnelAccessSchema.default("public"),
  /**
   * Whether the operator console may be exposed through this provider at all.
   *
   * False for a plain-TCP relay: the Fleet session cookie and every transcript
   * it fetches would cross it in clear text, so the Host refuses to issue a
   * session there and refuses to start it for that purpose.
   */
  controlPlaneEligible: z.boolean().default(true),
});
export type TunnelProviderInfo = z.infer<typeof TunnelProviderInfoSchema>;

/**
 * Live state of one provider.
 *
 * Providers run independently — a fixed Cloudflare hostname and a private Dev
 * Tunnel are useful at the same time, for different audiences — so each one
 * carries its own switch, status and URL rather than the UI inferring them from
 * a single "current provider".
 */
export const TunnelStateSchema = z.object({
  provider: TunnelProviderSchema,
  enabled: z.boolean(),
  status: TunnelStatusSchema,
  /** Absent until the provider reports one. */
  url: z.string().optional(),
  /** Traffic inspector for this tunnel, for providers that publish one. */
  inspectUrl: z.string().optional(),
  error: z.string().nullable(),
  tunnelId: z.string().optional(),
  /** True when this provider runs as its own process outside the Host. */
  external: z.boolean().default(false),
});
export type TunnelState = z.infer<typeof TunnelStateSchema>;

export const TunnelInfoSchema = z.object({
  /** Whose URL enrollment currently advertises; null when none is online. */
  primary: TunnelProviderSchema.nullable(),
  /** What enrollment would hand a node right now, including fallbacks. */
  publicUrl: z.string().min(1),
  /** Every supported provider plus whether its CLI is installed. */
  providers: z.array(TunnelProviderInfoSchema),
  /** Live state for every provider, whether enabled or not. */
  tunnels: z.array(TunnelStateSchema),
  /**
   * Provider-side identifier for the primary tunnel, when it has one that the
   * public URL does not encode. Dev Tunnels needs this: the URL subdomain is an
   * opaque routing token, so `devtunnel connect` cannot be derived from it.
   */
  tunnelId: z.string().optional(),
});
export type TunnelInfo = z.infer<typeof TunnelInfoSchema>;

export const UpdateTunnelSchema = z.object({
  enabled: z.boolean(),
  /** Which provider to switch; omitted means the current primary. */
  provider: TunnelProviderSchema.optional(),
  /** Make this provider the one enrollment advertises. */
  primary: z.boolean().optional(),
});

/**
 * Versioned archives for moving a Host or a Node to another machine.
 *
 * Two kinds on purpose: the Host never sees a Node's plaintext secret, and a
 * Node has no business ingesting another fleet's catalog. The `kind` field is
 * what lets each side refuse the other's file with a useful error.
 */
export const HOST_BACKUP_KIND = "copilot-fleet-host" as const;
export const NODE_BACKUP_KIND = "copilot-fleet-node" as const;
export const BACKUP_VERSION = 1 as const;

/**
 * A shared-secret Node must arrive with the secret's digest and nothing else
 * will do.
 *
 * Restoring a legacy row with an empty hash produces a Node that cannot
 * authenticate by either protocol: the gateway refuses an empty stored hash on
 * purpose, so it would be a machine silently dropped out of the fleet by a
 * move that reported success.
 */
function requireSecretHashUnlessKeyed(
  value: { authProtocol: NodeAuthProtocol; secretHash: string },
  context: z.RefinementCtx,
): void {
  if (value.authProtocol === MUTUAL_AUTH_PROTOCOL) return;
  if (/^[a-f0-9]{64}$/.test(value.secretHash)) return;
  context.addIssue({
    code: "custom",
    path: ["secretHash"],
    message:
      "A Node that authenticates with a shared secret needs the SHA-256 digest of it.",
  });
}

/**
 * A Node row, plus the proof that lets it back in.
 *
 * An empty hash is meaningful rather than merely permitted: it says this
 * machine proves itself with a key instead. On a legacy row it would restore a
 * Node nothing can authenticate — a machine the operator has to re-enrol
 * without ever being told why — so the two are checked against each other.
 */
export const HostBackupNodeSchema = NodeSchema.extend({
  /**
   * SHA-256 hex of the Node secret; enough to authenticate, never to impersonate.
   *
   * Empty for a Node that authenticates with a key pair instead. The public key
   * is not here: a version 1 archive has no security envelope to put it in, so
   * a key-based Node is restored by the portable format or re-enrolled.
   */
  secretHash: z.string().regex(/^([a-f0-9]{64})?$/),
}).superRefine(requireSecretHashUnlessKeyed);
export type HostBackupNode = z.infer<typeof HostBackupNodeSchema>;

export const HostBackupWorkspaceSchema = WorkspaceSchema.extend({
  position: z.number().int(),
});
export type HostBackupWorkspace = z.infer<typeof HostBackupWorkspaceSchema>;

export const HostBackupPlacementSchema = PlacementSchema.extend({
  position: z.number().int(),
});
export type HostBackupPlacement = z.infer<typeof HostBackupPlacementSchema>;

export const HostBackupSessionSchema = SessionSchema.extend({
  position: z.number().int(),
});
export type HostBackupSession = z.infer<typeof HostBackupSessionSchema>;

/**
 * Everything a Host archive carries that is not its format version.
 *
 * Shared rather than extended so that the two versions are two literals over
 * one shape: a field added to a data archive cannot be left out of a portable
 * one, and neither schema can drift into accepting the other's version.
 */
const hostBackupDataShape = {
  kind: z.literal(HOST_BACKUP_KIND),
  exportedAt: z.string().datetime(),
  /**
   * Empty on a Host that never had one.
   *
   * The fleet-wide token is a migration artefact: a grant-only install has
   * nothing for it to do, and requiring one here would make the default
   * install the single configuration that cannot be archived. Older files
   * still carry a real value, which is why this is defaulted rather than
   * dropped.
   */
  enrollmentToken: z.string().max(1_000).default(""),
  /** Omitted when the live URL would not survive a move (loopback / quick tunnel). */
  publicUrl: z.string().url().optional(),
  tunnel: z.object({
    enabled: z.boolean(),
    provider: TunnelProviderSchema,
  }),
  defaults: z.object({
    yolo: z.boolean(),
    autoResume: z.boolean(),
  }),
  nodes: z.array(HostBackupNodeSchema),
  workspaces: z.array(HostBackupWorkspaceSchema),
  placements: z.array(HostBackupPlacementSchema),
  sessions: z.array(HostBackupSessionSchema),
  events: z.array(SessionEventSchema),
  /**
   * Defaulted, or every archive written before orchestration existed stops
   * importing — the one failure mode a backup format may not have.
   */
  runs: z.array(RunSchema).default([]),
  runSteps: z.array(RunStepSchema).default([]),
  /**
   * A task's notes are the orchestrator's own record of it — what a phase
   * concluded, what it handed over. Dropping them on a move would leave a live
   * task with its steps intact and no memory of why they were run.
   */
  runNotes: z.array(RunNoteSchema).default([]),
} as const;

export const HostBackupSchema = z.object({
  ...hostBackupDataShape,
  version: z.literal(BACKUP_VERSION),
});
export type HostBackup = z.infer<typeof HostBackupSchema>;

/** A Host archive's contents, with nothing said about which version wrote it. */
export type HostBackupData = Omit<HostBackup, "kind" | "version">;

/**
 * The portable archive: the same data, plus the Host's authority under a key
 * nobody has unless they were given the passphrase.
 */
export const PORTABLE_BACKUP_VERSION = 2 as const;

/** The envelope layout, so a later one can be told apart rather than guessed. */
export const SECURITY_ENVELOPE_FORMAT = 1 as const;

/**
 * The work factor this Host writes, and the floor it will read.
 *
 * A file names the parameters its key was derived with, which is also a way to
 * ask for cheap ones; the floor is what keeps an archive from choosing how
 * hard it is to attack.
 */
export const MIN_SECURITY_ENVELOPE_SCRYPT_N = 32_768;

/**
 * A bound on the sealed section, which holds keys and identities rather than
 * transcripts. An archive is parsed before anybody has authenticated, so the
 * parse itself must not be a way to spend the Host's memory.
 */
export const MAX_SECURITY_ENVELOPE_BYTES = 1_000_000;

export const SecurityEnvelopeKdfSchema = z.object({
  algorithm: z.literal("scrypt"),
  version: z.literal(1),
  N: z.literal(MIN_SECURITY_ENVELOPE_SCRYPT_N),
  r: z.literal(8),
  p: z.literal(1),
  keyLength: z.literal(32),
});
export type SecurityEnvelopeKdf = z.infer<typeof SecurityEnvelopeKdfSchema>;

export const SecurityEnvelopeSchema = z.object({
  format: z.literal(SECURITY_ENVELOPE_FORMAT),
  cipher: z.literal("aes-256-gcm"),
  kdf: SecurityEnvelopeKdfSchema,
  /** Base64, and random per export: one passphrase must not derive one key. */
  salt: z.string().min(1).max(128),
  nonce: z.string().min(1).max(128),
  authTag: z.string().min(1).max(128),
  ciphertext: z.string().min(1).max(MAX_SECURITY_ENVELOPE_BYTES),
});
export type SecurityEnvelope = z.infer<typeof SecurityEnvelopeSchema>;

export const SecurityBackupAdministratorSchema = z.object({
  id: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  objectId: z.string().min(1).max(200),
  username: z.string().max(320).default(""),
  displayName: z.string().max(320).default(""),
  addedVia: z.string().max(40).default(""),
  addedByAdminId: z.string().max(200).default(""),
  createdAt: z.string().max(64).default(""),
  lastLoginAt: z.string().max(64).default(""),
  disabledAt: z.string().max(64).default(""),
});
export type SecurityBackupAdministrator = z.infer<
  typeof SecurityBackupAdministratorSchema
>;

/**
 * What a Node authenticates with, named rather than assumed.
 *
 * Nodes hold a shared secret today and will hold a key pair; recording which
 * protocol a row is for means the archive that moves a fleet before that
 * change can still be read by the Host that comes after it — and means an
 * empty hash can be held to meaning "this one has a key" rather than "this one
 * has nothing".
 */
export const SecurityBackupNodeAuthSchema = z
  .object({
    nodeId: z.string().min(1).max(200),
    authProtocol: NodeAuthProtocolSchema.default("legacy-secret"),
    secretHash: z.string().max(200).default(""),
    publicKey: z.string().max(1_000).default(""),
  })
  .superRefine(requireSecretHashUnlessKeyed);
export type SecurityBackupNodeAuth = z.infer<typeof SecurityBackupNodeAuthSchema>;

export const SecurityBackupHostIdentitySchema = z.object({
  id: z.string().max(200).default(""),
  privateKey: z.string().max(4_000).default(""),
  publicKey: z.string().max(4_000).default(""),
  fingerprint: z.string().max(200).default(""),
});

/**
 * The sealed contents: who owns a Host, and every key it proves things with.
 *
 * There is deliberately nowhere in here for an operator session, an admin
 * invitation, an enrollment grant, or a half-finished login. They belong to
 * the machine that issued them, and a format with no field for them cannot
 * resurrect one on another machine by accident.
 */
export const SecurityBackupPayloadSchema = z.object({
  version: z.literal(1),
  /**
   * Legacy only, and empty on a Host that enrols with one-time grants.
   *
   * A fleet that has retired the shared Node secret has no fleet-wide token to
   * carry, and an archive that insisted on one would make the grant-only
   * install unbackupable.
   */
  enrollmentToken: z.string().max(1_000).default(""),
  auth: z.object({
    mode: z.string().max(40).default(""),
    passwordEnabled: z.boolean(),
    passwordExplicitlyEnabled: z.boolean().default(false),
    /** Only present while the migration password is still switched on. */
    passwordVerifier: z.string().max(500).default(""),
    passwordIsRecovery: z.boolean().default(false),
    entraTenantId: z.string().max(200).default(""),
    entraClientId: z.string().max(200).default(""),
    deviceFlowEnabled: z.boolean().default(false),
    csrfKey: z.string().min(1).max(200),
  }),
  /**
   * Whether the shared Node secret is over, which travels with the fleet.
   *
   * Enforcement is as much a part of who may talk to a Host as the
   * administrator table is: an archive that left it behind would restore a
   * fleet quietly accepting the credential its operator had retired. Defaulted
   * so an archive written before the field existed restores as unenforced,
   * which is what those fleets actually were.
   */
  node: z
    .object({ mutualAuthenticationRequired: z.boolean().default(false) })
    .default({ mutualAuthenticationRequired: false }),
  leadTokenKey: z.string().min(1).max(200),
  /** Absent until the Host has an identity key pair of its own to move. */
  hostIdentity: SecurityBackupHostIdentitySchema.optional(),
  administrators: z.array(SecurityBackupAdministratorSchema).max(100),
  nodeAuth: z.array(SecurityBackupNodeAuthSchema).max(1_000).default([]),
});
export type SecurityBackupPayload = z.infer<typeof SecurityBackupPayloadSchema>;

const {
  enrollmentToken: _portableEnrollmentToken,
  nodes: _portableNodes,
  ...portableBackupDataShape
} = hostBackupDataShape;

export const HostPortableBackupSchema = z
  .object({
    ...portableBackupDataShape,
    nodes: z.array(NodeSchema.strict()),
    version: z.literal(PORTABLE_BACKUP_VERSION),
    security: SecurityEnvelopeSchema,
  })
  .strict();
export type HostPortableBackup = z.infer<typeof HostPortableBackupSchema>;
export type HostPortableBackupData = Omit<
  HostPortableBackup,
  "kind" | "version" | "security"
>;

/**
 * The identity half of a Node archive, in either protocol.
 *
 * Mirrors what the Node writes to disk: a machine restored from an archive has
 * to come back as the same Node, and a key-based one whose private half was
 * dropped in transit would come back as a stranger.
 *
 * The discriminator is defaulted before the union sees it, because an archive
 * exported before Node keys existed has no `authProtocol` and every one of them
 * is by construction a shared-secret machine — refusing those would break the
 * import path for exactly the fleet the migration is for.
 */
export const NodeBackupCredentialsSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !("authProtocol" in value)
      ? { ...(value as Record<string, unknown>), authProtocol: "legacy-secret" }
      : value,
  z.discriminatedUnion("authProtocol", [
    z.object({
      hostUrl: z.string().url(),
      nodeId: z.string().min(1),
      name: z.string().min(1),
      authProtocol: z.literal("legacy-secret"),
      secret: z.string().min(1),
    }),
    z.object({
      hostUrl: z.string().url(),
      nodeId: z.string().min(1),
      name: z.string().min(1),
      authProtocol: z.literal(MUTUAL_AUTH_PROTOCOL),
      privateKey: z.string().min(1).max(4_000),
      publicKey: z.string().min(1).max(4_000),
      host: z.object({
        hostId: z.string().min(1).max(200),
        publicKey: z.string().min(1).max(4_000),
        fingerprint: sha256Hex,
      }),
    }),
  ]),
);
export type NodeBackupCredentials = z.infer<typeof NodeBackupCredentialsSchema>;

export const NodeBackupSettingsSchema = z.object({
  hostUrl: z.string().url(),
  nodeName: z.string().min(1).max(120),
  maxSessions: z.number().int().min(1).max(64),
  copilotCommand: z.string(),
  permissionTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  contextTier: z.enum(["default", "long_context"]).default("long_context"),
  knownHostUrls: z.array(z.string()).default([]),
});
export type NodeBackupSettings = z.infer<typeof NodeBackupSettingsSchema>;

export const NodeBackupSchema = z.object({
  kind: z.literal(NODE_BACKUP_KIND),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string().datetime(),
  credentials: NodeBackupCredentialsSchema,
  settings: NodeBackupSettingsSchema,
});
export type NodeBackup = z.infer<typeof NodeBackupSchema>;

/** Hostnames that are issued per process and die when that process does. */
export function isRotatingTunnelUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return (
    hostname.endsWith(".trycloudflare.com") ||
    hostname.endsWith(".ngrok-free.app") ||
    hostname.endsWith(".ngrok.io") ||
    hostname === "bore.pub" ||
    hostname.endsWith(".bore.pub")
  );
}

/**
 * Hostnames that answer a browser and only a browser.
 *
 * A Dev Tunnels URL is private by default: opening it prompts for a Microsoft
 * login. A Node sends neither a browser cookie nor an `X-Tunnel-Authorization`
 * header, so it cannot satisfy that prompt and cannot be told to try anywhere
 * else afterwards — it has just been moved somewhere it cannot reach the Host
 * from, which is the one failure that cannot be corrected remotely.
 *
 * Lives here rather than beside any one caller because it is a safety check in
 * three places at once — what the Host may announce, what a Node may adopt, and
 * which enrollment command the Connect card offers — and three copies of a rule
 * like that only have to disagree once.
 */
export function isLoginWalledTunnelUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === "devtunnels.ms" || hostname.endsWith(".devtunnels.ms");
}

/**
 * Live sessions cannot move with the Host process, so import parks them in
 * `offline` — the same landing a Host restart uses — and Resume can re-attach
 * once the original Node is back.
 */
export function sessionFieldsForHostImport(
  session: Pick<FleetSession, "state" | "currentActivity">,
): { state: SessionState; currentActivity: string } {
  if (terminalSessionStates.has(session.state) || session.state === "offline") {
    return { state: session.state, currentActivity: session.currentActivity };
  }
  return { state: "offline", currentActivity: "Imported onto this Host" };
}

/** Reads `kind` off an unknown JSON value so a mismatched file can be named. */
export function backupKind(
  value: unknown,
): typeof HOST_BACKUP_KIND | typeof NODE_BACKUP_KIND | undefined {
  if (!value || typeof value !== "object" || !("kind" in value)) return undefined;
  const kind = (value as { kind: unknown }).kind;
  if (kind === HOST_BACKUP_KIND || kind === NODE_BACKUP_KIND) return kind;
  return undefined;
}

/**
 * Reads the format version off an unknown archive.
 *
 * Read before anything is applied, because the endpoint that restores data is
 * not the endpoint that may change who owns a Host: a portable archive posted
 * to the data restore has to be named rather than merely rejected as
 * malformed, or the operator is told their file is corrupt when it is not.
 */
export function backupFormatVersion(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("version" in value)) return undefined;
  const version = (value as { version: unknown }).version;
  return typeof version === "number" && Number.isInteger(version) ? version : undefined;
}

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
  // Running is the reconnect landing state for a session whose turn never
  // stopped: the socket dropped, not the agent, and the Node says so.
  offline: new Set(["stopped", "failed", "idle", "starting", "running"]),
  stopped: new Set(["starting"]),
  completed: new Set(["starting"]),
  failed: new Set(["starting"]),
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || transitions[from].has(to);
}

const runTransitions: Record<RunState, ReadonlySet<RunState>> = {
  /*
   * Approval is the entrance, not a mid-course gate: a human authorises the
   * objective and its budget once, and the Lead spends that budget without
   * asking again. `running` is reachable directly for the handwritten-DAG
   * fixture, which has no Lead and therefore nothing to plan — its plan
   * arrived over REST.
   */
  awaiting_approval: new Set(["planning", "running", "failed", "cancelled"]),
  planning: new Set(["running", "failed", "cancelled"]),
  running: new Set([
    "awaiting_lead",
    "awaiting_human",
    "aggregating",
    "completed",
    "failed",
    "cancelled",
  ]),
  awaiting_lead: new Set([
    "running",
    "awaiting_human",
    "aggregating",
    "completed",
    "failed",
    "cancelled",
  ]),
  /*
   * A person can send a task back, which is why this is not terminal: rejecting
   * returns it to `running` with the reviewer's note, and the orchestrator
   * carries on from the phase it was in.
   */
  awaiting_human: new Set(["running", "completed", "failed", "cancelled"]),
  aggregating: new Set(["completed", "failed", "cancelled"]),
  /*
   * Finished, but not sealed.
   *
   * A person can reopen a task they had called done — because it turned out not
   * to be, or because the next thing to do belongs with it rather than in a new
   * task that would start with none of its history. Only back to `running`:
   * reopening means "carry on", and every other route in is a fresh task.
   */
  completed: new Set(["running"]),
  failed: new Set(["running"]),
  cancelled: new Set(["running"]),
};

const runStepTransitions: Record<RunStepState, ReadonlySet<RunStepState>> = {
  // A pending retry can fail while re-attaching its existing session, before a
  // prompt starts. That is a real attempt failure, not a skipped dependency.
  pending: new Set(["starting", "failed", "skipped", "cancelled"]),
  // Back to pending when the command never left, failed when the Node was lost
  // before it answered. Both are reachable only from here, which is the point
  // of naming the window at all.
  starting: new Set(["running", "pending", "failed", "cancelled"]),
  running: new Set(["succeeded", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return from === to || runTransitions[from].has(to);
}

export function canTransitionRunStep(from: RunStepState, to: RunStepState): boolean {
  return from === to || runStepTransitions[from].has(to);
}

/** Runs the engine will no longer advance on its own. */
export const terminalRunStates = new Set<RunState>(["completed", "failed", "cancelled"]);

/** Steps that are done deciding; a late event about one is noise. */
export const terminalRunStepStates = new Set<RunStepState>([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

/**
 * Categories that write to the checkout.
 *
 * The parallel limit is scoped to these because the race is over files, not
 * over the run: a read-only reviewer sharing a checkout with its implementer
 * is not a hazard, it is the only way it can see the diff at all.
 */
export function isWritingCategory(category: string): boolean {
  return category === "implement" || category === "test";
}

/**
 * States a session can be re-attached from: it is no longer running here, but
 * nothing has ruled out picking it back up.
 */
const resumableStates = new Set<SessionState>([...terminalSessionStates, "offline"]);

/**
 * Whether **Resume** can bring this session back.
 *
 * The Host settles a session as `failed` when a Node reconnects without it —
 * which is what a Node reboot looks like — but Copilot keeps the conversation on
 * disk, so `session/load` re-attaches it and the transcript continues. Such a
 * session is dormant, not lost, and callers use this to avoid treating the two
 * the same: one is worth showing and keeping, the other is only worth clearing.
 */
export function isResumableSession(
  session: Pick<FleetSession, "state" | "agentSessionId">,
): boolean {
  return Boolean(session.agentSessionId) && resumableStates.has(session.state);
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

/*
 * How a Node authenticates an ordinary HTTP call to the Host.
 *
 * The Node's config page cannot reach the Host from the browser — different
 * origin, no CORS — so the Node process relays those calls, and the relay needs
 * a credential now that the Host's API is not open. The secret it already has
 * is that credential; these header names are where both ends agree to put it.
 */
export const NODE_ID_HEADER = "x-fleet-node-id";
export const NODE_SECRET_HEADER = "x-fleet-node-secret";

/*
 * The same question, answered by a Node that has a key pair instead.
 *
 * A shared secret answers "who is calling" by handing the answer over on every
 * request, so anything that sees one call can make every other. These carry a
 * signature over just the call being made — the method, the exact path, the
 * body, and a timestamp and nonce that keep it from being made twice.
 */
export const NODE_PROOF_TIMESTAMP_HEADER = "x-fleet-node-timestamp";
export const NODE_PROOF_NONCE_HEADER = "x-fleet-node-nonce";
export const NODE_PROOF_SIGNATURE_HEADER = "x-fleet-node-signature";

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
