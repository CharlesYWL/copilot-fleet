import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MUTUAL_AUTH_PROTOCOL,
  OUTBOX_ACK_CAPABILITY,
  SESSION_RETENTION_CAPABILITY,
  DURABLE_LEAD_DELIVERY_CAPABILITY,
  COMMAND_EXECUTION_CAPABILITY,
  COMMAND_PERMISSIONS_CAPABILITY,
  NodeBackupSchema,
  NODE_BACKUP_KIND,
  BACKUP_VERSION,
  PreparedCommandSchema,
  type PreparedCommand,
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
import { CommandPermissions, permissionPath } from "./command-permissions.js";
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
const journalRecords: { descriptor: PreparedCommand }[] = [];
let testConfigDirectory = "";
let emitEvent: (event: SessionEvent) => void;
const refreshMcpSessions = vi.fn(async () => {});
const stopAll = vi.fn(async () => {});
const configureCommands = vi.fn(async (_enabled: boolean) => {});
let activeSessionIds = ["session-1"];
const remoteCommandHandle = vi.fn(async () => {});
const commandCancelAll = vi.fn(async () => {});
const deliverLeadPrompt = vi.fn(async () => {});
const rejectLeadPrompt = vi.fn();
const leadReplay = vi.fn();
const maintenanceRelease = vi.fn();
const quarantine = vi.fn();
const worktreesShutdown = vi.fn(async () => {});
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
  configDirectory: () => testConfigDirectory,
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
    get activeSessionIds() {
      return activeSessionIds;
    }
    busySessionIds = ["session-1"];
    refreshMcpSessions = refreshMcpSessions;
    route = route;
    setMaxSessions = vi.fn();
    stopAll = stopAll;
    deliverLeadPrompt = deliverLeadPrompt;
    rejectLeadPrompt = rejectLeadPrompt;
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
vi.mock("./managed-worktrees.js", () => ({
  ManagedWorktrees: class {
    quarantine = quarantine;
    shutdown = worktreesShutdown;
  },
}));
vi.mock("./command-journal.js", () => ({
  CommandJournal: class {
    close = vi.fn();
    all = vi.fn(() => journalRecords);
  },
}));
vi.mock("./lead-prompt-delivery.js", () => ({
  LeadPromptJournal: class {
    replay = leadReplay;
    flush = vi.fn();
    close = vi.fn();
  },
}));
vi.mock("./repository-participation.js", () => ({
  RepositoryParticipation: class {
    resolve = vi.fn(async () => ({}));
    acquire = vi.fn(async () => [{ release: maintenanceRelease }]);
    activate = vi.fn(async () => {});
  },
}));
vi.mock("./command-execution-manager.js", () => ({
  CommandExecutionManager: class {
    readiness = {
      enabled: false,
      supported: false,
      reason: "Disabled locally",
      shells: [],
      admissionVersion: 1,
    };
    unsettled = false;
    recoverAll = vi.fn(async () => {});
    configure = configureCommands;
    handle = remoteCommandHandle;
    inventory = vi.fn();
    flush = vi.fn();
    restore = vi.fn(async () => {});
    cancelAll = commandCancelAll;
  },
}));
vi.mock("./command-supervisor-adapter.js", () => ({ nativeCommandSupervisor: {} }));

beforeEach(() => {
  testConfigDirectory = resolvePath(`.fleet-main-config-${randomUUID()}`);
  mkdirSync(testConfigDirectory);
  sockets.length = 0;
  journalRecords.length = 0;
  vi.clearAllMocks();
  activeSessionIds = ["session-1"];
});

it.each([false, true])(
  "reports failures and verifies service restart handoff (shutdown failure: %s)",
  async (failShutdown) => {
    activeSessionIds = [];
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
      expect(hello.capabilities).not.toContain(COMMAND_EXECUTION_CAPABILITY);
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
        beforeMutation: expect.any(Function),
        forceRebuild: false,
      });
      expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
        type: "update_status",
        updateId: "restart-service",
        stage: "restarting",
        revision: "abcdef123456",
      });
      if (failShutdown) expect(exit).not.toHaveBeenCalled();
      else expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      expect(maintenanceRelease).toHaveBeenCalledTimes(3);
      if (!failShutdown)
        expect(maintenanceRelease.mock.invocationCallOrder.at(-1)!).toBeLessThan(
          exit.mock.invocationCallOrder[0]!,
        );
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
  rmSync(testConfigDirectory, { recursive: true, force: true });
});

