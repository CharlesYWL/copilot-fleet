import { isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  eventPayload,
  isSessionActivityEvent,
  sessionRetentionCutoff,
  terminalSessionStates,
  type NodeCommand,
  type SessionEvent,
  type StartupConfig,
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

export type CommandRouterOptions = {
  deleteInactiveSession?: (
    agentSessionId: string,
    inactiveBefore: number,
    beforeDelete: () => Promise<void>,
  ) => Promise<void>;
};

type SessionActivity = {
  lastActivityAt: number;
  inFlightCommands: number;
  agentSessionId?: string;
};

type SessionSlot = {
  agent: SessionAgent | undefined;
  ready: Promise<void>;
  initializing: boolean;
  activity: SessionActivity;
  refreshing?: Promise<void>;
  refreshMcpPending?: boolean;
  launch?: LaunchCommand;
  cwd?: string;
  additionalDirectories?: string[];
  selectedAgent?: string;
  agentSessionId: string | undefined;
  config: Map<string, string>;
  generation: number;
  sequenceOffset: number;
  toolTitles: Map<string, string>;
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
type DeleteSessionCommand = Extract<NodeCommand, { type: "delete_session" }>;

export class CommandRouter {
  private readonly slots = new Map<string, SessionSlot>();
  private readonly handled = new Map<string, Promise<CommandResult>>();
  private readonly handledBySession = new Map<string, Set<string>>();
  // Small activity records survive terminal slot release until cleanup succeeds.
  private readonly sessionActivity = new Map<string, SessionActivity>();
  private readonly deleting = new Map<string, string>();
  private readonly deleted = new Map<string, string>();

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
    private readonly options: CommandRouterOptions = {},
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
    const commands = this.handledBySession.get(command.sessionId) ?? new Set<string>();
    commands.add(command.commandId);
    this.handledBySession.set(command.sessionId, commands);
    const pending = this.run(command);
    this.handled.set(command.commandId, pending);
    const result = await pending;
    if (command.type === "delete_session" && !result.ok) {
      this.handled.delete(command.commandId);
      this.handledBySession.get(command.sessionId)?.delete(command.commandId);
    }
    return result;
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
        fatal: command.type !== "delete_session" && !(error instanceof CommandRefused),
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

  /**
   * Restores MCP tools removed by Copilot while the Host was unreachable.
   *
   * A session mid-turn is left alone and refreshed when it next reports idle.
   * Reloading a busy ACP session would interrupt the answer whose buffered
   * events the reconnect handshake has just protected.
   */
  async refreshMcpSessions(): Promise<void> {
    await Promise.allSettled(
      [...this.slots].map(async ([sessionId, slot]) => {
        if (this.deleting.has(sessionId)) return;
        if (slot.refreshing) {
          await slot.refreshing;
          return;
        }
        await slot.ready;
        if (
          this.deleting.has(sessionId) ||
          this.slots.get(sessionId) !== slot ||
          !slot.agent
        )
          return;
        if (slot.agent.busy) {
          slot.refreshMcpPending = true;
          return;
        }
        await this.refreshMcpSession(sessionId, slot);
      }),
    );
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
    if (command.type === "delete_session") return this.deleteSession(command);
    this.assertNotDeleting(
      command.sessionId,
      command.type === "resume_session"
        ? command.agentSessionId
        : this.slots.get(command.sessionId)?.agentSessionId,
    );
    if (command.type === "start_session" || command.type === "resume_session") {
      return this.startSession(command);
    }

    const slot = this.slots.get(command.sessionId);
    await slot?.ready;
    this.assertNotDeleting(command.sessionId, slot?.agentSessionId);
    const agent = slot?.agent;
    if (!agent || this.slots.get(command.sessionId) !== slot) {
      throw new Error("Session is not active on this node");
    }
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
      void this.withActivity(slot, () =>
        agent.prompt(command.prompt, command.attachments),
      ).catch(() => undefined);
    } else {
      await this.withActivity(slot, async () => {
        if (command.type === "cancel") {
          await agent.cancel();
        } else if (command.type === "stop") {
          await agent.stop();
          this.release(command.sessionId, slot);
        } else if (command.type === "set_config_option") {
          // A rejected picker change must not tear down an otherwise healthy session.
          try {
            await agent.setConfigOption(command.configId, command.value);
            slot.config.set(command.configId, command.value);
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
      });
    }
  }

  private assertNotDeleting(sessionId: string, agentSessionId?: string): void {
    if (
      this.deleting.has(sessionId) ||
      this.deleted.has(sessionId) ||
      (agentSessionId && [...this.deleting.values()].includes(agentSessionId))
    ) {
      throw new CommandRefused(
        "session_cleanup_in_progress: This session is being deleted or was deleted",
      );
    }
  }

  private noteActivity(slot: SessionSlot, at = Date.now()): void {
    slot.activity.lastActivityAt = Math.max(slot.activity.lastActivityAt, at);
  }

  private async withActivity(
    slot: SessionSlot,
    work: () => Promise<void>,
  ): Promise<void> {
    this.noteActivity(slot);
    slot.activity.inFlightCommands += 1;
    try {
      await work();
    } finally {
      this.noteActivity(slot);
      slot.activity.inFlightCommands -= 1;
    }
  }

  private assertInactive(
    command: DeleteSessionCommand,
    slot: SessionSlot | undefined,
    cutoff: number,
  ): void {
    if (this.slots.get(command.sessionId) !== slot) {
      throw new CommandRefused(
        "session_active: The local session changed during cleanup",
      );
    }
    const activity = this.sessionActivity.get(command.sessionId);
    if (
      (activity && (activity.lastActivityAt > cutoff || activity.inFlightCommands > 0)) ||
      (slot && (slot.initializing || slot.refreshing || !slot.agent || slot.agent.busy))
    ) {
      throw new CommandRefused(
        "session_active: The local session is active, recent, or has work in flight",
      );
    }
    const agentSessionId = slot?.agentSessionId ?? activity?.agentSessionId;
    if (slot && !slot.agentSessionId) {
      throw new CommandRefused(
        "session_identity_mismatch: The local Copilot session id is not known",
      );
    }
    if (agentSessionId !== undefined && agentSessionId !== command.agentSessionId) {
      throw new CommandRefused(
        "session_identity_mismatch: The local Copilot session id does not match",
      );
    }
    if (command.agentSessionId) {
      for (const [sessionId, other] of this.slots) {
        if (
          sessionId !== command.sessionId &&
          other.agentSessionId === command.agentSessionId
        ) {
          throw new CommandRefused(
            "session_active: Another local session is using this Copilot conversation",
          );
        }
      }
      for (const [sessionId, other] of this.sessionActivity) {
        if (
          sessionId !== command.sessionId &&
          other.agentSessionId === command.agentSessionId &&
          (other.lastActivityAt > cutoff || other.inFlightCommands > 0)
        ) {
          throw new CommandRefused(
            "session_active: This Copilot conversation has recent local activity",
          );
        }
      }
    }
  }

  private clearHandledSession(sessionId: string, keepCommandId: string): void {
    for (const commandId of this.handledBySession.get(sessionId) ?? []) {
      if (commandId !== keepCommandId) this.handled.delete(commandId);
    }
    this.handledBySession.set(sessionId, new Set([keepCommandId]));
  }

  private async deleteSession(command: DeleteSessionCommand): Promise<void> {
    const localCutoff = sessionRetentionCutoff(Date.now(), command.retentionDays);
    const hostCutoff = Date.parse(command.inactiveBefore);
    if (localCutoff === undefined || !Number.isFinite(hostCutoff)) {
      throw new CommandRefused("delete_failed: Invalid session inactivity cutoff");
    }
    const cutoff = Math.min(hostCutoff, localCutoff);
    if (this.deleted.has(command.sessionId)) {
      if (this.deleted.get(command.sessionId) !== command.agentSessionId) {
        throw new CommandRefused(
          "session_identity_mismatch: This session was already deleted with a different Copilot id",
        );
      }
      this.clearHandledSession(command.sessionId, command.commandId);
      return;
    }
    if (
      this.deleting.has(command.sessionId) ||
      (command.agentSessionId &&
        [...this.deleting.values()].includes(command.agentSessionId))
    ) {
      throw new CommandRefused(
        "session_cleanup_in_progress: A cleanup is already in flight",
      );
    }

    const slot = this.slots.get(command.sessionId);
    this.assertInactive(command, slot, cutoff);
    this.deleting.set(command.sessionId, command.agentSessionId);
    let stopped = false;
    try {
      let prepared = false;
      const beforeDelete = async (): Promise<void> => {
        if (prepared) return;
        // ACP listing may have waited while the retained process produced output.
        this.assertInactive(command, slot, cutoff);
        if (slot) {
          await slot.agent!.stop(false);
          stopped = true;
          try {
            this.assertInactive(command, slot, cutoff);
          } finally {
            this.release(command.sessionId, slot);
          }
        }
        prepared = true;
      };
      if (command.agentSessionId === "") {
        await beforeDelete();
      } else {
        if (!this.options.deleteInactiveSession) {
          throw new CommandRefused(
            "unsupported_delete: Copilot session deletion is not configured",
          );
        }
        await this.options.deleteInactiveSession(
          command.agentSessionId,
          cutoff,
          beforeDelete,
        );
      }
      if (!prepared) {
        throw new CommandRefused(
          "delete_failed: Cleanup did not verify local inactivity",
        );
      }
      this.deleted.set(command.sessionId, command.agentSessionId);
      this.sessionActivity.delete(command.sessionId);
      this.clearHandledSession(command.sessionId, command.commandId);
    } catch (error) {
      // The process may be gone even though its persisted conversation survived.
      if (stopped && slot) {
        this.emit({
          eventId: `cleanup-stopped-${command.commandId}`,
          sessionId: command.sessionId,
          sequence: ++slot.sequenceOffset,
          type: "state",
          payload: {
            state: "stopped",
            activity: "Stopped for cleanup; persisted session deletion failed",
          },
          createdAt: new Date().toISOString(),
        });
      }
      throw error;
    } finally {
      this.deleting.delete(command.sessionId);
    }
  }

  private startSession(command: LaunchCommand): Promise<void> {
    let lastActivityAt = Date.now();
    if (command.type === "resume_session" && command.lastActivityAt !== undefined) {
      const restoredActivity = Date.parse(command.lastActivityAt);
      if (!Number.isFinite(restoredActivity)) {
        return Promise.reject(
          new CommandRefused("Invalid automatic resume activity timestamp"),
        );
      }
      lastActivityAt = Math.min(lastActivityAt, restoredActivity);
    }
    const existing = this.slots.get(command.sessionId);
    if (existing) {
      this.noteActivity(existing, lastActivityAt);
      return existing.ready;
    }
    const kind: SessionKind = command.readOnly ? "read-only" : "writing";
    const held = [...this.slots.values()].filter((slot) => slot.kind === kind).length;
    if (held >= this.maxSessions) {
      return Promise.reject(new Error(`Node is at capacity for ${kind} work`));
    }

    const activity = this.sessionActivity.get(command.sessionId) ?? {
      lastActivityAt,
      inFlightCommands: 0,
    };
    const slot: SessionSlot = {
      ready: Promise.resolve(),
      initializing: true,
      activity,
      agent: undefined,
      agentSessionId:
        command.type === "resume_session" ? command.agentSessionId : undefined,
      config: new Map(command.config.map((entry) => [entry.id, entry.value])),
      generation: 0,
      kind,
      sequenceOffset: command.type === "resume_session" ? command.sequenceOffset : 0,
      toolTitles: new Map(),
    };
    this.noteActivity(slot, lastActivityAt);
    this.sessionActivity.set(command.sessionId, activity);
    this.slots.set(command.sessionId, slot);
    slot.ready = this.initializeSession(command, slot);
    return slot.ready;
  }

  private async initializeSession(
    command: LaunchCommand,
    slot: SessionSlot,
  ): Promise<void> {
    const automaticResume =
      command.type === "resume_session" && command.lastActivityAt !== undefined;
    let replaying = automaticResume;
    try {
      const cwd = await this.validatePath(command.localPath);
      let additionalDirectories: string[] = [];
      if (command.type === "resume_session") {
        const restored = await Promise.allSettled(
          command.additionalDirectories.map(this.validatePath),
        );
        additionalDirectories = restored.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const unavailable = restored.length - additionalDirectories.length;
        if (unavailable > 0) {
          this.warn(
            `session ${command.sessionId.slice(0, 8)}: omitted ${unavailable} unavailable additional workspace root${unavailable === 1 ? "" : "s"}`,
          );
        }
      }
      const generation = slot.generation;
      const sink = (event: SessionEvent) =>
        this.handleSessionEvent(
          command.sessionId,
          slot,
          generation,
          replaying
            ? { ...event, payload: { ...event.payload, historyReplay: true } }
            : event,
        );
      const mcpServers = resolveMcpServers(command.mcpServers, this.hostUrl());
      const requested = await installRequestedAgent(
        cwd,
        command.agent,
        await this.agentCatalog(),
      );
      if (requested.reason) {
        this.warn(`session ${command.sessionId.slice(0, 8)}: ${requested.reason}`);
      }
      slot.launch = command;
      slot.cwd = cwd;
      slot.additionalDirectories = additionalDirectories;
      slot.selectedAgent = requested.selected;
      if (command.type === "resume_session") {
        slot.agentSessionId = command.agentSessionId;
        slot.activity.agentSessionId = command.agentSessionId;
      }
      const agent = await this.factory
        .start(
          command.sessionId,
          cwd,
          sink,
          command.type === "resume_session"
            ? {
                resumeAgentSessionId: command.agentSessionId,
                additionalDirectories,
                sequenceOffset: command.sequenceOffset,
                yolo: command.yolo,
                agencyMode: command.agencyMode ?? false,
                mcpServers,
                agent: requested.selected,
                config: command.config,
              }
            : {
                yolo: command.yolo,
                agencyMode: command.agencyMode ?? false,
                mcpServers,
                agent: requested.selected,
                config: command.config,
              },
        )
        .finally(() => {
          replaying = false;
        });
      slot.agent = agent;
      if (this.slots.get(command.sessionId) !== slot) {
        await agent.stop();
        throw new Error("Session terminated during startup");
      }
      // A resumed session waits for the operator's next prompt.
      if (command.type === "start_session") {
        void this.withActivity(slot, () => agent.prompt(command.prompt)).catch(() =>
          this.release(command.sessionId, slot),
        );
      }
    } catch (error) {
      this.release(command.sessionId, slot);
      throw error;
    } finally {
      if (!automaticResume) this.noteActivity(slot);
      slot.initializing = false;
    }
  }

  private release(sessionId: string, slot: SessionSlot): void {
    if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
  }

  private handleSessionEvent(
    sessionId: string,
    slot: SessionSlot,
    generation: number,
    event: SessionEvent,
  ): void {
    if (slot.generation !== generation || this.slots.get(sessionId) !== slot) return;
    if (isSessionActivityEvent(event)) this.noteActivity(slot);
    slot.sequenceOffset = Math.max(slot.sequenceOffset, event.sequence);
    const agentSession = eventPayload(event, "agent_session");
    if (agentSession?.agentSessionId) {
      slot.agentSessionId = agentSession.agentSessionId;
      slot.activity.agentSessionId = agentSession.agentSessionId;
    }
    const config = eventPayload(event, "config");
    for (const option of config?.options ?? []) {
      if (option.currentValue !== undefined) {
        slot.config.set(option.id, option.currentValue);
      }
    }
    const tool = eventPayload(event, "tool");
    if (tool) {
      const toolCallId = tool.toolCallId ?? "";
      if (toolCallId && tool.title) slot.toolTitles.set(toolCallId, tool.title);
      const title = tool.title || slot.toolTitles.get(toolCallId) || "";
      if (
        tool.status === "failed" &&
        title.startsWith("fleet-fleet_") &&
        tool.error?.toLowerCase().includes("tool does not exist")
      ) {
        slot.refreshMcpPending = true;
        this.warn(
          `session ${sessionId.slice(0, 8)}: Fleet MCP tools were lost; restarting Copilot after the current turn`,
        );
      }
      if (toolCallId && (tool.status === "completed" || tool.status === "failed")) {
        slot.toolTitles.delete(toolCallId);
      }
    }
    this.emit(event);
    const state = eventPayload(event, "state")?.state;
    if (state && terminalSessionStates.has(state)) {
      this.release(sessionId, slot);
    } else if (
      state === "idle" &&
      slot.refreshMcpPending &&
      !this.deleting.has(sessionId)
    ) {
      slot.refreshMcpPending = false;
      void this.refreshMcpSession(sessionId, slot);
    }
  }

  private async refreshMcpSession(sessionId: string, slot: SessionSlot): Promise<void> {
    if (this.deleting.has(sessionId)) return;
    if (slot.refreshing) {
      await slot.refreshing;
      return;
    }
    const refresh = slot.ready.then(async () => {
      const current = slot.agent;
      const launch = slot.launch;
      if (
        this.slots.get(sessionId) !== slot ||
        this.deleting.has(sessionId) ||
        !current ||
        !launch ||
        !slot.cwd ||
        !slot.agentSessionId ||
        launch.mcpServers.length === 0
      ) {
        return;
      }
      if (current.busy) {
        slot.refreshMcpPending = true;
        return;
      }
      const generation = ++slot.generation;
      await current.stop(false);
      slot.agent = undefined;
      // Only load-time replay is historical; the retained sink goes live once startup settles.
      let replaying = true;
      const next = await this.factory
        .start(
          sessionId,
          slot.cwd,
          (event) =>
            this.handleSessionEvent(
              sessionId,
              slot,
              generation,
              replaying
                ? { ...event, payload: { ...event.payload, historyReplay: true } }
                : event,
            ),
          {
            resumeAgentSessionId: slot.agentSessionId,
            additionalDirectories: slot.additionalDirectories ?? [],
            sequenceOffset: slot.sequenceOffset,
            yolo: launch.yolo,
            agencyMode: launch.agencyMode ?? false,
            mcpServers: resolveMcpServers(launch.mcpServers, this.hostUrl()),
            agent: slot.selectedAgent ?? "",
            config: [...slot.config].map(([id, value]): StartupConfig => ({ id, value })),
            announceLifecycle: false,
          },
        )
        .finally(() => {
          replaying = false;
        });
      if (this.slots.get(sessionId) !== slot) {
        await next.stop(false);
        return;
      }
      slot.agent = next;
    });
    const handled = refresh.catch((error) => {
      this.warn(
        `session ${sessionId.slice(0, 8)}: could not restore MCP tools: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      if (this.slots.get(sessionId) === slot) {
        slot.sequenceOffset += 1;
        this.handleSessionEvent(sessionId, slot, slot.generation, {
          eventId: `mcp-refresh-failed-${sessionId}-${slot.sequenceOffset}`,
          sessionId,
          sequence: slot.sequenceOffset,
          type: "state",
          payload: {
            state: "failed",
            activity: "Copilot could not be restarted to restore MCP tools",
          },
          createdAt: new Date().toISOString(),
        });
      }
    });
    slot.refreshing = handled;
    slot.ready = handled;
    try {
      await handled;
    } finally {
      if (slot.refreshing === handled) delete slot.refreshing;
    }
  }
}

export async function validateWorkspacePath(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error("Workspace path must be absolute");
  const canonical = await realpath(resolve(input));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("Workspace path must be a directory");
  return canonical;
}
