import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type { McpHttpServer, PromptAttachment, SessionEvent } from "@fleet/protocol";
import { attachmentSummary } from "@fleet/protocol";
import {
  configValueFor,
  toSessionCommands,
  toSessionConfigOptions,
} from "./acp-config.js";
import { toPromptBlocks } from "./prompt-content.js";

export type PermissionDecision = {
  outcome: "allow_once" | "deny";
  optionId?: string;
};

/**
 * Which context window Copilot is launched with.
 *
 * Mirrors the choices `copilot --context` accepts; kept in step with the enum
 * in settings.ts, which is what the config page writes.
 */
export type ContextTier = "default" | "long_context";

/**
 * The permissions picker, whose value the Host already knows.
 *
 * Named here because it is the lever {@link configRecoveryRequest} pulls to get
 * the option list back on a resumed session.
 */
const ALLOW_ALL_OPTION = "allow_all";

/**
 * How long work nobody asked for may go quiet before it is called finished.
 *
 * Copilot starts turns of its own — a backgrounded shell finishing is the usual
 * trigger — and nothing announces one in either direction: the stop reason
 * comes back on a `session/prompt` this side never made. Silence is therefore
 * the only end-of-turn signal there is, and the window has to clear the longest
 * ordinary gap *inside* a turn, or a session would flap between running and
 * idle and chime on every lap.
 */
export const UNPROMPTED_QUIET_MS = 45_000;

/**
 * How much longer an unfinished tool call may hold such a turn open.
 *
 * A tool call reports when it starts and when it ends and says nothing in
 * between, so a long one is silence that means the opposite of finished. It is
 * still only evidence: an ending that never arrives would pin the session as
 * running for good and lock the composer over an agent doing nothing, so the
 * benefit of the doubt is bounded rather than open.
 */
export const UNPROMPTED_TOOL_GRACE_MS = 10 * 60_000;

/**
 * What to set, if anything, to get a session's pickers back.
 *
 * `session/new` reports the option list and `session/load` does not, so a
 * resumed session has no idea what its own model or mode is: no notification
 * follows the load, and there is no method to ask. The Host papers over that by
 * keeping the last list it was told, which works until a session has never had
 * one — and one machine in this fleet produces exactly that from a *fresh*
 * session too, on the same Copilot build and the same fleet build as its
 * neighbours that are fine. Whatever the cause there, the result is identical
 * and permanent: every later resume is a load, so the composer stays bare with
 * no control on it to press and nothing to say why.
 *
 * `session/set_config_option` answers with the whole list, so setting one
 * breaks the deadlock. `allow_all` is the only option whose correct value is
 * known without having read that list first: the Host decides it per session
 * and the process was launched moments earlier with the matching `--allow-all`.
 * Re-asserting it therefore changes nothing about the session and makes the
 * pickers agree with what is already true of it.
 */
export function configRecoveryRequest(
  options: readonly acp.SessionConfigOption[],
  yolo: boolean,
): { configId: string; value: string } | undefined {
  // Anything already in hand came from the agent itself and is better than
  // anything that could be asked for here.
  if (options.length > 0) return undefined;
  return { configId: ALLOW_ALL_OPTION, value: yolo ? "on" : "off" };
}

export interface SessionAgent {
  prompt(text: string, attachments?: readonly PromptAttachment[]): Promise<void>;
  cancel(): Promise<void>;
  stop(): Promise<void>;
  resolvePermission(requestId: string, decision: PermissionDecision): void;
  denyPendingPermissions(): void;
  /** Changes a session picker (model, mode, reasoning effort) by option id. */
  setConfigOption(configId: string, value: string): Promise<void>;
  /** True while a turn is in flight, so a second prompt cannot be accepted. */
  readonly busy: boolean;
  /**
   * Re-announces the state this agent is actually in.
   *
   * The Host has to guess when a socket drops mid-turn, and a wrong guess is
   * only correctable by the side that knows — nothing else here observes the
   * agent, so without this the guess stands until the turn happens to end.
   */
  resync(): void;
}

export type EventSink = (event: SessionEvent) => void;