it.each([
  [false, false],
  [true, false],
  [false, true],
] as const)(
  "replays events with independent durable lead delivery=%s and command reconciliation=%s",
  async (deliveryEnabled, commandsEnabled) => {
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
          DURABLE_LEAD_DELIVERY_CAPABILITY,
        ]),
        pendingOutbox: true,
        pendingOutboxCount: 1,
        outboxFlush: { eventCount: 1 },
      });
      if (ready.type !== "ready" || !ready.outboxFlush) throw new Error("No outbox");
      expect(ready.capabilities).toContain(COMMAND_EXECUTION_CAPABILITY);
      expect(ready.capabilities).toContain(COMMAND_PERMISSIONS_CAPABILITY);
      expect(configureCommands).toHaveBeenCalledWith(true);
      expect(ready.commandExecution).toMatchObject({ enabled: false, supported: false });
      const receive = (message: HostToNodeMessage) =>
        socket.receive(hostChannel.seal(JSON.stringify(message)));
      await receive({
        type: "welcome",
        nodeId: credentials.nodeId,
        reconcileAfterOutbox: true,
        acknowledgeOutbox: true,
        commandExecutions: commandsEnabled,
        commandPermissions: commandsEnabled,
        durableLeadDelivery: deliveryEnabled,
      });
      await receive({
        type: "deliver_lead_prompt",
        delivery: {
          deliveryId: "a8477b16-2993-4d19-a035-b9c8063ba6ae",
          sessionId: "session-1",
          prompt: "not negotiated",
        },
      });
      expect(deliverLeadPrompt).toHaveBeenCalledTimes(deliveryEnabled ? 1 : 0);
      expect(leadReplay).toHaveBeenCalledTimes(deliveryEnabled ? 1 : 0);
      await socket.receive(
        hostChannel.seal(
          JSON.stringify({
            type: "deliver_lead_prompt",
            delivery: {
              deliveryId: "ab477b16-2993-4d19-a035-b9c8063ba6ae",
              sessionId: "session-1",
              prompt: "attachment must not disappear",
              attachments: [
                { name: "evidence.txt", mimeType: "text/plain", data: "ZXZpZGVuY2U=" },
              ],
            },
          }),
        ),
      );
      expect(rejectLeadPrompt).not.toHaveBeenCalled();
      expect(deliverLeadPrompt).toHaveBeenCalledTimes(deliveryEnabled ? 2 : 0);
      if (deliveryEnabled)
        expect(deliverLeadPrompt).toHaveBeenLastCalledWith(
          credentials.host.hostId,
          expect.objectContaining({
            attachments: [
              { name: "evidence.txt", mimeType: "text/plain", data: "ZXZpZGVuY2U=" },
            ],
          }),
        );
      await socket.receive(
        hostChannel.seal(
          JSON.stringify({
            type: "deliver_lead_prompt",
            delivery: {
              deliveryId: "ac477b16-2993-4d19-a035-b9c8063ba6ae",
              sessionId: "session-1",
              prompt: "unknown content must not disappear",
              unsupportedContent: "future payload",
            },
          }),
        ),
      );
      expect(rejectLeadPrompt).toHaveBeenCalledTimes(deliveryEnabled ? 1 : 0);
      await receive({
        type: "reconcile_command_executions",
        hostId: credentials.host.hostId,
        executions: [],
      });
      expect(remoteCommandHandle).toHaveBeenCalledTimes(commandsEnabled ? 1 : 0);
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
      await routerOptions.deleteInactiveSession!(
        "mock-session",
        Date.now(),
        beforeDelete,
      );
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
  },
);

