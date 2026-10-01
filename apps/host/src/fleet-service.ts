import { createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import {
  BrowserMessageSchema,
  agentKindLabels,
  supportsAgentKind,
  CONTEXT_TIER_CONFIG_ID,
  ContextTierSchema,
  HOST_URL_SYNC_CAPABILITY,
  HostToNodeMessageSchema,
  MANAGED_WORKTREES_CAPABILITY,
  WorktreeConflict,
  NODE_NAME_SYNC_CAPABILITY,
  ORCHESTRATOR_STOP_REASON,
  SELF_UPDATE_CAPABILITY,
  canTransition,
  canTransitionRun,
  canTransitionRunStep,
  eventPayload,
  liveSessionStates,
  nodeUpdateState,
  prMaintenanceTaskStatuses,
  terminalRunStepStates,
  terminalSessionStates,
  type BrowserMessage,
  type AgentParams,
  type FleetNode,
  type FleetSession,
  type HostBackup,
  type HostPortableBackupData,
  type HostUpdateStatus,
  type McpHttpServer,
  type NodeCommand,
  type NodeHealth,
  type NodeUpdateStage,
  type Notification,
  type Placement,
  type PromptAttachment,
  type PrMaintenanceRegistration,
  type StartupConfig,
  type Run,
  type RunRole,
  type RunStep,
  type SecurityBackupPayload,
  type RunStepState,
  type SessionEvent,
  type SessionState,
  type Snapshot,
  type ExecutionBinding,
} from "@fleet/protocol";
import type {
  FleetStore,
  RevokedSession,
  SessionTransitionIntent,
  SessionTurnCompletion,
} from "./store.js";
import { isBroadcastableHostUrl } from "./host-url.js";
import { SessionRetention } from "./session-retention.js";
import { ManagedWorktreeService } from "./managed-worktree-service.js";
import { CommandExecutionService } from "./command-execution-service.js";
import { SessionFileService } from "./session-files.js";
import { CommandConflict } from "./command-execution-store.js";
import { PR_MAINTENANCE_WAKE_INSTRUCTION } from "./orchestrator/briefing.js";
import { PrMaintenanceError, type SupervisorCommand } from "./pr-maintenance-store.js";
import type { WorkerResumeService } from "./orchestrator/resume-now.js";
import {
  NotificationService,
  notificationAttemptKey,
  type EffectiveSessionNotificationPreference,
  type NotificationAttemptContext,
  type NotificationMutation,
} from "./notifications/service.js";
import {
  capacityFor,
  reservedSessionCount,
  yoloUnsupportedReason,
} from "./session-policy.js";

/**
 * The agent an orchestrator is put into, when its machine carries one.
 *
 * A name shared with the Node's built-in catalog rather than a definition:
 * changing how the orchestrator thinks is a change to that markdown file, not
 * to the Host.
 */
export const ORCHESTRATOR_AGENT = "fleet-orchestrator";

/** `Omit` over a union has to be distributed, or the discriminant collapses. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** The service stamps the command id, so no caller can forget one. */
export type CommandRequest = DistributiveOmit<NodeCommand, "commandId">;

/** What to do with the session when its Node turns out to be unreachable. */
export type DispatchFallback = { state: SessionState; activity: string };

/**
 * One end of a Node connection, as everything outside the gateway sees it.
 *
 * Narrower than a WebSocket on purpose: the gateway hands over a sealing
 * wrapper for a mutually authenticated Node and the raw socket for a legacy
 * one, and nothing here should be able to tell — or reach past the wrapper to
 * the socket underneath it.
 */
export type NodeLink = {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type DispatchResult = {
  sent: boolean;
  /** The session after the fallback transition, when one was applied. */
  session?: FleetSession;
};

/** What the service needs from the Host's own update (`self-update.ts`). */
export type HostUpdateHooks = {
  status(): HostUpdateStatus;
  /** Why this Node may not update on its own right now, if it may not. */
  blocksNodeUpdate(nodeId: string): string | undefined;
  /** Why a session may not start or resume on this Node right now, if it may not. */
  blocksNodeWork(nodeId: string): string | undefined;
};

export type EventHandlingResult =
  | { outcome: "accepted" }
  | {
      outcome: "permanent_rejection";
      reason: "session_missing" | "identity_conflict" | "sqlite_constraint";
    }
  | { outcome: "retryable_failure" };

type HostTransitionCause =
  | "resume_requested"
  | "dispatch_fallback"
  | "operator_cancel_requested"
  | "operator_settlement"
  | "automatic_resume"
  | "connectivity_lost";

type AcceptedSessionTransitionSource =
  | {
      type: "session_event";
      event: Pick<SessionEvent, "eventId" | "sequence" | "createdAt">;
    }
  | {
      type: "fatal_command_result";
      commandId: string;
      createdAt: string;
    }
  | {
      type: "reconciliation";
      outcome: "restored" | "missing";
    }
  | {
      type: "host";
      cause: HostTransitionCause;
    };

type AcceptedSessionTransition = {
  before: FleetSession;
  after: FleetSession;
  source: AcceptedSessionTransitionSource;
  intent: SessionTransitionIntent | undefined;
  completion: SessionTurnCompletion | undefined;
  context: NotificationAttemptContext;
};

/**
 * Everything that touches more than one part of the fleet at once: the socket
 * registries, what gets published to browsers, and the command/transition
 * choreography.
 *
 * It exists because "send a command, and if the Node is gone move the session
 * to a fallback state and tell every browser about it" was written out four
 * times inside one 800-line closure, each copy free to drift — and none of it
 * reachable from a test.
 */
export class FleetService {
  /**
   * What the service needs from a Node connection, which is not a WebSocket.
   *
   * A mutually authenticated Node is spoken to through a sealing wrapper rather
   * than the raw socket, so every existing path — dispatch, host_url, renames,
   * update requests — is encrypted by construction instead of by each caller
   * remembering to encrypt. A `ws` socket satisfies this shape as it is, which
   * is what keeps the legacy protocol working unchanged.
   */
  private readonly nodeSockets = new Map<string, NodeLink>();
  private readonly browserSockets = new Set<WebSocket>();
  /** Latest observations only: no history, database writes, or backup telemetry. */
  private readonly nodeHealth = new Map<string, NodeHealth>();
  /**
   * Nodes told to update that have not yet reported how it went.
   *
   * A Node's last word before an update is "restarting", sent immediately
   * before it exits: there is nobody left to send anything after that. The Host
   * has to notice the return itself, so it remembers which Nodes owe it one.
   */
  private readonly updatesInFlight = new Map<
    string,
    {
      updateId: string;
      previousRevision: string;
      restarting: boolean;
      expectedRevision?: string;
    }
  >();
  /** Suppresses disconnect bookkeeping while the Host itself is shutting down. */
  private closing = false;
  /**
   * Who wants to hear about session events.
   *
   * A set of callbacks rather than a direct call into the orchestrator, so the
   * service stays unaware that orchestration exists — `server.ts` is the only
   * place that knows both halves.
   */
  private readonly sessionEventListeners = new Set<(event: SessionEvent) => void>();
  /**
   * Set by `server.ts` once the MCP endpoint and the engine exist.
   *
   * Late-bound rather than constructor arguments because the service is built
   * before both of them, and it must stay unaware of orchestration otherwise —
   * these are the two seams, and they are the only two.
   */
  private leadTokens:
    | { mint: (subject: { sessionId: string; runId: string; nodeId: string }) => string }
    | undefined;
  private mcpUrl: (() => string) | undefined;
  private runTicker: ((runId: string) => void) | undefined;
  /**
   * "Resume now" and step admission, owned by the orchestration engine.
   *
   * Late-bound like the other orchestration seams; absent in a service built
   * without an engine, where steps are published without admission.
   */
  workerResume: WorkerResumeService | undefined;
  /** Late-bound like the orchestration seams: built after the service. */
  private hostUpdate: HostUpdateHooks | undefined;
  readonly notifications: NotificationService;
  readonly sessionRetention: SessionRetention;
  readonly worktrees: ManagedWorktreeService;
  readonly commands: CommandExecutionService;
  readonly files: SessionFileService;

  /** Wires the orchestration seams. Called once, from `server.ts`. */
  attachOrchestration(input: {
    leadTokens: {
      mint: (subject: { sessionId: string; runId: string; nodeId: string }) => string;
    };
    mcpUrl: () => string;
    tickRun: (runId: string) => void;
    resume?: WorkerResumeService;
  }): void {
    this.leadTokens = input.leadTokens;
    this.mcpUrl = input.mcpUrl;
    this.runTicker = input.tickRun;
    this.workerResume = input.resume;
  }

  /** Advances one run now, used by the tools so a dispatch is not left waiting. */
  tickRun(runId: string): void {
    this.runTicker?.(runId);
  }

  /** Why nothing new may start on this Node right now, if something prevents it. */
  nodeWorkBlocked(nodeId: string): string | undefined {
    return this.hostUpdate?.blocksNodeWork(nodeId);
  }

  logManagedPlacementScheduling(details: Record<string, unknown>, message: string): void {
    this.log.info(details, message);
  }

  constructor(
    readonly store: FleetStore,
    private readonly log: FastifyBaseLogger,
    /**
     * The commit this Host runs, which is what Nodes are compared against.
     *
     * A function is read at access time rather than frozen at construction: a
     * commit moves HEAD without touching a file, so nothing restarts the Host,
     * and a captured value would go on describing a commit the Host has left —
     * marking every node that updated correctly as out of date.
     */
    private readonly revisionSource: string | (() => string) = "",
    sessionRetentionDays?: number,
  ) {
    this.notifications = new NotificationService(store, {
      notificationUpsert: (notification) => this.publishNotification(notification),
      notificationUnreadCount: (unreadCount) =>
        this.publishNotificationUnreadCount(unreadCount),
      runUpsert: (run) => this.publishRun(run),
    });
    this.sessionRetention = new SessionRetention(this, log, sessionRetentionDays);
    this.worktrees = new ManagedWorktreeService(this);
    this.commands = new CommandExecutionService(this);
    this.files = new SessionFileService(this);
    this.commands.reconcileNotifications();
  }

  snapshot(): Snapshot {
    return {
      nodes: this.listNodes(),
      workspaces: this.store.listWorkspaces(),
      placements: this.store.listPlacements(),
      sessions: this.store.listSessions(),
      runs: this.store.listRuns(),
      notifications: this.store.listNotificationHydration(),
      notificationUnreadCount: this.store.notificationUnreadCount(),
      hostRevision: this.hostRevision,
      ...(this.hostUpdate ? { hostUpdate: this.hostUpdate.status() } : {}),
      commandExecutions: this.commands.list({ limit: 100 }),
      prMaintenanceApprovals: this.store.prMaintenance.listApprovals(),
      prMaintenanceTasks: prMaintenanceTaskStatuses(this.retainedPrMaintenance()),
      workerResumeRequests: this.store.resumeRequests.list({ limit: 50 }),
    };
  }

  private retainedPrMaintenance(): PrMaintenanceRegistration[] {
    const records: PrMaintenanceRegistration[] = [];
    let cursor: string | undefined;
    do {
      const page = this.store.prMaintenance.list({
        retainedOnly: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor);
    return records;
  }

  listNodes(): FleetNode[] {
    return this.store.listNodes().map((node) => this.withNodeHealth(node));
  }

  private withNodeHealth(node: FleetNode): FleetNode {
    const health = this.nodeHealth.get(node.id);
    return health ? { ...node, health } : node;
  }

  get hostRevision(): string {
    return typeof this.revisionSource === "function"
      ? this.revisionSource()
      : this.revisionSource;
  }

  addBrowser(socket: WebSocket): void {
    this.browserSockets.add(socket);
  }

  removeBrowser(socket: WebSocket): void {
    this.browserSockets.delete(socket);
  }

  nodeSocket(nodeId: string): NodeLink | undefined {
    return this.nodeSockets.get(nodeId);
  }

  attachNode(nodeId: string, socket: NodeLink): void {
    this.sessionRetention.nodeDisconnected(nodeId);
    this.nodeHealth.delete(nodeId);
    this.nodeSockets.set(nodeId, socket);
  }

  /** Hangs up on a Node the operator deleted; no session bookkeeping follows. */
  evictNode(nodeId: string, code: number, reason: string): void {
    this.commands.nodeDisconnected(nodeId);
    this.files.nodeDisconnected(nodeId);
    this.nodeHealth.delete(nodeId);
    const socket = this.nodeSockets.get(nodeId);
    if (!socket) return;
    this.nodeSockets.delete(nodeId);
    socket.close(code, reason);
  }

  /**
   * Drops every Node socket without touching session rows.
   *
   * Used before a backup replace: the catalog is about to be wiped, so marking
   * the old sessions offline would only race the delete. Removing the socket
   * from the map first means the close handler will not call disconnectNode.
   */
  evictAllNodes(code: number, reason: string): void {
    this.nodeHealth.clear();
    for (const [nodeId, socket] of [...this.nodeSockets.entries()]) {
      this.commands.nodeDisconnected(nodeId);
      this.files.nodeDisconnected(nodeId);
      this.sessionRetention.nodeDisconnected(nodeId);
      this.nodeSockets.delete(nodeId);
      socket.close(code, reason);
    }
  }

  /**
   * Replaces the catalog with a Host archive and tells every browser.
   *
   * Nodes are hung up first so they cannot append events into the new rows
   * under ids that no longer mean what they did a moment ago.
   */
  importHostBackup(backup: HostBackup): void {
    this.store.commands.assertRestoreAllowed();
    this.store.assertNoSessionCleanup();
    this.commands.revokeAllSessionGrants();
    this.evictAllNodes(4002, "Host restored from backup");
    this.store.replaceHostBackup(backup);
    this.commands.reconcileNotifications();
    this.broadcast({ type: "snapshot", data: this.snapshot() });
  }

  /**
   * Becomes the Host a portable archive describes, and hangs up on everything
   * that was talking to the one it used to be.
   *
   * Nodes are dropped for the same reason a data restore drops them, and the
   * sessions this returns are the browser sessions the store revoked — their
   * sockets are closed by the caller, which is the half of a revocation that
   * a database row cannot do.
   */
  importPortableBackup(input: {
    data: HostPortableBackupData;
    security: SecurityBackupPayload;
  }): { revokedSessions: RevokedSession[] } {
    this.store.commands.assertRestoreAllowed();
    this.store.assertNoSessionCleanup();
    this.commands.revokeAllSessionGrants();
    this.evictAllNodes(4002, "Host restored from a portable backup");
    const result = this.store.importPortableBackup(input);
    this.commands.reconcileNotifications();
    return result;
  }

  /** Publishes after restore-time credentials and sockets have been replaced. */
  publishSnapshot(): void {
    this.broadcast({ type: "snapshot", data: this.snapshot() });
  }

  send(socket: NodeLink, message: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  broadcast(message: BrowserMessage): void {
    BrowserMessageSchema.parse(message);
    for (const socket of this.browserSockets) {
      // Slow consumers recover command bytes by durable cursor; lifecycle is not dropped.
      if (
        message.type === "command_execution_output" &&
        socket.bufferedAmount > 1024 * 1024
      )
        continue;
      if (message.type === "command_execution" && socket.bufferedAmount > 1024 * 1024) {
        socket.close(1013, "Recover command evidence by cursor after reconnect");
        continue;
      }
      this.send(socket, message);
    }
  }

  publishNode(node: FleetNode): void {
    this.broadcast({ type: "node", node: this.withNodeHealth(node) });
  }

  publishSession(session: FleetSession): void {
    if (
      session.runRole === "lead" &&
      (terminalSessionStates.has(session.state) ||
        session.stopRequested ||
        session.cleanupRequested)
    )
      this.commands.revokeLead(session.id);
    this.broadcast({ type: "session", session });
  }

  publishSessions(sessions: readonly FleetSession[]): void {
    for (const session of sessions) this.publishSession(session);
  }

  publishRun(run: Run): void {
    this.broadcast({ type: "run", run, notes: this.store.listRunNotes(run.id) });
  }

  publishNotification(notification: Notification): void {
    this.broadcast({ type: "notification_upsert", notification });
  }

  publishNotificationUnreadCount(
    unreadCount = this.store.notificationUnreadCount(),
  ): void {
    this.broadcast({ type: "notification_unread_count", unreadCount });
  }

  effectiveNotificationPreference(
    sessionId: string,
  ): EffectiveSessionNotificationPreference | undefined {
    const session = this.store.getSession(sessionId);
    return session ? this.notifications.effectivePreference(session) : undefined;
  }

  updateNotificationPreference(
    sessionId: string,
    lifecycleEnabled: boolean,
  ): EffectiveSessionNotificationPreference | undefined {
    const session = this.store.getSession(sessionId);
    return session
      ? this.notifications.updatePreference(session, lifecycleEnabled)
      : undefined;
  }

  resetNotificationPreference(
    sessionId: string,
  ): EffectiveSessionNotificationPreference | undefined {
    const session = this.store.getSession(sessionId);
    return session ? this.notifications.resetPreference(session) : undefined;
  }

  requestRunReview(
    input: Parameters<NotificationService["requestRunReview"]>[0],
  ): Run | undefined {
    return this.notifications.requestRunReview(input);
  }

  resolveRunReview(runId: string): NotificationMutation | undefined {
    const run = this.store.getRun(runId);
    return run ? this.notifications.resolveRunReview(run) : undefined;
  }

  resolveSessionPermissionRequests(sessionId: string): number {
    return this.notifications.resolveSessionPermissionRequests(sessionId);
  }

  settleOrchestrationStep(input: {
    runId: string;
    stepId: string;
    state: RunStepState;
    output: string;
    patch?: Pick<RunStep, "dispatchedAt"> | undefined;
  }): boolean {
    const settled = this.notifications.commitAtomically(
      () => {
        const run = this.store.getRun(input.runId);
        const step = this.store.getRunStep(input.stepId);
        if (
          !run ||
          !step ||
          step.runId !== run.id ||
          !canTransitionRunStep(step.state, input.state)
        ) {
          return undefined;
        }
        const updatedStep = this.store.updateRunStep(step.id, {
          state: input.state,
          output: input.output,
          ...(input.patch ?? {}),
        });
        if (!updatedStep) return undefined;
        const maintenanceChanged = this.recordPrMaintenanceExecution(updatedStep);

        this.store.recordRunSettle(run.id);
        let updatedRun = this.store.getRun(run.id)!;
        if (
          updatedRun.policy.wakePolicy !== "none" &&
          updatedRun.state === "running" &&
          canTransitionRun(updatedRun.state, "awaiting_lead")
        ) {
          updatedRun = this.store.setRunState(run.id, "awaiting_lead")!;
        }
        if (updatedStep.sessionId) {
          this.store.clearSessionTurnCompletion(updatedStep.sessionId);
        }
        if (updatedStep.state === "failed") {
          this.notifications.createOrchestrationStepFailure(updatedRun, updatedStep);
        }
        return { run: updatedRun, step: updatedStep, maintenanceChanged };
      },
      (result) => {
        if (!result) return;
        this.publishRun(result.run);
        this.publishRunSteps(result.run.id, this.store.listRunSteps(result.run.id));
        if (result.maintenanceChanged) this.publishSnapshot();
      },
    );
    return settled !== undefined;
  }

  /**
   * Preserves a late authoritative result for a step cancelled by Stop.
   *
   * Cancelled steps are normally terminal, so this narrow reconciliation path
   * also owns the failure notification that an active run's scheduler creates.
   */
  reconcileStoppedOrchestrationStep(input: {
    runId: string;
    stepId: string;
    state: "succeeded" | "failed";
    output: string;
  }): boolean {
    const settled = this.notifications.commitAtomically(
      () => {
        const run = this.store.getRun(input.runId);
        const step = this.store.getRunStep(input.stepId);
        const session = step && this.store.getSession(step.sessionId);
        if (
          !run ||
          run.state !== "cancelled" ||
          run.failureReason !== ORCHESTRATOR_STOP_REASON ||
          !step ||
          step.runId !== run.id ||
          step.state !== "cancelled" ||
          !step.stoppedByOrchestrator ||
          !session ||
          this.store.getSessionDispatchAttempt(step.sessionId)?.attempt !==
            notificationAttemptKey(session, { step, run })
        ) {
          return undefined;
        }
        const updatedStep = this.store.updateRunStep(step.id, {
          state: input.state,
          output: input.output,
          stoppedByOrchestrator: false,
        });
        if (!updatedStep) return undefined;
        const maintenanceChanged = this.recordPrMaintenanceExecution(updatedStep);
        if (updatedStep.sessionId) {
          this.store.clearSessionTurnCompletion(updatedStep.sessionId);
        }
        if (updatedStep.state === "failed") {
          this.notifications.createOrchestrationStepFailure(run, updatedStep);
        }
        return { run, step: updatedStep, maintenanceChanged };
      },
      (result) => {
        if (!result) return;
        this.publishRunSteps(result.run.id, this.store.listRunSteps(result.run.id));
        if (result.maintenanceChanged) this.publishSnapshot();
      },
    );
    return settled !== undefined;
  }

  /** Steps travel whole: a step that was removed has no row left to describe. */
  publishRunSteps(runId: string, steps: readonly RunStep[]): void {
    this.broadcast({ type: "run_steps", runId, steps: this.withAdmission(runId, steps) });
  }

  /** Steps as browsers and REST readers see them: with what they are waiting on. */
  withAdmission(runId: string, steps: readonly RunStep[]): RunStep[] {
    return this.workerResume ? this.workerResume.decorate(runId, steps) : [...steps];
  }

  reconcilePrMaintenanceExecution(sessionId: string): void {
    const step = this.store.getRunStepBySession(sessionId);
    if (!step || !terminalRunStepStates.has(step.state)) return;
    const changed = this.store.writeAtomically(() =>
      this.recordPrMaintenanceExecution(step),
    );
    if (changed) this.publishSnapshot();
  }

  private recordPrMaintenanceExecution(step: RunStep, neverDispatched = false): boolean {
    const reference = this.store.prMaintenance.referenceForStep(step.id, step.attempts);
    if (!reference) return false;
    const record = this.store.prMaintenance.get(reference.recordId)!;
    const batch = record.batches.find((entry) => entry.id === reference.batchId)!;
    if (batch.executionSettled) return false;
    const events = this.store
      .listEvents(step.sessionId)
      .filter((event) => event.sequence > step.eventSeqFrom);
    const stateReceipt = events.filter((event) => event.type === "state").at(-1);
    const receivedState = stateReceipt
      ? eventPayload(stateReceipt, "state")?.state
      : undefined;
    const completed = events.some((event) => event.type === "turn_complete");
    const executionSettled =
      neverDispatched ||
      (receivedState !== undefined &&
        (terminalSessionStates.has(receivedState) ||
          (receivedState === "idle" && completed)));
    if (!executionSettled && batch.state === "uncertain") return false;
    const reconciled = this.store.prMaintenance.checkpoint(
      record.leadSessionId,
      record.id,
      record.version,
      {
        kind: "batch",
        batchId: batch.id,
        generation: record.generation,
        state: executionSettled ? "reconciling" : "uncertain",
        findings: batch.findings,
        effects: batch.effects,
        executionSettled,
        published: batch.published,
        evidence: executionSettled
          ? `Correlated execution receipt: step ${step.id}, attempt ${step.attempts}, state ${step.state}${neverDispatched ? "; queued dispatch was never sent" : ""}. Remote effects still require reconciliation.`
          : `Host step ${step.id}, attempt ${step.attempts}, is ${step.state} without a correlated quiescence receipt. Execution and effects remain uncertain.`,
      },
    );
    this.store.prMaintenance.checkpoint(
      reconciled.leadSessionId,
      reconciled.id,
      reconciled.version,
      {
        kind: "reconcile",
        progress: executionSettled,
        immediateCheck: executionSettled,
        evidence: `Execution reconciliation for step ${step.id}, attempt ${step.attempts}; settled=${executionSettled}.`,
      },
    );
    return true;
  }

  /** Stop only the accepted bound attempt; a stop request is not an effect receipt. */
  cancelPausedPrMaintenance(now = new Date().toISOString()): void {
    let cursor: string | undefined;
    do {
      const page = this.store.prMaintenance.list({
        retainedOnly: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const record of page.records) {
        if (record.lifecycle === "paused" && record.decision?.state !== "pending") {
          this.notifications.createPrMaintenanceAttention(record, "paused");
        }
        if (record.readyFingerprint)
          this.notifications.createPrMaintenanceAttention(record, "ready");
        for (const batch of record.batches) {
          if (!batch.cancellationRequestedAt || batch.executionSettled || !batch.stepId)
            continue;
          const step = this.store.getRunStep(batch.stepId);
          const worker = this.store.getSession(record.workerSessionId);
          if (
            !step ||
            step.attempts !== batch.attempt ||
            step.sessionId !== record.workerSessionId ||
            !worker
          )
            continue;
          const dispatch = this.store.getSessionDispatchAttempt(worker.id);
          const currentAttempt = notificationAttemptKey(worker, {
            step,
            run: this.store.getRun(record.taskId),
          });
          if (
            step.state === "pending" &&
            !step.dispatchedAt &&
            dispatch?.attempt !== currentAttempt
          ) {
            const changed = this.store.writeAtomically(() => {
              const cancelled = this.store.updateRunStep(step.id, {
                state: "cancelled",
                output: "PR maintenance paused or terminal before queued execution.",
              })!;
              return this.recordPrMaintenanceExecution(cancelled, true);
            });
            this.publishRunSteps(record.taskId, this.store.listRunSteps(record.taskId));
            if (changed) this.publishSnapshot();
          } else if (
            this.store.getNode(worker.nodeId)?.online &&
            !["idle", "offline", "completed", "stopped", "failed"].includes(
              worker.state,
            ) &&
            !this.store.getSessionTransitionIntent(worker.id)
          ) {
            this.dispatch(worker.nodeId, { type: "cancel", sessionId: worker.id });
          }
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.notifications.commitAtomically(() => {
      this.store.prMaintenance.notifyLongPauses(now, (record) => {
        this.notifications.createPrMaintenanceAttention(record, "long_pause");
      });
    });
  }

  /**
   * Announces the workspace/placement catalog after any edit to it.
   *
   * Called from every mutating route rather than derived from the store,
   * because these are now edited from node config pages too, and a browser that
   * only updated on its own writes would quietly show stale paths.
   */
  publishCatalog(): void {
    this.broadcast({
      type: "catalog",
      workspaces: this.store.listWorkspaces(),
      placements: this.store.listPlacements(),
    });
  }

  agentLaunchProblem(
    node: FleetNode,
    params: AgentParams,
    sessionId?: string,
  ): string | undefined {
    const session = sessionId ? this.store.getSession(sessionId) : undefined;
    if (params.kind !== "copilot" && session && session.runRole !== "lead") {
      return "Only orchestrators can use another agent";
    }
    if (!supportsAgentKind(node, params.kind)) {
      return `${agentKindLabels[params.kind]} is unavailable on ${node.name}. Install the agent and reconnect or upgrade this Node; existing sessions never change backend.`;
    }
    if (
      params.kind === "hermes" &&
      this.store
        .listSessions()
        .some(
          (session) =>
            session.id !== sessionId &&
            session.nodeId === node.id &&
            session.agentParams?.kind === "hermes" &&
            session.agentParams.profile === params.profile &&
            (liveSessionStates.has(session.state) ||
              session.state === "offline" ||
              session.stopRequested),
        )
    ) {
      return `Hermes profile "${params.profile}" already belongs to an active orchestrator on ${node.name}. Stop it before starting another, or select a different profile. If its Node is unavailable, verify the old process has stopped, then use Mark stopped on that conversation. Dismissal alone does not stop a process.`;
    }
    return undefined;
  }

  /**
   * Creates a session and asks its Node to start it.
   *
   * Shared by REST, orchestration and MCP so admission cannot drift by caller.
   */
  createAndStartSession(input: {
    placement: Placement;
    agentParams?: AgentParams;
    startupNotice?: string;
    prompt: string;
    yolo: boolean;
    name?: string;
    runId?: string;
    runRole?: RunRole;
    operatorUsername?: string;
    /** Work that only reads, which is counted against its own allowance. */
    readOnly?: boolean;
    /** Authoritative orchestration attempt when the step is not attached yet. */
    dispatchAttempt?: string;
    executionBinding?: ExecutionBinding;
  }):
    | { ok: true; session: FleetSession }
    | { ok: false; status: number; error: string; session?: FleetSession } {
    if (input.runRole !== "lead") {
      const maintenance = this.store.prMaintenance.admission({
        action: "dispatch",
        placementId: input.placement.id,
        ...(input.runId ? { taskId: input.runId } : {}),
        ...(input.executionBinding
          ? { checkoutKey: input.executionBinding.checkoutKey }
          : {}),
      });
      if (!maintenance.allowed) {
        return {
          ok: false,
          status: 409,
          error: `PR maintenance: ${maintenance.reason}. Use the retained worker and prepared batch.`,
        };
      }
    }
    const node = this.store.getNode(input.placement.nodeId);
    if (!node?.online) return { ok: false, status: 409, error: "Node is offline" };
    const agentParams = input.agentParams ?? { kind: "copilot" as const };
    if (agentParams.kind !== "copilot" && input.runRole !== "lead") {
      return {
        ok: false,
        status: 400,
        error: "Only orchestrators can use another agent",
      };
    }
    const agentProblem = this.agentLaunchProblem(node, agentParams);
    if (agentProblem) return { ok: false, status: 409, error: agentProblem };
    const hostUpdating = this.hostUpdate?.blocksNodeWork(node.id);
    if (hostUpdating) return { ok: false, status: 409, error: hostUpdating };
    const kind = input.readOnly ? "read-only" : "writing";
    if (
      reservedSessionCount(this.store.listSessions(), node.id, kind) >=
      capacityFor(node, kind)
    ) {
      return {
        ok: false,
        status: 409,
        error: `Node is at capacity for ${kind} work`,
      };
    }
    const unsupported = yoloUnsupportedReason(node, input.yolo);
    if (unsupported) return { ok: false, status: 409, error: unsupported };

    let binding = input.executionBinding;
    try {
      if (input.runId && input.runRole !== "lead") {
        const run = this.store.getRun(input.runId);
        if (run && !binding) binding = this.worktrees.bindingFor(run) ?? binding;
      }
    } catch (error) {
      return {
        ok: false,
        status: 409,
        error: error instanceof Error ? error.message : "Workspace unavailable",
      };
    }
    let session = this.store.createSession(
      input.placement,
      input.prompt,
      input.yolo,
      input.name ?? "",
      {
        runId: input.runId ?? "",
        runRole: input.runRole ?? "",
        readOnly: input.readOnly ?? false,
        operatorUsername: input.operatorUsername ?? "",
        agentParams,
      },
    );
    if (binding) {
      this.store.setSessionExecutionBinding(session.id, binding);
      session = this.store.getSession(session.id)!;
    }
    try {
      this.worktrees.validateSession(session);
    } catch (error) {
      this.store.transitionSession(
        session.id,
        "failed",
        error instanceof Error ? error.message : "Workspace unavailable",
      );
      return {
        ok: false,
        status: 409,
        error: error instanceof Error ? error.message : "Workspace unavailable",
      };
    }
    this.publishSession(session);
    const dispatched = this.dispatch(
      node.id,
      {
        type: "start_session",
        ...(input.startupNotice ? { startupNotice: input.startupNotice } : {}),
        sessionId: session.id,
        localPath: input.placement.localPath,
        sourcePlacementId: input.placement.id,
        ...(input.runRole === "lead" &&
        node.capabilities.includes(MANAGED_WORKTREES_CAPABILITY)
          ? { coordinator: true }
          : {}),
        prompt: input.prompt,
        yolo: input.yolo,
        mcpServers: this.mcpServersFor(session),
        agent: this.agentFor(session, node),
        config: this.startupConfigFor(session),
        readOnly: session.readOnly,
      },
      { state: "failed", activity: "Node disconnected before process start" },
      input.dispatchAttempt,
    );
    if (!dispatched.sent) {
      return {
        ok: false,
        status: 503,
        error: "Node disconnected",
        ...(dispatched.session ? { session: dispatched.session } : {}),
      };
    }
    return { ok: true, session: this.store.getSession(session.id)! };
  }

  /**
   * Adopts a Copilot-owned ACP session into Fleet and resumes it on its node.
   */
  adoptAndResumeSession(input: {
    placement: Placement;
    agentSessionId: string;
    additionalDirectories?: string[];
    yolo: boolean;
    name?: string;
  }): { ok: true; session: FleetSession } | { ok: false; status: number; error: string } {
    const sessions = this.store.listSessions();
    const existing = sessions.find(
      (session) =>
        session.agentSessionId === input.agentSessionId &&
        (session.agentParams?.kind ?? "copilot") === "copilot",
    );
    if (existing && liveSessionStates.has(existing.state)) {
      return {
        ok: false,
        status: 409,
        error: "This Copilot session is already live in Fleet",
      };
    }
    const node = this.store.getNode(input.placement.nodeId);
    const socket = node ? this.nodeSockets.get(node.id) : undefined;
    if (!node?.online || !socket || socket.readyState !== socket.OPEN) {
      return { ok: false, status: 503, error: "Node is offline" };
    }
    const kind = existing?.readOnly ? "read-only" : "writing";
    if (reservedSessionCount(sessions, node.id, kind) >= capacityFor(node, kind)) {
      return {
        ok: false,
        status: 409,
        error: `Node is at capacity for ${kind} work`,
      };
    }
    const unsupported = yoloUnsupportedReason(node, input.yolo);
    if (unsupported) return { ok: false, status: 409, error: unsupported };

    const adopted = this.store.adoptSession(
      input.placement,
      input.agentSessionId,
      input.additionalDirectories ?? [],
      input.yolo,
      input.name ?? "",
    );
    return this.resumeSession(adopted.session.id, "Adopting Copilot session");
  }

  /**
   * Re-attaches one finished conversation without changing its backend or prompting it.
   *
   * Kept beside creation because both paths enforce the same admission rules
   * and assemble the same launch context. The caller may send a prompt
   * immediately afterwards: the Node queues it behind session initialization.
   */
  resumeSession(
    sessionId: string,
    activity?: string,
    supervisor?: { operatorId: string; operationId?: string | undefined },
  ): { ok: true; session: FleetSession } | { ok: false; status: number; error: string } {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
    const manual =
      supervisor && this.supervisorCommand(sessionId, "resume_session", supervisor);
    if (manual && this.isSupervisorRetry(sessionId, manual)) return { ok: true, session };
    if (session.runRole !== "lead" && !manual) {
      const step = this.store.getRunStepBySession(session.id);
      const reference = step
        ? this.store.prMaintenance.referenceForStep(step.id, step.attempts)
        : undefined;
      const maintenance = this.store.prMaintenance.admission({
        action: "resume",
        sessionId: session.id,
        placementId: session.placementId,
        ...(session.runId ? { taskId: session.runId } : {}),
        ...(session.executionBinding
          ? { checkoutKey: session.executionBinding.checkoutKey }
          : {}),
        ...(reference ?? {}),
      });
      if (!maintenance.allowed) {
        return {
          ok: false,
          status: 409,
          error: `PR maintenance: ${maintenance.reason}. Reconcile the registration before resuming.`,
        };
      }
    }
    if (session.cleanupRequested) {
      return { ok: false, status: 409, error: "Session deletion is awaiting its Node" };
    }
    if (session.stopRequested) {
      return { ok: false, status: 409, error: "Session is still stopping" };
    }
    if (session.dismissed) {
      return { ok: false, status: 409, error: "Restore the session before resuming it" };
    }
    if (liveSessionStates.has(session.state)) {
      return { ok: false, status: 409, error: "Session is already live" };
    }
    if (!canTransition(session.state, "starting")) {
      return { ok: false, status: 409, error: "Session is already live" };
    }
    if (!session.agentSessionId) {
      return { ok: false, status: 409, error: "Session has no resumable agent id" };
    }
    const placement = this.store.getPlacement(session.placementId);
    if (!placement) {
      return { ok: false, status: 409, error: "Placement was removed" };
    }
    const node = this.store.getNode(session.nodeId);
    if (!node?.online) return { ok: false, status: 503, error: "Node is offline" };
    const agentProblem = this.agentLaunchProblem(
      node,
      session.agentParams ?? { kind: "copilot" },
      session.id,
    );
    if (agentProblem) return { ok: false, status: 409, error: agentProblem };
    const hostUpdating = this.hostUpdate?.blocksNodeWork(node.id);
    if (hostUpdating) return { ok: false, status: 409, error: hostUpdating };
    const kind = session.readOnly ? "read-only" : "writing";
    if (
      reservedSessionCount(this.store.listSessions(), node.id, kind) >=
      capacityFor(node, kind)
    ) {
      return {
        ok: false,
        status: 409,
        error: `Node is at capacity for ${kind} work`,
      };
    }
    const unsupported = yoloUnsupportedReason(node, session.yolo);
    if (unsupported) return { ok: false, status: 409, error: unsupported };
    try {
      this.worktrees.validateSession(session);
      if (manual) this.store.prMaintenance.assertManualAvailable(sessionId);
    } catch (error) {
      return {
        ok: false,
        status: 409,
        error: error instanceof Error ? error.message : "Workspace unavailable",
      };
    }

    const resumed = this.transitionSession(
      sessionId,
      "starting",
      activity ??
        `Resuming ${agentKindLabels[session.agentParams?.kind ?? "copilot"]} session`,
      {
        type: "host",
        cause: "resume_requested",
      },
    );
    this.publishSession(resumed);
    const provenance: [undefined?, SupervisorCommand?] = manual
      ? [undefined, manual]
      : [];
    const dispatched = this.dispatch(
      session.nodeId,
      {
        type: "resume_session",
        sessionId,
        localPath: placement.localPath,
        agentSessionId: session.agentSessionId,
        contextOverflowRecoveryPrompt: manual
          ? undefined
          : contextOverflowRecoveryPrompt(session),
        additionalDirectories: session.additionalDirectories ?? [],
        sequenceOffset: this.store.maxEventSequence(sessionId),
        yolo: session.yolo,
        mcpServers: this.mcpServersFor(session),
        agent: this.agentFor(session, node),
        config: this.startupConfigFor(session),
        readOnly: session.readOnly,
      },
      { state: "failed", activity: "Node disconnected before session resume" },
      ...provenance,
    );
    if (!dispatched.sent) return { ok: false, status: 503, error: "Node is offline" };

    return { ok: true, session: resumed };
  }

  private supervisorCommand(
    sessionId: string,
    kind: SupervisorCommand["kind"],
    supervisor: { operatorId: string; operationId?: string | undefined },
    input?: { prompt: string; attachments: PromptAttachment[] },
  ): SupervisorCommand | undefined {
    if (
      !this.store.prMaintenance.manualRecord(sessionId) &&
      !this.store.prMaintenance.hasManualHistory(sessionId)
    )
      return undefined;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          kind,
          prompt: input?.prompt,
          attachments: input?.attachments,
        }),
      )
      .digest("hex");
    // Keyless requests correlate only while delivery is unsettled. Once settled,
    // another request is new intent; only an explicit UUID survives that ambiguity.
    const pending = !supervisor.operationId
      ? this.store.prMaintenance
          .pendingManualCommands(sessionId)
          .find(
            (command) =>
              command.digest === digest &&
              command.operatorId === supervisor.operatorId &&
              command.kind === kind,
          )
      : undefined;
    return {
      id: supervisor.operationId
        ? createHash("sha256")
            .update(JSON.stringify([sessionId, supervisor.operationId]))
            .digest("hex")
        : (pending?.id ?? randomUUID()),
      digest,
      kind,
      operatorId: supervisor.operatorId,
    };
  }

  private isSupervisorRetry(sessionId: string, command: SupervisorCommand): boolean {
    this.store.prMaintenance.assertManualOperationUnambiguous(sessionId, command.id);
    const previous = this.store.prMaintenance.manualCommand(sessionId, command.id);
    if (!previous) return false;
    if (
      previous.digest !== command.digest ||
      previous.operatorId !== command.operatorId ||
      previous.kind !== command.kind
    )
      throw new PrMaintenanceError(
        "manual_request_conflict",
        "This request key already identifies different manual input.",
      );
    if (previous.state === "unknown" || previous.state === "rejected")
      throw new PrMaintenanceError(
        "manual_receipt",
        `Manual delivery is ${previous.state}; the request was not replayed. Reconcile its receipt before a new request.`,
      );
    return true;
  }

  promptSession(
    sessionId: string,
    input: {
      prompt: string;
      attachments: PromptAttachment[];
      operationId?: string | undefined;
    },
    operatorId?: string,
  ): { ok: true } | { ok: false; status: number; error: string } {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
    const manual = operatorId
      ? this.supervisorCommand(
          sessionId,
          "prompt",
          { operatorId, operationId: input.operationId },
          input,
        )
      : undefined;
    if (manual && this.isSupervisorRetry(sessionId, manual)) return { ok: true };
    if (session.stopRequested)
      return { ok: false, status: 409, error: "Session is stopping" };
    if (session.state !== "idle")
      return { ok: false, status: 409, error: "Session must be idle" };
    if (!manual)
      this.store.prMaintenance.assertAdmission({ sessionId, action: "prompt" });
    const provenance: [undefined?, SupervisorCommand?] = manual
      ? [undefined, manual]
      : [];
    const dispatched = this.dispatch(
      session.nodeId,
      { type: "prompt", sessionId, prompt: input.prompt, attachments: input.attachments },
      { state: "failed", activity: "Node disconnected before prompt" },
      ...provenance,
    );
    return dispatched.sent
      ? { ok: true }
      : { ok: false, status: 503, error: "Node disconnected" };
  }

  /**
   * The MCP servers a session should be given, on start and on resume alike.
   *
   * Derived from the session's role rather than stored, so there is one answer
   * to "what tools does this have" and a resumed orchestrator cannot come back
   * without them. A fresh token is minted each time: they are cheap, and it
   * means an old one stops working the moment a session restarts.
   *
   * The token names the run and the machine as well as the session, so `/mcp`
   * can re-check the authorisation against the fleet as it stands rather than
   * as it stood when the token was written.
   */
  mcpServersFor(
    session: Pick<FleetSession, "id" | "runRole" | "runId" | "nodeId">,
  ): McpHttpServer[] {
    if (session.runRole !== "lead" || !this.leadTokens || !this.mcpUrl) return [];
    const token = this.leadTokens.mint({
      sessionId: session.id,
      runId: session.runId,
      nodeId: session.nodeId,
    });
    return [
      {
        name: "fleet",
        url: this.mcpUrl(),
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    ];
  }

  /**
   * The custom agent a session should be put into, on start and on resume.
   *
   * Derived from the role for the same reason as {@link mcpServersFor}: one
   * answer to "what is this session", and a resumed orchestrator cannot come
   * back as something else.
   *
   * Asked of the Node's catalog rather than named blindly. A Node too old to
   * carry the definition degrades to an ordinary lead steered by its briefing,
   * which is worth more than a lead that fails to start — and checking here
   * keeps that a quiet fact rather than a warning logged on every dispatch.
   */
  agentFor(
    session: Pick<FleetSession, "runRole" | "agentParams">,
    node: Pick<FleetNode, "agents">,
  ): string {
    if (
      session.runRole !== "lead" ||
      (session.agentParams?.kind ?? "copilot") !== "copilot"
    )
      return "";
    return node.agents.some((agent) => agent.name === ORCHESTRATOR_AGENT)
      ? ORCHESTRATOR_AGENT
      : "";
  }

  /**
   * The pickers a session should start on.
   *
   * Two different kinds of setting, deliberately in one place because they are
   * applied in one window — after the session exists, before it is prompted.
   *
   * **Mode is not a preference for a session the fleet drives.** Copilot's
   * autopilot keeps working until it calls `task_complete`, and plan mode
   * produces a plan instead of acting; both contradict the contract every fleet
   * session runs under, which is to take one turn and stop. An orchestrator put
   * into autopilot has nothing to do between wakes and spends the difference
   * looping on a tool that cannot end a turn nobody started. So the fleet owns
   * it for its own sessions, the same way it owns permissions.
   *
   * **Model and effort are a preference**, so they are only sent when someone
   * has expressed one, and a machine that cannot honour them says so and
   * carries on.
   */
  startupConfigFor(
    session: Pick<FleetSession, "runRole" | "agentParams">,
  ): StartupConfig[] {
    if ((session.agentParams?.kind ?? "copilot") !== "copilot") return [];
    const config: StartupConfig[] = [];
    if (session.runRole === "lead" || session.runRole === "worker") {
      config.push({ id: "mode", value: "agent" });
    }
    const model = this.store.getDefaultModel();
    if (model) config.push({ id: "model", value: model });
    const effort = this.store.getDefaultReasoningEffort();
    if (effort) config.push({ id: "reasoning_effort", value: effort });
    return config;
  }

  /**
   * Sends a command to a Node and, when it cannot be delivered, settles the
   * session the caller was acting on.
   */
  dispatch(
    nodeId: string,
    request: CommandRequest,
    fallback?: DispatchFallback,
    attemptOverride?: string,
    supervisor?: SupervisorCommand,
  ): DispatchResult {
    const commandSession = this.store.getSession(request.sessionId);
    if (
      ["stop", "cancel", "delete_session"].includes(request.type) &&
      commandSession?.runRole === "lead"
    )
      this.commands.revokeLead(commandSession.id);
    if (
      ["start_session", "resume_session", "prompt"].includes(request.type) &&
      commandSession?.runId &&
      commandSession.runRole !== "lead"
    )
      this.store.commands.assertTaskUnfenced(commandSession.runId);
    if (
      request.type === "prompt" &&
      commandSession?.runRole === "lead" &&
      this.commands.durableLead(commandSession.id)
    ) {
      this.commands.queueLeadPrompt(
        commandSession.id,
        request.prompt,
        undefined,
        [],
        commandSession.executionBinding,
        request.attachments,
      );
      this.commands.pumpLead(commandSession.id);
      return { sent: true };
    }
    if (
      ["start_session", "resume_session", "prompt"].includes(request.type) &&
      commandSession?.runRole === "lead" &&
      this.store.commands.reserved(commandSession.id)
    )
      throw new CommandConflict("lead_prompt_reserved");
    if (
      ["start_session", "resume_session", "prompt"].includes(request.type) &&
      commandSession?.runRole === "lead" &&
      !this.commands.durableLead(commandSession.id) &&
      this.store.commands.prompts(commandSession.id).length
    )
      throw new CommandConflict("durable_lead_delivery_required");
    if (request.type !== "delete_session") {
      this.store.assertSessionMutable(request.sessionId);
    }
    if (request.type === "stop" || request.type === "cancel") {
      this.store.prMaintenance.pauseForSession(
        request.sessionId,
        "Session stop or cancellation requested",
      );
    }
    if (
      request.type === "start_session" ||
      request.type === "resume_session" ||
      request.type === "prompt"
    ) {
      const session = this.store.getSession(request.sessionId);
      if (session) {
        if (session.runRole !== "lead") {
          const step = this.store.getRunStepBySession(session.id);
          const reference = step
            ? this.store.prMaintenance.referenceForStep(step.id, step.attempts)
            : undefined;
          if (supervisor) this.store.prMaintenance.assertManualAvailable(session.id);
          else
            this.store.prMaintenance.assertAdmission({
              action: "execute",
              sessionId: session.id,
              placementId: session.placementId,
              ...(session.runId ? { taskId: session.runId } : {}),
              ...(session.executionBinding
                ? { checkoutKey: session.executionBinding.checkoutKey }
                : {}),
              ...(reference ?? {}),
            });
          if (
            !supervisor &&
            reference &&
            request.type !== "resume_session" &&
            request.prompt !== step?.prompt
          ) {
            throw new PrMaintenanceError(
              "prompt_conflict",
              "Only the exact accepted maintenance prompt may execute.",
            );
          }
        }
        this.worktrees.validateSession(session);
      }
    }
    const lifecycleIntent =
      request.type === "cancel" || request.type === "stop" ? request.type : undefined;
    // Nothing new starts on the Node beside the Host while the Host is updating:
    // the restart at the end would stop it without anyone having agreed to that.
    // Refused the way an unreachable Node is, so every caller already copes.
    const hostUpdating =
      request.type === "start_session" || request.type === "resume_session"
        ? this.hostUpdate?.blocksNodeWork(nodeId)
        : undefined;
    const socket = hostUpdating ? undefined : this.nodeSockets.get(nodeId);
    if (socket && socket.readyState === socket.OPEN) {
      if (lifecycleIntent) {
        this.store.writeAtomically(() => {
          this.store.setSessionTransitionIntent(request.sessionId, lifecycleIntent);
          this.store.clearSessionTurnCompletion(request.sessionId);
        });
      } else if (
        request.type === "start_session" ||
        request.type === "resume_session" ||
        request.type === "prompt"
      ) {
        const session = this.store.getSession(request.sessionId);
        if (!session) return { sent: false };
        const commandId = supervisor?.id ?? randomUUID();
        let binding = session.executionBinding;
        if (binding && request.type !== "prompt") {
          binding = { ...binding, leaseAttempt: commandId };
        }
        const attempt = supervisor
          ? `manual:${commandId}`
          : (attemptOverride ?? this.dispatchAttemptKey(session));
        const eventSeqFrom =
          request.type === "resume_session"
            ? request.sequenceOffset
            : this.store.maxEventSequence(request.sessionId);
        // A new attempt must not inherit a stop/cancel or completion receipt
        // from the old one, and its sequence boundary must be durable before send.
        this.store.writeAtomically(() => {
          if (supervisor) {
            if (request.type !== supervisor.kind)
              throw new PrMaintenanceError(
                "manual_request_conflict",
                "Manual command kind changed before delivery.",
              );
            this.store.prMaintenance.beginManualControl(
              session.id,
              supervisor,
              eventSeqFrom,
            );
          }
          // Resume is an authoritative reattachment, not a new checkout owner.
          // Persist its fencing attempt and dispatch receipt as one transition.
          if (binding && request.type !== "prompt")
            this.store.setSessionExecutionBinding(session.id, binding);
          this.store.clearSessionTransitionIntent(request.sessionId);
          this.store.clearSessionTurnCompletion(request.sessionId);
          this.store.setSessionDispatchAttempt(request.sessionId, {
            commandId,
            eventSeqFrom,
            attempt,
          });
          if (request.type !== "resume_session" || request.lastActivityAt === undefined) {
            this.store.touchSessionActivity(request.sessionId);
          }
        });
        // The current fleet preference also applies to adopted conversations,
        // automatic recovery, and orchestration, not just the new-session UI.
        const manualPrompt =
          supervisor &&
          request.type === "prompt" &&
          this.store.prMaintenance.manualRecord(session.id)
            ? `${request.prompt}\n\n<fleet-manual-control>\nThe human supervisor has taken manual control of this retained worker. Unattended PR maintenance is paused and must remain paused after this turn. Follow the human's direction; this handoff itself does not authorize unattended publication, certify PR readiness, or approve pending design decisions. Preserve retained scope and receipts; do not restart maintenance.\n</fleet-manual-control>`
            : undefined;
        const command = {
          ...request,
          ...(manualPrompt ? { prompt: manualPrompt } : {}),
          ...(session.runRole === "lead" &&
          this.store.prMaintenance.list({
            leadSessionId: session.id,
            retainedOnly: true,
            limit: 1,
          }).records.length > 0 &&
          (request.type === "start_session" || request.type === "prompt") &&
          !request.prompt.trimStart().startsWith("/")
            ? { prompt: `${request.prompt}\n\n${PR_MAINTENANCE_WAKE_INSTRUCTION}` }
            : {}),
          ...(binding?.worktreeId &&
          (request.type === "start_session" || request.type === "prompt")
            ? {
                prompt: `${manualPrompt ?? request.prompt}\n\n<fleet-workspace>\nUse only this bound checkout for repository work: ${binding.cwd}\nWorktree ${binding.worktreeId}, generation ${binding.generation}. The catalog placement is the source, not your writable cwd. This may be a per-step or composed DAG workspace; never substitute another predecessor or the source checkout. Do not create/remove worktrees or integrate/push automatically; those are managed operations. This binding is not a filesystem sandbox.\n</fleet-workspace>`,
              }
            : {}),
          ...(binding ? { executionBinding: binding } : {}),
          ...(request.type === "start_session" || request.type === "resume_session"
            ? {
                localPath: binding?.cwd ?? request.localPath,
                sourcePlacementId: session.placementId,
              }
            : {}),
          ...(request.type === "start_session" || request.type === "resume_session"
            ? {
                agentParams: session.agentParams ?? { kind: "copilot" },
              }
            : {}),
          ...((request.type === "start_session" || request.type === "resume_session") &&
          (session.agentParams?.kind ?? "copilot") === "copilot"
            ? {
                agencyMode: this.store.getAgencyMode(),
                contextTier:
                  ContextTierSchema.safeParse(
                    session.configOptions.find(
                      (option) => option.id === CONTEXT_TIER_CONFIG_ID,
                    )?.currentValue,
                  ).data ?? this.store.getDefaultContextTier(),
              }
            : {}),
          commandId,
        } as NodeCommand;
        this.send(socket, HostToNodeMessageSchema.parse({ type: "command", command }));
        if (supervisor && session.runId) {
          this.publishSnapshot();
          this.publishRunSteps(session.runId, this.store.listRunSteps(session.runId));
        }
        return { sent: true };
      }
      if (request.type !== "delete_session") {
        this.store.touchSessionActivity(request.sessionId);
      }
      const command = { ...request, commandId: randomUUID() } as NodeCommand;
      this.send(socket, HostToNodeMessageSchema.parse({ type: "command", command }));
      return { sent: true };
    }
    if (!fallback) return { sent: false };
    const settledAs = hostUpdating ? { ...fallback, activity: hostUpdating } : fallback;
    const session = this.notifications.commitAtomically(
      () => {
        if (lifecycleIntent) {
          this.store.setSessionTransitionIntent(request.sessionId, lifecycleIntent);
          this.store.clearSessionTurnCompletion(request.sessionId);
        }
        const settled = this.transitionSession(
          request.sessionId,
          settledAs.state,
          settledAs.activity,
          { type: "host", cause: "dispatch_fallback" },
        );
        if (terminalSessionStates.has(settledAs.state)) {
          this.store.clearSessionTurnCompletion(request.sessionId);
        }
        if (lifecycleIntent) {
          this.store.consumeSessionTransitionIntent(request.sessionId);
        }
        if (terminalSessionStates.has(settledAs.state)) {
          this.resolveSessionPermissionRequests(request.sessionId);
        }
        return settled;
      },
      (settled) => this.publishSession(settled),
    );
    return { sent: false, session };
  }

  /**
   * Settles a session synchronously after a stop command and consumes its
   * durable suppression intent. Used by run archive/purge, which cannot wait
   * for a Node event before releasing capacity.
   */
  settleCommandedSession(
    sessionId: string,
    state: SessionState,
    activity: string,
    publish = true,
  ): FleetSession {
    return this.notifications.commitAtomically(
      () => {
        let session = this.transitionSession(sessionId, state, activity, {
          type: "host",
          cause: "operator_settlement",
        });
        if (terminalSessionStates.has(state) && session.stopRequested) {
          session = this.store.setSessionControls(sessionId, {
            stopRequested: false,
          });
        }
        this.store.consumeSessionTransitionIntent(sessionId);
        this.store.clearSessionTurnCompletion(sessionId);
        if (terminalSessionStates.has(state)) {
          this.resolveSessionPermissionRequests(sessionId);
        }
        return session;
      },
      (session) => {
        if (publish) this.publishSession(session);
      },
    );
  }

  beginSessionCancellation(sessionId: string): FleetSession {
    return this.transitionSession(sessionId, "cancelling", "Cancelling active turn", {
      type: "host",
      cause: "operator_cancel_requested",
    });
  }

  /**
   * Tells every connected Node where this Host moved to.
   *
   * Skips Nodes that do not advertise the capability: their copy of the message
   * union has no `host_url` in it, so the frame would fail validation and cost
   * them the connection this exists to preserve. They keep dialing the address
   * they enrolled with, exactly as before — the operator retargets those from
   * the node config page.
   *
   * Nothing is sent to the Node that is *reached through* the old URL and would
   * therefore never see it: that socket is already gone by the time its tunnel
   * is. This reaches the Nodes on a path that outlives the change — a LAN
   * address, a named tunnel — which is precisely the set that can act on it.
   */
  broadcastHostUrl(hostUrl: string): number {
    // Checked again at the point of sending, not only where the address was
    // chosen. Every other mistake here costs a reconnect; this one costs the
    // machine — a Node that follows an address it cannot authenticate to is
    // beyond the reach of the correction, so the cheap check goes on both sides
    // of the decision.
    if (!isBroadcastableHostUrl(hostUrl)) {
      this.log.warn(
        { hostUrl },
        "Refused to announce a Host URL that a Node could not authenticate to",
      );
      return 0;
    }
    let notified = 0;
    for (const [nodeId, socket] of this.nodeSockets) {
      const node = this.store.getNode(nodeId);
      if (!node?.capabilities.includes(HOST_URL_SYNC_CAPABILITY)) continue;
      this.send(socket, HostToNodeMessageSchema.parse({ type: "host_url", hostUrl }));
      notified += 1;
    }
    if (notified > 0) {
      this.log.info({ hostUrl, notified }, "Announced new Host URL to nodes");
    }
    return notified;
  }

  /**
   * Tells one Node the name the Host has for it.
   *
   * Skipped for Nodes that predate the capability, which validate every frame
   * against their own copy of the message union and hang up on anything they do
   * not recognise — costing the connection instead of syncing a label.
   */
  announceNodeName(nodeId: string, name: string): boolean {
    const socket = this.nodeSockets.get(nodeId);
    if (!socket) return false;
    const node = this.store.getNode(nodeId);
    if (!node?.capabilities.includes(NODE_NAME_SYNC_CAPABILITY)) return false;
    this.send(socket, HostToNodeMessageSchema.parse({ type: "node_name", name }));
    this.log.info({ nodeId, name }, "Told node the name the Host has for it");
    return true;
  }

  /**
   * Tells one Node to pull, rebuild and restart itself.
   *
   * Refused rather than queued when the Node is busy: an update restarts the
   * process, and every agent it is hosting dies with it. Losing a colleague's
   * running turn to someone else's click on "Update all" is a worse outcome
   * than being told to wait, so the caller is given the reason to show — along
   * with what is in the way, so an operator who does own those sessions can
   * decide to stop them rather than being told only that they cannot proceed.
   *
   * `stopSessions` is that decision, taken deliberately about one named Node.
   * "Update all" never sets it.
   */
  requestUpdate(
    nodeId: string,
    { stopSessions = false }: { stopSessions?: boolean } = {},
  ): { started: boolean; reason?: string; blockedBy?: FleetSession[] } {
    const node = this.store.getNode(nodeId);
    if (!node) return { started: false, reason: "Unknown node" };
    if (!node.capabilities.includes(SELF_UPDATE_CAPABILITY)) {
      return {
        started: false,
        reason: `${node.name} runs a build that predates remote updates; update it by hand once`,
      };
    }
    // The Node beside the Host shares its checkout; two updates resetting and
    // rebuilding one directory at once would leave it in neither state.
    const hostUpdating = this.hostUpdate?.blocksNodeUpdate(nodeId);
    if (hostUpdating) return { started: false, reason: hostUpdating };
    const socket = this.nodeSockets.get(nodeId);
    if (!socket || socket.readyState !== socket.OPEN) {
      return { started: false, reason: `${node.name} is offline` };
    }
    const live = this.liveSessionsOn(nodeId);
    if (live.length > 0) {
      if (!stopSessions) {
        return {
          started: false,
          reason: `${node.name} is running ${live.length} session(s); updating would stop them`,
          blockedBy: live,
        };
      }
      this.stopSessionsForUpdate(nodeId, live, "Stopped to update the node");
    }
    const updateId = randomUUID();
    this.send(socket, HostToNodeMessageSchema.parse({ type: "update_node", updateId }));
    this.log.info({ nodeId, updateId }, "Asked node to update itself");
    this.updatesInFlight.set(nodeId, {
      updateId,
      previousRevision: node.revision,
      restarting: false,
    });
    this.publishNodeUpdate(nodeId, "checking", "Update requested");
    return { started: true };
  }

  /** Every Node that is behind this Host and can be told to catch up. */
  staleNodeIds(): string[] {
    return this.store
      .listNodes()
      .filter((node) => nodeUpdateState(node, this.hostRevision) === "stale")
      .map((node) => node.id);
  }

  /** Sessions a restart of this Node would end. */
  liveSessionsOn(nodeId: string): FleetSession[] {
    return this.store
      .listSessions()
      .filter(
        (session) =>
          session.nodeId === nodeId && !terminalSessionStates.has(session.state),
      );
  }

  /**
   * Stops sessions an operator agreed to give up for an update.
   *
   * Stopped before the update rather than left to die with the process, so
   * each one ends as something an operator asked for and its agent is given
   * the chance to shut down rather than being killed mid-write.
   */
  stopSessionsForUpdate(
    nodeId: string,
    sessions: readonly FleetSession[],
    activity: string,
  ): void {
    for (const session of sessions) {
      this.dispatch(
        nodeId,
        { type: "stop", sessionId: session.id },
        { state: "stopped", activity },
      );
    }
    this.log.info(
      { nodeId, stopped: sessions.length },
      "Stopping sessions so the node can update",
    );
  }

  /** Whether this Node has been told to update and has not said how it went. */
  nodeUpdateInFlight(nodeId: string): boolean {
    return this.updatesInFlight.has(nodeId);
  }

  /** Wires the Host's own update. Called once, from `server.ts`. */
  attachHostUpdate(hostUpdate: HostUpdateHooks): void {
    this.hostUpdate = hostUpdate;
  }

  publishHostUpdate(status: HostUpdateStatus): void {
    this.broadcast({ type: "host_update", status });
  }

  publishNodeUpdate(
    nodeId: string,
    stage: NodeUpdateStage,
    detail: string,
    status?: { updateId: string; revision?: string | undefined },
  ): void {
    const update = this.updatesInFlight.get(nodeId);
    if (status && update?.updateId !== status.updateId) {
      this.log.warn({ nodeId, updateId: status.updateId }, "Ignored stale node update");
      return;
    }
    if (update && stage === "restarting") {
      update.restarting = true;
      if (status?.revision) update.expectedRevision = status.revision;
    }
    // Only these two end an update. Every other stage is progress, and leaving
    // the Node on the books through them is what lets the return be recognised.
    if (stage === "up_to_date" || stage === "failed") {
      this.updatesInFlight.delete(nodeId);
    }
    this.broadcast({ type: "node_update", nodeId, stage, detail });
  }

  /**
   * Files the report a restarting Node could not send for itself.
   *
   * "restarting" is the last thing a Node says before it exits, so nothing ever
   * followed it: browsers kept rendering that stage forever, and a Node that had
   * been back for minutes still showed as restarting until someone reloaded the
   * page. The Node reconnecting is the missing report, and the revision it
   * returns on is what the operator actually wants to see.
   *
   * Only Nodes with an update outstanding are settled, so an ordinary reconnect
   * — a dropped tunnel, a machine waking up — stays silent.
   */
  settleUpdateOnReconnect(nodeId: string, revision: string | undefined): void {
    const update = this.updatesInFlight.get(nodeId);
    // A tunnel reconnect during install/build is not a completed restart.
    if (!update?.restarting) return;
    const landed = revision?.trim();
    const expected = update.expectedRevision;
    const matches = (left: string, right: string) =>
      left.slice(0, 12) === right.slice(0, 12);
    if (
      !landed ||
      (expected
        ? !matches(landed, expected)
        : !update.previousRevision || matches(landed, update.previousRevision))
    ) {
      const detail = !landed
        ? "Node reconnected without a revision; the update could not be verified"
        : expected
          ? `Node reconnected on ${landed.slice(0, 12)}, expected ${expected.slice(0, 12)}; the new build is not running`
          : `Node reconnected on ${landed.slice(0, 12)}; no revision change could be verified`;
      this.log.warn({ nodeId, revision: landed }, detail);
      this.publishNodeUpdate(nodeId, "failed", detail);
      return;
    }
    this.log.info({ nodeId, revision: landed }, "Node returned from its update");
    this.publishNodeUpdate(nodeId, "up_to_date", `Updated to ${landed.slice(0, 12)}`);
  }

  /** Records a heartbeat, publishing only when a browser would render it. */
  recordPresence(
    nodeId: string,
    activeSessionIds: readonly string[],
    busySessionIds: readonly string[] = [],
    reconcileSessions = true,
    health?: NodeHealth,
  ): void {
    const { node, changed } = this.store.recordPresence(
      nodeId,
      true,
      activeSessionIds.length,
    );
    if (node) {
      const healthChanged =
        JSON.stringify(this.nodeHealth.get(nodeId)) !== JSON.stringify(health);
      if (health) this.nodeHealth.set(nodeId, health);
      else this.nodeHealth.delete(nodeId);
      if (changed || healthChanged) this.publishNode(node);
    }
    if (!reconcileSessions) return;
    this.reconcile(nodeId, activeSessionIds, busySessionIds);
  }

  /**
   * Settles the sessions a Node did not bring back, and re-attaches the ones
   * that can be. Shared by the hello and the heartbeat, which both arrive with
   * the Node's current inventory.
   */
  reconcile(
    nodeId: string,
    activeSessionIds: readonly string[],
    busySessionIds: readonly string[] = [],
  ): FleetSession[] {
    const settled = this.notifications.commitAtomically(
      () => {
        const candidates = new Map(
          this.store
            .listSessions()
            .filter(
              (session) =>
                session.nodeId === nodeId &&
                (session.state === "offline" || session.stopRequested),
            )
            .map((session) => [
              session.id,
              {
                session,
                intent: this.store.getSessionTransitionIntent(session.id),
                completion: this.store.getSessionTurnCompletion(session.id),
                context: this.notificationAttemptContext(session),
              },
            ]),
        );
        const reconciled = this.store.reconcileOfflineSessions(
          nodeId,
          activeSessionIds,
          busySessionIds,
        );
        for (const session of reconciled) {
          const prior = candidates.get(session.id);
          if (prior) {
            if (prior.session.state !== session.state) {
              this.acceptSessionTransition({
                before: prior.session,
                after: session,
                source: {
                  type: "reconciliation",
                  outcome: session.state === "failed" ? "missing" : "restored",
                },
                intent: prior.intent,
                completion: prior.completion,
                context: prior.context,
              });
            }
            if (
              prior.intent &&
              ["idle", "stopped", "completed", "failed"].includes(session.state)
            ) {
              this.store.consumeSessionTransitionIntent(session.id);
            }
            this.clearConsumedTurnCompletion(session, prior.intent, prior.context);
          }
          if (terminalSessionStates.has(session.state)) {
            this.resolveSessionPermissionRequests(session.id);
          }
        }
        return reconciled;
      },
      (reconciled) => this.publishSessions(reconciled),
    );
    for (const session of settled) {
      if (!session.stopRequested || terminalSessionStates.has(session.state)) continue;
      this.dispatch(nodeId, { type: "stop", sessionId: session.id });
    }
    this.sessionRetention.nodeReconciled(nodeId);
    this.worktrees.onNodeReconciled(nodeId);
    this.autoResume(nodeId, settled);
    return settled;
  }

  /**
   * Re-attaches sessions a reconnecting Node no longer has.
   *
   * Reconciliation settles those as `failed` with a Resume button, which is
   * accurate but leaves an operator clicking through them one at a time after
   * every Host or Node restart — the two events that produce them in bulk.
   *
   * Only sessions that settled during *this* reconnect are taken. That keeps a
   * restart from resurrecting conversations abandoned days ago, and means a
   * resume that fails is not retried on the next heartbeat: it settles as
   * failed and waits for a person, instead of looping.
   *
   * Resuming is not prompting. `session/load` re-attaches the conversation and
   * the agent lands on idle waiting for input, so nothing here starts work or
   * spends tokens on the operator's behalf — the cost is one Copilot process per
   * session, which is why capacity is still enforced.
   */
  private autoResume(nodeId: string, settled: readonly FleetSession[]): void {
    if (!this.store.getAutoResume()) return;
    const node = this.store.getNode(nodeId);
    if (!node) return;
    const candidates = settled
      .filter(
        (session) =>
          session.state === "failed" &&
          session.agentSessionId &&
          !session.stopRequested &&
          !session.dismissed &&
          !this.sessionRetention.shouldExpire(session),
      )
      // Newest first, by creation: when capacity cannot cover them all, the
      // most recently started work is the likeliest to still matter. Last
      // activity would be the better signal, but reconciliation has just
      // stamped every one of these rows with the same instant, so it no longer
      // distinguishes them.
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (candidates.length === 0) return;

    // Counted per kind, the same split the dispatch path and the Node use.
    let reservedWriting = reservedSessionCount(this.store.listSessions(), nodeId);
    let reservedReading = reservedSessionCount(
      this.store.listSessions(),
      nodeId,
      "read-only",
    );
    let resumed = 0;
    for (const session of candidates) {
      const kind = session.readOnly ? "read-only" : "writing";
      const held = kind === "read-only" ? reservedReading : reservedWriting;
      if (held >= capacityFor(node, kind)) continue;
      if (this.store.prMaintenance.hasPendingManualExecution(session.id)) continue;
      const retained = this.store.prMaintenance.manualRecord(session.id);
      if (retained?.manualControl && !retained.manualControl.endedAt) {
        // Reconnect may reattach a settled manual conversation, never replay a
        // prompt or consume a queued maintenance attempt.
        const result = this.resumeSession(session.id, "Reconnecting manual session", {
          operatorId: retained.manualControl.operatorId,
          operationId: randomUUID(),
        });
        if (result.ok) {
          if (kind === "read-only") reservedReading += 1;
          else reservedWriting += 1;
          resumed += 1;
        }
        continue;
      }
      if (retained) {
        const step = this.store.getRunStepBySession(session.id);
        if (
          !this.store.prMaintenance.admission({
            action: "resume",
            sessionId: session.id,
            ...(step
              ? this.store.prMaintenance.referenceForStep(step.id, step.attempts)
              : {}),
          }).allowed
        )
          continue;
      }
      const placement = this.store.getPlacement(session.placementId);
      if (!placement) continue;
      const agentProblem = this.agentLaunchProblem(
        node,
        session.agentParams ?? { kind: "copilot" },
        session.id,
      );
      if (agentProblem) {
        this.publishSession(
          this.store.transitionSession(session.id, session.state, agentProblem),
        );
        continue;
      }
      if (yoloUnsupportedReason(node, session.yolo)) continue;
      try {
        this.worktrees.validateSession(session);
      } catch (error) {
        if (error instanceof WorktreeConflict) continue;
        throw error;
      }
      const dispatched = this.dispatch(nodeId, {
        type: "resume_session",
        sessionId: session.id,
        lastActivityAt: session.lastActivityAt ?? session.updatedAt,
        localPath: placement.localPath,
        agentSessionId: session.agentSessionId,
        contextOverflowRecoveryPrompt: contextOverflowRecoveryPrompt(session),
        additionalDirectories: session.additionalDirectories ?? [],
        sequenceOffset: this.store.maxEventSequence(session.id),
        yolo: session.yolo,
        // Re-issued, not replayed: `session/load` takes its own server list, and
        // an orchestrator reloaded without one wakes up with no way to dispatch.
        mcpServers: this.mcpServersFor(session),
        // The selection survives `session/load`, but the file it names has to
        // still be beneath the session; a scratch directory is exactly where
        // something else may have cleaned up while this node was away.
        agent: this.agentFor(session, node),
        config: this.startupConfigFor(session),
        readOnly: session.readOnly,
      });
      // The socket went away mid-sweep; the rest are settled and resumable by
      // hand, and the next reconnect will not pick them up again.
      if (!dispatched.sent) break;
      this.publishSession(
        this.transitionSession(session.id, "starting", "Reconnecting automatically", {
          type: "host",
          cause: "automatic_resume",
        }),
      );
      if (kind === "read-only") reservedReading += 1;
      else reservedWriting += 1;
      resumed += 1;
    }
    if (resumed > 0) {
      this.log.info(
        { nodeId, resumed, skipped: candidates.length - resumed },
        "Re-attached sessions after a node reconnect",
      );
    }
  }

  disconnectNode(nodeId: string, activity: string): void {
    this.commands.nodeDisconnected(nodeId);
    this.files.nodeDisconnected(nodeId);
    this.worktrees.nodeLost(nodeId);
    this.sessionRetention.nodeDisconnected(nodeId);
    this.nodeSockets.delete(nodeId);
    const node = this.store.setNodeOnline(nodeId, false, 0);
    if (node) this.publishNode(node);
    // Soft-fail: the Node may still be running agents and will resurrect
    // them on the next hello that lists those session ids.
    const before = new Map(
      this.store
        .listSessions()
        .filter(
          (session) =>
            session.nodeId === nodeId && !terminalSessionStates.has(session.state),
        )
        .map((session) => [session.id, session]),
    );
    const offline = this.store.markNodeSessionsOffline(nodeId, activity);
    for (const session of offline) {
      const prior = before.get(session.id);
      if (!prior) continue;
      this.acceptSessionTransition({
        before: prior,
        after: session,
        source: { type: "host", cause: "connectivity_lost" },
        intent: this.store.getSessionTransitionIntent(session.id),
        completion: this.store.getSessionTurnCompletion(session.id),
        context: this.notificationAttemptContext(prior),
      });
    }
    this.publishSessions(offline);
  }

  /** True while the Host is tearing down, so close handlers stay quiet. */
  get shuttingDown(): boolean {
    return this.closing;
  }

  handleEvent(event: SessionEvent): boolean {
    return this.handleEventResult(event).outcome === "accepted";
  }

  handleEventResult(event: SessionEvent): EventHandlingResult {
    let manualReceiptChanged = false;
    type WriteResult = {
      outcome: "accepted" | "permanent_rejection";
      reason?: "session_missing" | "identity_conflict";
      skipped: number;
      publish: boolean;
      notifyListeners: boolean;
      redispatchStop?: boolean;
      session?: FleetSession;
    };

    const write = (): WriteResult => {
      const session = this.store.getSession(event.sessionId);
      if (!session) {
        return {
          outcome: "permanent_rejection",
          reason: "session_missing",
          skipped: 0,
          publish: false,
          notifyListeners: false,
        };
      }
      const appended = this.store.appendEvent(event);
      if (!appended.stored) {
        return appended.conflict
          ? {
              outcome: "permanent_rejection",
              reason: "identity_conflict",
              skipped: 0,
              publish: false,
              notifyListeners: false,
            }
          : {
              outcome: "accepted",
              skipped: 0,
              publish: false,
              notifyListeners: false,
            };
      }
      let context = this.notificationAttemptContext(session);
      if (this.isStaleAttemptEvent(session, event, context)) {
        return {
          outcome: "accepted",
          skipped: appended.skipped,
          publish: false,
          notifyListeners: false,
        };
      }

      const dispatch = this.store.getSessionDispatchAttempt(session.id);
      const manual =
        dispatch &&
        this.store.prMaintenance.manualCommand(session.id, dispatch.commandId);
      const manualState =
        event.type === "state" ? eventPayload(event, "state")?.state : undefined;
      if (
        manual &&
        this.store.getSessionDispatchAttempt(session.id)?.commandId === manual.id &&
        event.sequence > manual.eventSeqFrom &&
        ((manual.kind === "prompt" && event.type === "turn_complete") ||
          (manualState !== undefined &&
            canTransition(session.state, manualState) &&
            (!session.dismissed || terminalSessionStates.has(manualState)) &&
            (terminalSessionStates.has(manualState) ||
              (manual.kind === "resume_session" && manualState === "idle"))))
      )
        manualReceiptChanged = this.store.prMaintenance.recordManualReceipt(
          session.id,
          manual.id,
          "settled",
        );

      if (event.type === "state") {
        const payload = eventPayload(event, "state");
        if (!payload?.state) {
          this.log.error(
            { sessionId: session.id, eventId: event.eventId },
            "Dropped an unreadable session state event",
          );
          return {
            outcome: "accepted",
            skipped: appended.skipped,
            publish: false,
            notifyListeners: false,
          };
        }
        if (session.dismissed && !terminalSessionStates.has(payload.state)) {
          this.log.warn(
            { sessionId: session.id, state: payload.state },
            "Recorded but ignored a live state event for a dismissed session",
          );
          return {
            outcome: "accepted",
            skipped: appended.skipped,
            publish: false,
            notifyListeners: false,
          };
        }
        if (!canTransition(session.state, payload.state)) {
          this.log.error(
            { sessionId: session.id, from: session.state, to: payload.state },
            "Dropped session state event the transition table forbids",
          );
          return {
            outcome: "accepted",
            skipped: appended.skipped,
            publish: false,
            notifyListeners: false,
          };
        }
        if (
          payload.state === "running" &&
          context.step &&
          event.sequence > context.step.eventSeqFrom
        ) {
          const step = this.store.updateRunStep(context.step.id, {
            eventSeqFrom: event.sequence,
          });
          if (step) context = { ...context, step };
        }

        const intent = this.store.getSessionTransitionIntent(session.id);
        let transitioned = this.transitionSession(
          session.id,
          payload.state,
          payload.activity ?? session.currentActivity,
          {
            type: "session_event",
            event: {
              eventId: event.eventId,
              sequence: event.sequence,
              createdAt: event.createdAt,
            },
          },
          context,
        );
        const redispatchStop =
          session.stopRequested === true && !terminalSessionStates.has(payload.state);
        if (session.stopRequested && terminalSessionStates.has(payload.state)) {
          transitioned = this.store.setSessionControls(session.id, {
            stopRequested: false,
          });
        }
        if (
          intent &&
          ["idle", "stopped", "completed", "failed"].includes(payload.state)
        ) {
          this.store.consumeSessionTransitionIntent(session.id);
        }
        this.clearConsumedTurnCompletion(transitioned, intent, context);
        if (terminalSessionStates.has(payload.state)) {
          this.resolveSessionPermissionRequests(session.id);
        }
        return {
          outcome: "accepted",
          skipped: appended.skipped,
          publish: true,
          notifyListeners: true,
          redispatchStop,
          session: transitioned,
        };
      }

      if (event.type === "turn_complete") {
        if (!eventPayload(event, "turn_complete")) {
          return {
            outcome: "accepted",
            skipped: appended.skipped,
            publish: false,
            notifyListeners: false,
          };
        }
        if (!this.store.getSessionTransitionIntent(session.id)) {
          this.store.setSessionTurnCompletion(session.id, {
            eventId: event.eventId,
            sequence: event.sequence,
            attempt: dispatch?.attempt ?? notificationAttemptKey(session, context),
          });
        }
      } else if (event.type === "permission") {
        const payload = eventPayload(event, "permission");
        if (!payload) {
          return {
            outcome: "accepted",
            skipped: appended.skipped,
            publish: false,
            notifyListeners: false,
          };
        }
        this.notifications.createPermissionRequest({
          session,
          requestId: payload.requestId,
          event: {
            eventId: event.eventId,
            sequence: event.sequence,
            createdAt: event.createdAt,
          },
          context,
        });
      } else if (event.type === "permission_result") {
        const payload = eventPayload(event, "permission_result");
        if (!payload) {
          return {
            outcome: "accepted",
            skipped: appended.skipped,
            publish: false,
            notifyListeners: false,
          };
        }
        this.notifications.resolvePermissionRequest({
          session,
          requestId: payload.requestId,
          event: {
            eventId: event.eventId,
            sequence: event.sequence,
            createdAt: event.createdAt,
          },
          context,
        });
      }

      return {
        outcome: "accepted",
        skipped: appended.skipped,
        publish: true,
        notifyListeners: true,
        session: this.store.getSession(session.id)!,
      };
    };

    const afterCommit = (result: WriteResult): void => {
      if (manualReceiptChanged) this.publishSnapshot();
      if (result.skipped > 0) {
        this.log.warn(
          { sessionId: event.sessionId, skipped: result.skipped },
          "Session events were lost while the Host was unreachable",
        );
      }
      if (result.publish && result.session) {
        this.broadcast({ type: "event", event });
        this.publishSession(result.session);
        if (result.notifyListeners) this.notifySessionEventListeners(event);
      }
      if (result.redispatchStop && result.session) {
        this.dispatch(result.session.nodeId, {
          type: "stop",
          sessionId: result.session.id,
        });
      }
    };

    try {
      const result = eventMayAffectNotifications(event)
        ? this.notifications.commitAtomically(write, afterCommit)
        : (() => {
            const committed = this.store.writeAtomically(write);
            afterCommit(committed);
            return committed;
          })();
      return result.outcome === "accepted"
        ? { outcome: "accepted" }
        : {
            outcome: "permanent_rejection",
            reason: result.reason ?? "identity_conflict",
          };
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        this.log.error({ error, event }, "Permanently rejected session event");
        return { outcome: "permanent_rejection", reason: "sqlite_constraint" };
      }
      this.log.error({ error, event }, "Rejected session event");
      return { outcome: "retryable_failure" };
    }
  }

  private notificationAttemptContext(session: FleetSession): NotificationAttemptContext {
    const context = this.runStepAttemptContext(session);
    if (!context.step) return {};
    const dispatch = this.store.getSessionDispatchAttempt(session.id);
    if (!dispatch) return context;
    return dispatch.attempt === notificationAttemptKey(session, context) ? context : {};
  }

  private runStepAttemptContext(session: FleetSession): NotificationAttemptContext {
    if (session.runRole !== "worker" && session.runRole !== "reviewer") return {};
    const step = this.store.getRunStepBySession(session.id);
    if (!step || (session.runId && step.runId !== session.runId)) return {};
    return { step, run: this.store.getRun(step.runId) };
  }

  private dispatchAttemptKey(session: FleetSession): string {
    const context = this.runStepAttemptContext(session);
    return context.step && !terminalRunStepStates.has(context.step.state)
      ? notificationAttemptKey(session, context)
      : `session:${session.id}`;
  }

  /**
   * Leaves an orchestration completion receipt until the step settlement that
   * consumes it. Everything else has already used the receipt, or invalidated
   * it by beginning another turn.
   */
  private clearConsumedTurnCompletion(
    session: FleetSession,
    intent: SessionTransitionIntent | undefined,
    context: NotificationAttemptContext,
  ): void {
    const stepConsumesReceipt =
      !intent &&
      context.step !== undefined &&
      !terminalRunStepStates.has(context.step.state) &&
      ["idle", "completed", "failed", "stopped"].includes(session.state);
    if (!stepConsumesReceipt) {
      this.store.clearSessionTurnCompletion(session.id);
    }
  }

  private isStaleAttemptEvent(
    session: FleetSession,
    event: SessionEvent,
    context: NotificationAttemptContext,
  ): boolean {
    if (session.runRole !== "worker" && session.runRole !== "reviewer") return false;
    if (
      !["state", "turn_complete", "error", "permission", "permission_result"].includes(
        event.type,
      )
    ) {
      return false;
    }
    const dispatch = this.store.getSessionDispatchAttempt(session.id);
    if (dispatch && event.sequence <= dispatch.eventSeqFrom) return true;
    if (dispatch?.attempt === `session:${session.id}`) return false;
    const step = context.step;
    if (!step) return false;
    let currentTerminalEvent = false;
    if (terminalRunStepStates.has(step.state)) {
      if (event.type === "permission_result") {
        // A failing agent can terminalize the step before denying its pending
        // permission request. The exact request identity still guards resolve.
        currentTerminalEvent = true;
      } else if (event.type === "state") {
        const intent = this.store.getSessionTransitionIntent(session.id);
        const state = eventPayload(event, "state")?.state;
        const settlesIntent =
          (intent === "stop" &&
            state !== undefined &&
            ["stopped", "failed"].includes(state)) ||
          (intent === "cancel" &&
            state !== undefined &&
            ["idle", "stopped", "failed"].includes(state));
        if (!settlesIntent) return true;
        currentTerminalEvent = true;
      } else {
        return true;
      }
    }
    if (event.sequence <= step.eventSeqFrom) return true;
    if (currentTerminalEvent) return false;
    if (event.type === "state") {
      const state = eventPayload(event, "state")?.state;
      if (state === "running") return false;
      if (step.state === "pending" && session.state === "starting" && state === "idle") {
        return false;
      }
    }
    // Once this attempt's running marker has advanced the sequence boundary,
    // ordering alone separates every later event from the previous attempt.
    if (step.state === "running") return false;
    if (!step.dispatchedAt) return false;
    const offset = this.store.eventClockOffsetMs(session.id, step.eventSeqFrom);
    if (offset === undefined) return false;
    return Date.parse(event.createdAt) + offset < Date.parse(step.dispatchedAt);
  }

  /** Applies the bounded notification retention policy and refreshes browsers once. */
  pruneNotifications(now = Date.now()): number {
    let pruned = 0;
    while (true) {
      const batch = this.store.pruneNotifications(now);
      pruned += batch;
      if (batch === 0) break;
    }
    if (pruned > 0) {
      this.broadcast({ type: "snapshot", data: this.snapshot() });
    }
    return pruned;
  }

  private notifySessionEventListeners(event: SessionEvent): void {
    // After persistence and any accepted transition, so listeners read the fact
    // they were told about rather than the state that preceded it.
    for (const listener of this.sessionEventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.error({ error, event }, "A session event listener threw");
      }
    }
  }

  /** Subscribes to session events; returns a function that unsubscribes. */
  onSessionEvent(listener: (event: SessionEvent) => void): () => void {
    this.sessionEventListeners.add(listener);
    return () => this.sessionEventListeners.delete(listener);
  }

  private transitionSession(
    sessionId: string,
    state: SessionState,
    activity: string | undefined,
    source: AcceptedSessionTransitionSource,
    context?: NotificationAttemptContext,
  ): FleetSession {
    const before = this.store.getSession(sessionId);
    if (!before) throw new Error("Session not found");
    const intent = this.store.getSessionTransitionIntent(sessionId);
    const completion = this.store.getSessionTurnCompletion(sessionId);
    const after = this.store.transitionSession(sessionId, state, activity);
    this.acceptSessionTransition({
      before,
      after,
      source,
      intent,
      completion,
      context: context ?? this.notificationAttemptContext(before),
    });
    return after;
  }

  private acceptSessionTransition(transition: AcceptedSessionTransition): void {
    const { before, after, source, intent, completion, context } = transition;
    if (after.runRole === "lead" && terminalSessionStates.has(after.state))
      this.commands.revokeLead(after.id);
    if (before.state === after.state) return;
    const attempt = notificationAttemptKey(after, context);
    const completed =
      !intent &&
      completion?.attempt === attempt &&
      (after.state === "idle" || after.state === "completed") &&
      (source.type === "session_event" ||
        (source.type === "reconciliation" && source.outcome === "restored"));
    const failed =
      after.state === "failed" &&
      (source.type === "fatal_command_result" ||
        (!intent &&
          (source.type === "session_event" ||
            (source.type === "reconciliation" && source.outcome === "missing"))));
    if (!completed && !failed) return;

    const identity =
      source.type === "session_event"
        ? {
            ...source.event,
            source: "session_event" as const,
          }
        : source.type === "fatal_command_result"
          ? {
              eventId: `command-result:${source.commandId}`,
              sequence: this.store.maxEventSequence(after.id),
              createdAt: source.createdAt,
              source: "fatal_command_result" as const,
            }
          : {
              eventId: `reconciliation:${source.outcome}:${after.id}:${after.updatedAt}`,
              sequence: this.store.maxEventSequence(after.id),
              createdAt: after.updatedAt,
              source: "reconciliation" as const,
            };
    this.notifications.createAgentLifecycle({
      kind: completed ? "agent_completion" : "agent_failure",
      session: after,
      transition: {
        ...identity,
        from: before.state,
        to: after.state,
      },
      ...(completed && completion
        ? {
            turnComplete: {
              eventId: completion.eventId,
              sequence: completion.sequence,
            },
          }
        : {}),
      context,
    });
  }

  /** Fails a session whose Node reported the command it was given did not run. */
  failFromCommandResult(sessionId: string, commandId: string, reason: string): void {
    this.notifications.commitAtomically(
      () => {
        const session = this.store.getSession(sessionId);
        if (!session || terminalSessionStates.has(session.state)) return undefined;
        const context = this.notificationAttemptContext(session);
        let failed = this.transitionSession(session.id, "failed", reason, {
          type: "fatal_command_result",
          commandId,
          createdAt: new Date().toISOString(),
        });
        if (session.stopRequested) {
          failed = this.store.setSessionControls(session.id, {
            stopRequested: false,
          });
        }
        this.store.consumeSessionTransitionIntent(session.id);
        this.clearConsumedTurnCompletion(failed, undefined, context);
        this.resolveSessionPermissionRequests(session.id);
        return failed;
      },
      (failed) => {
        if (failed) this.publishSession(failed);
      },
    );
  }

  /**
   * Tells browsers a command was refused without ending the session.
   *
   * The alternative was silence, and silence is what made a refused prompt
   * indistinguishable from an agent that had stopped answering.
   */
  reportSessionNotice(sessionId: string, message: string): void {
    this.broadcast({ type: "session_notice", sessionId, message });
  }

  /**
   * Settles a session whose start or resume the Node refused.
   *
   * A refusal is non-fatal because whatever session the Node holds is healthy,
   * and it re-announces that session's state ahead of the refusal. A refused
   * launch leaves nothing to re-announce: no process started, so nothing on the
   * Node will ever report on it again. Left in `starting`, the session was drawn
   * as running with Cancel disabled indefinitely, and Stop then Resume only sent
   * the same launch into the same refusal. Failing it keeps the conversation
   * resumable and puts the reason where the operator is already looking.
   */
  settleRefusedLaunch(sessionId: string, commandId: string, reason: string): void {
    const session = this.store.getSession(sessionId);
    if (
      !session ||
      (session.state !== "queued" && session.state !== "starting") ||
      this.store.getSessionDispatchAttempt(sessionId)?.commandId !== commandId
    )
      return;
    this.failFromCommandResult(
      sessionId,
      commandId,
      `${session.agentSessionId ? "Resume" : "Start"} refused: ${reason}`,
    );
  }

  /**
   * Marks nodes offline rather than failed, so a quick Host restart (tsx watch,
   * deploy bounce) can resurrect agents the Node kept alive.
   */
  shutdown(): void {
    this.worktrees.shutdown();
    this.closing = true;
    for (const [nodeId, socket] of [...this.nodeSockets.entries()]) {
      this.disconnectNode(nodeId, "Host stopped; waiting for Node reconnect");
      socket.close();
    }
    for (const socket of this.browserSockets) socket.close();
  }
}

function eventMayAffectNotifications(event: SessionEvent): boolean {
  return (
    event.type === "state" ||
    event.type === "permission" ||
    event.type === "permission_result"
  );
}

export function contextOverflowRecoveryPrompt(session: FleetSession): string {
  const assignment = session.initialPrompt.trim().slice(0, 12_000);
  const latest = session.lastText.trim().slice(-3_000);
  return [
    assignment ? `Original assignment:\n${assignment}` : "",
    latest ? `Most recent agent output:\n${latest}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 16_000);
}

function isSqliteConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown };
  return (
    candidate.code === "ERR_SQLITE_ERROR" &&
    typeof candidate.errcode === "number" &&
    (candidate.errcode & 0xff) === 19
  );
}
