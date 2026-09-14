import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MUTUAL_AUTH_PROTOCOL,
  OUTBOX_ACK_CAPABILITY,
  SESSION_RETENTION_CAPABILITY,
  type HostToNodeMessage,
  type NodeCommand,
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
import type * as ConfigServerModule from "./config-server.js";
import type * as UpdaterModule from "./updater.js";
import type { CopilotSessionDiscoveryOptions } from "./copilot-sessions.js";
import type { CommandResult, CommandRouterOptions } from "./router.js";

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
const stopAll = vi.fn(async () => {});
const route = vi.fn<(command: NodeCommand) => Promise<CommandResult>>(
  async (command) => ({ commandId: command.commandId, ok: true }),
);
let routerOptions: CommandRouterOptions;
let discoveryOptions: CopilotSessionDiscoveryOptions;
let configOptions: Parameters<typeof ConfigServerModule.startConfigServer>[0];
const createDiscovery = vi.fn();
const stopHealthSampler = vi.fn();
const sampledHealth = {
  memory: {
    sampledAt: "2026-09-14T12:00:00.000Z",
    totalBytes: 16_000,
    availableBytes: 4_000,
  },
};
const deleteInactiveSession = vi.fn<
  NonNullable<CommandRouterOptions["deleteInactiveSession"]>
>(async (_id, _cutoff, beforeDelete) => {
  await beforeDelete();
});
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
vi.mock("./github-auth.js", () => ({ ensureGithubAuth: vi.fn(async () => {}) }));
vi.mock("./health.js", () => ({
  startHealthSampler: () => ({ latest: () => sampledHealth, stop: stopHealthSampler }),
}));
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
  startConfigServer: (options: typeof configOptions) => {
    configOptions = options;
    return { close: vi.fn() };
  },
}));
vi.mock("./updater.js", async (original) => ({
  ...(await original<typeof UpdaterModule>()),
  updateCheckout: vi.fn(),
  respawn: vi.fn(),
}));
vi.mock("./copilot-sessions.js", () => ({
  CopilotSessionDiscovery: class {
    deleteInactiveSession = deleteInactiveSession;
    constructor(options: CopilotSessionDiscoveryOptions) {
      discoveryOptions = options;
      createDiscovery(options);
    }
  },
}));
vi.mock("./router.js", () => ({
  validateWorkspacePath: vi.fn(),
  CommandRouter: class {
    activeSessionIds = ["session-1"];
    busySessionIds = ["session-1"];
    refreshMcpSessions = refreshMcpSessions;
    route = route;
    setMaxSessions = vi.fn();
    stopAll = stopAll;
    constructor(
      _factory: unknown,
      _capacity: number,
      onEvent: (event: SessionEvent) => void,
      _validatePath: unknown,
      _hostUrl: unknown,
      _catalog: unknown,
      _warn: unknown,
      options: CommandRouterOptions,
    ) {
      emitEvent = onEvent;
      routerOptions = options;
    }
  },
}));

beforeEach(() => {
  sockets.length = 0;
  vi.clearAllMocks();
});