it("refuses self-update before invoking the updater with live sessions or pending admission", async () => {
  vi.useFakeTimers();
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
  vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
  vi.stubEnv("FLEET_MOCK_AGENT", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { loadCredentials } = await import("./config.js");
  vi.mocked(loadCredentials).mockResolvedValueOnce({
    hostUrl: credentials.hostUrl,
    nodeId: credentials.nodeId,
    name: credentials.name,
    authProtocol: "legacy-secret",
    secret: "test-secret",
  });

  const { updateCheckout } = await import("./updater.js");
  const exits = process.listeners("exit");
  const { main } = await import("./main.js");
  const runtime = await main([]);
  try {
    const socket = sockets[0]!;
    socket.readyState = TestSocket.OPEN;
    socket.emit("open");
    await socket.receive({ type: "update_node", updateId: "live" });
    expect(updateCheckout).not.toHaveBeenCalled();
    expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
      type: "update_status",
      stage: "failed",
    });
    activeSessionIds = [];
    const pending = routerOptions.admission!.enter("session:resolving-root");
    await socket.receive({ type: "update_node", updateId: "pending" });
    expect(updateCheckout).not.toHaveBeenCalled();
    pending.release();
    expect(routerOptions.admission!.reason).toBe("");
  } finally {
    await runtime.shutdown();
    for (const listener of process.listeners("exit"))
      if (!exits.includes(listener)) process.removeListener("exit", listener);
  }
});

it("keeps command admission quarantined after updater mutation failure and forces explicit retry rebuild", async () => {
  vi.useFakeTimers();
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
  vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
  vi.stubEnv("FLEET_MOCK_AGENT", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  activeSessionIds = [];
  const { loadCredentials } = await import("./config.js");
  vi.mocked(loadCredentials).mockResolvedValueOnce({
    hostUrl: credentials.hostUrl,
    nodeId: credentials.nodeId,
    name: credentials.name,
    authProtocol: "legacy-secret",
    secret: "fixture",
  });
  const { updateCheckout } = await import("./updater.js");
  vi.mocked(updateCheckout).mockImplementation(async (options) => {
    await options.beforeMutation?.();
    return { action: "failed", reason: "npm install failed after reset" };
  });
  const exits = process.listeners("exit");
  const { main } = await import("./main.js");
  const runtime = await main([]);
  try {
    const socket = sockets[0]!;
    socket.readyState = TestSocket.OPEN;
    socket.emit("open");
    await socket.receive({ type: "update_node", updateId: "mutating-update" });
    expect(updateCheckout).toHaveBeenCalledOnce();
    expect(routerOptions.admission!.reason).toContain("update is incomplete");
    expect(() => routerOptions.admission!.enter("command:must-not-start")).toThrow();
    await socket.receive({ type: "update_node", updateId: "explicit-retry" });
    expect(updateCheckout).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateCheckout).mock.lastCall![0].forceRebuild).toBe(true);
    expect(routerOptions.admission!.reason).toContain("update is incomplete");
  } finally {
    await runtime.shutdown();
    vi.mocked(updateCheckout).mockReset();
    for (const listener of process.listeners("exit"))
      if (!exits.includes(listener)) process.removeListener("exit", listener);
  }
});