export type StartAgentOptions = {
  /** Copilot session id to re-attach to via ACP `session/load`. */
  resumeAgentSessionId?: string;
  /** First event sequence number to use, so resumed runs keep ordering. */
  sequenceOffset?: number;
  /** Launch Copilot with --allow-all. The Host owns this decision. */
  yolo?: boolean;
  /**
   * MCP servers to hand this session, supplied on both `session/new` and
   * `session/load`. Empty for every ordinary session.
   */
  mcpServers?: readonly McpHttpServer[];
};

export interface AgentFactory {
  start(
    sessionId: string,
    cwd: string,
    sink: EventSink,
    options?: StartAgentOptions,
  ): Promise<SessionAgent>;
}

abstract class SequencedAgent {
  private sequence = 0;
  private terminal = false;

  constructor(
    protected readonly fleetSessionId: string,
    protected readonly sink: EventSink,
    sequenceOffset = 0,
  ) {
    this.sequence = sequenceOffset;
  }

  protected emit(type: SessionEvent["type"], payload: Record<string, unknown>): void {
    if (
      type === "state" &&
      typeof payload.state === "string" &&
      ["failed", "completed", "stopped"].includes(payload.state)
    ) {
      this.terminal = true;
    }
    this.sink({
      eventId: randomUUID(),
      sessionId: this.fleetSessionId,
      sequence: ++this.sequence,
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  protected get hasTerminated(): boolean {
    return this.terminal;
  }
}

export type UnpromptedTurnOptions = {
  quietMs?: number;
  toolGraceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

/**
 * Notices Copilot working on a turn this node never asked for, so the fleet can
 * still say so.
 *
 * Session state used to be read off the `session/prompt` request alone, which
 * describes what the fleet asked for rather than what the agent is doing. The
 * two part company whenever Copilot picks its own work back up — most often
 * when a backgrounded shell finishes and wakes it — and the fleet reported
 * `idle` throughout, and meant it: the composer stood open over an agent
 * mid-turn, Cancel was disabled for the whole of it, and the chime that says a
 * session has finished had already sounded, sometimes a quarter of an hour
 * early.
 *
 * Nothing here can ask when such a turn ends, so it is inferred from the stream
 * going quiet. That is a guess, and it is made deliberately late: being slow to
 * call a turn finished costs a locked composer for a moment, while being quick
 * about it costs a false chime and a session that flickers.
 */
export class UnpromptedTurn {
  private started = false;
  private lastSeen = 0;
  private timer: unknown;
  /** Tool calls that have reported a start but not an end. */
  private readonly openTools = new Set<string>();
  private readonly quietMs: number;
  private readonly toolGraceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(
    private readonly onStart: () => void,
    private readonly onSettle: () => void,
    options: UnpromptedTurnOptions = {},
  ) {
    this.quietMs = options.quietMs ?? UNPROMPTED_QUIET_MS;
    this.toolGraceMs = options.toolGraceMs ?? UNPROMPTED_TOOL_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        // A node waiting out a quiet window must still be able to exit.
        timer.unref();
        return timer;
      });
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  /** True while the agent is working on something nobody here prompted. */
  get active(): boolean {
    return this.started;
  }

  /**
   * Records one update from an agent that was not prompted by this node.
   *
   * `tool` names the call the update concerns, when it names one at all: an
   * update carrying only content leaves the outstanding calls alone, because
   * output arriving for a call that has already finished must not reopen it and
   * hold the turn open behind it.
   */
  note(tool?: { id: string; done: boolean }): void {
    if (tool) {
      if (tool.done) this.openTools.delete(tool.id);
      else this.openTools.add(tool.id);
    }
    this.lastSeen = this.now();
    if (!this.started) {
      this.started = true;
      this.onStart();
    }
    this.arm();
  }

  /** Calls the turn finished now and announces it. */
  settle(): void {
    if (!this.started) return;
    this.reset();
    this.onSettle();
  }

  /** Stands down without announcing anything: something else owns the state. */
  clear(): void {
    this.reset();
  }

  private reset(): void {
    this.clearTimer(this.timer);
    this.timer = undefined;
    this.openTools.clear();
    this.started = false;
  }

  private arm(): void {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.check(), this.quietMs);
  }

  private check(): void {
    if (!this.started) return;
    // An unfinished tool call is an agent working with nothing to say about it,
    // so the silence belongs to the tool rather than to the turn — up to the
    // point where a call that is never coming back would own the session.
    if (this.openTools.size > 0 && this.now() - this.lastSeen < this.toolGraceMs) {
      this.timer = this.setTimer(() => this.check(), this.quietMs);
      return;
    }
    this.settle();
  }
}

/**
 * Which tool call an update starts or finishes, when it says.
 *
 * Only a status settles that. Content updates arrive under the same call id
 * with no status at all, and reading one as a fresh start would resurrect a
 * call that had already reported its end.
 */
export function toolProgress(
  update: acp.SessionUpdate,
): { id: string; done: boolean } | undefined {
  if (update.sessionUpdate === "tool_call") {
    return { id: update.toolCallId, done: isFinishedTool(update.status) };
  }
  if (update.sessionUpdate === "tool_call_update" && update.status) {
    return { id: update.toolCallId, done: isFinishedTool(update.status) };
  }
  return undefined;
}

function isFinishedTool(status: acp.ToolCallStatus | undefined): boolean {
  return status === "completed" || status === "failed";
}

type PendingPermission = {
  options: acp.PermissionOption[];
  resolve: (value: acp.RequestPermissionResponse) => void;
  timer: NodeJS.Timeout;
};

class AcpAgent extends SequencedAgent implements SessionAgent {
  private readonly pending = new Map<string, PendingPermission>();
  private agentSessionId: string | undefined;
  private connection: acp.ClientConnection | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private prompting = false;
  private stopping = false;
  /** `session/load` replays the whole history; the host already stored it. */
  private replaying = false;
  /**
   * The agent's own option list, kept as ACP sent it.
   *
   * `set_config_option` is a union whose branch depends on the option's type,
   * and the flattened copy the fleet passes around cannot tell a boolean from a
   * two-value select — so the raw list is what types an outgoing change.
   */
  private configOptions: acp.SessionConfigOption[] = [];
  /**
   * The turn Copilot started for itself, if it is in one.
   *
   * Its two ends are the whole point: `running` the moment work appears that no
   * prompt here accounts for, and `idle` once it stops — which is what the
   * composer, the Cancel button and the finished chime are all read off.
   */
  private readonly unprompted = new UnpromptedTurn(
    () =>
      this.emit("state", {
        state: "running",
        activity: "Copilot picked up work on its own",
      }),
    () => {
      // A process that has already ended has emitted the state that settles it,
      // and a queued timer must not walk that backwards.
      if (this.stopping || this.hasTerminated) return;
      this.emit("state", { state: "idle", activity: "Ready for follow-up" });
    },
  );

  constructor(
    fleetSessionId: string,
    sink: EventSink,
    private readonly permissionTimeoutMs: number,
    sequenceOffset = 0,
    private readonly yolo = false,
    private readonly copilotCommand = "",
    private readonly contextTier: ContextTier | undefined = undefined,
    private readonly mcpServerConfigs: readonly McpHttpServer[] = [],
  ) {
    super(fleetSessionId, sink, sequenceOffset);
  }

  /**
   * ACP's own MCP shape, built from the Host's.
   *
   * Kept as a method rather than a stored array because both `session/new` and
   * `session/load` need it, and a resumed session that skipped it would come
   * back with no tools at all.
   */
  private mcpServers(): acp.McpServer[] {
    return this.mcpServerConfigs.map((server) => ({
      type: "http" as const,
      name: server.name,
      url: server.url,
      headers: server.headers.map((header) => ({
        name: header.name,
        value: header.value,
      })),
    }));
  }

  async start(cwd: string, resumeAgentSessionId?: string): Promise<void> {
    this.emit("state", {
      state: "starting",
      activity: resumeAgentSessionId ? "Resuming Copilot ACP" : "Starting Copilot ACP",
    });
    const executable =
      this.copilotCommand || process.env.FLEET_COPILOT_COMMAND || "copilot";
    const args = copilotLaunchArgs(this.yolo, this.contextTier);
    // npm installs a CLI on Windows as a .cmd shim, which CreateProcess cannot
    // launch directly; the shell can, but then the path has to be quoted.
    const viaShell = process.platform === "win32";
    const command = viaShell && executable.includes(" ") ? `"${executable}"` : executable;
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: viaShell,
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) this.emit("system", { text });
    });
    child.on("error", (error) => {
      this.emit("error", { message: error.message });
      this.emit("state", { state: "failed", activity: "Copilot failed to start" });
      this.denyPendingPermissions();
    });
    child.on("exit", (code, signal) => {
      this.denyPendingPermissions();
      this.unprompted.clear();
      if (!this.stopping && !this.hasTerminated) {
        this.emit("state", {
          state: code === 0 ? "completed" : "failed",
          activity: `Copilot exited (${signal ?? code ?? "unknown"})`,
        });
      }
    });

