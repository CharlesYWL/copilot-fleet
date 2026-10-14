import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CONSOLE_REPLAY_MAX_BYTES,
  ConsoleActionSchema,
  ConsoleRequestSchema,
  CONTEXT_TIER_CONFIG_ID,
  ContextTierSchema,
  SessionPermissions,
  errorMessage,
  liveSessionStates,
  terminalSessionStates,
  type BrowserMessage,
  type ConsoleAction,
  type ConsoleGrant,
  type ConsoleOperation,
  type ConsoleRequest,
  type ConsoleSessionView,
  type FleetSession,
} from "@fleet/protocol";
import type { FleetService, NodeLink } from "./fleet-service.js";
import { HOST_IDENTITY_ID_SETTING } from "./auth/host-identity.js";

type Peer = {
  link: NodeLink;
  syncing: boolean;
  active: string[];
  busy: string[];
  subscriptions: Set<string>;
  sentGrants: Map<string, string>;
  replayTail: Promise<void>;
  pendingReplays: number;
  pendingReplayBytes: number;
  replayFailed: boolean;
};

export class ConsoleRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A scoped client of the existing Fleet services, never an administrator proxy. */
export class SessionConsoleService {
  private readonly peers = new Map<string, Peer>();
  constructor(private readonly service: FleetService) {}
  private get store() {
    return this.service.store;
  }

  attach(nodeId: string, link: NodeLink, active: string[], busy: string[]): void {
    this.peers.set(nodeId, {
      link,
      syncing: true,
      active,
      busy,
      subscriptions: new Set(),
      sentGrants: new Map(),
      replayTail: Promise.resolve(),
      pendingReplays: 0,
      pendingReplayBytes: 0,
      replayFailed: false,
    });
  }
  detach(nodeId: string): void {
    this.peers.delete(nodeId);
  }
  blocked(nodeId: string): boolean {
    return this.peers.get(nodeId)?.syncing === true;
  }
  enabled(nodeId: string): boolean {
    return this.peers.has(nodeId);
  }
  reserved(sessionId: string): boolean {
    return this.store.sessionConsole
      .localOperations(sessionId)
      .some(
        (operation) => operation.state === "queued" || operation.state === "accepted",
      );
  }
  controlQueue(
    sessionId: string,
    messageId: string,
    action: "cancel" | "send-now",
  ): void {
    const session = this.store.getSession(sessionId);
    const peer = session && this.peers.get(session.nodeId);
    if (!peer || peer.syncing)
      throw new ConsoleRequestError(
        409,
        "Reconnect and synchronize the Node before controlling its queue",
      );
    const operation = this.store.sessionConsole
      .localOperations(sessionId)
      .find((item) => item.id === messageId);
    if (operation?.state !== "queued")
      throw new ConsoleRequestError(409, "Local queued message has already changed");
    this.service.send(peer.link, {
      type: "session_console_queue",
      sessionId,
      messageId,
      action,
      operationId: randomUUID(),
    });
  }

  private own(nodeId: string, id: string): FleetSession {
    const session = this.store.getSession(id);
    if (!session || session.nodeId !== nodeId)
      throw new ConsoleRequestError(404, "Session is not available on this Node");
    return session;
  }

  private grant(session: FleetSession): ConsoleGrant {
    const hostId = this.store.getSetting(HOST_IDENTITY_ID_SETTING);
    if (!hostId) throw new ConsoleRequestError(503, "Host identity is not initialized");
    return this.store.sessionConsole.grant(
      hostId,
      session,
      this.store.maxEventSequence(session.id),
    );
  }

  observe(session: FleetSession): void {
    const peer = this.peers.get(session.nodeId);
    if (!peer || session.runRole === "lead" || session.cleanupRequested) return;
    const identity = JSON.stringify([
      session.name,
      session.agentSessionId,
      session.executionBinding?.worktreeId,
      session.executionBinding?.generation,
      session.executionBinding?.cwd,
      session.executionBinding?.leaseAttempt,
    ]);
    if (peer.sentGrants.get(session.id) === identity) return;
    if (
      !liveSessionStates.has(session.state) &&
      !this.store.sessionConsole.get(session.id)
    )
      return;
    const grant = this.grant(session);
    peer.sentGrants.set(session.id, identity);
    this.service.send(peer.link, { type: "session_console_grant", grant });
  }

  publish(message: BrowserMessage): void {
    const id =
      message.type === "session"
        ? message.session.id
        : message.type === "event"
          ? message.event.sessionId
          : message.type === "transcript" ||
              message.type === "transcript_reset" ||
              message.type === "session_notice"
            ? message.sessionId
            : undefined;
    if (!id) return;
    const session = this.store.getSession(id);
    if (!session) return;
    const peer = this.peers.get(session.nodeId);
    if (peer?.subscriptions.has(id))
      this.service.send(peer.link, { type: "session_console_update", message });
  }

