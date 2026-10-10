import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import {
  CONSOLE_REPLAY_MAX_BYTES,
  ConsoleActionSchema,
  ConsoleGrantSchema,
  ConsoleSessionViewSchema,
  PendingSessionMessageSchema,
  TranscriptPageSchema,
  SessionFileReadRequestSchema,
  SESSION_FILE_CHUNK_BYTES,
  errorMessage,
  eventPayload,
  type BrowserMessage,
  type ConsoleAction,
  type ConsoleGrant,
  type ConsoleRequest,
  type ConsoleResponse,
  type ConsoleSessionView,
  type ConsoleStatus,
  type NodeCommand,
  type NodeToHostMessage,
  type PendingSessionMessage,
  type SessionEvent,
  type TranscriptPage,
} from "@fleet/protocol";
import type { CommandRouter, CommandResult } from "./router.js";
import type { ConfigReply } from "./config-server-types.js";
import {
  ReplayBudgetError,
  type SessionJournal,
  type LocalSessionOperation,
} from "./session-journal.js";
import type { SessionFileReader } from "./session-files.js";

export class NodeConsoleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Options = {
  journal: SessionJournal;
  router: CommandRouter;
  files: SessionFileReader;
  hostId: () => string;
  nodeId: () => string;
  send: (message: NodeToHostMessage) => boolean;
  onError: (message: string) => void;
};
type Waiter = {
  kind: ConsoleRequest["kind"];
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Loopback client and executor adapter. Permission decisions have no local route. */
export class NodeSessionConsole {
  private status: ConsoleStatus = "offline";
  private detail = "Host is disconnected";
  private supported = false;
  private closed = false;
  private fenced = false;
  private hostIdentity: string;
  private generation = 0;
  private readonly waiters = new Map<string, Waiter>();
  private readonly viewers = new Map<string, Set<ServerResponse>>();
  private readonly views = new Map<string, ConsoleSessionView>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly hostEpochs = new Map<string, number>();
  private readonly syncSessions = new Set<string>();
  private readonly sentOperations = new Map<string, string>();
  private pumping: Promise<void> | undefined;
  private pendingPump = false;
  private localPumping = new Set<string>();
  private readonly failedSessions = new Set<string>();

  constructor(private readonly options: Options) {
    this.hostIdentity = options.hostId();
  }
  private get journal() {
    return this.options.journal;
  }
  get synchronizing(): boolean {
    return this.status === "syncing";
  }
  get readyForHostWork(): boolean {
    return this.status === "online";
  }

  response(response: ConsoleResponse): void {
    const waiter = this.waiters.get(response.requestId);
    if (!waiter) return;
    this.waiters.delete(response.requestId);
    clearTimeout(waiter.timer);
    if (response.ok) {
      if (waiter.kind === "synchronized") {
        this.fenced = false;
        this.status = "online";
        this.detail = "";
      }
      waiter.resolve(response.data);
    } else waiter.reject(new NodeConsoleError(response.status, response.error));
  }

  private request(request: ConsoleRequest): Promise<unknown> {
    if (!this.supported || this.status === "offline" || this.status === "conflict")
      return Promise.reject(new NodeConsoleError(503, this.detail));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(
          new NodeConsoleError(
            504,
            "Host did not confirm the request; retry with the same operation ID",
          ),
        );
      }, 30_000);
      timer.unref();
      this.waiters.set(requestId, { kind: request.kind, resolve, reject, timer });
      if (!this.options.send({ type: "session_console_request", requestId, request })) {
        clearTimeout(timer);
        this.waiters.delete(requestId);
        reject(
          new NodeConsoleError(503, "Host disconnected before the request was sent"),
        );
      }
    });
  }

  disconnected(): void {
    this.generation++;
    this.status = this.fenced ? "conflict" : "offline";
    if (!this.fenced)
      this.detail =
        "Host disconnected. Local worker chat remains available; permission approvals require Host.";
    for (const pending of this.waiters.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new NodeConsoleError(503, "Host disconnected; request delivery may be uncertain"),
      );
    }
    this.waiters.clear();
    this.connection();
  }

  async connected(supported: boolean): Promise<void> {
    if (this.hostIdentity !== this.options.hostId()) {
      this.views.clear();
      for (const viewers of this.viewers.values())
        for (const response of viewers) response.end();
      this.viewers.clear();
      this.hostEpochs.clear();
      this.hostIdentity = this.options.hostId();
    }
    this.supported = supported;
    const generation = ++this.generation;
    this.syncSessions.clear();
    this.sentOperations.clear();
    if (!supported) {
      this.fenced = true;
      this.status = "conflict";
      this.detail =
        "Update and re-enroll Host and Node to enable the sealed session console.";
      this.connection();
      return;
    }
    this.status = "syncing";
    this.detail = "Synchronizing session history before accepting Host work";
    this.connection();
    try {
      await Promise.allSettled([...this.locks.values()]);
      if (generation !== this.generation) return;
      await this.journal.flush();
      const pending = this.journal
        .list(this.options.hostId())
        .filter(
          (entry) =>
            entry.highWater > entry.acknowledgedSequence ||
            entry.controlEpoch > entry.acknowledgedControlEpoch,
        );
      const response = z.object({ grants: z.array(ConsoleGrantSchema) }).parse(
        await this.request({
          kind: "initialize",
          activeSessionIds: this.options.router.activeSessionIds,
          busySessionIds: this.options.router.busySessionIds,
          sessions: pending.map((entry) => ({
            sessionId: entry.session.id,
            grantId: entry.grantId,
          })),
        }),
      );
      if (generation !== this.generation) return;
      for (const grant of response.grants) this.grant(grant);
      await this.flushToHost();
      if (generation !== this.generation) return;
      await this.journal.flush();
      const sessions = this.journal
        .list(this.options.hostId())
        .filter((entry) =>
          response.grants.some((grant) => grant.session.id === entry.session.id),
        );
      await this.request({
        kind: "synchronized",
        sessions: sessions.map((entry) => ({
          sessionId: entry.session.id,
          grantId: entry.grantId,
          highWater: entry.acknowledgedSequence,
          controlEpoch: this.hostEpochs.get(entry.session.id) ?? 0,
        })),
        activeSessionIds: this.options.router.activeSessionIds,
        busySessionIds: this.options.router.busySessionIds,
      });
      if (generation !== this.generation) return;
      this.status = "online";
      this.detail = "";
      this.connection();
      for (const id of this.viewers.keys()) {
        const view = ConsoleSessionViewSchema.parse(
          await this.request({ kind: "subscribe", sessionId: id }),
        );
        this.views.set(id, view);
        this.emit(id, { type: "session", session: view.session });
        this.emit(id, { type: "transcript_reset", sessionId: id });
      }
      this.schedulePump();
      for (const entry of sessions) void this.pumpLocal(entry.session.id);
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(error);
    }
  }

  grant(grant: ConsoleGrant): void {
    if (
      grant.hostId !== this.options.hostId() ||
      grant.session.nodeId !== this.options.nodeId()
    )
      throw new NodeConsoleError(403, "Session grant identity mismatch");
    if (grant.session.runRole === "lead") return;
    const existing = this.journal.get(grant.session.id);
    const live = this.options.router.activeSessionIds.includes(grant.session.id);
    const session = live
      ? {
          ...grant.session,
          ...(existing
            ? {
                state: existing.session.state,
                currentActivity: existing.session.currentActivity,
                lastText: existing.session.lastText,
                configOptions: existing.session.configOptions,
                agentSessionId:
                  existing.session.agentSessionId || grant.session.agentSessionId,
              }
            : grant.session.state === "offline"
              ? {
                  state: this.options.router.busySessionIds.includes(grant.session.id)
                    ? ("running" as const)
                    : ("idle" as const),
                }
              : {}),
        }
      : grant.session;
    this.journal.enable({ ...grant, session });
    this.syncSessions.add(grant.session.id);
    this.hostEpochs.set(grant.session.id, grant.controlEpoch);
  }

  capture(event: SessionEvent): boolean {
    if (!this.journal.has(event.sessionId)) return false;
    try {
      this.journal.append(event);
    } catch (error) {
      this.unavailable(`Local history could not be saved: ${errorMessage(error)}`);
      if (!this.failedSessions.has(event.sessionId)) {
        this.failedSessions.add(event.sessionId);
        void this.options.router
          .route({ type: "stop", sessionId: event.sessionId, commandId: randomUUID() })
          .then((result) => {
            if (!result.ok)
              this.options.onError(
                result.error || "Could not stop a worker after history storage failed",
              );
          });
      }
    }
    return true;
  }

  committed(events: SessionEvent[]): void {
    for (const event of events) {
      if (
        this.status !== "online" &&
        ["permission", "permission_result"].includes(event.type)
      )
        this.emit(event.sessionId, { type: "event", event });
      if (event.type === "turn_complete") {
        for (const operation of this.journal.operations(event.sessionId))
          if (
            operation.state === "accepted" &&
            operation.action === "prompt" &&
            event.sequence > operation.afterSequence &&
            !event.payload.historyReplay
          )
            this.journal.settleOperation(operation.id, "settled");
      }
      const state = eventPayload(event, "state")?.state;
      if (state && ["stopped", "failed", "completed"].includes(state)) {
        for (const operation of this.journal.operations(event.sessionId)) {
          if (operation.origin === "host") continue;
          if (operation.state === "accepted")
            this.journal.settleOperation(
              operation.id,
              "uncertain",
              "Session ended before execution completion was confirmed",
            );
          if (operation.state === "queued")
            this.journal.settleOperation(
              operation.id,
              "rejected",
              "Session stopped before this queued message was sent",
            );
        }
      }
      if (state === "idle") {
        queueMicrotask(() => {
          if (this.closed) return;
          if (this.options.router.busySessionIds.includes(event.sessionId)) return;
          for (const operation of this.journal.operations(event.sessionId)) {
            if (
              operation.origin === "local" &&
              operation.action === "prompt" &&
              operation.state === "accepted" &&
              event.sequence > operation.afterSequence
            )
              this.journal.settleOperation(
                operation.id,
                "uncertain",
                "The native turn became idle without an authoritative completion receipt; the prompt was not replayed.",
              );
          }
          this.schedulePump();
          void this.pumpLocal(event.sessionId);
        });
      }
    }
    if (this.status !== "online") {
      for (const id of new Set(events.map((event) => event.sessionId))) {
        this.emit(id, { type: "session", session: this.localView(id).session });
        this.emit(id, { type: "transcript_reset", sessionId: id });
      }
    }
    this.schedulePump();
  }

  private schedulePump(): void {
    this.pendingPump = true;
    if (this.status !== "online" || this.pumping) return;
    this.pendingPump = false;
    const generation = this.generation;
    const pumping = this.flushToHost()
      .catch((error: unknown) => {
        if (generation === this.generation) this.fail(error);
      })
      .finally(() => {
        if (this.pumping === pumping) this.pumping = undefined;
        if (this.pendingPump && this.status === "online") this.schedulePump();
      });
    this.pumping = pumping;
  }

  private async flushToHost(): Promise<void> {
    await this.journal.flush();
    for (const entry of this.journal.list(this.options.hostId())) {
      if (!this.syncSessions.has(entry.session.id)) continue;
      const highWater = entry.highWater;
      let after = entry.acknowledgedSequence;
      const operations = this.journal
        .operations(entry.session.id)
        .filter(
          (operation) =>
            operation.origin !== "host" &&
            this.sentOperations.get(operation.id) !== JSON.stringify(operation),
        )
        .map((operation) => {
          const payload = z.record(z.string(), z.unknown()).parse(operation.payload);
          return {
            ...operation,
            payload: {
              ...payload,
              ...(operation.action === "prompt" ? { attachments: [] } : {}),
            },
            payloadDigest: createHash("sha256")
              .update(JSON.stringify(operation.payload))
              .digest("hex"),
          };
        });
      while (after < highWater || operations.length) {
        let events: SessionEvent[];
        try {
          events = this.journal.events(entry.session.id, after, 512, 512 * 1024);
        } catch (error) {
          if (!(error instanceof ReplayBudgetError)) throw error;
          events = this.journal.events(
            entry.session.id,
            after,
            1,
            CONSOLE_REPLAY_MAX_BYTES - 1024 * 1024,
          );
        }
        events = events.filter((event) => event.sequence <= highWater);
        const through = events.at(-1)?.sequence ?? after;
        const controls: typeof operations = [];
        let bytes = Buffer.byteLength(JSON.stringify(events));
        for (const operation of operations) {
          if (operation.afterSequence > through) continue;
          const size = Buffer.byteLength(JSON.stringify(operation));
          if (controls.length && (bytes + size > 512 * 1024 || controls.length >= 100))
            break;
          controls.push(operation);
          bytes += size;
        }
        if (!events.length && !controls.length) break;
        const response = z
          .object({ throughSequence: z.number().int().nonnegative() })
          .parse(
            await this.request({
              kind: "replay",
              sessionId: entry.session.id,
              grantId: entry.grantId,
              events,
              operations: controls,
            }),
          );
        const acknowledged = Math.min(response.throughSequence, highWater);
        this.journal.acknowledge(entry.session.id, acknowledged);
        after = acknowledged;
        for (const control of controls) {
          operations.splice(operations.indexOf(control), 1);
          this.hostEpochs.set(
            entry.session.id,
            Math.max(this.hostEpochs.get(entry.session.id) ?? 0, control.controlEpoch),
          );
          const original = this.journal
            .operations(entry.session.id)
            .find((operation) => operation.id === control.id);
          if (original) this.sentOperations.set(control.id, JSON.stringify(original));
          this.journal.acknowledgeControl(
            entry.session.id,
            Math.max(
              this.journal.get(entry.session.id)!.acknowledgedControlEpoch,
              control.controlEpoch,
            ),
          );
        }
      }
    }
  }

  update(message: BrowserMessage): void {
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
    if (message.type === "session") {
      const old = this.views.get(id);
      if (old) this.views.set(id, { ...old, session: message.session });
    }
    if (this.status === "online") this.emit(id, message);
  }

  private localView(id: string): ConsoleSessionView {
    const entry = this.journal.get(id);
    const cached = this.views.get(id);
    if (entry && entry.hostId !== this.options.hostId())
      throw new NodeConsoleError(404, "Session history belongs to a different Host");
    if (!entry) {
      if (cached && this.hostIdentity === this.options.hostId())
        return {
          ...cached,
          status: this.status,
          offlineAllowed: false,
          detail: this.detail,
        };
      throw new NodeConsoleError(
        404,
        "This session has no local history. Open it while Host is connected.",
      );
    }
    const live = this.options.router.activeSessionIds.includes(id);
    return {
      session: entry.session,
      permissions: this.journal.permissions(id),
      messages: this.localMessages(id),
      status: this.status,
      offlineAllowed:
        !this.closed &&
        live &&
        entry.session.runRole !== "lead" &&
        !entry.session.stopRequested &&
        !entry.session.cleanupRequested &&
        this.status !== "conflict",
      detail:
        this.detail ||
        (!live ? "The session process is not running. Resume through Host." : ""),
    };
  }

  private localMessages(id: string): PendingSessionMessage[] {
    return this.journal
      .operations(id)
      .filter((operation) =>
        ["queued", "accepted", "uncertain"].includes(operation.state),
      )
      .map((operation) => {
        const payload = z.record(z.string(), z.unknown()).parse(operation.payload);
        return {
          id: `node:${operation.id}`,
          prompt: typeof payload.prompt === "string" ? payload.prompt : operation.action,
          createdAt: operation.createdAt,
          source: "operator",
          state:
            operation.state === "queued"
              ? "pending"
              : operation.state === "uncertain"
                ? "failed"
                : "sending",
          attachments: [],
          canCancel: operation.state === "queued",
          canSendNow: operation.state === "queued",
          detail: operation.error || "Local Node console",
        };
      });
  }

  async view(id: string): Promise<ConsoleSessionView> {
    if (this.status !== "online") return this.localView(id);
    const view = ConsoleSessionViewSchema.parse(
      await this.request({ kind: "session", sessionId: id }),
    );
    this.views.set(id, view);
    return {
      ...view,
      messages: this.mergeMessages(view.messages, this.localMessages(id)),
    };
  }

  private mergeMessages(
    host: PendingSessionMessage[],
    local: PendingSessionMessage[],
  ): PendingSessionMessage[] {
    return [
      ...new Map([...host, ...local].map((message) => [message.id, message])).values(),
    ];
  }

  async transcript(id: string, before?: number, limit?: number): Promise<TranscriptPage> {
    if (this.status !== "online") {
      this.localView(id);
      await this.journal.flush();
      return this.journal.transcript(id, {
        ...(before === undefined ? {} : { before }),
        ...(limit === undefined ? {} : { limit }),
      });
    }
    return TranscriptPageSchema.parse(
      await this.request({
        kind: "transcript",
        sessionId: id,
        ...(before === undefined ? {} : { before }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  }

  private async fileRequest(id: string, path: string) {
    const view = await this.view(id);
    const session = view.session;
    const cwd = session.executionBinding?.cwd ?? view.placement?.localPath;
    return SessionFileReadRequestSchema.parse({
      requestId: randomUUID(),
      sessionId: id,
      path,
      roots: [...(cwd ? [cwd] : []), ...(session.additionalDirectories ?? [])],
      agentSessionId:
        (session.agentParams?.kind ?? "copilot") === "copilot" &&
        session.agentSessionId.length <= 128
          ? session.agentSessionId
          : "",
      coordinator: session.runRole === "lead",
      offset: 0,
      length: 0,
    });
  }

  async download(id: string, path: string, response: ServerResponse): Promise<void> {
    const request = await this.fileRequest(id, path);
    const info = await this.options.files.read(request);
    if (!info.ok) throw new NodeConsoleError(403, info.error);
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(info.size),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(info.name).replace(/'/g, "%27")}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    let offset = 0;
    while (offset < info.size && !response.destroyed) {
      const chunk = await this.options.files.read({
        ...request,
        requestId: randomUUID(),
        path: info.path,
        version: info.version,
        offset,
        length: Math.min(SESSION_FILE_CHUNK_BYTES, info.size - offset),
      });
      if (!chunk.ok) {
        response.destroy(new Error(chunk.error));
        return;
      }
      const bytes = Buffer.from(chunk.data, "base64");
      if (!bytes.length) {
        response.destroy(new Error("File download made no progress"));
        return;
      }
      offset += bytes.length;
      if (!response.write(bytes)) await once(response, "drain");
    }
    response.end();
  }

  async stream(id: string, response: ServerResponse): Promise<void> {
    await this.view(id);
    const viewers = this.viewers.get(id) ?? new Set<ServerResponse>();
    const first = !viewers.size;
    viewers.add(response);
    this.viewers.set(id, viewers);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    response.on("close", () => {
      clearInterval(heartbeat);
      viewers.delete(response);
      if (!viewers.size) {
        this.viewers.delete(id);
        if (this.status === "online")
          void this.request({ kind: "unsubscribe", sessionId: id }).catch(
            (error: unknown) => this.options.onError(errorMessage(error)),
          );
      }
    });
    this.connection();
    if (this.status === "online") {
      try {
        if (first) {
          const current = ConsoleSessionViewSchema.parse(
            await this.request({ kind: "subscribe", sessionId: id }),
          );
          this.views.set(id, current);
        }
        this.emit(id, { type: "transcript_reset", sessionId: id });
      } catch (error) {
        this.emit(id, {
          type: "connection",
          status: "conflict",
          offlineAllowed: false,
          detail: errorMessage(error),
        });
      }
    }
  }

  private emit(id: string, message: unknown): void {
    for (const response of this.viewers.get(id) ?? []) {
      if (response.writableLength > 1024 * 1024) {
        response.end();
        continue;
      }
      response.write(`data: ${JSON.stringify(message)}\n\n`);
    }
  }
  private connection(): void {
    for (const id of this.viewers.keys()) {
      let allowed = false;
      try {
        allowed = this.localView(id).offlineAllowed;
      } catch {
        /* An online-only view has no local grant. */
      }
      this.emit(id, {
        type: "connection",
        status: this.status,
        offlineAllowed: allowed,
        detail: this.detail,
      });
    }
  }
  private fail(error: unknown): void {
    if (this.status === "offline") return;
    this.unavailable(errorMessage(error));
  }

  unavailable(detail: string): void {
    this.fenced = true;
    this.status = "conflict";
    this.detail = detail;
    this.options.onError(`Session console: ${this.detail}`);
    this.connection();
  }

  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(id, next);
    void next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  hostCommand(command: NodeCommand, epoch?: number): Promise<CommandResult> {
    return this.exclusive(command.sessionId, async () => {
      const safety = ["stop", "cancel", "permission_response"].includes(command.type);
      const entry = this.journal.get(command.sessionId);
      if (
        !safety &&
        ((this.supported && this.status !== "online") ||
          (entry && entry.controlEpoch > (epoch ?? 0)))
      )
        return {
          commandId: command.commandId,
          ok: false,
          fatal: false,
          error: "Local session control/history must reconcile before Host work",
        };
      if (command.type === "resume_session" && entry)
        command = {
          ...command,
          sequenceOffset: Math.max(command.sequenceOffset, entry.highWater),
        };
      if (
        command.type === "delete_session" &&
        entry &&
        (entry.highWater > entry.acknowledgedSequence ||
          entry.controlEpoch > entry.acknowledgedControlEpoch)
      )
        return {
          commandId: command.commandId,
          ok: false,
          fatal: false,
          error: "Local history must be synchronized before cleanup",
        };
      const result = await this.options.router.route(command);
      if (command.type === "delete_session" && entry && result.ok) {
        try {
          await this.journal.flush();
          await this.pumping;
          await this.flushToHost();
          this.journal.retire(command.sessionId);
          this.syncSessions.delete(command.sessionId);
          this.views.delete(command.sessionId);
        } catch (error) {
          return {
            commandId: command.commandId,
            ok: false,
            fatal: false,
            error: errorMessage(error),
          };
        }
      }
      return result;
    });
  }

  private async action(id: string, input: ConsoleAction): Promise<unknown> {
    if (
      (input.action === "queue_cancel" || input.action === "queue_send_now") &&
      input.messageId.startsWith("node:")
    )
      return this.queueAction(
        id,
        input.messageId.slice("node:".length),
        input.action === "queue_cancel" ? "cancel" : "send-now",
      );
    if (this.status === "online") {
      const journaled =
        this.journal.has(id) &&
        ["prompt", "cancel", "stop", "config"].includes(input.action);
      if (
        journaled &&
        (input.action === "prompt" ||
          input.action === "cancel" ||
          input.action === "stop" ||
          input.action === "config")
      ) {
        const { operation, invoke } = this.journal.acceptOperation({
          id: input.operationId,
          sessionId: id,
          action: input.action,
          payload: input,
          origin: "host",
        });
        if (!invoke && operation.origin !== "host")
          return this.operationResult(operation);
        if (!invoke && operation.state === "settled") return { ok: true };
      }

      try {
        const result = await this.request({ kind: "action", sessionId: id, input });
        if (journaled) this.journal.settleOperation(input.operationId, "settled");
        return result;
      } catch (error) {
        if (journaled)
          this.journal.settleOperation(
            input.operationId,
            "uncertain",
            errorMessage(error),
          );
        throw error;
      }
    }
    if (this.status === "syncing")
      throw new NodeConsoleError(409, "History is synchronizing; try again shortly");
    const view = this.localView(id);
    if (!view.offlineAllowed)
      throw new NodeConsoleError(
        409,
        "Offline continuation is not available for this session",
      );
    if (input.action === "resume")
      throw new NodeConsoleError(409, "Resume requires Host");
    if (input.action === "queue_cancel" || input.action === "queue_send_now") {
      return this.queueAction(
        id,
        input.messageId,
        input.action === "queue_cancel" ? "cancel" : "send-now",
      );
    }
    const action = input.action;
    if (
      action !== "prompt" &&
      action !== "cancel" &&
      action !== "stop" &&
      action !== "config"
    )
      throw new NodeConsoleError(403, "This action requires Host");
    return this.exclusive(id, async () => {
      if (this.status !== "offline")
        throw new NodeConsoleError(
          409,
          "Connection state changed before local admission; retry after synchronization",
        );
      const queued =
        action === "prompt" && this.options.router.busySessionIds.includes(id);
      const { operation, invoke } = this.journal.acceptOperation({
        id: input.operationId,
        sessionId: id,
        action,
        payload: input,
        queued,
      });
      if (!invoke) return this.operationResult(operation);
      if (invoke && !queued) await this.invokeLocal(operation);
      return { ok: true };
    });
  }

  async prepareIdentityMove(): Promise<void> {
    await this.journal.flush();
    if (this.status === "online") {
      await this.pumping;
      await this.flushToHost();
    }
    if (
      this.journal
        .list(this.options.hostId())
        .some(
          (entry) =>
            entry.highWater > entry.acknowledgedSequence ||
            entry.controlEpoch > entry.acknowledgedControlEpoch,
        )
    )
      throw new NodeConsoleError(
        409,
        "Synchronize local session history with the original Host before moving this Node",
      );
  }

  private operationResult(operation: LocalSessionOperation): { ok: true } {
    if (
      operation.state === "uncertain" ||
      operation.state === "rejected" ||
      (operation.origin === "host" && operation.state !== "settled")
    )
      throw new NodeConsoleError(
        409,
        operation.error ||
          "Host delivery is uncertain; reconnect and retry the same operation",
      );
    return { ok: true };
  }

  async queueAction(
    id: string,
    messageId: string,
    action: "cancel" | "send-now",
  ): Promise<{ ok: true }> {
    if (this.status === "syncing" || this.status === "conflict")
      throw new NodeConsoleError(409, "Reconcile the session before changing its queue");
    const entry = this.journal.get(id);
    if (!entry || entry.hostId !== this.options.hostId())
      throw new NodeConsoleError(404, "Local session not found");
    await this.exclusive(id, async () => {
      if (this.status === "syncing" || this.status === "conflict")
        throw new NodeConsoleError(
          409,
          "Session synchronization began before queue admission",
        );
      const queued = this.journal
        .operations(id)
        .find((operation) => operation.id === messageId && operation.state === "queued");
      if (!queued) throw new NodeConsoleError(409, "Local queued message has changed");
      if (action === "cancel")
        this.journal.settleOperation(queued.id, "rejected", "Cancelled before sending");
      else {
        this.journal.prioritizeOperation(queued.id);
        if (this.options.router.busySessionIds.includes(id)) {
          const result = await this.options.router.route({
            type: "cancel",
            sessionId: id,
            commandId: randomUUID(),
          });
          if (!result.ok)
            throw new NodeConsoleError(
              409,
              result.error || "Could not cancel the current turn",
            );
        }
      }
    });
    this.schedulePump();
    if (action === "send-now") void this.pumpLocal(id);
    return { ok: true };
  }

  private async invokeLocal(operation: LocalSessionOperation): Promise<void> {
    const input = ConsoleActionSchema.parse(operation.payload);
    const id = operation.sessionId;
    let command: NodeCommand;
    if (input.action === "prompt") {
      const entry = this.journal.get(id)!;
      command = {
        type: "prompt",
        sessionId: id,
        commandId: operation.id,
        prompt: input.prompt,
        attachments: input.attachments,
        ...(entry.session.executionBinding
          ? { executionBinding: entry.session.executionBinding }
          : {}),
      };
    } else if (input.action === "config") {
      command = {
        type: "set_config_option",
        sessionId: id,
        commandId: operation.id,
        configId: input.configId,
        value: input.value,
      };
    } else if (input.action === "cancel" || input.action === "stop") {
      command = { type: input.action, sessionId: id, commandId: operation.id };
    } else throw new NodeConsoleError(403, "Action is not available offline");
    const result = await this.options.router.route(command);
    if (!result.ok) {
      this.journal.settleOperation(operation.id, "rejected", result.error);
      throw new NodeConsoleError(409, result.error || "Local command was refused");
    }
    if (input.action !== "prompt") this.journal.settleOperation(operation.id, "settled");
    this.emit(id, { type: "session", session: this.localView(id).session });
  }

  private async pumpLocal(id: string): Promise<void> {
    if (
      this.localPumping.has(id) ||
      this.status === "syncing" ||
      this.status === "conflict"
    )
      return;
    this.localPumping.add(id);
    try {
      await this.exclusive(id, async () => {
        if (this.status === "syncing" || this.status === "conflict") return;
        if (this.options.router.busySessionIds.includes(id)) return;
        const queued = this.journal
          .operations(id)
          .filter((operation) => operation.state === "queued")
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
        if (queued) await this.invokeLocal(this.journal.beginOperation(queued.id));
      });
    } catch (error) {
      this.options.onError(`Local queued message: ${errorMessage(error)}`);
    } finally {
      this.localPumping.delete(id);
    }
  }

  async route(
    method: string,
    url: string,
    body: string,
  ): Promise<ConfigReply | undefined> {
    const parsed = new URL(url, "http://localhost");
    if (!parsed.pathname.startsWith("/api/fleet-sessions")) return undefined;
    try {
      if (method === "POST" && parsed.pathname === "/api/fleet-sessions/purge") {
        const input = z
          .object({
            confirmation: z.literal("Delete local session history"),
            discardUnsynchronized: z.boolean().default(false),
          })
          .strict()
          .parse(JSON.parse(body));
        if (this.options.router.activeSessionIds.some((id) => this.journal.has(id)))
          throw new NodeConsoleError(
            409,
            "Stop local workers before deleting their history",
          );
        this.journal.purge(this.options.hostId(), input.discardUnsynchronized);
        this.views.clear();
        this.syncSessions.clear();
        return { status: 200, body: { ok: true } };
      }
      if (method === "GET" && parsed.pathname === "/api/fleet-sessions") {
        if (this.status === "conflict" && !this.supported)
          throw new NodeConsoleError(503, this.detail);
        const query = z
          .object({
            cursor: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .parse(Object.fromEntries(parsed.searchParams));
        if (this.status === "online")
          return { status: 200, body: await this.request({ kind: "catalog", ...query }) };
        const sessions = this.journal
          .list(this.options.hostId())
          .map((entry) => entry.session)
          .sort((a, b) => a.id.localeCompare(b.id))
          .filter((session) => !query.cursor || session.id > query.cursor);
        return {
          status: 200,
          body: {
            sessions: sessions.slice(0, query.limit),
            ...(sessions.length > query.limit
              ? { nextCursor: sessions[query.limit - 1]!.id }
              : {}),
          },
        };
      }
      const match = /^\/api\/fleet-sessions\/([^/]+)(?:\/(.*))?$/.exec(parsed.pathname);
      if (!match?.[1]) return { status: 404, body: { error: "Session route not found" } };
      const id = decodeURIComponent(match[1]);
      const action = match[2] ?? "";
      if (method === "GET" && !action) return { status: 200, body: await this.view(id) };
      if (method === "GET" && action === "messages") {
        const host =
          this.status === "online"
            ? PendingSessionMessageSchema.array().parse(
                await this.request({ kind: "messages", sessionId: id }),
              )
            : [];
        return { status: 200, body: this.mergeMessages(host, this.localMessages(id)) };
      }
      if (method === "GET" && action === "transcript") {
        const query = z
          .object({
            before: z.coerce.number().int().nonnegative().optional(),
            limit: z.coerce.number().int().min(1).max(1000).optional(),
          })
          .parse(Object.fromEntries(parsed.searchParams));
        return {
          status: 200,
          body: await this.transcript(id, query.before, query.limit),
        };
      }
      if (method === "GET" && action === "files/stat") {
        const result = await this.options.files.read(
          await this.fileRequest(id, parsed.searchParams.get("path") ?? ""),
        );
        if (!result.ok) throw new NodeConsoleError(403, result.error);
        return {
          status: 200,
          body: {
            path: result.path,
            name: result.name,
            size: result.size,
            modifiedAt: result.modifiedAt,
          },
        };
      }
      if (method === "POST") {
        const data = z.record(z.string(), z.unknown()).parse(JSON.parse(body));
        const queue = /^messages\/([^/]+)\/(cancel|send-now)$/.exec(action);
        const input = ConsoleActionSchema.parse({
          ...data,
          action: queue
            ? queue[2] === "cancel"
              ? "queue_cancel"
              : "queue_send_now"
            : action,
          ...(queue ? { messageId: decodeURIComponent(queue[1]!) } : {}),
          operationId:
            data.operationId ?? (action === "prompt" ? undefined : randomUUID()),
        });
        return { status: 202, body: await this.action(id, input) };
      }
      return { status: 404, body: { error: "Session route not found" } };
    } catch (error) {
      return {
        status:
          error instanceof NodeConsoleError
            ? error.status
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? 400
              : 409,
        body: { error: errorMessage(error) },
      };
    }
  }

  close(): void {
    this.closed = true;
    this.disconnected();
    for (const viewers of this.viewers.values())
      for (const response of viewers) response.end();
    this.viewers.clear();
  }
}
