import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type { PromptAttachment, SessionEvent } from "@fleet/protocol";
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
 * What to set, if anything, to get a resumed session's pickers back.
 *
 * `session/new` reports the option list; `session/load` does not, and neither
 * does any notification that follows it — there is no method to ask, either, so
 * a resumed session has no idea what its own model or mode is. The Host papers
 * over this by keeping the last list it was told, which works until a session
 * has never had one: created by a fleet build too old to capture them, or by
 * anything else that left the record empty. From then on every resume is a
 * load, and the session stays pickerless permanently — a composer with nothing
 * on it and no way to ask for anything.
 *
 * `session/set_config_option` answers with the whole list, so setting one
 * breaks the deadlock. `allow_all` is the only option whose correct value is
 * known without having read the list first: the Host decides it per session and
 * the process was just launched with the matching `--allow-all`. Re-asserting
 * it therefore changes nothing about the session and makes the pickers agree
 * with what is already true of it.
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

  constructor(
    fleetSessionId: string,
    sink: EventSink,
    private readonly permissionTimeoutMs: number,
    sequenceOffset = 0,
    private readonly yolo = false,
    private readonly copilotCommand = "",
    private readonly contextTier: ContextTier | undefined = undefined,
  ) {
    super(fleetSessionId, sink, sequenceOffset);
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
        if (!this.replaying) this.forwardUpdate(params.update);
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
            mcpServers: [],
          },
        );
        this.captureConfigOptions(loaded.configOptions);
      } finally {
        this.replaying = false;
      }
      this.agentSessionId = resumeAgentSessionId;
      await this.recoverConfigOptions();
      this.emit("state", { state: "idle", activity: "Resumed; ready for follow-up" });
    } else {
      const created = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      this.agentSessionId = created.sessionId;
      this.captureConfigOptions(created.configOptions);
    }
    this.emit("agent_session", { agentSessionId: this.agentSessionId });
  }

  /** Gets the pickers back after a load that arrived without them. */
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
    return this.prompting;
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
      this.prompting
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
      });
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      this.emit("tool", {
        toolCallId: update.toolCallId,
        status: update.status,
        title: update.title,
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
