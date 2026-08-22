import { isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  eventPayload,
  terminalSessionStates,
  type NodeCommand,
  type SessionEvent,
} from "@fleet/protocol";
import type { AgentFactory, SessionAgent } from "./agents.js";
import { installRequestedAgent, type CatalogEntry } from "./agent-catalog.js";
type SessionKind = "writing" | "read-only";
import { resolveMcpServers } from "./mcp-endpoint.js";

export type CommandResult = {
  commandId: string;
  ok: boolean;
  error?: string;
  /** False when the command was refused but the session is still healthy. */
  fatal?: boolean;
};

/**
 * A command the agent declined without anything being wrong with it.
 *
 * Distinguished from a real failure so the Host can tell the operator "not
 * now" instead of tearing down a session that is working perfectly well.
 */
export class CommandRefused extends Error {}

type SessionSlot = {
  agent?: SessionAgent;
  ready: Promise<void>;
  /**
   * What this slot's session may do, so capacity is counted by kind.
   *
   * The Host counts the same way. If only one side split its budget the two
   * would disagree, and the Host would cheerfully dispatch work this machine
   * then refuses — which costs the whole connection, not just the step.
   */
  kind: SessionKind;
};

type LaunchCommand = Extract<NodeCommand, { type: "start_session" | "resume_session" }>;

export class CommandRouter {
  private readonly slots = new Map<string, SessionSlot>();
  private readonly handled = new Map<string, Promise<CommandResult>>();

  constructor(
    private readonly factory: AgentFactory,
    private maxSessions: number,
    private readonly emit: (event: SessionEvent) => void,
    private readonly validatePath: (
      path: string,
    ) => Promise<string> = validateWorkspacePath,
    /**
     * The Host address this node is connected on, used to rebase the MCP
     * endpoint the Host names. Only an orchestrator is given one.
     */
    private readonly hostUrl: () => string = () => "",
    /**
     * What agents this machine offers, read fresh so an operator who drops one
     * in does not have to restart the Node to use it.
     */
    private readonly agentCatalog: () => Promise<
      readonly CatalogEntry[]
    > = async () => [],
    /** Where a refused agent is reported; a session still starts without one. */
    private readonly warn: (message: string) => void = () => {},
  ) {}

  /**
   * Capacity edits apply to future launches only; sessions already running
   * above the new limit keep going rather than being killed mid-task.
   */
  setMaxSessions(maxSessions: number): void {
    this.maxSessions = maxSessions;
  }

  get activeSessionIds(): string[] {
    return [...this.slots.keys()];
  }

  async route(command: NodeCommand): Promise<CommandResult> {
    const previous = this.handled.get(command.commandId);
    if (previous) return previous;
    const pending = this.run(command);
    this.handled.set(command.commandId, pending);
    return pending;
  }

  private async run(command: NodeCommand): Promise<CommandResult> {
    try {
      await this.execute(command);
      return { commandId: command.commandId, ok: true };
    } catch (error) {
      return {
        commandId: command.commandId,
        ok: false,
        error: error instanceof Error ? error.message : "Command failed",
        // A refusal leaves the session healthy, so the Host must not bury it.
        fatal: !(error instanceof CommandRefused),
      };
    }
  }

  /** Sessions with a turn still in flight, for the Host's reconnect bookkeeping. */
  get busySessionIds(): string[] {
    return [...this.slots.entries()]
      .filter(([, slot]) => slot.agent?.busy)
      .map(([sessionId]) => sessionId);
  }

  denyPendingPermissions(): void {
    for (const slot of this.slots.values()) slot.agent?.denyPendingPermissions();
  }

  async stopAll(): Promise<void> {
    const slots = [...this.slots.entries()];
    for (const [sessionId] of slots) this.slots.delete(sessionId);
    await Promise.all(
      slots.map(async ([, slot]) => {
        await slot.ready.catch(() => undefined);
        await slot.agent?.stop();
      }),
    );
  }