    const app = acp
      .client({ name: "copilot-fleet-node" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        this.requestPermission(params),
      )
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        // Commands and pickers describe what the session can do now, not what
        // it did, so they are the one thing a replay must not swallow: a
        // resumed session would otherwise come back with an empty slash menu
        // and no model until the agent happened to change one.
        if (this.isCurrentStateUpdate(params.update)) {
          this.forwardUpdate(params.update);
          return;
        }
        if (this.replaying) return;
        this.watchUnpromptedWork(params.update);
        this.forwardUpdate(params.update);
      });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    this.connection = app.connect(stream);
    await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    });
    if (resumeAgentSessionId) {
      this.replaying = true;
      try {
        const loaded = await this.connection.agent.request(
          acp.methods.agent.session.load,
          {
            sessionId: resumeAgentSessionId,
            cwd,
            mcpServers: this.mcpServers(),
          },
        );
        this.captureConfigOptions(loaded.configOptions);
      } finally {
        this.replaying = false;
      }
      this.agentSessionId = resumeAgentSessionId;
      this.emit("state", { state: "idle", activity: "Resumed; ready for follow-up" });
    } else {
      const created = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: this.mcpServers(),
      });
      this.agentSessionId = created.sessionId;
      this.captureConfigOptions(created.configOptions);
    }
    // Both paths, because both can arrive without pickers: `session/load` never
    // reports them, and `session/new` has been seen not to on at least one
    // machine in this fleet — same Copilot build, same fleet build, same agent
    // otherwise working, and a composer with nothing on it.
    await this.recoverConfigOptions();
    this.emit("agent_session", { agentSessionId: this.agentSessionId });
  }

  /** Gets the pickers back when a start — of either kind — brought none. */
  private async recoverConfigOptions(): Promise<void> {
    const request = configRecoveryRequest(this.configOptions, this.yolo);
    if (!request) return;
    try {
      await this.setConfigOption(request.configId, request.value);
    } catch {
      // An agent without this option is one that was never going to offer
      // pickers, and a resumed session is worth more than the pickers on it.
    }
  }

  /**
   * Records the pickers the agent offers and passes them on.
   *
   * `session/new` answers with them once and then only reports changes, so a
   * client that joined later has no way to ask again — the Host keeps the last
   * copy, and this is what feeds it.
   *
   * Replaying a loaded session suppresses ordinary updates because the Host
   * already stored that history, but the option list is current state rather
   * than history, and a resumed session that skipped it would show no model.
   */
  private captureConfigOptions(
    options: acp.SessionConfigOption[] | null | undefined,
  ): void {
    if (!options) return;
    this.configOptions = options;
    this.emit("config", { options: toSessionConfigOptions(options) });
  }

  async prompt(
    text: string,
    attachments: readonly PromptAttachment[] = [],
  ): Promise<void> {
    if (!this.agentSessionId || !this.connection) {
      throw new Error("ACP session is not initialized");
    }
    if (this.prompting) throw new Error("A prompt is already active");
    this.prompting = true;
    // The prompt owns the session's state from here, so whatever was inferred
    // from a turn Copilot started for itself stands down without a word.
    this.unprompted.clear();
    this.emit("state", { state: "running", activity: "Copilot is working" });
    // Only the file's name and size are recorded: the transcript is stored on
    // the Host and replayed to every browser watching, which a few megabytes of
    // base64 per prompt would turn into a liability.
    this.emit("system", {
      text: `User: ${text}`,
      ...(attachments.length > 0
        ? { attachments: attachments.map(attachmentSummary) }
        : {}),
    });
    try {
      const response = await this.connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: this.agentSessionId,
          prompt: toPromptBlocks(text, attachments),
        },
      );
      this.emit("turn_complete", { stopReason: response.stopReason });
      this.emit("state", { state: "idle", activity: "Ready for follow-up" });
    } catch (error) {
      this.emit("error", {
        message: error instanceof Error ? error.message : "ACP prompt failed",
      });
      this.emit("state", { state: "failed", activity: "ACP prompt failed" });
      await this.stop();
      throw error;
    } finally {
      this.prompting = false;
    }
  }

  get busy(): boolean {
    return this.prompting || this.unprompted.active;
  }

  /**
   * Restates where this agent is, for a Host that had to guess.
   *
   * Only meaningful while the agent is alive: a terminated one has already
   * emitted the state that settles it, and re-announcing over that would walk
   * a finished session backwards.
   */
  resync(): void {
    if (this.hasTerminated || this.stopping) return;
    this.emit(
      "state",
      this.busy
        ? { state: "running", activity: "Copilot is working" }
        : { state: "idle", activity: "Ready for follow-up" },
    );
  }

  async cancel(): Promise<void> {
    if (!this.agentSessionId || !this.connection) {
      throw new Error("ACP session is not initialized");
    }
    this.denyPendingPermissions();
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.agentSessionId,
    });
    // A turn nobody prompted has no response to carry a stop reason back, so
    // the cancel itself is the only end it will ever report.
    this.unprompted.settle();
  }

  /**
   * Switches a picker, and reports where it landed.
   *
   * The agent answers with the settled option list, which is emitted rather
   * than assumed: a request to select a model can change the reasoning levels
   * on offer too, and the caller only asked about one of them.
   */
  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.agentSessionId || !this.connection) {
      throw new Error("ACP session is not initialized");
    }
    const response = await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId: this.agentSessionId,
        configId,
        value: configValueFor(this.configOptions, configId, value),
      } as acp.SetSessionConfigOptionRequest,
    );
    this.captureConfigOptions(response.configOptions);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.unprompted.clear();
    this.denyPendingPermissions();
    this.connection?.close();
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    if (!this.hasTerminated) {
      this.emit("state", { state: "stopped", activity: "Process stopped" });
    }
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const item = this.pending.get(requestId);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(requestId);
    const option =
      (decision.optionId
        ? item.options.find((candidate) => candidate.optionId === decision.optionId)
        : undefined) ??
      item.options.find((candidate) =>
        decision.outcome === "allow_once"
          ? candidate.kind === "allow_once"
          : candidate.kind.startsWith("reject"),
      );
    item.resolve(
      option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
    this.emit("permission_result", { requestId, outcome: decision.outcome });
  }

  denyPendingPermissions(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.resolvePermission(requestId, { outcome: "deny" });
    }
  }

  private requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = randomUUID();
    this.emit("permission", {
      requestId,
      title: params.toolCall.title,
      toolCallId: params.toolCall.toolCallId,
      options: params.options.map(({ optionId, name, kind }) => ({
        optionId,
        name,
        kind,
      })),
    });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.resolvePermission(requestId, { outcome: "deny" }),
        this.permissionTimeoutMs,
      );
      this.pending.set(requestId, { options: params.options, resolve, timer });
    });
  }

  /** Updates that state what the session offers now, rather than what it did. */
  private isCurrentStateUpdate(update: acp.SessionUpdate): boolean {
    return (
      update.sessionUpdate === "available_commands_update" ||
      update.sessionUpdate === "config_option_update"
    );
  }

  /**
   * Reads work the fleet did not ask for off the update stream.
   *
   * Everything Copilot does arrives here, whether a `session/prompt` is in
   * flight or not, and the difference is invisible in the updates themselves —
   * so anything that turns up while this node is not prompting is a turn it
   * started for itself, and the session is running whether or not it was asked.
   */
  private watchUnpromptedWork(update: acp.SessionUpdate): void {
    if (this.prompting || this.stopping || this.hasTerminated) return;
    this.unprompted.note(toolProgress(update));
  }

  private forwardUpdate(update: acp.SessionUpdate): void {
    if (update.sessionUpdate === "available_commands_update") {
      this.emit("commands", { commands: toSessionCommands(update.availableCommands) });
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      this.captureConfigOptions(update.configOptions);
      return;
    }
    if (
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") &&
      update.content.type === "text"
    ) {
      this.emit(
        update.sessionUpdate === "agent_message_chunk" ? "agent_text" : "agent_thought",
        { text: update.content.text },
      );
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      this.emit("tool", {
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status,
        ...(update.kind ? { kind: update.kind } : {}),
        ...toolDetailPayload(update),
      });
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      this.emit("tool", {
        toolCallId: update.toolCallId,
        status: update.status,
        title: update.title,
        ...(update.kind ? { kind: update.kind } : {}),
        ...toolDetailPayload(update),
      });
      return;
    }
    this.emit("system", { update });
  }
}

