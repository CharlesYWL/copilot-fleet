import { isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  agentKindLabels,
  CONTEXT_TIER_CONFIG_ID,
  ContextTierSchema,
  eventPayload,
  isSessionActivityEvent,
  sessionRetentionCutoff,
  terminalSessionStates,
  type NodeCommand,
  type SessionEvent,
  type StartupConfig,
  type ContextTier,
  type ExecutionBinding,
  WorktreeConflict,
} from "@fleet/protocol";
import {
  AgentStartupCleanupError,
  type AgentFactory,
  type SessionAgent,
} from "./agents.js";
import { installRequestedAgent, type CatalogEntry } from "./agent-catalog.js";
type SessionKind = "writing" | "read-only";
import { resolveMcpServers } from "./mcp-endpoint.js";
import type { ManagedWorktrees } from "./managed-worktrees.js";
import type { CheckoutLease } from "./checkout-locks.js";
import type { NodeAdmission, AdmissionTicket } from "./node-admission.js";
import type { RepositoryParticipation } from "./repository-participation.js";
import type { LeadPromptJournal } from "./lead-prompt-delivery.js";
import type { LeadPromptDelivery, LeadPromptReceipt } from "@fleet/protocol";
import {
  MCP_RECOVERY_DELAYS_MS,
  McpRecoveryConnection,
  recoveryDelay,
} from "./mcp-recovery.js";

export type CommandResult = {
  commandId: string;
  ok: boolean;
  error?: string;
  /** False when the command was refused but the session is still healthy. */
  fatal?: boolean;
  executionBinding?: ExecutionBinding;
};

/**
 * A command the agent declined without anything being wrong with it.
 *
 * Distinguished from a real failure so the Host can tell the operator "not
 * now" instead of tearing down a session that is working perfectly well.
 */
export class CommandRefused extends Error {}