  private async execute(command: NodeCommand): Promise<void> {
    if (command.type === "start_session" || command.type === "resume_session") {
      return this.startSession(command);
    }

    const slot = this.slots.get(command.sessionId);
    await slot?.ready;
    const agent = slot?.agent;
    if (!agent) throw new Error("Session is not active on this node");
    if (command.type === "prompt") {
      // Refused rather than dropped. This used to be `.catch(() => undefined)`
      // over a promise that rejects immediately when a turn is already in
      // flight, so a follow-up sent while the agent was still working vanished:
      // the Host had already been told the command succeeded, no event was
      // raised, and the operator watched an agent that never answered. The
      // resync corrects whatever state the Host guessed while disconnected,
      // which is how the composer came to be open over a busy agent at all.
      if (agent.busy) {
        agent.resync();
        throw new CommandRefused(
          "Copilot is still working on the previous turn; wait for it to finish or cancel it",
        );
      }
      void agent.prompt(command.prompt, command.attachments).catch(() => undefined);
    } else if (command.type === "cancel") {
      await agent.cancel();
    } else if (command.type === "stop") {
      await agent.stop();
      if (this.slots.get(command.sessionId) === slot) {
        this.slots.delete(command.sessionId);
      }
    } else if (command.type === "set_config_option") {
      // Awaited, unlike a prompt, and refused rather than failed: the agent
      // rejects an unknown value with a message naming the ones it takes, and
      // a mistyped model must not tear down a session that is working fine.
      try {
        await agent.setConfigOption(command.configId, command.value);
      } catch (error) {
        throw new CommandRefused(
          error instanceof Error ? error.message : "Could not change that option",
        );
      }
    } else {
      agent.resolvePermission(command.requestId, {
        outcome: command.outcome,
        ...(command.optionId ? { optionId: command.optionId } : {}),
      });
    }
  }

  private startSession(command: LaunchCommand): Promise<void> {
    const existing = this.slots.get(command.sessionId);
    if (existing) return existing.ready;
    const kind: SessionKind = command.readOnly ? "read-only" : "writing";
    const held = [...this.slots.values()].filter((slot) => slot.kind === kind).length;
    if (held >= this.maxSessions) {
      return Promise.reject(new Error(`Node is at capacity for ${kind} work`));
    }

    const slot: SessionSlot = { ready: Promise.resolve(), kind };
    this.slots.set(command.sessionId, slot);
    slot.ready = this.initializeSession(command, slot);
    return slot.ready;
  }

  private async initializeSession(
    command: LaunchCommand,
    slot: SessionSlot,
  ): Promise<void> {
    try {
      const cwd = await this.validatePath(command.localPath);
      const sink = (event: SessionEvent) => {
        this.emit(event);
        const state = eventPayload(event, "state")?.state;
        if (state && terminalSessionStates.has(state)) {
          this.release(command.sessionId, slot);
        }
      };
      const mcpServers = resolveMcpServers(command.mcpServers, this.hostUrl());
      const requested = await installRequestedAgent(
        cwd,
        command.agent,
        await this.agentCatalog(),
      );
      if (requested.reason) {
        this.warn(`session ${command.sessionId.slice(0, 8)}: ${requested.reason}`);
      }
      const agent = await this.factory.start(
        command.sessionId,
        cwd,
        sink,
        command.type === "resume_session"
          ? {
              resumeAgentSessionId: command.agentSessionId,
              sequenceOffset: command.sequenceOffset,
              yolo: command.yolo,
              mcpServers,
              agent: requested.selected,
            }
          : { yolo: command.yolo, mcpServers, agent: requested.selected },
      );
      slot.agent = agent;
      if (this.slots.get(command.sessionId) !== slot) {
        await agent.stop();
        throw new Error("Session terminated during startup");
      }
      // A resumed session waits for the operator's next prompt.
      if (command.type === "start_session") {
        void agent
          .prompt(command.prompt)
          .catch(() => this.release(command.sessionId, slot));
      }
    } catch (error) {
      this.release(command.sessionId, slot);
      throw error;
    }
  }

  private release(sessionId: string, slot: SessionSlot): void {
    if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
  }
}

export async function validateWorkspacePath(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error("Workspace path must be absolute");
  const canonical = await realpath(resolve(input));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("Workspace path must be a directory");
  return canonical;
}
