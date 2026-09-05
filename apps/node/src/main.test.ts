import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  MUTUAL_AUTH_PROTOCOL,
  OUTBOX_ACK_CAPABILITY,
  type HostToNodeMessage,
  type NodeClientHello,
  type NodeToHostMessage,
  type SessionEvent,
} from "@fleet/protocol";
import {
  AuthenticatedChannel,
  CHANNEL_KEY_LABEL,
  HOST_CHALLENGE_LABEL,
  createEphemeralKeyPair,
  createIdentityKeyPair,
  deriveChannelKeys,
  handshakeTranscript,
  signWithIdentity,
} from "@fleet/protocol/node-auth";
import { settingsFromEnv } from "./settings.js";
import type * as SettingsModule from "./settings.js";
import type * as AgentCatalogModule from "./agent-catalog.js";
import type * as InstanceLockModule from "./instance-lock.js";

class TestSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  send = vi.fn<(text: string) => void>();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  ping = vi.fn();
  terminate = vi.fn();

  constructor(_url: URL, _options: unknown) {
    super();
    sockets.push(this);
  }

  async receive(frame: unknown): Promise<void> {
    for (const listener of this.listeners("message")) {
      await listener(JSON.stringify(frame));
    }
  }
}

const sockets: TestSocket[] = [];
let emitEvent: (event: SessionEvent) => void;
const refreshMcpSessions = vi.fn(async () => {});
const hostKeys = createIdentityKeyPair();
const nodeKeys = createIdentityKeyPair();
const credentials = {
  hostUrl: "http://127.0.0.1:8787",
  nodeId: "node-1",
  name: "node",
  authProtocol: MUTUAL_AUTH_PROTOCOL,
  privateKey: nodeKeys.privateKey,
  publicKey: nodeKeys.publicKey,
  host: {
    hostId: "host-1",
    publicKey: hostKeys.publicKey,
    fingerprint: hostKeys.fingerprint,
  },
};

