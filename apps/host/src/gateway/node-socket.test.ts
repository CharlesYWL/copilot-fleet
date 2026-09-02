import { setTimeout as delay } from "node:timers/promises";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import {
  MAX_OUTBOX_EVENT_COUNT,
  NodeToHostMessageSchema,
  OUTBOX_ACK_CAPABILITY,
  OutboxFlushIdSchema,
  type HostToNodeMessage,
  type NodeToHostMessage,
  type OutboxFlushId,
  type SessionEvent,
} from "@fleet/protocol";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetService } from "../fleet-service.js";
import { FleetStore } from "../store.js";
import { registerNodeGateway } from "./node-socket.js";

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
} as unknown as FastifyBaseLogger;

describe("node reconnect socket ordering", () => {
  const firstFlushId = OutboxFlushIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const secondFlushId = OutboxFlushIdSchema.parse("22222222-2222-4222-8222-222222222222");
  let app: FastifyInstance;
  let store: FleetStore;
  let service: FleetService;
  let nodeId: string;
  let secret: string;
  let sessionId: string;
  let clients: WebSocket[];

  beforeEach(async () => {
    store = new FleetStore(":memory:");
    service = new FleetService(store, silentLog, "");
    const registered = store.registerNode({
      name: "node",
      os: "win32",
      arch: "x64",
      version: "0.3.0",
      capabilities: [],
      maxSessions: 1,
    });
    nodeId = registered.node.id;
    secret = registered.secret;
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, nodeId, "C:\\repo");
    const session = store.createSession(placement, "finish while disconnected");
    store.transitionSession(session.id, "starting", "Starting");
    store.transitionSession(session.id, "running", "Working");
    service.disconnectNode(nodeId, "Host unavailable");
    sessionId = session.id;

    app = Fastify({ logger: false });
    await app.register(websocket);
    registerNodeGateway(app, service);
    await app.listen({ port: 0, host: "127.0.0.1" });
    clients = [];
  });

  afterEach(async () => {
    service.shutdown();
    await Promise.all(clients.map((client) => close(client)));
    await app.close();
    store.close();
  });

  it("acknowledges a complete durable batch after reconciliation and notifies once", async () => {
    const client = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });
    const acknowledged = nextMessage(client, "outbox_flush_ack");

    expect(store.getSession(sessionId)?.state).toBe("offline");
    send(client, {
      type: "heartbeat",
      activeSessionIds: [sessionId],
      busySessionIds: [],
      sentAt: new Date().toISOString(),
    });
    await delay(10);
    expect(store.getSession(sessionId)?.state).toBe("offline");

    send(client, event(1, "turn_complete", {}, firstFlushId, 2, 0));
    send(client, event(2, "state", { state: "idle" }, firstFlushId, 2, 1));
    send(client, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [],
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
    });

    expect(await acknowledged).toEqual({
      type: "outbox_flush_ack",
      flushId: firstFlushId,
    });
    await waitFor(() => store.getSession(sessionId)?.state === "idle");
    expect(store.listNotifications().notifications).toMatchObject([
      {
        kind: "agent_completion",
        navigation: { sessionId },
      },
    ]);
    expect(store.listNotifications().notifications).toHaveLength(1);
  });

  it("keeps the normal immediate reconciliation when no outbox fields are sent", async () => {
    await connect({
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });

    await waitFor(() => store.getSession(sessionId)?.state === "idle");
    expect(store.listNotifications().notifications).toEqual([]);
  });

  it("keeps the legacy ordered reconnect handshake for older Nodes", async () => {
    const client = await connect({
      pendingOutbox: true,
      pendingOutboxCount: 2,
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });

    send(client, event(1, "turn_complete", {}));
    send(client, event(2, "state", { state: "idle" }));
    send(client, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });

    await waitFor(() => store.getSession(sessionId)?.state === "idle");
    expect(store.listNotifications().notifications).toHaveLength(1);
  });

  it("rejects a durable batch identity without the acknowledgement capability", async () => {
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/node`);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));

    send(client, {
      type: "hello",
      nodeId,
      secret,
      os: "win32",
      arch: "x64",
      version: "0.3.0",
      revision: "",
      capabilities: [],
      agents: [],
      maxSessions: 1,
      homeDir: "C:\\Users\\node",
      pendingOutbox: true,
      pendingOutboxCount: 1,
      outboxFlush: { flushId: firstFlushId, eventCount: 1 },
    });

    expect(await closed).toBe(1008);
  });

  it("rejects an outbox batch larger than the Node retention capacity", async () => {
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/node`);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));

    client.send(
      JSON.stringify({
        type: "hello",
        nodeId,
        secret,
        os: "win32",
        arch: "x64",
        version: "0.3.0",
        revision: "",
        capabilities: [OUTBOX_ACK_CAPABILITY],
        agents: [],
        maxSessions: 1,
        homeDir: "C:\\Users\\node",
        pendingOutbox: true,
        pendingOutboxCount: MAX_OUTBOX_EVENT_COUNT + 1,
        outboxFlush: {
          flushId: firstFlushId,
          eventCount: MAX_OUTBOX_EVENT_COUNT + 1,
        },
      }),
    );

    expect(await closed).toBe(1008);
  });

  it("does not ack a partial flush and accepts the whole retained batch on retry", async () => {
    const client = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));
    send(client, event(1, "turn_complete", {}, firstFlushId, 2, 0));
    send(client, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [],
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
    });

    expect(await closed).toBe(1008);
    expect(store.getSession(sessionId)?.state).toBe("offline");
    expect(store.listNotifications().notifications).toEqual([]);

    const retry = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });
    const acknowledged = nextMessage(retry, "outbox_flush_ack");
    send(retry, event(1, "turn_complete", {}, firstFlushId, 2, 0));
    send(retry, event(2, "state", { state: "idle" }, firstFlushId, 2, 1));
    send(retry, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [],
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
    });

    expect(await acknowledged).toMatchObject({ flushId: firstFlushId });
    await waitFor(() => store.getSession(sessionId)?.state === "idle");
    expect(store.listEvents(sessionId)).toHaveLength(2);
    expect(store.listNotifications().notifications).toHaveLength(1);
  });

  it("rejects an outbox inventory containing another node's session", async () => {
    const foreign = store.registerNode({
      name: "foreign-node",
      os: "linux",
      arch: "x64",
      version: "0.3.0",
      capabilities: [],
      maxSessions: 1,
    }).node;
    const workspace = store.createWorkspace("foreign-repo", "");
    const placement = store.createPlacement(workspace.id, foreign.id, "/repo");
    const foreignSession = store.createSession(placement, "foreign work");
    const client = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 0,
      outboxFlush: { flushId: firstFlushId, eventCount: 0 },
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));

    send(client, {
      type: "outbox_flushed",
      activeSessionIds: [foreignSession.id],
      busySessionIds: [],
      outboxFlush: { flushId: firstFlushId, eventCount: 0 },
    });

    expect(await closed).toBe(1008);
    expect(store.getSession(sessionId)?.state).toBe("offline");
  });

  it("accepts a newer retained batch on the same connection after the first ack", async () => {
    const client = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 1,
      outboxFlush: { flushId: firstFlushId, eventCount: 1 },
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
    });
    const firstAck = nextMessage(client, "outbox_flush_ack");
    send(client, event(1, "agent_text", { text: "still working" }, firstFlushId, 1, 0));
    send(client, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
      outboxFlush: { flushId: firstFlushId, eventCount: 1 },
    });
    expect(await firstAck).toMatchObject({ flushId: firstFlushId });
    expect(store.getSession(sessionId)?.state).toBe("running");

    const secondAck = nextMessage(client, "outbox_flush_ack");
    send(client, event(2, "turn_complete", {}, secondFlushId, 2, 0));
    send(client, event(3, "state", { state: "idle" }, secondFlushId, 2, 1));
    send(client, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [],
      outboxFlush: { flushId: secondFlushId, eventCount: 2 },
    });

    expect(await secondAck).toMatchObject({ flushId: secondFlushId });
    expect(store.getSession(sessionId)?.state).toBe("idle");
    expect(store.listNotifications().notifications).toHaveLength(1);
  });

  it("deduplicates a complete batch resent after its ack was lost", async () => {
    const first = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });
    send(first, event(1, "turn_complete", {}, firstFlushId, 2, 0));
    send(first, event(2, "state", { state: "idle" }, firstFlushId, 2, 1));
    send(first, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [],
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
    });
    await waitFor(() => store.getSession(sessionId)?.state === "idle");
    await close(first);
    await waitFor(() => store.getSession(sessionId)?.state === "offline");

    const retry = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });
    const acknowledged = nextMessage(retry, "outbox_flush_ack");
    send(retry, event(1, "turn_complete", {}, firstFlushId, 2, 0));
    send(retry, event(2, "state", { state: "idle" }, firstFlushId, 2, 1));
    send(retry, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [],
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
    });

    expect(await acknowledged).toMatchObject({ flushId: firstFlushId });
    expect(store.listEvents(sessionId)).toHaveLength(2);
    expect(store.listNotifications().notifications).toHaveLength(1);
  });

  it("rejects a marker for a different flush identity", async () => {
    const client = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 1,
      outboxFlush: { flushId: firstFlushId, eventCount: 1 },
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));
    send(client, event(1, "turn_complete", {}, firstFlushId, 1, 0));
    send(client, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [],
      outboxFlush: { flushId: secondFlushId, eventCount: 1 },
    });

    expect(await closed).toBe(1008);
    expect(store.getSession(sessionId)?.state).toBe("offline");
  });

  it("rejects an out-of-order batch event", async () => {
    const client = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [],
    });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));

    send(client, event(2, "state", { state: "idle" }, firstFlushId, 2, 1));

    expect(await closed).toBe(1008);
    expect(store.listEvents(sessionId)).toEqual([]);
  });

  it("skips a conflicting retained event after reconnect and advances newer batches", async () => {
    store.appendEvent({
      eventId: "event-1",
      sessionId,
      sequence: 1,
      type: "agent_text",
      payload: { text: "durable original" },
      createdAt: "2026-09-01T20:00:00.000Z",
    });
    const first = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
    });
    send(
      first,
      event(1, "agent_text", { text: "conflicting replay" }, firstFlushId, 2, 0),
    );
    await close(first);
    await waitFor(() => store.getSession(sessionId)?.state === "offline");

    const retry = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
    });
    const firstAck = nextMessage(retry, "outbox_flush_ack");
    send(
      retry,
      event(1, "agent_text", { text: "conflicting replay" }, firstFlushId, 2, 0),
    );
    send(retry, event(2, "agent_text", { text: "retained valid" }, firstFlushId, 2, 1));
    send(retry, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
    });
    expect(await firstAck).toMatchObject({ flushId: firstFlushId });

    const secondAck = nextMessage(retry, "outbox_flush_ack");
    send(retry, event(3, "agent_text", { text: "new valid" }, secondFlushId, 1, 0));
    send(retry, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
      outboxFlush: { flushId: secondFlushId, eventCount: 1 },
    });
    expect(await secondAck).toMatchObject({ flushId: secondFlushId });
    expect(store.listEvents(sessionId)).toMatchObject([
      { payload: { text: "durable original" } },
      { payload: { text: "retained valid" } },
      { payload: { text: "new valid" } },
    ]);
  });

  it("skips a deleted-session replay after reconnect and persists later events", async () => {
    const placement = store.listPlacements()[0]!;
    const deleted = store.createSession(placement, "deleted work");
    store.transitionSession(deleted.id, "failed", "deleted");
    store.deleteSession(deleted.id);

    const first = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
    });
    send(
      first,
      event(1, "agent_text", { text: "deleted poison" }, firstFlushId, 2, 0, deleted.id),
    );
    await close(first);
    await waitFor(() => store.getSession(sessionId)?.state === "offline");

    const retry = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 2,
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
    });
    const acknowledged = nextMessage(retry, "outbox_flush_ack");
    send(
      retry,
      event(1, "agent_text", { text: "deleted poison" }, firstFlushId, 2, 0, deleted.id),
    );
    send(retry, event(1, "agent_text", { text: "valid survivor" }, firstFlushId, 2, 1));
    send(retry, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
      outboxFlush: { flushId: firstFlushId, eventCount: 2 },
    });

    expect(await acknowledged).toMatchObject({ flushId: firstFlushId });
    expect(store.listEvents(sessionId)).toMatchObject([
      { payload: { text: "valid survivor" } },
    ]);
  });

  it("closes and retries a retained batch after a transient persistence failure", async () => {
    const original = service.handleEventResult.bind(service);
    let failOnce = true;
    vi.spyOn(service, "handleEventResult").mockImplementation((buffered) => {
      if (failOnce) {
        failOnce = false;
        return { outcome: "retryable_failure" };
      }
      return original(buffered);
    });
    const first = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 1,
      outboxFlush: { flushId: firstFlushId, eventCount: 1 },
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
    });
    const closed = new Promise<number>((resolve) => first.once("close", resolve));
    send(first, event(1, "agent_text", { text: "retry me" }, firstFlushId, 1, 0));

    expect(await closed).toBe(1011);
    expect(store.listEvents(sessionId)).toEqual([]);

    const retry = await connect({
      capabilities: [OUTBOX_ACK_CAPABILITY],
      pendingOutbox: true,
      pendingOutboxCount: 1,
      outboxFlush: { flushId: firstFlushId, eventCount: 1 },
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
    });
    const acknowledged = nextMessage(retry, "outbox_flush_ack");
    send(retry, event(1, "agent_text", { text: "retry me" }, firstFlushId, 1, 0));
    send(retry, {
      type: "outbox_flushed",
      activeSessionIds: [sessionId],
      busySessionIds: [sessionId],
      outboxFlush: { flushId: firstFlushId, eventCount: 1 },
    });

    expect(await acknowledged).toMatchObject({ flushId: firstFlushId });
    expect(store.listEvents(sessionId)).toHaveLength(1);
  });

  async function connect(
    hello: Partial<Extract<NodeToHostMessage, { type: "hello" }>>,
  ): Promise<WebSocket> {
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/node`);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const welcomed = new Promise<void>((resolve, reject) => {
      client.once("message", (raw) => {
        const message = JSON.parse(String(raw)) as {
          type?: string;
          reconcileAfterOutbox?: boolean;
          acknowledgeOutbox?: boolean;
        };
        if (message.type === "welcome") {
          expect(message.reconcileAfterOutbox).toBe(
            hello.pendingOutbox === true ||
              (hello.pendingOutboxCount ?? 0) > 0 ||
              hello.outboxFlush !== undefined,
          );
          expect(message.acknowledgeOutbox).toBe(
            hello.capabilities?.includes(OUTBOX_ACK_CAPABILITY) ?? false,
          );
          resolve();
        } else reject(new Error(`Expected welcome, received ${message.type}`));
      });
    });
    send(client, {
      type: "hello",
      nodeId,
      secret,
      os: "win32",
      arch: "x64",
      version: "0.3.0",
      revision: "",
      capabilities: hello.capabilities ?? [],
      agents: [],
      maxSessions: 1,
      homeDir: "C:\\Users\\node",
      ...hello,
    });
    await welcomed;
    return client;
  }

  function send(client: WebSocket, message: unknown): void {
    client.send(JSON.stringify(NodeToHostMessageSchema.parse(message)));
  }

  function event(
    sequence: number,
    type: SessionEvent["type"],
    payload: SessionEvent["payload"],
    flushId?: OutboxFlushId,
    eventCount?: number,
    eventIndex?: number,
    replaySessionId = sessionId,
  ): Extract<NodeToHostMessage, { type: "event" }> {
    return {
      type: "event",
      event: {
        eventId:
          replaySessionId === sessionId
            ? `event-${sequence}`
            : `${replaySessionId}-event-${sequence}`,
        sessionId: replaySessionId,
        sequence,
        type,
        payload,
        createdAt: "2026-09-01T20:00:00.000Z",
      },
      ...(flushId !== undefined && eventCount !== undefined && eventIndex !== undefined
        ? { outboxFlush: { flushId, eventCount, eventIndex } }
        : {}),
    };
  }
});

async function nextMessage<T extends HostToNodeMessage["type"]>(
  client: WebSocket,
  type: T,
): Promise<Extract<HostToNodeMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    client.once("message", (raw) => {
      const message = JSON.parse(String(raw)) as HostToNodeMessage;
      if (message.type === type) {
        resolve(message as Extract<HostToNodeMessage, { type: T }>);
      } else {
        reject(new Error(`Expected ${type}, received ${message.type}`));
      }
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for socket processing");
}

async function close(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  client.close();
  await closed;
}
