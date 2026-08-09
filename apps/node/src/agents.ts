import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionEvent } from "@fleet/protocol";

export type PermissionDecision = {
  outcome: "allow_once" | "deny";
  optionId?: string;
};

export interface SessionAgent {
  prompt(text: string): Promise<void>;
  cancel(): Promise<void>;
  stop(): Promise<void>;
  resolvePermission(requestId: string, decision: PermissionDecision): void;
  denyPendingPermissions(): void;
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
        await this.connection.agent.request(acp.methods.agent.session.load, {
          sessionId: resumeAgentSessionId,
          cwd,
          mcpServers: [],
        });
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
    }
    this.emit("agent_session", { agentSessionId: this.agentSessionId });
  }

  async prompt(text: string): Promise<void> {
    if (!this.agentSessionId || !this.connection) {
      throw new Error("ACP session is not initialized");
    }
    if (this.prompting) throw new Error("A prompt is already active");
    this.prompting = true;
    this.emit("state", { state: "running", activity: "Copilot is working" });
    this.emit("system", { text: `User: ${text}` });
    try {
      const response = await this.connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: this.agentSessionId,
          prompt: [{ type: "text", text }],
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

  async cancel(): Promise<void> {
    if (!this.agentSessionId || !this.connection) {
      throw new Error("ACP session is not initialized");
    }
    this.denyPendingPermissions();
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.agentSessionId,
    });
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

  private forwardUpdate(update: acp.SessionUpdate): void {
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
    // A resumed session is never prompted by the router, so without this the
    // mock stayed in `starting` forever and Resume looked broken — the ACP
    // adapter settles on idle the same way once session/load returns.
    if (resumeAgentSessionId) {
      this.emit("state", { state: "idle", activity: "Resumed; ready for follow-up" });
    }
  }

  async prompt(text: string): Promise<void> {
    if (this.stopped) throw new Error("Mock agent is stopped");
    this.cancelled = false;
    this.emit("state", { state: "running", activity: "Mock agent is streaming" });
    this.emit("system", { text: `User: ${text}` });
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
