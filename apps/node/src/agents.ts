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
    const args = copilotLaunchArgs(this.yolo);
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
  /** Values are injected: settings.ts is the only place that reads the env. */
  constructor(
    private permissionTimeoutMs: number,
    private copilotCommand: string,
  ) {}

  /** Lets the local config UI retune the agent without a process restart. */
  configure(permissionTimeoutMs: number, copilotCommand: string): void {
    this.permissionTimeoutMs = permissionTimeoutMs;
    this.copilotCommand = copilotCommand;
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
    );
    try {
      await agent.start(cwd, options.resumeAgentSessionId);
      return agent;
    } catch (error) {
      await agent.stop();
      throw error;
    }
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
 */
export function copilotLaunchArgs(yolo: boolean): string[] {
  const args = ["--acp", "--stdio"];
  if (yolo) args.push("--allow-all");
  return args;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