it.each([false, true])(
  "reports failures and verifies service restart handoff (shutdown failure: %s)",
  async (failShutdown) => {
    vi.useFakeTimers();
    vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
    vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
    vi.stubEnv("FLEET_MOCK_AGENT", "1");
    vi.stubEnv("FLEET_RESTART_MODE", "exit");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
    const { loadCredentials } = await import("./config.js");
    vi.mocked(loadCredentials).mockResolvedValueOnce({
      hostUrl: credentials.hostUrl,
      nodeId: credentials.nodeId,
      name: credentials.name,
      authProtocol: "legacy-secret",
      secret: "test-secret",
    });
    const { updateCheckout, respawn } = await import("./updater.js");
    const exits = process.listeners("exit");
    const { main } = await import("./main.js");
    const runtime = await main([]);
    try {
      const { ensureGithubAuth } = await import("./github-auth.js");
      expect(ensureGithubAuth).not.toHaveBeenCalled();
      const socket = sockets[0]!;
      socket.readyState = TestSocket.OPEN;
      socket.emit("open");
      const hello = JSON.parse(socket.send.mock.calls[0]![0]) as Extract<
        NodeToHostMessage,
        { type: "hello" }
      >;
      vi.mocked(updateCheckout).mockResolvedValueOnce({
        action: "failed",
        reason: "Build failed",
      });
      await socket.receive({ type: "update_node", updateId: "failed-build" });
      expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
        type: "update_status",
        updateId: "failed-build",
        stage: "failed",
        detail: "Build failed",
      });
      expect(exit).not.toHaveBeenCalled();
      expect(configOptions.recentLogs?.()).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "Self-update failed: Build failed",
        }),
      );

      vi.mocked(updateCheckout).mockRejectedValueOnce(new Error("Cannot start build"));
      await socket.receive({ type: "update_node", updateId: "failed-command" });
      expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
        stage: "failed",
        detail: "Cannot start build",
      });
      expect(exit).not.toHaveBeenCalled();

      vi.mocked(updateCheckout).mockResolvedValueOnce({
        action: "restart",
        revision: "abcdef123456",
      });
      if (failShutdown) {
        stopAll.mockRejectedValueOnce(new Error("Shutdown failed"));
        await expect(
          socket.receive({ type: "update_node", updateId: "restart-service" }),
        ).rejects.toThrow("Shutdown failed");
      } else {
        await socket.receive({ type: "update_node", updateId: "restart-service" });
      }
      expect(updateCheckout).toHaveBeenLastCalledWith({
        repoRoot: expect.any(String),
        runningRevision: hello.revision,
        report: expect.any(Function),
      });
      expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
        type: "update_status",
        updateId: "restart-service",
        stage: "restarting",
        revision: "abcdef123456",
      });
      if (failShutdown) expect(exit).not.toHaveBeenCalled();
      else expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      expect(respawn).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
      for (const listener of process.listeners("exit")) {
        if (!exits.includes(listener)) process.removeListener("exit", listener);
      }
    }
  },
);

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
      capabilities: expect.arrayContaining([
        OUTBOX_ACK_CAPABILITY,
        SESSION_RETENTION_CAPABILITY,
      ]),
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

    const heartbeatIndex = socket.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(open(heartbeatIndex)).toMatchObject({
      type: "heartbeat",
      health: sampledHealth,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(open(heartbeatIndex + 1)).toMatchObject({
      type: "heartbeat",
      health: sampledHealth,
    });

    const beforeDelete = vi.fn(async () => {});
    await routerOptions.deleteInactiveSession!("mock-session", Date.now(), beforeDelete);
    expect(beforeDelete).toHaveBeenCalledOnce();
    expect(createDiscovery).not.toHaveBeenCalled();
    expect(deleteInactiveSession).not.toHaveBeenCalled();

    const cleanup: Extract<NodeCommand, { type: "delete_session" }> = {
      type: "delete_session",
      commandId: "cleanup-1",
      sessionId: "session-1",
      agentSessionId: "mock-session",
      inactiveBefore: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      retentionDays: 30,
    };
    let responseIndex = socket.send.mock.calls.length;
    await receive({ type: "command", command: cleanup });
    expect(open(responseIndex)).toEqual({
      type: "session_cleanup_result",
      commandId: "cleanup-1",
      sessionId: "session-1",
      ok: true,
    });
    route.mockResolvedValueOnce({
      commandId: "cleanup-2",
      ok: false,
      fatal: false,
      error: "session_active",
    });
    responseIndex = socket.send.mock.calls.length;
    await receive({
      type: "command",
      command: { ...cleanup, commandId: "cleanup-2" },
    });
    expect(open(responseIndex)).toEqual({
      type: "session_cleanup_result",
      commandId: "cleanup-2",
      sessionId: "session-1",
      ok: false,
      error: "session_active",
    });
    responseIndex = socket.send.mock.calls.length;
    await receive({
      type: "command",
      command: {
        type: "prompt",
        commandId: "normal-prompt",
        sessionId: "session-1",
        prompt: "hello",
        attachments: [],
      },
    });
    expect(open(responseIndex)).toEqual({
      type: "command_result",
      commandId: "normal-prompt",
      sessionId: "session-1",
      ok: true,
      fatal: true,
    });
  } finally {
    await runtime.shutdown();
    expect(stopHealthSampler).toHaveBeenCalledOnce();
    for (const listener of process.listeners("exit")) {
      if (!exits.includes(listener)) process.removeListener("exit", listener);
    }
  }
});

it("uses current Copilot launch settings for persisted cleanup without starting agents", async () => {
  vi.useFakeTimers();
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
  vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
  vi.stubEnv("FLEET_MOCK_AGENT", "0");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const exits = process.listeners("exit");
  const { main } = await import("./main.js");
  const runtime = await main([]);
  try {
    const { ensureGithubAuth } = await import("./github-auth.js");
    expect(ensureGithubAuth).toHaveBeenCalledExactlyOnceWith({
      env: expect.objectContaining({ FLEET_MOCK_AGENT: "0" }),
    });
    expect(createDiscovery).toHaveBeenCalledOnce();
    const settings = configOptions.getSettings();
    expect(discoveryOptions.getCopilotCommand()).toBe(settings.copilotCommand);
    expect(discoveryOptions.getContextTier()).toBe(settings.contextTier);
    await configOptions.applySettings({
      ...settings,
      copilotCommand: "updated-copilot",
      contextTier: "long_context",
    });

    expect(discoveryOptions.getCopilotCommand()).toBe("updated-copilot");
    expect(discoveryOptions.getContextTier()).toBe("long_context");
    expect(configOptions.sessionDiscovery).toMatchObject({ deleteInactiveSession });
    const beforeDelete = vi.fn(async () => {});
    await routerOptions.deleteInactiveSession!("expired", 123, beforeDelete);
    expect(deleteInactiveSession).toHaveBeenCalledExactlyOnceWith(
      "expired",
      123,
      beforeDelete,
    );
    expect(beforeDelete).toHaveBeenCalledOnce();
  } finally {
    await runtime.shutdown();
    for (const listener of process.listeners("exit")) {
      if (!exits.includes(listener)) process.removeListener("exit", listener);
    }
  }
});

it("stops before connecting or loading settings when GitHub authentication fails", async () => {
  vi.stubEnv("FLEET_MOCK_AGENT", "0");
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "must-not-connect");
  const { ensureGithubAuth } = await import("./github-auth.js");
  const { loadSettings } = await import("./settings.js");
  vi.mocked(ensureGithubAuth).mockRejectedValueOnce(new Error("GitHub login cancelled"));
  const { main } = await import("./main.js");
  await expect(main([])).rejects.toThrow("GitHub login cancelled");
  expect(loadSettings).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(0);
});