  async handle(nodeId: string, requestId: string, raw: ConsoleRequest): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (!peer) return;
    if (raw.kind === "replay") {
      const bytes = Buffer.byteLength(JSON.stringify(raw));
      if (
        bytes > CONSOLE_REPLAY_MAX_BYTES ||
        peer.pendingReplays >= 128 ||
        (peer.pendingReplays > 0 && peer.pendingReplayBytes + bytes > 8 * 1024 * 1024)
      ) {
        peer.replayFailed = true;
        peer.syncing = true;
        this.service.send(peer.link, {
          type: "session_console_response",
          response: {
            requestId,
            ok: false,
            status: 429,
            error: "Session event window is full; retain and reconcile local history",
          },
        });
        return;
      }
      peer.pendingReplays++;
      peer.pendingReplayBytes += bytes;
      const work = peer.replayTail
        .then(async () => {
          if (
            this.peers.get(nodeId) !== peer ||
            this.service.nodeSocket(nodeId) !== peer.link
          )
            return;
          if (peer.replayFailed) {
            this.service.send(peer.link, {
              type: "session_console_response",
              response: {
                requestId,
                ok: false,
                status: 409,
                error:
                  "Earlier history failed validation; reconnect to reconcile retained evidence",
              },
            });
            return;
          }
          await this.handleRequest(nodeId, peer, requestId, raw);
        })
        .finally(() => {
          peer.pendingReplays--;
          peer.pendingReplayBytes -= bytes;
        });
      peer.replayTail = work.catch(() => undefined);
      return work;
    }
    return this.handleRequest(nodeId, peer, requestId, raw);
  }

  private async handleRequest(
    nodeId: string,
    peer: Peer,
    requestId: string,
    raw: ConsoleRequest,
  ): Promise<void> {
    try {
      const request = ConsoleRequestSchema.parse(raw);
      const data = await this.request(nodeId, peer, request);
      if (this.peers.get(nodeId) === peer) {
        this.service.send(peer.link, {
          type: "session_console_response",
          response: { requestId, ok: true, data },
        });
        if (request.kind === "synchronized" && peer.link.readyState === peer.link.OPEN) {
          peer.syncing = false;
          this.service.commands.reconnect(nodeId);
          this.service.reconcile(nodeId, peer.active, peer.busy);
          for (const id of new Set(
            request.sessions.map(
              (entry) => this.store.getSession(entry.sessionId)?.runId,
            ),
          ))
            if (id) this.service.tickRun(id);
        }
      }
    } catch (error) {
      if (raw.kind === "replay") {
        peer.replayFailed = true;
        peer.syncing = true;
      }
      if (this.peers.get(nodeId) === peer)
        this.service.send(peer.link, {
          type: "session_console_response",
          response: {
            requestId,
            ok: false,
            status: error instanceof ConsoleRequestError ? error.status : 409,
            error: errorMessage(error),
          },
        });
    }
  }

  private view(nodeId: string, id: string): ConsoleSessionView {
    const session = this.own(nodeId, id);
    if (!session.cleanupRequested) this.store.touchSessionActivity(id);
    const permissions = new SessionPermissions();
    permissions.apply(this.store.listPermissionEvents(id));
    return {
      session,
      node: this.store.getNode(nodeId),
      placement: this.store.getPlacement(session.placementId),
      permissions: permissions.latestEvents(),
      messages: this.service.messages.list(id),
      status: this.blocked(nodeId) ? "syncing" : "online",
      offlineAllowed:
        session.runRole !== "lead" && !session.cleanupRequested && !session.stopRequested,
    };
  }

  private async request(
    nodeId: string,
    peer: Peer,
    request: ConsoleRequest,
  ): Promise<unknown> {
    if (request.kind === "initialize") {
      peer.syncing = true;
      peer.replayFailed = false;
      for (const id of [...request.activeSessionIds, ...request.busySessionIds])
        this.own(nodeId, id);
      peer.active = request.activeSessionIds;
      peer.busy = request.busySessionIds;
      const grants: ConsoleGrant[] = [];
      const unavailableSessionIds: string[] = [];
      for (const id of new Set([
        ...peer.active,
        ...request.sessions.map((entry) => entry.sessionId),
      ])) {
        if (!this.store.getSession(id)) {
          unavailableSessionIds.push(id);
          continue;
        }
        const session = this.own(nodeId, id);
        if (session.runRole === "lead") continue;
        const old = request.sessions.find((entry) => entry.sessionId === id);
        const saved = this.store.sessionConsole.get(id);
        if (old && (!saved || old.grantId !== saved.grantId))
          throw new ConsoleRequestError(
            409,
            "Session history belongs to a different grant; reconciliation is required",
          );
        grants.push(this.grant(session));
      }
      return { grants, unavailableSessionIds };
    }
    if (request.kind === "catalog") {
      const all = this.store
        .listSessions()
        .filter((session) => session.nodeId === nodeId)
        .sort((a, b) => a.id.localeCompare(b.id));
      const start = request.cursor
        ? all.findIndex((session) => session.id > request.cursor!)
        : 0;
      const sessions = start < 0 ? [] : all.slice(start, start + request.limit);
      const nextCursor =
        start >= 0 && start + sessions.length < all.length
          ? sessions.at(-1)?.id
          : undefined;
      return { sessions, ...(nextCursor ? { nextCursor } : {}) };
    }
    if (request.kind === "synchronized") {
      for (const entry of request.sessions) {
        this.own(nodeId, entry.sessionId);
        const grant = this.store.sessionConsole.get(entry.sessionId);
        if (
          !grant ||
          grant.grantId !== entry.grantId ||
          this.store.maxEventSequence(entry.sessionId) < entry.highWater ||
          grant.controlEpoch !== entry.controlEpoch
        )
          throw new ConsoleRequestError(409, "History synchronization is incomplete");
      }
      for (const id of [...request.activeSessionIds, ...request.busySessionIds])
        this.own(nodeId, id);
      peer.active = request.activeSessionIds;
      peer.busy = request.busySessionIds;
      const active = new Set(peer.active);
      for (const entry of request.sessions) {
        const session = this.own(nodeId, entry.sessionId);
        if (!active.has(session.id) && !terminalSessionStates.has(session.state))
          this.store.transitionSession(
            session.id,
            "offline",
            "Recorded history recovered; the Node has no live process for this session",
          );
      }
      return { ok: true };
    }
    const session = this.own(nodeId, request.sessionId);
    if (request.kind === "session") return this.view(nodeId, session.id);
    if (request.kind === "messages") return this.service.messages.list(session.id);
    if (request.kind === "subscribe") {
      peer.subscriptions.add(session.id);
      return this.view(nodeId, session.id);
    }
    if (request.kind === "unsubscribe") {
      peer.subscriptions.delete(session.id);
      return { ok: true };
    }
    if (request.kind === "transcript") {
      if (!session.cleanupRequested && request.before === undefined)
        this.store.touchSessionActivity(session.id);
      return this.service.transcripts.page(session.id, request);
    }
    if (request.kind === "replay") {
      if (Buffer.byteLength(JSON.stringify(request)) > CONSOLE_REPLAY_MAX_BYTES)
        throw new ConsoleRequestError(413, "Replay batch is too large");
      const grant = this.store.sessionConsole.get(session.id);
      if (!grant || grant.grantId !== request.grantId || session.runRole === "lead")
        throw new ConsoleRequestError(409, "Offline session ownership changed");
      if (!this.store.sessionConsole.matches(grant, session))
        throw new ConsoleRequestError(409, "Workspace binding changed");
      let previous = -1;
      const operations = [...request.operations].sort(
        (a, b) => a.afterSequence - b.afterSequence,
      );
      const applyOperations = (through: number) => {
        while (operations.length && operations[0]!.afterSequence <= through)
          this.importOperation(nodeId, session, operations.shift()!);
      };
      for (const event of request.events) {
        if (event.sessionId !== session.id || event.sequence <= previous)
          throw new ConsoleRequestError(400, "Replay events are not in session order");
        previous = event.sequence;
        applyOperations(event.sequence - 1);
        const result = this.service.handleEventResult(event);
        if (result.outcome !== "accepted")
          throw new ConsoleRequestError(
            409,
            "Event evidence conflicts with Host history; local evidence must be retained",
          );
      }
      applyOperations(this.store.maxEventSequence(session.id));
      return { throughSequence: this.store.maxEventSequence(session.id) };
    }
    if (request.kind === "action")
      return this.action(nodeId, request.sessionId, request.input);
    throw new ConsoleRequestError(400, "Unsupported console request");
  }

  private importOperation(
    nodeId: string,
    session: FleetSession,
    operation: ConsoleOperation,
  ): void {
    this.store.writeAtomically(() => this.applyOperation(nodeId, session, operation));
  }

  private applyOperation(
    nodeId: string,
    session: FleetSession,
    operation: ConsoleOperation,
  ): void {
    const grant = this.store.sessionConsole.get(session.id)!;
    if (operation.sessionId !== session.id || operation.grantId !== grant.grantId)
      throw new ConsoleRequestError(409, "Local operation identity mismatch");
    const input = ConsoleActionSchema.parse({
      ...z.record(z.string(), z.unknown()).parse(operation.payload),
      action: operation.action,
      operationId: operation.id,
    });
    this.store.sessionConsole.localOperation(operation);
    if (operation.state === "queued") {
      if (operation.controlEpoch > grant.controlEpoch)
        this.store.sessionConsole.epoch(session.id, operation.controlEpoch);
      return;
    }
    const payload = [
      operation.grantId,
      operation.controlEpoch,
      input,
      operation.afterSequence,
      operation.payloadDigest,
    ];
    const fresh = this.store.sessionConsole.accept(operation.id, session.id, payload);
    if (fresh) {
      if (operation.controlEpoch > grant.controlEpoch)
        this.store.sessionConsole.epoch(session.id, operation.controlEpoch);
      for (const message of this.store.queuedMessages(session.id)) {
        if (message.state === "pending" || message.state === "sending")
          this.store.saveQueuedMessage({
            ...message,
            state: "failed",
            error:
              message.state === "sending"
                ? "Local console intervened during delivery. Review the transcript before confirming a resend."
                : "Local console intervened. Confirm this message before sending.",
          });
      }
      if (operation.action === "prompt" && operation.state !== "rejected") {
        const retained =
          this.store.prMaintenance.manualRecord(session.id) ||
          this.store.prMaintenance.hasManualHistory(session.id);
        if (retained) {
          this.store.prMaintenance.beginManualControl(
            session.id,
            {
              id: operation.id,
              digest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
              kind: "prompt",
              actor: { kind: "node_console", nodeId },
            },
            operation.afterSequence,
          );
        }
        this.store.clearSessionTurnCompletion(session.id);
        this.store.setSessionDispatchAttempt(session.id, {
          commandId: operation.id,
          eventSeqFrom: operation.afterSequence,
          attempt: retained ? `manual:${operation.id}` : `session:${session.id}`,
        });
      }
      this.store.sessionConsole.settle(operation.id);
    }
    if (this.store.prMaintenance.manualCommand(session.id, operation.id))
      this.store.prMaintenance.recordManualReceipt(
        session.id,
        operation.id,
        operation.state === "settled"
          ? "settled"
          : operation.state === "rejected"
            ? "rejected"
            : "accepted",
      );
  }

  private action(nodeId: string, id: string, input: ConsoleAction): { ok: true } {
    const session = this.own(nodeId, id);
    if (this.blocked(nodeId))
      throw new ConsoleRequestError(409, "Wait for history synchronization");
    const actor = { kind: "node_console" as const, nodeId };
    if (input.action === "prompt") {
      const result = this.service.messages.submit(id, input, undefined, actor);
      if (!result.ok) throw new ConsoleRequestError(result.status, result.error);
      return { ok: true };
    }
    if (input.action === "resume") {
      const conflict = this.service.resumeCheckoutProblem(id);
      if (conflict) throw new ConsoleRequestError(409, conflict.error);
    }
    if (!this.store.sessionConsole.accept(input.operationId, id, input))
      return { ok: true };
    try {
      if (input.action === "resume") {
        const result = this.service.resumeSession(id, undefined, {
          actor,
          operationId: input.operationId,
        });
        if (!result.ok) throw new ConsoleRequestError(result.status, result.error);
      } else if (input.action === "queue_cancel" || input.action === "queue_send_now") {
        this.service.messages.act(
          id,
          input.messageId,
          input.action === "queue_cancel" ? "cancel" : "send-now",
        );
      } else if (input.action === "config") {
        if (terminalSessionStates.has(session.state) || session.stopRequested)
          throw new ConsoleRequestError(
            409,
            "Session is not available for configuration",
          );
        if (input.configId === CONTEXT_TIER_CONFIG_ID) {
          ContextTierSchema.parse(input.value);
          if (session.state !== "idle")
            throw new ConsoleRequestError(409, "Wait for the session to be idle");
        }
        if (!session.configOptions.some((option) => option.id === input.configId))
          throw new ConsoleRequestError(409, "Configuration option is unavailable");
        if (
          !this.service.dispatch(nodeId, {
            type: "set_config_option",
            sessionId: id,
            configId: input.configId,
            value: input.value,
          }).sent
        )
          throw new ConsoleRequestError(503, "Node disconnected");
      } else {
        if (input.action === "cancel" && session.state !== "running")
          throw new ConsoleRequestError(409, "Session is not running");
        if (input.action === "stop") {
          if (!terminalSessionStates.has(session.state)) {
            this.service.publishSession(
              this.store.setSessionControls(id, { stopRequested: true }),
            );
            this.service.dispatch(nodeId, { type: "stop", sessionId: id });
          }
        } else {
          this.service.publishSession(this.service.beginSessionCancellation(id));
          this.service.dispatch(nodeId, { type: "cancel", sessionId: id });
        }
      }
      this.store.sessionConsole.settle(input.operationId);
      return { ok: true };
    } catch (error) {
      this.store.sessionConsole.settle(
        input.operationId,
        errorMessage(error),
        error instanceof ConsoleRequestError || error instanceof z.ZodError,
      );
      throw error;
    }
  }
}