export type CommandRouterOptions = {
  worktrees?: ManagedWorktrees;
  admission?: NodeAdmission;
  repositories?: RepositoryParticipation;
  leadDeliveries?: LeadPromptJournal;
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
  leases?: CheckoutLease[];
  participation?: CheckoutLease[];
  supervisedParticipation?: boolean;
  ticket?: AdmissionTicket;
  deliveryId?: string;
  deliverySequence?: number;
  binding?: ExecutionBinding;
  terminalEvent?: SessionEvent;
  terminalEmitted?: boolean;
  quiescing?: Promise<void>;
  retiredAttempts?: Set<string>;
  agent: SessionAgent | undefined;
  ready: Promise<void>;
  initializing: boolean;
  activity: SessionActivity;
  refreshing?: Promise<void>;
  refreshMcpPending?: boolean;
  mcpRecovery?: AbortController;
  stopping?: boolean;
  silentReplacement?: boolean;
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
  private readonly bindings = new Map<string, ExecutionBinding>();
  private readonly reconciliation = new Map<string, SessionSlot>();
  private draining = false;
  private readonly mcpConnection = new McpRecoveryConnection();

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

  /** Where a live session is working, working directory first; empty otherwise. */
  sessionRoots(sessionId: string): string[] {
    const slot = this.slots.get(sessionId);
    return slot?.cwd ? [slot.cwd, ...(slot.additionalDirectories ?? [])] : [];
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
      const binding = this.bindings.get(command.sessionId);
      return {
        commandId: command.commandId,
        ok: true,
        ...(binding ? { executionBinding: binding } : {}),
      };
    } catch (error) {
      return {
        commandId: command.commandId,
        ok: false,
        error: error instanceof Error ? error.message : "Command failed",
        // A refusal leaves the session healthy, so the Host must not bury it.
        fatal:
          command.type !== "delete_session" &&
          !(error instanceof CommandRefused) &&
          !(
            error instanceof WorktreeConflict && this.slots.get(command.sessionId)?.agent
          ),
      };
    }
  }

  /** Sessions with a turn still in flight, for the Host's reconnect bookkeeping. */
  get busySessionIds(): string[] {
    return [...this.slots.entries()]
      .filter(
        ([id, slot]) =>
          slot.mcpRecovery ||
          slot.agent?.busy ||
          this.options.leadDeliveries?.reserved(id, slot.agentSessionId),
      )
      .map(([sessionId]) => sessionId);
  }

  denyPendingPermissions(): void {
    for (const slot of this.slots.values()) slot.agent?.denyPendingPermissions();
  }

  setMcpAvailable(available: boolean): void {
    this.mcpConnection.setAvailable(available);
  }

  private cancelMcpRecovery(slot: SessionSlot): void {
    slot.refreshMcpPending = false;
    if (slot.mcpRecovery) {
      slot.silentReplacement = true;
      slot.mcpRecovery.abort(new Error("MCP recovery cancelled by Stop"));
    }
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
        if (this.deleting.has(sessionId) || slot.stopping || this.draining) return;
        if (slot.refreshing) {
          await slot.refreshing;
          return;
        }
        await slot.ready;
        if (
          this.deleting.has(sessionId) ||
          this.slots.get(sessionId) !== slot ||
          !slot.agent ||
          !slot.launch?.mcpServers.length
        )
          return;
        if (slot.agent.busy) {
          slot.refreshMcpPending = true;
          return;
        }
        await this.restartSession(sessionId, slot);
      }),
    );
  }

  async stopAll(): Promise<void> {
    this.draining = true;
    const slots = [...new Map([...this.reconciliation, ...this.slots])];
    for (const [, slot] of slots) {
      slot.stopping = true;
      this.cancelMcpRecovery(slot);
    }
    const results = await Promise.allSettled(
      slots.map(async ([sessionId, slot]) => {
        await slot.ready.catch(() => undefined);
        await this.quiesce(sessionId, slot, true);
      }),
    ).finally(() => {
      this.draining = false;
    });
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Some sessions could not stop safely.");
  }

  async quiesceWorktree(worktreeId: string, targetPath?: string): Promise<void> {
    const target = targetPath
      ? await this.options.worktrees!.checkoutIdentity(targetPath)
      : undefined;
    const results = await Promise.allSettled(
      [...new Map([...this.reconciliation, ...this.slots])].map(
        async ([sessionId, slot]) => {
          const checkoutKey =
            slot.binding?.checkoutKey ??
            (target && slot.cwd
              ? (await this.options.worktrees!.checkoutIdentity(slot.cwd)).key
              : undefined);
          if (
            slot.binding?.worktreeId !== worktreeId &&
            (!target || checkoutKey !== target.key)
          )
            return;
          slot.stopping = true;
          this.cancelMcpRecovery(slot);
          await slot.ready.catch(() => undefined);
          await this.quiesce(sessionId, slot, true);
        },
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Worktree process quiescence is unknown.");
  }

  private async execute(command: NodeCommand): Promise<void> {
    if (this.draining) throw new CommandRefused("Node sessions are being stopped.");
    if (command.type === "delete_session") return this.deleteSession(command);
    this.assertNotDeleting(
      command.sessionId,
      command.type === "resume_session"
        ? command.agentSessionId
        : this.slots.get(command.sessionId)?.agentSessionId,
    );
    if (command.type === "start_session" || command.type === "resume_session") {
      if (this.options.admission?.reason)
        throw new CommandRefused(this.options.admission.reason);
      return this.startSession(command);
    }

    const slot =
      this.slots.get(command.sessionId) ??
      (command.type === "stop" ? this.reconciliation.get(command.sessionId) : undefined);
    if (command.type === "stop" && slot) {
      slot.stopping = true;
      this.cancelMcpRecovery(slot);
    } else if (slot?.mcpRecovery || slot?.stopping) {
      throw new CommandRefused("Session is recovering MCP tools or being stopped");
    }
    await slot?.ready;
    this.assertNotDeleting(command.sessionId, slot?.agentSessionId);
    if (command.type === "stop") {
      if (!slot) throw new Error("Session is not active on this node");
      await this.withActivity(slot, () => this.quiesce(command.sessionId, slot, true));
      return;
    }
    const agent = slot?.agent;
    if (!agent || this.slots.get(command.sessionId) !== slot) {
      throw new Error("Session is not active on this node");
    }
    if (command.type === "prompt") {
      if (this.options.admission?.reason)
        throw new CommandRefused(this.options.admission.reason);
      // Admission itself is in flight: cleanup must not stop the process while
      // physical checkout/lease validation is waiting on the filesystem.
      await this.withActivity(slot, async () => {
        await this.revalidate(slot, command.executionBinding);
        slot.ticket?.revalidate();
        this.assertNotDeleting(command.sessionId, slot.agentSessionId);
        if (this.slots.get(command.sessionId) !== slot || slot.agent !== agent) {
          throw new CommandRefused("Session changed during prompt admission");
        }
        // Refused rather than dropped: acknowledge only after admission, but
        // keep the turn tracked without making the Host wait for its completion.
        if (
          agent.busy ||
          this.options.leadDeliveries?.reserved(command.sessionId, slot.agentSessionId)
        ) {
          agent.resync();
          throw new CommandRefused(
            `${agentKindLabels[slot.launch?.agentParams?.kind ?? "copilot"]} is still working on the previous turn; wait for it to finish or cancel it`,
          );
        }
        void this.withActivity(slot, () =>
          agent.prompt(command.prompt, command.attachments),
        ).catch(() => undefined);
      });
    } else {
      await this.withActivity(slot, async () => {
        if (command.type === "cancel") {
          await agent.cancel();
        } else if (command.type === "set_config_option") {
          // A rejected picker change must not tear down an otherwise healthy session.
          try {
            if (command.configId === CONTEXT_TIER_CONFIG_ID) {
              const tier = ContextTierSchema.parse(command.value);
              if (!slot.config.has(CONTEXT_TIER_CONFIG_ID)) {
                throw new CommandRefused("This agent does not support context switching");
              }
              if (agent.busy) {
                agent.resync();
                throw new CommandRefused(
                  "Wait for the current turn before changing context",
                );
              }
              if (slot.config.get(CONTEXT_TIER_CONFIG_ID) !== tier) {
                await this.restartSession(command.sessionId, slot, tier);
              }
            } else {
              await agent.setConfigOption(command.configId, command.value);
              slot.config.set(command.configId, command.value);
            }
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

  rejectLeadPrompt(
    hostId: string,
    delivery: LeadPromptDelivery,
    reason: string,
  ): LeadPromptReceipt {
    const journal = this.options.leadDeliveries;
    if (!journal) throw new CommandRefused("Durable lead delivery is unavailable.");
    return journal.accept(hostId, delivery, "", false, reason).receipt;
  }

  async deliverLeadPrompt(
    hostId: string,
    delivery: LeadPromptDelivery,
  ): Promise<LeadPromptReceipt> {
    const journal = this.options.leadDeliveries;
    if (!journal) throw new CommandRefused("Durable lead delivery is unavailable.");
    const slot = this.slots.get(delivery.sessionId);
    if (slot?.mcpRecovery || slot?.stopping)
      return journal.accept(hostId, delivery, slot.agentSessionId ?? "", true).receipt;
    await slot?.ready;
    if (slot?.mcpRecovery || slot?.stopping)
      return journal.accept(hostId, delivery, slot.agentSessionId ?? "", true).receipt;
    const agent = slot?.agent;
    const usable =
      !!slot && !!agent && this.slots.get(delivery.sessionId) === slot && !slot.quiescing;
    if (usable) await this.revalidate(slot, delivery.executionBinding);
    const stillUsable =
      usable &&
      this.slots.get(delivery.sessionId) === slot &&
      slot.agent === agent &&
      !slot.quiescing;
    const accepted = journal.accept(
      hostId,
      delivery,
      stillUsable || slot?.mcpRecovery || slot?.stopping
        ? (slot?.agentSessionId ?? "")
        : "",
      !!this.options.admission?.reason ||
        !!agent?.busy ||
        !!slot?.refreshing ||
        !!slot?.initializing ||
        !!slot?.mcpRecovery ||
        !!slot?.stopping ||
        this.deleting.has(delivery.sessionId),
    );
    if (accepted.invoke && slot && agent) {
      slot.deliveryId = delivery.deliveryId;
      slot.deliverySequence = slot.sequenceOffset;
      void this.withActivity(slot, () =>
        agent.prompt(delivery.prompt, delivery.attachments, {
          allowContextRollover: false,
        }),
      )
        .then(
          () => {
            // Only turn_complete settles a delivery. Rollover/replay/stop is not consumption proof.
            journal.uncertain(
              delivery.deliveryId,
              "Native prompt returned without an authoritative current-turn completion.",
            );
          },
          (error: unknown) => journal.uncertain(delivery.deliveryId, String(error)),
        )
        .catch((error: unknown) => {
          this.options.admission?.quarantine(
            `Durable lead receipt persistence failed: ${String(error)}`,
          );
          this.warn(String(error));
        });
    }
    return accepted.receipt;
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
      (slot &&
        (slot.initializing ||
          slot.refreshing ||
          slot.stopping ||
          !slot.agent ||
          slot.agent.busy))
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
    if (
      command.agentParams?.kind === "hermes" ||
      this.slots.get(command.sessionId)?.launch?.agentParams?.kind === "hermes"
    ) {
      throw new CommandRefused(
        "unsupported_delete: Manage Hermes conversation history in its named profile; Copilot retention cannot delete it.",
      );
    }
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
          try {
            await slot.agent!.stop(false);
            stopped = true;
            this.assertInactive(command, slot, cutoff);
          } finally {
            if (stopped || slot.binding?.worktreeId)
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
    if (this.reconciliation.has(command.sessionId))
      return Promise.reject(
        new WorktreeConflict(
          "process_unknown",
          "The previous process requires reconciliation.",
        ),
      );
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
      const previous = existing.launch?.agentParams ?? { kind: "copilot" };
      const next = command.agentParams ?? { kind: "copilot" };
      if (
        previous.kind !== next.kind ||
        (previous.kind === "hermes" &&
          next.kind === "hermes" &&
          previous.profile !== next.profile)
      ) {
        return Promise.reject(
          new CommandRefused("A live conversation cannot change its agent or profile."),
        );
      }
      if (existing.mcpRecovery || existing.stopping)
        return Promise.reject(
          new CommandRefused("Session is recovering MCP tools or being stopped"),
        );
      this.noteActivity(existing, lastActivityAt);
      return existing.ready.then(async () => {
        if (this.slots.get(command.sessionId) !== existing || existing.quiescing)
          throw new CommandRefused("Session is being stopped.");
        if (command.type === "resume_session" && existing.binding?.worktreeId) {
          return this.withActivity(existing, () => this.reattach(command, existing));
        }
        if (
          existing.binding &&
          command.executionBinding &&
          (existing.binding.cwd !== command.executionBinding.cwd ||
            existing.binding.worktreeId !== command.executionBinding.worktreeId ||
            existing.binding.generation !== command.executionBinding.generation)
        ) {
          throw new WorktreeConflict(
            "binding_mismatch",
            "A live conversation cannot move checkout.",
          );
        }
        await this.revalidate(existing, command.executionBinding);
      });
    }
    if (
      command.type === "resume_session" &&
      this.options.leadDeliveries?.reserved(command.sessionId, command.agentSessionId)
    ) {
      return Promise.reject(
        new CommandRefused(
          "A durable native prompt handoff is unresolved; automatic resume/re-prompt is blocked.",
        ),
      );
    }
    const kind: SessionKind = command.readOnly ? "read-only" : "writing";
    const params = command.agentParams;
    if (
      params?.kind === "hermes" &&
      [...this.slots.values(), ...this.reconciliation.values()].some(
        (slot) =>
          slot.launch?.agentParams?.kind === "hermes" &&
          slot.launch.agentParams.profile === params.profile,
      )
    ) {
      return Promise.reject(
        new CommandRefused(
          `Hermes profile "${params.profile}" is already in use on this Node. Stop its orchestrator and wait for cleanup before reusing it.`,
        ),
      );
    }
    const held = [...new Map([...this.reconciliation, ...this.slots]).values()].filter(
      (slot) => slot.kind === kind,
    ).length;
    if (held >= this.maxSessions) {
      return Promise.reject(new Error(`Node is at capacity for ${kind} work`));
    }

    const activity = this.sessionActivity.get(command.sessionId) ?? {
      lastActivityAt,
      inFlightCommands: 0,
    };
    const slot: SessionSlot = {
      launch: command,
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
      ...(this.options.admission
        ? { ticket: this.options.admission.enter(`session:${command.sessionId}`) }
        : {}),
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
      const worktrees = this.options.worktrees;
      if (command.executionBinding?.worktreeId && !worktrees)
        throw new WorktreeConflict(
          "unsupported_node",
          "Managed workspace admission is not configured on this Node.",
        );
      const requestedPath =
        command.type === "start_session" && command.coordinator && worktrees
          ? await worktrees.coordinatorPath(command.sessionId)
          : command.localPath;
      const cwd = await this.validatePath(requestedPath);
      if (worktrees) {
        const checkout = await worktrees.checkoutIdentity(cwd);
        const binding = command.executionBinding?.worktreeId
          ? command.executionBinding
          : undefined;
        if (
          binding &&
          (binding.checkoutKey !== checkout.key ||
            binding.cwd !== cwd ||
            command.localPath !== binding.cwd)
        ) {
          throw new WorktreeConflict(
            "binding_mismatch",
            "The launch path does not match the resolved physical checkout.",
          );
        }
        worktrees.assertManagedPathBound(checkout, binding);
        if (binding) {
          await worktrees.validateExecution(binding);
          slot.binding = binding;
          this.bindings.set(command.sessionId, binding);
        }
      }
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
      if (worktrees && additionalDirectories.length) {
        const identities = await Promise.all(
          additionalDirectories.map((path) => worktrees.checkoutIdentity(path)),
        );
        if (
          slot.binding?.worktreeId &&
          identities.some((identity) => identity.key !== slot.binding!.checkoutKey)
        ) {
          throw new WorktreeConflict(
            "additional_checkout",
            "A managed task cannot load additional source checkouts.",
          );
        }
        for (const identity of identities.sort((a, b) => a.key.localeCompare(b.key))) {
          if (slot.leases?.some((lease) => lease.key === identity.key)) continue;
          worktrees.assertManagedPathBound(identity);
        }
      }
      if (this.options.repositories) {
        const participation = await this.options.repositories.participate(
          [cwd, ...additionalDirectories],
          `session:${command.sessionId}`,
        );
        slot.participation = participation.leases;
        slot.supervisedParticipation = participation.supervised;
      }
      if (slot.binding && worktrees) {
        slot.leases = [
          worktrees.locks.acquire(await worktrees.checkoutIdentity(cwd), {
            owner: `session:${command.sessionId}`,
            attempt: slot.binding.leaseAttempt,
            kind: "worker",
          }),
        ];
      }
      await this.revalidate(slot, command.executionBinding);
      slot.ticket?.revalidate();
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
        (command.agentParams?.kind ?? "copilot") === "copilot" ? command.agent : "",
        await this.agentCatalog(),
      );
      if (requested.reason) {
        this.warn(`session ${command.sessionId.slice(0, 8)}: ${requested.reason}`);
      }
      slot.launch = command;
      slot.cwd = cwd;
      slot.additionalDirectories = additionalDirectories;
      slot.selectedAgent = requested.selected;
      slot.ticket?.revalidate();
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
                ...(command.agentParams ? { agentParams: command.agentParams } : {}),
                resumeAgentSessionId: command.agentSessionId,
                ...(command.contextOverflowRecoveryPrompt
                  ? {
                      contextOverflowRecoveryPrompt:
                        command.contextOverflowRecoveryPrompt,
                    }
                  : {}),
                additionalDirectories,
                sequenceOffset: command.sequenceOffset,
                yolo: command.yolo,
                agencyMode: command.agencyMode ?? false,
                ...(command.contextTier ? { contextTier: command.contextTier } : {}),
                mcpServers,
                agent: requested.selected,
                config: command.config,
                ...this.processOwnership(slot),
              }
            : {
                ...(command.agentParams ? { agentParams: command.agentParams } : {}),
                ...(command.startupNotice
                  ? { startupNotice: command.startupNotice }
                  : {}),
                contextOverflowRecoveryPrompt: command.prompt,
                yolo: command.yolo,
                agencyMode: command.agencyMode ?? false,
                ...(command.contextTier ? { contextTier: command.contextTier } : {}),
                mcpServers,
                agent: requested.selected,
                config: command.config,
                ...this.processOwnership(slot),
              },
        )
        .finally(() => {
          replaying = false;
        });
      slot.agent = agent;
      if (this.slots.get(command.sessionId) !== slot || slot.terminalEvent) {
        throw new Error("Session terminated during startup");
      }
      // A resumed session waits for the operator's next prompt.
      if (command.type === "start_session" && !slot.terminalEvent) {
        if (this.options.leadDeliveries?.reserved(command.sessionId, slot.agentSessionId))
          throw new CommandRefused(
            "This native conversation has an unresolved durable prompt handoff.",
          );
        void this.withActivity(slot, () => agent.prompt(command.prompt))
          .catch(() => this.quiesce(command.sessionId, slot))
          .catch((error: unknown) => this.warn(String(error)));
      }
    } catch (error) {
      if (error instanceof AgentStartupCleanupError) slot.agent = error.agent;
      try {
        await this.quiesce(command.sessionId, slot);
      } catch (cleanupError) {
        this.reconciliation.set(command.sessionId, slot);
        if (this.slots.get(command.sessionId) === slot)
          this.slots.delete(command.sessionId);
        throw new AggregateError([error, cleanupError], String(error), {
          cause: cleanupError,
        });
      }
      throw error;
    } finally {
      if (!automaticResume) this.noteActivity(slot);
      slot.initializing = false;
      if (slot.terminalEvent && this.slots.get(command.sessionId) === slot) {
        void this.quiesce(command.sessionId, slot).catch((error: unknown) =>
          this.warn(
            error instanceof Error ? error.message : "Process quiescence is unknown.",
          ),
        );
      }
    }
  }

  private release(sessionId: string, slot: SessionSlot): void {
    const errors: unknown[] = [];
    for (const lease of [
      ...(slot.leases ?? []),
      ...[...(slot.participation ?? [])].reverse(),
    ]) {
      try {
        lease.release();
      } catch (error) {
        errors.push(error);
        try {
          lease.requireReconciliation(String(error));
        } catch (persistError) {
          errors.push(persistError);
        }
      }
    }
    if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
    if (errors.length) {
      this.reconciliation.set(sessionId, slot);
      if (slot.binding) {
        try {
          this.options.worktrees!.requireReconciliation(
            slot.binding,
            errors.map(String).join("; "),
          );
        } catch (error) {
          errors.push(error);
        }
      }
      throw new AggregateError(errors, "Checkout remains locked for reconciliation.");
    }
    if (this.reconciliation.get(sessionId) === slot)
      this.reconciliation.delete(sessionId);
    slot.ticket?.release();
  }

  private processOwnership(slot: SessionSlot) {
    const leases = [
      ...(slot.leases ?? []),
      ...(slot.supervisedParticipation ? (slot.participation ?? []) : []),
    ];
    if (!leases.length) return {};
    return {
      processStarting: () => {
        for (const lease of leases) lease.processPending();
      },
      processStarted: (pid: number) => {
        for (const lease of leases) lease.processStarted(pid);
      },
      processesQuiesced: () => {
        for (const lease of leases) lease.processesQuiesced();
      },
    };
  }

  private async revalidate(
    slot: SessionSlot,
    expected?: ExecutionBinding,
  ): Promise<void> {
    for (const lease of slot.participation ?? []) await lease.revalidate();
    if (!slot.binding) {
      if (expected?.worktreeId)
        throw new WorktreeConflict(
          "binding_mismatch",
          "A legacy session cannot adopt a managed checkout.",
        );
      return;
    }
    const binding = slot.binding;
    if (
      slot.binding.worktreeId &&
      (!expected ||
        expected.worktreeId !== slot.binding.worktreeId ||
        expected.generation !== slot.binding.generation ||
        expected.checkoutKey !== slot.binding.checkoutKey ||
        expected.cwd !== slot.binding.cwd ||
        expected.sourcePlacementId !== slot.binding.sourcePlacementId ||
        expected.accessClass !== slot.binding.accessClass ||
        expected.quarantined !== slot.binding.quarantined ||
        expected.leaseAttempt !== slot.binding.leaseAttempt)
    ) {
      throw new WorktreeConflict(
        "binding_mismatch",
        "Prompt/load binding does not match the task's checkout lease.",
      );
    }
    await this.options.worktrees!.validateExecution(slot.binding);
    for (const lease of slot.leases ?? []) await lease.revalidate();
    if (slot.binding !== binding || slot.quiescing)
      throw new WorktreeConflict(
        "binding_mismatch",
        "Checkout lease changed during command admission.",
      );
  }

  private async reattach(
    command: Extract<LaunchCommand, { type: "resume_session" }>,
    slot: SessionSlot,
  ): Promise<void> {
    const previous = slot.binding!;
    const next = command.executionBinding;
    if (
      !next ||
      slot.agentSessionId !== command.agentSessionId ||
      command.localPath !== previous.cwd ||
      slot.retiredAttempts?.has(next.leaseAttempt) ||
      next.sourcePlacementId !== previous.sourcePlacementId ||
      next.accessClass !== previous.accessClass ||
      next.quarantined !== previous.quarantined
    )
      throw new WorktreeConflict(
        "binding_mismatch",
        "Resume does not own this conversation's checkout.",
      );
    await this.revalidate(slot, { ...next, leaseAttempt: previous.leaseAttempt });
    if (this.slots.get(command.sessionId) !== slot || slot.binding !== previous)
      throw new WorktreeConflict(
        "binding_mismatch",
        "Session changed during reattachment.",
      );
    if (next.leaseAttempt === previous.leaseAttempt) {
      slot.agent?.resync();
      return;
    }
    // Managed sessions hold exactly one physical checkout. The synchronous CAS
    // and binding replacement cannot interleave with another command.
    if (slot.leases?.length !== 1)
      throw new WorktreeConflict(
        "binding_mismatch",
        "Managed checkout lease is missing.",
      );
    slot.leases[0]!.reattach(
      `session:${command.sessionId}`,
      previous.leaseAttempt,
      next.leaseAttempt,
    );
    (slot.retiredAttempts ??= new Set()).add(previous.leaseAttempt);
    slot.binding = next;
    if (slot.launch) slot.launch = { ...slot.launch, executionBinding: next };
    this.bindings.set(command.sessionId, next);
    slot.agent?.resync();
  }

  private quiesce(sessionId: string, slot: SessionSlot, announce = false): Promise<void> {
    if (slot.quiescing) return slot.quiescing;
    slot.quiescing = Promise.resolve()
      .then(async () => {
        const errors: unknown[] = [];
        let stopped = false;
        try {
          await slot.agent?.stop(announce && !slot.silentReplacement);
          stopped = true;
        } catch (error) {
          errors.push(error);
        }
        try {
          // Without a managed lease, a failed stop must not manufacture a
          // terminal receipt and free the Host's legacy placement reservation.
          if (stopped || slot.binding?.worktreeId || slot.supervisedParticipation)
            this.release(sessionId, slot);
        } catch (error) {
          errors.push(error);
        } finally {
          if (
            stopped &&
            announce &&
            slot.silentReplacement &&
            !slot.terminalEmitted &&
            !slot.terminalEvent
          ) {
            slot.terminalEvent = {
              eventId: `stopped-${sessionId}-${++slot.sequenceOffset}`,
              sessionId,
              sequence: slot.sequenceOffset,
              type: "state",
              payload: { state: "stopped", activity: "Process stopped" },
              createdAt: new Date().toISOString(),
            };
          }
          if (
            errors.length &&
            slot.binding?.worktreeId &&
            slot.agent &&
            !slot.terminalEvent &&
            !slot.terminalEmitted
          ) {
            slot.terminalEvent = {
              eventId: `quiescence-failed-${sessionId}-${++slot.sequenceOffset}`,
              sessionId,
              sequence: slot.sequenceOffset,
              type: "state",
              payload: {
                state: "failed",
                activity: "Process cleanup failed; ownership requires reconciliation",
              },
              createdAt: new Date().toISOString(),
            };
          }
          const terminal = slot.terminalEvent;
          delete slot.terminalEvent;
          if (terminal && !slot.terminalEmitted) {
            slot.terminalEmitted = true;
            this.emit(terminal);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, errors.map(String).join("; "));
      })
      .finally(() => {
        delete slot.quiescing;
      });
    return slot.quiescing;
  }

  private handleSessionEvent(
    sessionId: string,
    slot: SessionSlot,
    generation: number,
    event: SessionEvent,
  ): void {
    if (slot.generation !== generation || this.slots.get(sessionId) !== slot) return;
    if (slot.mcpRecovery) {
      event = { ...event, sequence: Math.max(event.sequence, slot.sequenceOffset + 1) };
    }
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
          `session ${sessionId.slice(0, 8)}: Fleet MCP tools were lost; restarting ${agentKindLabels[slot.launch?.agentParams?.kind ?? "copilot"]} after the current turn`,
        );
      }
      if (toolCallId && (tool.status === "completed" || tool.status === "failed")) {
        slot.toolTitles.delete(toolCallId);
      }
    }
    const state = eventPayload(event, "state")?.state;
    if (
      slot.deliveryId &&
      event.type === "turn_complete" &&
      !event.payload.historyReplay &&
      event.sequence > (slot.deliverySequence ?? 0)
    ) {
      this.options.leadDeliveries?.settle(slot.deliveryId, slot.agentSessionId ?? "");
      delete slot.deliveryId;
      delete slot.deliverySequence;
    }
    if (slot.deliveryId && state && terminalSessionStates.has(state))
      this.options.leadDeliveries?.uncertain(
        slot.deliveryId,
        "Native session ended before authoritative delivery settlement.",
      );
    if (
      state &&
      terminalSessionStates.has(state) &&
      (slot.leases?.length || slot.supervisedParticipation || slot.initializing)
    ) {
      slot.terminalEvent ??= event;
      if (!slot.initializing)
        void this.quiesce(sessionId, slot).catch((error: unknown) =>
          this.warn(
            error instanceof Error ? error.message : "Process quiescence is unknown.",
          ),
        );
      return;
    }
    if (
      state === "idle" &&
      slot.refreshMcpPending &&
      !this.deleting.has(sessionId) &&
      !slot.stopping &&
      !this.options.admission?.reason &&
      !this.options.leadDeliveries?.reserved(sessionId, slot.agentSessionId)
    ) {
      slot.refreshMcpPending = false;
      // Do not invite a scheduler wake between turn completion and MCP recovery.
      this.emit({
        ...event,
        payload: {
          ...event.payload,
          state: "running",
          activity: "Restoring MCP tools",
          historyReplay: true,
        },
      });
      void this.restartSession(sessionId, slot);
      return;
    }
    if (state && terminalSessionStates.has(state)) slot.terminalEmitted = true;
    this.emit(event);
    if (state && terminalSessionStates.has(state)) this.release(sessionId, slot);
  }

  private async restartSession(
    sessionId: string,
    slot: SessionSlot,
    contextTier?: ContextTier,
  ): Promise<void> {
    if (this.deleting.has(sessionId)) return;
    if (
      this.options.admission?.reason ||
      this.options.leadDeliveries?.reserved(sessionId, slot.agentSessionId)
    ) {
      if (contextTier !== undefined)
        throw new CommandRefused(
          "Session has a durable prompt reservation or Node maintenance is active.",
        );
      slot.refreshMcpPending = true;
      return;
    }
    if (contextTier === undefined) return this.recoverMcpSession(sessionId, slot);
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
        !slot.agentSessionId
      ) {
        throw new CommandRefused(
          "Session cannot be restarted without its saved conversation",
        );
      }
      if (current.busy) {
        current.resync();
        throw new CommandRefused("Wait for the current turn before changing context");
      }
      await this.replaceAgent(sessionId, slot, contextTier);
    });
    const handled = refresh.catch((error) => {
      if (error instanceof CommandRefused) throw error;
      const purpose = "change context window";
      this.warn(
        `session ${sessionId.slice(0, 8)}: could not ${purpose}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      this.failReplacement(
        sessionId,
        slot,
        `${agentKindLabels[slot.launch?.agentParams?.kind ?? "copilot"]} could not be restarted to ${purpose}`,
      );
      throw error;
    });
    slot.refreshing = handled;
    slot.ready = handled;
    try {
      await handled;
    } finally {
      if (slot.refreshing === handled) delete slot.refreshing;
      if (slot.ready === handled) slot.ready = Promise.resolve();
    }
  }

  private publishRecoveryState(
    sessionId: string,
    slot: SessionSlot,
    state: "running" | "idle" | "failed",
    activity: string,
  ): void {
    this.emit({
      eventId: `mcp-recovery-${sessionId}-${++slot.sequenceOffset}`,
      sessionId,
      sequence: slot.sequenceOffset,
      type: "state",
      payload: {
        state,
        activity,
        ...(state === "failed" ? {} : { historyReplay: true }),
      },
      createdAt: new Date().toISOString(),
    });
  }

  private failReplacement(sessionId: string, slot: SessionSlot, activity: string): void {
    if (this.slots.get(sessionId) !== slot) return;
    ++slot.generation;
    if (slot.agent) {
      // Unknown process ownership must survive failure and refuse another launch.
      for (const lease of [...(slot.leases ?? []), ...(slot.participation ?? [])]) {
        try {
          lease.requireReconciliation(activity);
        } catch (error) {
          const reason = `MCP recovery ownership could not be persisted: ${String(error)}`;
          this.options.admission?.quarantine(reason);
          this.warn(reason);
        }
      }
      this.reconciliation.set(sessionId, slot);
      this.slots.delete(sessionId);
    } else {
      try {
        this.release(sessionId, slot);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        activity = `MCP recovery blocked: ${detail}`;
        this.warn(`session ${sessionId.slice(0, 8)}: ${activity}`);
      }
    }
    slot.terminalEmitted = true;
    this.publishRecoveryState(sessionId, slot, "failed", activity);
  }

  private async recoverMcpSession(sessionId: string, slot: SessionSlot): Promise<void> {
    if (slot.refreshing) return slot.refreshing;
    if (slot.stopping || this.draining || this.deleting.has(sessionId)) return;
    const controller = new AbortController();
    const { signal } = controller;
    slot.mcpRecovery = controller;
    const recovery = slot.ready.then(async () => {
      if (
        !slot.launch?.mcpServers.length ||
        !slot.agentSessionId ||
        !slot.cwd ||
        this.slots.get(sessionId) !== slot ||
        signal.aborted
      )
        return;
      if (slot.agent?.busy) {
        slot.refreshMcpPending = true;
        return;
      }
      slot.refreshMcpPending = false;
      for (let attempt = 0; attempt <= MCP_RECOVERY_DELAYS_MS.length; attempt++) {
        try {
          if (attempt > 0)
            await recoveryDelay(MCP_RECOVERY_DELAYS_MS[attempt - 1]!, signal);
          signal.throwIfAborted();
          if (this.slots.get(sessionId) !== slot) return;
          this.publishRecoveryState(
            sessionId,
            slot,
            "running",
            `Restoring MCP tools (attempt ${attempt + 1}/${MCP_RECOVERY_DELAYS_MS.length + 1})`,
          );
          await this.mcpConnection.wait(signal);
          signal.throwIfAborted();
          if (this.slots.get(sessionId) !== slot) return;
          if (attempt === 0 && slot.agent?.busy) {
            slot.refreshMcpPending = true;
            return;
          }
          await this.replaceAgent(sessionId, slot, undefined, signal);
          signal.throwIfAborted();
          this.publishRecoveryState(
            sessionId,
            slot,
            slot.agent?.busy ? "running" : "idle",
            slot.agent?.busy
              ? `MCP tools restored; ${agentKindLabels[slot.launch?.agentParams?.kind ?? "copilot"]} is working`
              : "MCP tools restored; ready for follow-up",
          );
          return;
        } catch (error) {
          ++slot.generation;
          if (signal.aborted) return;
          if (this.slots.get(sessionId) !== slot) return;
          const detail = error instanceof Error ? error.message : String(error);
          this.warn(
            `session ${sessionId.slice(0, 8)}: MCP recovery attempt ${attempt + 1} failed: ${detail}`,
          );
          const admissionBlocked =
            error instanceof WorktreeConflict || error instanceof CommandRefused;
          if (admissionBlocked || attempt === MCP_RECOVERY_DELAYS_MS.length) {
            this.failReplacement(
              sessionId,
              slot,
              admissionBlocked
                ? `MCP recovery blocked: ${detail}`
                : slot.agent
                  ? `MCP recovery blocked: process shutdown could not be verified. ${detail}`
                  : `MCP recovery exhausted after ${attempt + 1} attempts. Resume to retry. ${detail}`,
            );
            return;
          }
          this.publishRecoveryState(
            sessionId,
            slot,
            "running",
            `MCP recovery retry in ${MCP_RECOVERY_DELAYS_MS[attempt]! / 1000}s: ${detail}`,
          );
        }
      }
    });
    slot.refreshing = recovery;
    slot.ready = recovery;
    try {
      await recovery;
    } finally {
      if (slot.mcpRecovery === controller) delete slot.mcpRecovery;
      if (slot.refreshing === recovery) delete slot.refreshing;
      if (slot.ready === recovery) slot.ready = Promise.resolve();
    }
  }

  private async replaceAgent(
    sessionId: string,
    slot: SessionSlot,
    contextTier?: ContextTier,
    signal?: AbortSignal,
  ): Promise<void> {
    const launch = slot.launch!;
    slot.silentReplacement = true;
    const generation = ++slot.generation;
    const nextContextTier = contextTier ?? launch.contextTier;
    await this.revalidate(slot, slot.binding);
    slot.ticket?.revalidate();
    signal?.throwIfAborted();
    await slot.agent?.stop(false);
    slot.agent = undefined;
    if (signal) await this.mcpConnection.wait(signal);
    await this.revalidate(slot, slot.binding);
    slot.ticket?.revalidate();
    signal?.throwIfAborted();
    if (this.slots.get(sessionId) !== slot || slot.stopping || this.draining)
      throw new CommandRefused("Session is being stopped");
    let replaying = true;
    try {
      const next = await this.factory.start(
        sessionId,
        slot.cwd!,
        (event) => {
          if (slot.generation !== generation || this.slots.get(sessionId) !== slot)
            return;
          // Router recovery notices also consume sequence numbers between agent events.
          event = {
            ...event,
            sequence: Math.max(event.sequence, slot.sequenceOffset + 1),
          };
          const startupState = eventPayload(event, "state")?.state;
          if (
            replaying &&
            event.type === "state" &&
            (signal || (startupState && terminalSessionStates.has(startupState)))
          ) {
            slot.sequenceOffset = Math.max(slot.sequenceOffset, event.sequence);
            return;
          }
          this.handleSessionEvent(
            sessionId,
            slot,
            generation,
            replaying
              ? { ...event, payload: { ...event.payload, historyReplay: true } }
              : event,
          );
        },
        {
          ...(launch.agentParams ? { agentParams: launch.agentParams } : {}),
          resumeAgentSessionId: slot.agentSessionId!,
          contextOverflowRecoveryPrompt:
            launch.type === "start_session"
              ? launch.prompt
              : (launch.contextOverflowRecoveryPrompt ?? ""),
          additionalDirectories: slot.additionalDirectories ?? [],
          sequenceOffset: slot.sequenceOffset,
          yolo: launch.yolo,
          agencyMode: launch.agencyMode ?? false,
          ...(nextContextTier ? { contextTier: nextContextTier } : {}),
          mcpServers: resolveMcpServers(launch.mcpServers, this.hostUrl()),
          agent: slot.selectedAgent ?? "",
          config: [...slot.config].map(([id, value]): StartupConfig => ({ id, value })),
          announceLifecycle: false,
          ...(signal ? { signal, allowResumeRollover: false } : {}),
          ...this.processOwnership(slot),
        },
      );
      slot.agent = next;
      signal?.throwIfAborted();
      if (this.slots.get(sessionId) !== slot) {
        await next.stop(false);
        return;
      }
      slot.silentReplacement = false;
      if (contextTier !== undefined) slot.launch = { ...launch, contextTier };
    } catch (error) {
      if (error instanceof AgentStartupCleanupError) slot.agent = error.agent;
      throw error;
    } finally {
      replaying = false;
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