vi.mock("ws", () => ({ default: TestSocket }));
vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("./config.js", () => ({
  configDirectory: () => process.cwd(),
  loadCredentials: vi.fn(async () => credentials),
  saveCredentials: vi.fn(),
}));
vi.mock("./settings.js", async (original) => ({
  ...(await original<typeof SettingsModule>()),
  loadSettings: vi.fn(async () => settingsFromEnv({})),
  saveSettings: vi.fn(),
}));
vi.mock("./agent-catalog.js", async (original) => ({
  ...(await original<typeof AgentCatalogModule>()),
  readAgentCatalog: vi.fn(async () => []),
}));
vi.mock("./instance-lock.js", async (original) => ({
  ...(await original<typeof InstanceLockModule>()),
  acquireInstanceLock: () => ({ ok: true, release: vi.fn() }),
}));
vi.mock("./config-server.js", () => ({
  configServerPort: () => 8788,
  startConfigServer: () => ({ close: vi.fn() }),
}));
vi.mock("./router.js", () => ({
  validateWorkspacePath: vi.fn(),
  CommandRouter: class {
    activeSessionIds = ["session-1"];
    busySessionIds = ["session-1"];
    refreshMcpSessions = refreshMcpSessions;
    stopAll = vi.fn(async () => {});
    constructor(
      _factory: unknown,
      _capacity: number,
      onEvent: (event: SessionEvent) => void,
    ) {
      emitEvent = onEvent;
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("replays events produced during mutual authentication before refreshing MCP sessions", async () => {
  vi.useFakeTimers();
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
  vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
  vi.stubEnv("FLEET_MOCK_AGENT", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const exits = process.listeners("exit");
  const { main } = await import("./main.js");
  const runtime = await main([]);
  try {
    const socket = sockets[0]!;
    socket.readyState = TestSocket.OPEN;
    socket.emit("open");
    const hello = JSON.parse(socket.send.mock.calls[0]![0]) as NodeClientHello;
    expect(hello.type).toBe("client_hello");

    const event: SessionEvent = {
      eventId: "event-1",
      sessionId: "session-1",
      sequence: 1,
      type: "turn_complete",
      payload: {},
      createdAt: new Date().toISOString(),
    };
    emitEvent(event);
    expect(socket.send).toHaveBeenCalledTimes(1);

    const ephemeral = createEphemeralKeyPair();
    const transcript = {
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId: credentials.host.hostId,
      nodeId: credentials.nodeId,
      connectionId: "connection-1",
      hostNonce: randomBytes(32).toString("base64"),
      nodeNonce: hello.nodeNonce,
      hostPublicKey: hostKeys.publicKey,
      nodePublicKey: nodeKeys.publicKey,
      hostEphemeralPublicKey: ephemeral.publicKey,
      nodeEphemeralPublicKey: hello.nodeEphemeralPublicKey,
      dialedHostUrl: hello.dialedHostUrl,
    };
    const hostChannel = new AuthenticatedChannel({
      keys: deriveChannelKeys({
        privateKey: ephemeral.privateKey,
        peerPublicKey: hello.nodeEphemeralPublicKey,
        transcript: handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
      }),
      binding: transcript,
      seals: "host-to-node",
    });
    await socket.receive({
      type: "host_challenge",
      ...transcript,
      hostFingerprint: hostKeys.fingerprint,
      signature: signWithIdentity(
        hostKeys.privateKey,
        handshakeTranscript(HOST_CHALLENGE_LABEL, transcript),
      ),
    });
    expect(JSON.parse(socket.send.mock.calls[1]![0]).type).toBe("node_proof");
    const open = (index: number): NodeToHostMessage => {
      const envelope = JSON.parse(socket.send.mock.calls[index]![0]);
      expect(envelope.type).toBe("envelope");
      const opened = hostChannel.open(envelope);
      if (!opened.ok) throw new Error(opened.reason);
      return JSON.parse(opened.plaintext) as NodeToHostMessage;
    };
    const ready = open(2);
    expect(ready).toMatchObject({
      type: "ready",
      capabilities: expect.arrayContaining([OUTBOX_ACK_CAPABILITY]),
      pendingOutbox: true,
      pendingOutboxCount: 1,
      outboxFlush: { eventCount: 1 },
    });
    if (ready.type !== "ready" || !ready.outboxFlush) throw new Error("No outbox");
    const receive = (message: HostToNodeMessage) =>
      socket.receive(hostChannel.seal(JSON.stringify(message)));
    await receive({
      type: "welcome",
      nodeId: credentials.nodeId,
      reconcileAfterOutbox: true,
      acknowledgeOutbox: true,
    });
    expect(open(3)).toMatchObject({
      type: "event",
      event,
      outboxFlush: { ...ready.outboxFlush, eventIndex: 0 },
    });
    expect(open(4)).toMatchObject({
      type: "outbox_flushed",
      outboxFlush: ready.outboxFlush,
    });
    expect(refreshMcpSessions).not.toHaveBeenCalled();
    const later = { ...event, eventId: "event-2", sequence: 2 };
    emitEvent(later);
    expect(socket.send).toHaveBeenCalledTimes(5);
    await receive({ type: "outbox_flush_ack", flushId: ready.outboxFlush.flushId });
    expect(open(5)).toMatchObject({ type: "event", event: later });
    const nextBatch = open(6);
    if (nextBatch.type !== "outbox_flushed" || !nextBatch.outboxFlush) {
      throw new Error("No subsequent outbox batch");
    }
    expect(nextBatch.outboxFlush.flushId).not.toBe(ready.outboxFlush.flushId);
    expect(refreshMcpSessions).not.toHaveBeenCalled();
    await receive({ type: "outbox_flush_ack", flushId: nextBatch.outboxFlush.flushId });
    expect(refreshMcpSessions).toHaveBeenCalledOnce();
  } finally {
    await runtime.shutdown();
    for (const listener of process.listeners("exit")) {
      if (!exits.includes(listener)) process.removeListener("exit", listener);
    }
  }
});