it("recovers and persists legacy script text before exposing the production editor", async () => {
  vi.useFakeTimers();
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
  vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
  vi.stubEnv("FLEET_MOCK_AGENT", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const command = "Write-Output preserved; Write-Output script";
  const input = { command, hostId: credentials.host.hostId, leadSessionId: "lead" };
  const engine = new CommandPermissions({
    getRules: () => [],
    saveRules: async () => {},
  });
  const permission = engine.evaluate(input, testConfigDirectory);
  const at = new Date().toISOString();
  const identity = {
    key: "m:v:f",
    path: testConfigDirectory,
    machineId: "m",
    volume: "v",
    fileId: "f",
  };
  journalRecords.push({
    descriptor: PreparedCommandSchema.parse({
      ...input,
      executionId: randomUUID(),
      attemptId: randomUUID(),
      nodeId: credentials.nodeId,
      target: { placementId: "placement" },
      requestedPath: testConfigDirectory,
      shell: "windows-powershell-5.1",
      requestKey: "migration",
      reason: "fixture",
      createdAt: at,
      expiresAt: at,
      hostTime: at,
      digest: "a".repeat(64),
      prepared: {
        cwd: testConfigDirectory,
        checkout: identity,
        repository: identity,
        shellPath: "powershell.exe",
        admissionVersion: 1,
        preparedAt: at,
        clockUncertaintyMs: 0,
        hostClockOffsetMs: 0,
        permission,
      },
    }),
  });
  const { loadSettings, saveSettings } = await import("./settings.js");
  vi.mocked(loadSettings).mockResolvedValueOnce({
    ...settingsFromEnv({}),
    commandPermissionRevision: 7,
    commandPermissionRules: [
      {
        id: "legacy",
        commandKey: permission.commandKey!,
        path: permissionPath(testConfigDirectory),
        hostId: input.hostId,
        builtin: false,
      },
    ],
  });
  const exits = process.listeners("exit");
  const { main } = await import("./main.js");
  const runtime = await main([]);
  try {
    expect(configOptions.getCommandPermissions!()).toMatchObject({
      version: 8,
      entries: [{ command, path: permissionPath(testConfigDirectory), match: "exact" }],
    });
    expect(
      vi.mocked(saveSettings).mock.calls.at(-1)![0].commandPermissionRules[0],
    ).toMatchObject({
      command,
      match: "exact",
      commandKey: permission.commandKey,
    });
  } finally {
    await runtime.shutdown();
    for (const listener of process.listeners("exit"))
      if (!exits.includes(listener)) process.removeListener("exit", listener);
  }
});

it("starts command readiness without opt-in and edits rules without stopping existing sessions", async () => {
  vi.useFakeTimers();
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
  vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
  vi.stubEnv("FLEET_MOCK_AGENT", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const exits = process.listeners("exit");
  const { main } = await import("./main.js");
  const runtime = await main([]);
  try {
    expect(configureCommands).toHaveBeenCalledWith(true);
    expect(activeSessionIds).toHaveLength(1);
    const before = configOptions.getCommandPermissions!();
    const staleSettings = { ...configOptions.getSettings() };
    const updated = await configOptions.updateCommandPermissions!(before.version, []);
    expect(updated).toEqual({ version: before.version + 1, rules: [], entries: [] });
    const actualConfig =
      await vi.importActual<typeof ConfigServerModule>("./config-server.js");
    const route = actualConfig.createConfigRouter(configOptions);
    const saved = await route(
      "POST",
      "/api/config",
      JSON.stringify({
        ...staleSettings,
        nodeName: "Updated name",
        commandPermissionRules: undefined,
        commandPermissionRevision: undefined,
      }),
    );
    expect(saved.status).toBe(200);
    expect(configOptions.getSettings().commandPermissionRules).toEqual([]);
    await expect(
      configOptions.updateCommandPermissions!(before.version, before.rules),
    ).rejects.toThrow("changed");
    expect((await route("GET", "/api/command-permissions", "")).body).toEqual(updated);
    const savedRules = await route(
      "POST",
      "/api/command-permissions",
      JSON.stringify({
        expectedVersion: updated.version,
        rules: [
          ...before.rules,
          {
            id: "local-git",
            commandKey: "git status",
            path: testConfigDirectory,
            builtin: false,
          },
        ],
      }),
    );
    expect(savedRules.status).toBe(200);
    const persistent = configOptions.getCommandPermissions!();
    expect(persistent.version).toBe(updated.version + 1);
    expect(persistent.rules).toContainEqual(
      expect.objectContaining({
        id: "local-git",
        commandKey: expect.stringMatching(/^git status @sha256:[a-f0-9]{64}$/),
        hostId: credentials.host.hostId,
      }),
    );
    await route("POST", "/api/config", JSON.stringify(staleSettings));
    expect(configOptions.getCommandPermissions!()).toEqual(persistent);
    const edit = JSON.stringify({ expectedVersion: persistent.version, rules: [] });
    const competing = await Promise.all([
      route("POST", "/api/command-permissions", edit),
      route("POST", "/api/command-permissions", edit),
    ]);
    expect(competing.map((reply) => reply.status)).toEqual([200, 409]);
    const removed = configOptions.getCommandPermissions!();
    expect(removed.rules).toEqual([]);
    const { saveSettings } = await import("./settings.js");
    vi.mocked(saveSettings).mockRejectedValueOnce(new Error("disk full"));
    await expect(
      configOptions.updateCommandPermissions!(removed.version, before.rules),
    ).rejects.toThrow("disk full");
    expect(configOptions.getCommandPermissions!()).toEqual(removed);
    const bulk = await configOptions.updateCommandPermissionEntries!(removed.version, [
      { command: "git *", path: "*" },
      {
        command: "Write-Output one; Write-Output two",
        path: testConfigDirectory,
        match: "exact",
      },
    ]);
    expect(bulk.entries).toEqual([
      { command: "git *", path: "*", match: "pattern" },
      {
        command: "Write-Output one; Write-Output two",
        path: expect.any(String),
        match: "exact",
      },
    ]);
    expect(bulk.rules.every((rule) => rule.hostId === credentials.host.hostId)).toBe(
      true,
    );
    const invalidPolicy = await route(
      "POST",
      "/api/command-permissions",
      JSON.stringify({
        expectedVersion: bulk.version,
        entries: [{ command: "git *; Write-Output unsafe-pattern", path: "*" }],
      }),
    );
    expect(invalidPolicy.status).toBe(400);
    expect(configOptions.getCommandPermissions!()).toEqual(bulk);
    await route("POST", "/api/config", JSON.stringify(staleSettings));
    expect(configOptions.getCommandPermissions!()).toEqual(bulk);
    await expect(
      configOptions.updateCommandPermissionEntries!(removed.version, []),
    ).rejects.toThrow("changed");
    expect(stopAll).not.toHaveBeenCalled();
    expect(commandCancelAll).not.toHaveBeenCalled();
    expect(routerOptions.admission!.reason).toBe("");
  } finally {
    await runtime.shutdown();
    for (const listener of process.listeners("exit"))
      if (!exits.includes(listener)) process.removeListener("exit", listener);
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

it("always quarantines a failed backup drain and never installs an unsafe replacement identity", async () => {
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
  vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
  vi.stubEnv("FLEET_MOCK_AGENT", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const exits = process.listeners("exit");
  const { main } = await import("./main.js");
  const { saveCredentials } = await import("./config.js");
  const runtime = await main([]);
  try {
    const stopError = new Error("ACP descendants cannot be verified");
    stopAll.mockRejectedValueOnce(stopError);
    const saves = vi.mocked(saveCredentials).mock.calls.length;
    const archive = NodeBackupSchema.parse({
      kind: NODE_BACKUP_KIND,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      credentials: { ...credentials, nodeId: "replacement" },
      settings: configOptions.getSettings(),
    });
    await expect(configOptions.applyBackup(archive)).rejects.toMatchObject({
      message: expect.stringContaining("Backup import aborted"),
      errors: [stopError],
    });
    expect(quarantine).toHaveBeenCalledOnce();
    expect(vi.mocked(saveCredentials).mock.calls).toHaveLength(saves);
    expect(sockets).toHaveLength(1);
  } finally {
    await runtime.shutdown();
    for (const listener of process.listeners("exit")) {
      if (!exits.includes(listener)) process.removeListener("exit", listener);
    }
  }
});

it("always shuts down worktree resources and surfaces every shutdown failure", async () => {
  vi.stubEnv("FLEET_DEVTUNNEL_ID", "");
  vi.stubEnv("FLEET_UPDATE_PARENT_PID", "");
  vi.stubEnv("FLEET_MOCK_AGENT", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const exits = process.listeners("exit");
  const { main } = await import("./main.js");
  const runtime = await main([]);
  const stopError = new Error("ACP stop failed");
  const shutdownError = new Error("Worktree operation failed after database close");
  stopAll.mockRejectedValueOnce(stopError);
  worktreesShutdown.mockRejectedValueOnce(shutdownError);
  try {
    await expect(runtime.shutdown()).rejects.toMatchObject({
      errors: [stopError, shutdownError],
    });
    expect(worktreesShutdown).toHaveBeenCalledOnce();
    expect(sockets[0]!.close).toHaveBeenCalled();
  } finally {
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