export class AcpAgentFactory implements AgentFactory {
  /**
   * Whether this Copilot takes `--context`, asked once and remembered.
   *
   * A promise rather than a boolean so that sessions starting at the same
   * moment share one `copilot --help` instead of racing to run their own.
   * Cleared whenever the command changes, since the answer belongs to the
   * binary that was asked.
   */
  private contextTierSupport: Promise<boolean> | undefined;

  /** Values are injected: settings.ts is the only place that reads the env. */
  constructor(
    private permissionTimeoutMs: number,
    private copilotCommand: string,
    private contextTier: ContextTier = "long_context",
  ) {}

  /** Lets the local config UI retune the agent without a process restart. */
  configure(
    permissionTimeoutMs: number,
    copilotCommand: string,
    contextTier: ContextTier = this.contextTier,
  ): void {
    if (copilotCommand !== this.copilotCommand) this.contextTierSupport = undefined;
    this.permissionTimeoutMs = permissionTimeoutMs;
    this.copilotCommand = copilotCommand;
    this.contextTier = contextTier;
  }

  async start(
    sessionId: string,
    cwd: string,
    sink: EventSink,
    options: StartAgentOptions = {},
  ): Promise<SessionAgent> {
    const agent = new AcpAgent(
      sessionId,
      sink,
      this.permissionTimeoutMs,
      options.sequenceOffset ?? 0,
      options.yolo ?? false,
      this.copilotCommand,
      (await this.acceptsContextTier()) ? this.contextTier : undefined,
      options.mcpServers ?? [],
    );
    try {
      await agent.start(cwd, options.resumeAgentSessionId);
      return agent;
    } catch (error) {
      await agent.stop();
      throw error;
    }
  }

