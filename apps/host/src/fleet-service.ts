import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import {
  BrowserMessageSchema,
  HOST_URL_SYNC_CAPABILITY,
  HostToNodeMessageSchema,
  NODE_NAME_SYNC_CAPABILITY,
  SELF_UPDATE_CAPABILITY,
  canTransition,
  canTransitionRun,
  canTransitionRunStep,
  eventPayload,
  liveSessionStates,
  nodeUpdateState,
  terminalRunStepStates,
  terminalSessionStates,
  type BrowserMessage,
  type FleetNode,
  type FleetSession,
  type HostBackup,
  type McpHttpServer,
  type NodeCommand,
  type NodeUpdateStage,
  type Notification,
  type Placement,
  type StartupConfig,
  type Run,
  type RunRole,
  type RunStep,
  type RunStepState,
  type SessionEvent,
  type SessionState,
  type Snapshot,
} from "@fleet/protocol";
import type {
  FleetStore,
  SessionTransitionIntent,
  SessionTurnCompletion,
} from "./store.js";
import { isBroadcastableHostUrl } from "./host-url.js";
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

export type DispatchResult = {
  sent: boolean;
  /** The session after the fallback transition, when one was applied. */
  session?: FleetSession;
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
  private readonly nodeSockets = new Map<string, WebSocket>();
  private readonly browserSockets = new Set<WebSocket>();
  /**
   * Nodes told to update that have not yet reported how it went.
   *
   * A Node's last word before an update is "restarting", sent immediately
   * before it exits: there is nobody left to send anything after that. The Host
   * has to notice the return itself, so it remembers which Nodes owe it one.
   */
  private readonly updatesInFlight = new Set<string>();
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
  private leadTokens: { mint: (sessionId: string) => string } | undefined;
  private mcpUrl: (() => string) | undefined;
  private runTicker: ((runId: string) => void) | undefined;
  readonly notifications: NotificationService;

  /** Wires the orchestration seams. Called once, from `server.ts`. */
  attachOrchestration(input: {
    leadTokens: { mint: (sessionId: string) => string };
    mcpUrl: () => string;
    tickRun: (runId: string) => void;
  }): void {
    this.leadTokens = input.leadTokens;
    this.mcpUrl = input.mcpUrl;
    this.runTicker = input.tickRun;
  }

  /** Advances one run now, used by the tools so a dispatch is not left waiting. */
  tickRun(runId: string): void {
    this.runTicker?.(runId);
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
  ) {
    this.notifications = new NotificationService(store, {
      notificationUpsert: (notification) => this.publishNotification(notification),
      notificationUnreadCount: (unreadCount) =>
        this.publishNotificationUnreadCount(unreadCount),
      runUpsert: (run) => this.publishRun(run),
    });
  }

  snapshot(): Snapshot {
    return {
      nodes: this.store.listNodes(),
      workspaces: this.store.listWorkspaces(),
      placements: this.store.listPlacements(),
      sessions: this.store.listSessions(),
      runs: this.store.listRuns(),
      notifications: this.store.listNotificationHydration(),
      notificationUnreadCount: this.store.notificationUnreadCount(),
      hostRevision: this.hostRevision,
    };
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

  nodeSocket(nodeId: string): WebSocket | undefined {
    return this.nodeSockets.get(nodeId);
  }

  attachNode(nodeId: string, socket: WebSocket): void {
    this.nodeSockets.set(nodeId, socket);
  }

  /** Hangs up on a Node the operator deleted; no session bookkeeping follows. */
  evictNode(nodeId: string, code: number, reason: string): void {
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
    for (const [nodeId, socket] of [...this.nodeSockets.entries()]) {
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
    this.evictAllNodes(4002, "Host restored from backup");
    this.store.replaceHostBackup(backup);
    this.broadcast({ type: "snapshot", data: this.snapshot() });
  }

  send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  broadcast(message: BrowserMessage): void {
    BrowserMessageSchema.parse(message);
    for (const socket of this.browserSockets) this.send(socket, message);
  }

  publishNode(node: FleetNode): void {
    this.broadcast({ type: "node", node });
  }

  publishSession(session: FleetSession): void {
    this.broadcast({ type: "session", session });
  }

  publishSessions(sessions: readonly FleetSession[]): void {
    for (const session of sessions) this.publishSession(session);
  }

  publishRun(run: Run): void {
    this.broadcast({ type: "run", run });
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

  requestRunReview(input: {
    runId: string;
    note: string;
    reason: "completed" | "blocked";
  }): Run | undefined {
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
        return { run: updatedRun, step: updatedStep };
      },
      (result) => {
        if (!result) return;
        this.publishRun(result.run);
        this.publishRunSteps(result.run.id, this.store.listRunSteps(result.run.id));
      },
    );
    return settled !== undefined;
  }

  /** Steps travel whole: a step that was removed has no row left to describe. */
  publishRunSteps(runId: string, steps: readonly RunStep[]): void {
    this.broadcast({ type: "run_steps", runId, steps: [...steps] });
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

  /**
   * Creates a session and asks its Node to start it.
   *
   * Shared by the REST route, the orchestrator, and the MCP facade so all three
   * enforce the same admission rules — capacity, yolo support, a live node —
   * rather than each growing its own copy that drifts.
   */
  createAndStartSession(input: {
    placement: Placement;
    prompt: string;
    yolo: boolean;
    name?: string;
    runId?: string;
    runRole?: RunRole;
    /** Work that only reads, which is counted against its own allowance. */
    readOnly?: boolean;
    /** Authoritative orchestration attempt when the step is not attached yet. */
    dispatchAttempt?: string;
  }):
    | { ok: true; session: FleetSession }
    | { ok: false; status: number; error: string; session?: FleetSession } {
    const node = this.store.getNode(input.placement.nodeId);
    if (!node?.online) return { ok: false, status: 409, error: "Node is offline" };
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

    const session = this.store.createSession(
      input.placement,
      input.prompt,
      input.yolo,
      input.name ?? "",
      {
        runId: input.runId ?? "",
        runRole: input.runRole ?? "",
        readOnly: input.readOnly ?? false,
      },
    );
    this.publishSession(session);
    const dispatched = this.dispatch(
      node.id,
      {
        type: "start_session",
        sessionId: session.id,
        localPath: input.placement.localPath,
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
    return { ok: true, session };
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
      (session) => session.agentSessionId === input.agentSessionId,
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
   * Re-attaches one finished Copilot conversation without prompting it.
   *
   * Kept beside creation because both paths enforce the same admission rules
   * and assemble the same launch context. The caller may send a prompt
   * immediately afterwards: the Node queues it behind session initialization.
   */
  resumeSession(
    sessionId: string,
    activity = "Resuming Copilot session",
  ): { ok: true; session: FleetSession } | { ok: false; status: number; error: string } {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
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

    const resumed = this.transitionSession(sessionId, "starting", activity, {
      type: "host",
      cause: "resume_requested",
    });
    this.publishSession(resumed);
    const dispatched = this.dispatch(
      session.nodeId,
      {
        type: "resume_session",
        sessionId,
        localPath: placement.localPath,
        agentSessionId: session.agentSessionId,
        additionalDirectories: session.additionalDirectories ?? [],
        sequenceOffset: this.store.maxEventSequence(sessionId),
        yolo: session.yolo,
        mcpServers: this.mcpServersFor(session),
        agent: this.agentFor(session, node),
        config: this.startupConfigFor(session),
        readOnly: session.readOnly,
      },
      { state: "failed", activity: "Node disconnected before session resume" },
    );
    if (!dispatched.sent) return { ok: false, status: 503, error: "Node is offline" };

    return { ok: true, session: resumed };
  }

  /**
   * The MCP servers a session should be given, on start and on resume alike.
   *
   * Derived from the session's role rather than stored, so there is one answer
   * to "what tools does this have" and a resumed orchestrator cannot come back
   * without them. A fresh token is minted each time: they are cheap, and it
   * means an old one stops working the moment a session restarts.
   */
  mcpServersFor(session: Pick<FleetSession, "id" | "runRole">): McpHttpServer[] {
    if (session.runRole !== "lead" || !this.leadTokens || !this.mcpUrl) return [];
    const token = this.leadTokens.mint(session.id);
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
    session: Pick<FleetSession, "runRole">,
    node: Pick<FleetNode, "agents">,
  ): string {
    if (session.runRole !== "lead") return "";
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
  startupConfigFor(session: Pick<FleetSession, "runRole">): StartupConfig[] {
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
  ): DispatchResult {
    const lifecycleIntent =
      request.type === "cancel" || request.type === "stop" ? request.type : undefined;
    const socket = this.nodeSockets.get(nodeId);
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
        const commandId = randomUUID();
        const attempt = attemptOverride ?? this.dispatchAttemptKey(session);
        const eventSeqFrom =
          request.type === "resume_session"
            ? request.sequenceOffset
            : this.store.maxEventSequence(request.sessionId);
        // A new attempt must not inherit a stop/cancel or completion receipt
        // from the old one, and its sequence boundary must be durable before send.
        this.store.writeAtomically(() => {
          this.store.clearSessionTransitionIntent(request.sessionId);
          this.store.clearSessionTurnCompletion(request.sessionId);
          this.store.setSessionDispatchAttempt(request.sessionId, {
            commandId,
            eventSeqFrom,
            attempt,
          });
        });
        const command = { ...request, commandId } as NodeCommand;
        this.send(socket, HostToNodeMessageSchema.parse({ type: "command", command }));
        return { sent: true };
      }
      const command = { ...request, commandId: randomUUID() } as NodeCommand;
      this.send(socket, HostToNodeMessageSchema.parse({ type: "command", command }));
      return { sent: true };
    }
    if (!fallback) return { sent: false };
    const session = this.notifications.commitAtomically(
      () => {
        if (lifecycleIntent) {
          this.store.setSessionTransitionIntent(request.sessionId, lifecycleIntent);
          this.store.clearSessionTurnCompletion(request.sessionId);
        }
        const settled = this.transitionSession(
          request.sessionId,
          fallback.state,
          fallback.activity,
          { type: "host", cause: "dispatch_fallback" },
        );
        if (terminalSessionStates.has(fallback.state)) {
          this.store.clearSessionTurnCompletion(request.sessionId);
        }
        if (lifecycleIntent) {
          this.store.consumeSessionTransitionIntent(request.sessionId);
        }
        if (terminalSessionStates.has(fallback.state)) {
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
        const session = this.transitionSession(sessionId, state, activity, {
          type: "host",
          cause: "operator_settlement",
        });
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
    const socket = this.nodeSockets.get(nodeId);
    if (!socket || socket.readyState !== socket.OPEN) {
      return { started: false, reason: `${node.name} is offline` };
    }
    const live = this.store
      .listSessions()
      .filter(
        (session) =>
          session.nodeId === nodeId && !terminalSessionStates.has(session.state),
      );
    if (live.length > 0) {
      if (!stopSessions) {
        return {
          started: false,
          reason: `${node.name} is running ${live.length} session(s); updating would stop them`,
          blockedBy: live,
        };
      }
      // Stopped before the update rather than left to die with the process, so
      // each one ends as something an operator asked for and its agent is given
      // the chance to shut down rather than being killed mid-write.
      for (const session of live) {
        this.dispatch(
          nodeId,
          { type: "stop", sessionId: session.id },
          { state: "stopped", activity: "Stopped to update the node" },
        );
      }
      this.log.info(
        { nodeId, stopped: live.length },
        "Stopping sessions so the node can update",
      );
    }
    const updateId = randomUUID();
    this.send(socket, HostToNodeMessageSchema.parse({ type: "update_node", updateId }));
    this.log.info({ nodeId, updateId }, "Asked node to update itself");
    this.updatesInFlight.add(nodeId);
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

  publishNodeUpdate(nodeId: string, stage: NodeUpdateStage, detail: string): void {
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
    if (!this.updatesInFlight.has(nodeId)) return;
    const landed = revision?.trim();
    this.log.info({ nodeId, revision: landed }, "Node returned from its update");
    this.publishNodeUpdate(
      nodeId,
      "up_to_date",
      landed ? `Updated to ${landed.slice(0, 12)}` : "Update finished",
    );
  }

  /** Records a heartbeat, publishing only when a browser would render it. */
  recordPresence(
    nodeId: string,
    activeSessionIds: readonly string[],
    busySessionIds: readonly string[] = [],
    reconcileSessions = true,
  ): void {
    const { node, changed } = this.store.recordPresence(
      nodeId,
      true,
      activeSessionIds.length,
    );
    if (node && changed) this.publishNode(node);
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
        const offline = new Map(
          this.store
            .listSessions()
            .filter((session) => session.nodeId === nodeId && session.state === "offline")
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
          const prior = offline.get(session.id);
          if (prior) {
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
            if (
              prior.intent &&
              ["idle", "stopped", "completed", "failed"].includes(session.state)
            ) {
              this.store.consumeSessionTransitionIntent(session.id);
            }
            this.clearConsumedTurnCompletion(session, prior.intent, prior.context);
          }
          if (session.state === "failed") {
            this.resolveSessionPermissionRequests(session.id);
          }
        }
        return reconciled;
      },
      (reconciled) => this.publishSessions(reconciled),
    );
    for (const session of settled) {
      if (!session.stopRequested) continue;
      this.dispatch(nodeId, { type: "stop", sessionId: session.id });
    }
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
          !session.dismissed,
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
      const placement = this.store.getPlacement(session.placementId);
      if (!placement) continue;
      if (yoloUnsupportedReason(node, session.yolo)) continue;
      const dispatched = this.dispatch(nodeId, {
        type: "resume_session",
        sessionId: session.id,
        localPath: placement.localPath,
        agentSessionId: session.agentSessionId,
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
          session.stopRequested && !terminalSessionStates.has(payload.state);
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
            attempt: notificationAttemptKey(session, context),
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
   * Marks nodes offline rather than failed, so a quick Host restart (tsx watch,
   * deploy bounce) can resurrect agents the Node kept alive.
   */
  shutdown(): void {
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

function isSqliteConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown };
  return (
    candidate.code === "ERR_SQLITE_ERROR" &&
    typeof candidate.errcode === "number" &&
    (candidate.errcode & 0xff) === 19
  );
}
