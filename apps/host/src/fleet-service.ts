import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import {
  BrowserMessageSchema,
  HostToNodeMessageSchema,
  SessionStateSchema,
  canTransition,
  terminalSessionStates,
  type BrowserMessage,
  type FleetNode,
  type FleetSession,
  type NodeCommand,
  type SessionEvent,
  type SessionState,
  type Snapshot,
} from "@fleet/protocol";
import type { FleetStore } from "./store.js";

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
  /** Suppresses disconnect bookkeeping while the Host itself is shutting down. */
  private closing = false;

  constructor(
    readonly store: FleetStore,
    private readonly log: FastifyBaseLogger,
  ) {}

  snapshot(): Snapshot {
    return {
      nodes: this.store.listNodes(),
      workspaces: this.store.listWorkspaces(),
      placements: this.store.listPlacements(),
      sessions: this.store.listSessions(),
    };
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

  /** Records a heartbeat, publishing only when a browser would render it. */
  recordPresence(nodeId: string, activeSessionIds: readonly string[]): void {
    const { node, changed } = this.store.recordPresence(
      nodeId,
      true,
      activeSessionIds.length,
    );
    if (node && changed) this.publishNode(node);
    this.publishSessions(this.store.reconcileOfflineSessions(nodeId, activeSessionIds));
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
      if (!this.store.appendEvent(event)) return;
      this.broadcast({ type: "event", event });
      const session = this.store.getSession(event.sessionId);
      if (!session) return;
      if (event.type !== "state") {
        this.publishSession(this.store.getSession(session.id)!);
        return;
      }
      const state = SessionStateSchema.safeParse(event.payload.state);
      if (!state.success) return;
      // A rejected transition would otherwise strand the session in its old
      // state with nothing but a log line to explain it.
      if (!canTransition(session.state, state.data)) {
        this.log.error(
          { sessionId: session.id, from: session.state, to: state.data },
          "Dropped session state event the transition table forbids",
        );
        return;
      }
      this.publishSession(
        this.store.transitionSession(
          session.id,
          state.data,
          typeof event.payload.activity === "string"
            ? event.payload.activity
            : session.currentActivity,
        ),
      );
    } catch (error) {
      this.log.error({ error, event }, "Rejected session event");
    }
  }

  /** Fails a session whose Node reported the command it was given did not run. */
  failFromCommandResult(sessionId: string, reason: string): void {
    const session = this.store.getSession(sessionId);
    if (!session || terminalSessionStates.has(session.state)) return;
    this.publishSession(this.store.transitionSession(session.id, "failed", reason));
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