  private acceptsContextTier(): Promise<boolean> {
    this.contextTierSupport ??= copilotSupportsContextTier(
      this.copilotCommand || process.env.FLEET_COPILOT_COMMAND || "copilot",
    );
    return this.contextTierSupport;
  }
}

class MockAgent extends SequencedAgent implements SessionAgent {
  private cancelled = false;
  private stopped = false;
  private prompting = false;
  /** A small stand-in for what Copilot reports, so the UI has pickers to drive. */
  private readonly config = new Map<string, string>([
    ["model", "mock-fast"],
    ["mode", "agent"],
  ]);

  constructor(fleetSessionId: string, sink: EventSink, sequenceOffset = 0) {
    super(fleetSessionId, sink, sequenceOffset);
  }

  start(resumeAgentSessionId?: string): void {
    this.emit("state", {
      state: "starting",
      activity: resumeAgentSessionId ? "Resuming mock agent" : "Starting mock agent",
    });
    this.emit("agent_session", {
      agentSessionId: resumeAgentSessionId ?? `mock-${this.fleetSessionId}`,
    });
    this.emit("commands", {
      commands: [
        { name: "usage", description: "Display session usage metrics" },
        { name: "model", description: "Select AI model to use", hint: "model" },
        { name: "review", description: "Review changes", hint: "instructions" },
      ],
    });
    this.publishConfig();
    // A resumed session is never prompted by the router, so without this the
    // mock stayed in `starting` forever and Resume looked broken — the ACP
    // adapter settles on idle the same way once session/load returns.
    if (resumeAgentSessionId) {
      this.emit("state", { state: "idle", activity: "Resumed; ready for follow-up" });
    }
  }

