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
  eventPayload,
  nodeUpdateState,
  terminalSessionStates,
  type BrowserMessage,
  type FleetNode,
  type FleetSession,
  type HostBackup,
  type McpHttpServer,
  type NodeCommand,
  type NodeUpdateStage,
  type Placement,
  type Run,
  type RunRole,
  type RunStep,
  type SessionEvent,
  type SessionState,
  type Snapshot,
} from "@fleet/protocol";
import type { FleetStore } from "./store.js";
import { isBroadcastableHostUrl } from "./host-url.js";
import { reservedSessionCount, yoloUnsupportedReason } from "./session-policy.js";

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
  ) {}

  snapshot(): Snapshot {
    return {
      nodes: this.store.listNodes(),
      workspaces: this.store.listWorkspaces(),
      placements: this.store.listPlacements(),
      sessions: this.store.listSessions(),
      runs: this.store.listRuns(),
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
  }):
    | { ok: true; session: FleetSession }
    | { ok: false; status: number; error: string; session?: FleetSession } {
    const node = this.store.getNode(input.placement.nodeId);
    if (!node?.online) return { ok: false, status: 409, error: "Node is offline" };
    if (reservedSessionCount(this.store.listSessions(), node.id) >= node.maxSessions) {
      return { ok: false, status: 409, error: "Node is at capacity" };
    }
    const unsupported = yoloUnsupportedReason(node, input.yolo);
    if (unsupported) return { ok: false, status: 409, error: unsupported };

    const session = this.store.createSession(
      input.placement,
      input.prompt,
      input.yolo,
      input.name ?? "",
      { runId: input.runId ?? "", runRole: input.runRole ?? "" },
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
      },
      { state: "failed", activity: "Node disconnected before process start" },
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
   * Sends a command to a Node and, when it cannot be delivered, settles the
   * session the caller was acting on.
   */
  dispatch(
    nodeId: string,
    request: CommandRequest,
    fallback?: DispatchFallback,
  ): DispatchResult {
    const socket = this.nodeSockets.get(nodeId);
    if (socket && socket.readyState === socket.OPEN) {
      const command = { ...request, commandId: randomUUID() } as NodeCommand;
      this.send(socket, HostToNodeMessageSchema.parse({ type: "command", command }));
      return { sent: true };
    }
    if (!fallback) return { sent: false };
    const session = this.store.transitionSession(
      request.sessionId,
      fallback.state,
      fallback.activity,
    );
    this.publishSession(session);
    return { sent: false, session };
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
  ): void {
    const { node, changed } = this.store.recordPresence(
      nodeId,
      true,
      activeSessionIds.length,
    );
    if (node && changed) this.publishNode(node);
    this.publishSessions(this.reconcile(nodeId, activeSessionIds, busySessionIds));
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
    const settled = this.store.reconcileOfflineSessions(
      nodeId,
      activeSessionIds,
      busySessionIds,
    );
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
      .filter((session) => session.state === "failed" && session.agentSessionId)
      // Newest first, by creation: when capacity cannot cover them all, the
      // most recently started work is the likeliest to still matter. Last
      // activity would be the better signal, but reconciliation has just
      // stamped every one of these rows with the same instant, so it no longer
      // distinguishes them.
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (candidates.length === 0) return;

    let reserved = reservedSessionCount(this.store.listSessions(), nodeId);
    let resumed = 0;
    for (const session of candidates) {
      if (reserved >= node.maxSessions) break;
      const placement = this.store.getPlacement(session.placementId);
      if (!placement) continue;
      if (yoloUnsupportedReason(node, session.yolo)) continue;
      const dispatched = this.dispatch(nodeId, {
        type: "resume_session",
        sessionId: session.id,
        localPath: placement.localPath,
        agentSessionId: session.agentSessionId,
        sequenceOffset: this.store.maxEventSequence(session.id),
        yolo: session.yolo,
        // Re-issued, not replayed: `session/load` takes its own server list, and
        // an orchestrator reloaded without one wakes up with no way to dispatch.
        mcpServers: this.mcpServersFor(session),
        // The selection survives `session/load`, but the file it names has to
        // still be beneath the session; a scratch directory is exactly where
        // something else may have cleaned up while this node was away.
        agent: this.agentFor(session, node),
      });
      // The socket went away mid-sweep; the rest are settled and resumable by
      // hand, and the next reconnect will not pick them up again.
      if (!dispatched.sent) break;
      this.publishSession(
        this.store.transitionSession(
          session.id,
          "starting",
          "Reconnecting automatically",
        ),
      );
      reserved += 1;
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
    this.publishSessions(this.store.markNodeSessionsOffline(nodeId, activity));
  }

  /** True while the Host is tearing down, so close handlers stay quiet. */
  get shuttingDown(): boolean {
    return this.closing;
  }

  handleEvent(event: SessionEvent): void {
    try {
      const appended = this.store.appendEvent(event);
      if (!appended.stored) return;
      if (appended.skipped > 0) {
        this.log.warn(
          { sessionId: event.sessionId, skipped: appended.skipped },
          "Session events were lost while the Host was unreachable",
        );
      }
      this.broadcast({ type: "event", event });
      const session = this.store.getSession(event.sessionId);
      if (!session) return;
      if (event.type !== "state") {
        this.publishSession(this.store.getSession(session.id)!);
        return;
      }
      const payload = eventPayload(event, "state");
      if (!payload?.state) return;
      // A rejected transition would otherwise strand the session in its old
      // state with nothing but a log line to explain it.
      if (!canTransition(session.state, payload.state)) {
        this.log.error(
          { sessionId: session.id, from: session.state, to: payload.state },
          "Dropped session state event the transition table forbids",
        );
        return;
      }
      this.publishSession(
        this.store.transitionSession(
          session.id,
          payload.state,
          payload.activity ?? session.currentActivity,
        ),
      );
    } catch (error) {
      this.log.error({ error, event }, "Rejected session event");
    } finally {
      // After the store is updated, so a listener that reads it sees the event
      // it was told about. One-way on purpose: the service never imports the
      // orchestrator, which is what keeps the dependency pointing inward.
      for (const listener of this.sessionEventListeners) {
        try {
          listener(event);
        } catch (error) {
          this.log.error({ error, event }, "A session event listener threw");
        }
      }
    }
  }

  /** Subscribes to session events; returns a function that unsubscribes. */
  onSessionEvent(listener: (event: SessionEvent) => void): () => void {
    this.sessionEventListeners.add(listener);
    return () => this.sessionEventListeners.delete(listener);
  }

  /** Fails a session whose Node reported the command it was given did not run. */
  failFromCommandResult(sessionId: string, reason: string): void {
    const session = this.store.getSession(sessionId);
    if (!session || terminalSessionStates.has(session.state)) return;
    this.publishSession(this.store.transitionSession(session.id, "failed", reason));
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