  async prompt(
    text: string,
    attachments: readonly PromptAttachment[] = [],
  ): Promise<void> {
    if (this.stopped) throw new Error("Mock agent is stopped");
    if (this.prompting) throw new Error("A prompt is already active");
    this.prompting = true;
    this.cancelled = false;
    this.emit("state", { state: "running", activity: "Mock agent is streaming" });
    this.emit("system", {
      text: `User: ${text}`,
      ...(attachments.length > 0
        ? { attachments: attachments.map(attachmentSummary) }
        : {}),
    });
    try {
      for (const chunk of [
        `Mock response for "${text}": `,
        "stream one, ",
        "stream two.",
      ]) {
        await delay(25);
        if (this.cancelled) {
          this.emit("turn_complete", { stopReason: "cancelled" });
          this.emit("state", { state: "idle", activity: "Cancelled; ready" });
          return;
        }
        this.emit("agent_text", { text: chunk });
      }
      this.emit("turn_complete", { stopReason: "end_turn" });
      this.emit("state", { state: "idle", activity: "Ready for follow-up" });
    } finally {
      this.prompting = false;
    }
  }

  get busy(): boolean {
    return this.prompting;
  }

  resync(): void {
    if (this.hasTerminated || this.stopped) return;
    this.emit(
      "state",
      this.prompting
        ? { state: "running", activity: "Mock agent is streaming" }
        : { state: "idle", activity: "Ready for follow-up" },
    );
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (!this.hasTerminated) {
      this.emit("state", { state: "stopped", activity: "Mock process stopped" });
    }
  }

  resolvePermission(): void {}
  denyPendingPermissions(): void {}

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.config.has(configId)) throw new Error(`Unknown option '${configId}'`);
    this.config.set(configId, value);
    this.publishConfig();
  }

  private publishConfig(): void {
    this.emit("config", {
      options: [
        {
          id: "model",
          name: "Model",
          description: "Mock model selector",
          category: "model",
          currentValue: this.config.get("model"),
          choices: [
            { value: "mock-fast", name: "Mock Fast", description: "" },
            { value: "mock-deep", name: "Mock Deep", description: "" },
          ],
        },
        {
          id: "mode",
          name: "Mode",
          description: "Mock mode selector",
          category: "mode",
          currentValue: this.config.get("mode"),
          choices: [
            { value: "agent", name: "Agent", description: "" },
            { value: "plan", name: "Plan", description: "" },
          ],
        },
      ],
    });
  }
}

export class MockAgentFactory implements AgentFactory {
  async start(
    sessionId: string,
    _cwd: string,
    sink: EventSink,
    options: StartAgentOptions = {},
  ): Promise<SessionAgent> {
    const agent = new MockAgent(sessionId, sink, options.sequenceOffset ?? 0);
    agent.start(options.resumeAgentSessionId);
    return agent;
  }
}

/**
 * The one short input field a tool call is worth naming beside its title.
 *
 * A transcript reads as a list of steps, and "Run tests" says less than "Run
 * tests · npm test -w @fleet/host". The fields are allow-listed rather than
 * guessed at from whatever `rawInput` happens to hold: a tool's raw input also
 * carries the *contents* it is about to write, which would put a whole file on
 * one line of a transcript that is stored on the Host and replayed to every
 * browser watching. A path from `locations` is the fallback, since a file tool
 * that named nothing else still says which file.
 */
const DETAIL_FIELDS = [
  "command",
  "cmd",
  "path",
  "filePath",
  "file",
  "url",
  "pattern",
  "query",
] as const;

/** How much of a detail is worth carrying; the rest is ellipsis on one line. */
const DETAIL_MAX_LENGTH = 200;

export function toolDetail(update: {
  rawInput?: unknown;
  locations?: readonly { path?: string }[] | null;
}): string | undefined {
  const input =
    update.rawInput && typeof update.rawInput === "object"
      ? (update.rawInput as Record<string, unknown>)
      : undefined;
  const named = input
    ? DETAIL_FIELDS.map((field) => input[field]).find(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
    : undefined;
  const raw =
    typeof named === "string" ? named : (update.locations?.[0]?.path ?? undefined);
  if (!raw) return undefined;
  // Newlines and runs of spaces are what a heredoc or a wrapped shell command
  // arrives as; on a single-line row they would each be rendered as one space
  // anyway, so they are collapsed before the length is judged.
  const flattened = raw.replace(/\s+/g, " ").trim();
  if (!flattened) return undefined;
  return flattened.length > DETAIL_MAX_LENGTH
    ? `${flattened.slice(0, DETAIL_MAX_LENGTH)}…`
    : flattened;
}

/** `{ detail }` when there is one, so an update never blanks an earlier one. */
function toolDetailPayload(update: {
  rawInput?: unknown;
  locations?: readonly { path?: string }[] | null;
}): { detail?: string } {
  const detail = toolDetail(update);
  return detail ? { detail } : {};
}

/**
 * Copilot's --allow-all / --yolo: tools, paths, and URLs all run without
 * prompts. The Host decides this per session, so the node no longer reads the
 * environment and one machine cannot silently diverge from what the UI shows.
 *
 * The context tier is passed for the same reason, and is passed even when it is
 * "default": Copilot keeps a tier of its own in ~/.copilot/settings.json, and
 * omitting the flag would let that file decide, which is exactly the silent
 * per-machine divergence this argument list exists to prevent. Omitted only
 * when the installed Copilot is too old to accept it — see
 * {@link copilotSupportsContextTier}.
 */
export function copilotLaunchArgs(yolo: boolean, contextTier?: ContextTier): string[] {
  const args = ["--acp", "--stdio"];
  if (yolo) args.push("--allow-all");
  if (contextTier) args.push("--context", contextTier);
  return args;
}

/**
 * Whether the installed Copilot understands `--context`.
 *
 * Asked rather than assumed because Copilot is installed per machine and the
 * fleet does not update it: a node can be running the current fleet build
 * against a Copilot from months ago. Commander rejects an unknown option by
 * exiting 1 before it reads a byte of ACP, so passing the flag blindly would
 * not degrade the session — it would stop every session on that machine from
 * starting, with the reason buried in a child process's stderr.
 */
export async function copilotSupportsContextTier(
  command: string,
  help: (command: string) => Promise<string> = copilotHelp,
): Promise<boolean> {
  try {
    return (await help(command)).includes("--context");
  } catch {
    // A Copilot that cannot even be asked is one the launch is about to fail
    // on anyway, and it will fail with its own error rather than this one.
    return false;
  }
}

/** `copilot --help`, or a rejection if it cannot be run at all. */
function copilotHelp(command: string): Promise<string> {
  return new Promise((done, fail) => {
    const viaShell = process.platform === "win32";
    const executable = viaShell && command.includes(" ") ? `"${command}"` : command;
    const child = spawn(executable, ["--help"], {
      shell: viaShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.once("error", fail);
    child.once("close", () => done(output));
    // A help screen that has not arrived in this long is not going to, and the
    // session waiting behind it should not be held up over an optional flag.
    setTimeout(() => {
      child.kill();
      fail(new Error("copilot --help timed out"));
    }, 15_000).unref();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
