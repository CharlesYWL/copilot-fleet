import { config as loadEnv } from "dotenv";
import { arch, homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  HostToNodeMessageSchema,
  NodeToHostMessageSchema,
  RegisterNodeSchema,
  tryParseJson,
  type NodeToHostMessage,
} from "@fleet/protocol";
import { AcpAgentFactory, MockAgentFactory } from "./agents.js";
import {
  configDirectory,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "./config.js";
import {
  AUTH_FAILED_CLOSE_CODE,
  SUPERSEDED_CLOSE_CODE,
  acquireInstanceLock,
  shouldReconnectAfterClose,
} from "./instance-lock.js";
import { CommandRouter } from "./router.js";
import { startConfigServer } from "./config-server.js";
import { loadSettings, needsReconnect, saveSettings, type Settings } from "./settings.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const VERSION = "0.1.0";
let settings = await loadSettings();
const mockAgent = process.env.FLEET_MOCK_AGENT === "1";

function log(message: string): void {
  console.log(`${new Date().toISOString()} [node] ${message}`);
}

log(`copilot-fleet node ${VERSION} starting`);
log(`  name        ${settings.nodeName}`);
log(`  host        ${settings.hostUrl}`);
log(`  agent       ${mockAgent ? "mock" : "copilot --acp"}`);
log(`  permissions ${mockAgent ? "n/a" : "per session (Host decides)"}`);
log(`  capacity    ${settings.maxSessions} concurrent sessions`);
log(`  config      ${configDirectory()}`);

const instanceLock = acquireInstanceLock(configDirectory());
if (!instanceLock.ok) {
  console.error(instanceLock.reason);
  process.exit(1);
}
const releaseInstanceLock = instanceLock.release;
process.once("exit", () => releaseInstanceLock());

let credentials = await ensureCredentials();

const factory = mockAgent
  ? new MockAgentFactory()
  : new AcpAgentFactory(settings.permissionTimeoutMs, settings.copilotCommand);
let socket: WebSocket | undefined;
let shuttingDown = false;
let reconnectTimer: NodeJS.Timeout | undefined;
const router = new CommandRouter(factory, settings.maxSessions, (event) => {
  send({ type: "event", event });
});

/**
 * Registers when the stored identity is missing or the operator renamed this
 * node. The host URL is deliberately not part of the identity: tunnel providers
 * hand out a fresh URL constantly, and re-registering under the same name
 * collides with the unique name index.
 */
async function ensureCredentials(): Promise<Credentials> {
  const stored = await loadCredentials();
  if (!stored || stored.name !== settings.nodeName) {
    log(stored ? "Node name changed, registering again" : "No stored credentials, registering");
    const registered = await register();
    await saveCredentials(registered);
    log(`Registered as node ${registered.nodeId}`);
    return registered;
  }
  if (stored.hostUrl !== settings.hostUrl) {
    log(`Host URL changed to ${settings.hostUrl}, reusing node ${stored.nodeId}`);
    const moved = { ...stored, hostUrl: settings.hostUrl };
    await saveCredentials(moved);
    return moved;
  }
  log(`Reusing stored credentials for node ${stored.nodeId}`);
  return stored;
}

/**
 * Applies edits from the local config UI without restarting the process, so a
 * rotated tunnel URL no longer costs a manual restart on every node.
 */
async function applySettings(next: Settings): Promise<void> {
  const previous = settings;
  settings = next;
  await saveSettings(next);
  router.setMaxSessions(next.maxSessions);
  if (factory instanceof AcpAgentFactory) {
    factory.configure(next.permissionTimeoutMs, next.copilotCommand);
  }
  if (!needsReconnect(previous, next)) {
    log("Settings updated; no reconnect needed");
    return;
  }
  log(`Settings changed; reconnecting to ${next.hostUrl}`);
  credentials = await ensureCredentials();
  reconnect();
}

/** Drops the current socket so the next connect uses the latest credentials. */
function reconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const current = socket;
  socket = undefined;
  // Removing listeners first stops the close handler from scheduling its own
  // retry against the URL we are moving away from.
  current?.removeAllListeners();
  current?.close();
  connect();
}

const configServer = startConfigServer({
  getSettings: () => settings,
  getStatus: () => ({
    nodeId: credentials.nodeId,
    version: VERSION,
    connected: socket?.readyState === WebSocket.OPEN,
    activeSessions: router.activeSessionIds.length,
    mockAgent,
  }),
  applySettings,
  log,
});

connect();

function connect(): void {
  const auth = credentials;
  const url = new URL("/ws/node", auth.hostUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  log(`Connecting to ${url}`);
  const active = new WebSocket(url);
  socket = active;
  active.on("open", () => {
    send({
      type: "hello",
      nodeId: auth.nodeId,
      secret: auth.secret,
      os: platform(),
      arch: arch(),
      version: VERSION,
      capabilities: ["copilot-acp", "host-yolo", mockAgent ? "mock" : "real"],
      maxSessions: settings.maxSessions,
      homeDir: homedir(),
      activeSessionIds: router.activeSessionIds,
    });
  });
  active.on("message", async (raw) => {
    const frame = tryParseJson(raw.toString());
    if (!frame.ok) {
      console.error("Rejected malformed Host message:", frame.error);
      active.close(1007, "Malformed JSON");
      return;
    }
    const parsed = HostToNodeMessageSchema.safeParse(frame.value);
    if (!parsed.success) {
      console.error("Rejected invalid Host message:", parsed.error.message);
      active.close(1008, "Invalid Host message");
      return;
    }
    if (parsed.data.type === "welcome") {
      log(`Authenticated with Host, waiting for commands`);
      return;
    }
    if (parsed.data.type !== "command") return;
    const { command } = parsed.data;
    log(`< ${command.type} session=${command.sessionId.slice(0, 8)}`);
    const result = await router.route(command);
    log(
      result.ok
        ? `> ${command.type} ok session=${command.sessionId.slice(0, 8)}`
        : `> ${command.type} FAILED session=${command.sessionId.slice(0, 8)}: ${result.error}`,
    );
    send({
      type: "command_result",
      commandId: result.commandId,
      sessionId: command.sessionId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    });
  });
  active.on("close", async (code) => {
    // A settings change swaps the socket out; the stale one must not tear down
    // agents or schedule a retry against the URL we just left.
    if (socket !== active) return;
    if (code === AUTH_FAILED_CLOSE_CODE) {
      // The stored secret will never be accepted again, so retrying it is an
      // infinite loop. Registering reclaims this node by name, which keeps its
      // id and therefore its placements and session history.
      log("Host rejected our credentials; enrolling again");
      try {
        credentials = await register();
        await saveCredentials(credentials);
        log(`Re-enrolled as node ${credentials.nodeId}`);
      } catch (error) {
        console.error(
          "Re-enrollment failed:",
          error instanceof Error ? error.message : error,
        );
      }
      reconnectTimer = setTimeout(connect, 2_000);
      return;
    }
    if (!shouldReconnectAfterClose(code, shuttingDown)) {
      // Only tear agents down when this process is done; a Host bounce must
      // not wipe live sessions that we are about to re-announce on hello.
      router.denyPendingPermissions();
      await router.stopAll();
      if (code === SUPERSEDED_CLOSE_CODE) {
        console.error(
          "Connection superseded by another node instance; not reconnecting",
        );
        releaseInstanceLock();
        process.exit(1);
      }
      log(`Disconnected (code ${code}); shutting down`);
      return;
    }
    log(
      `Disconnected (code ${code}); keeping ${router.activeSessionIds.length} session(s), reconnecting in 2s`,
    );
    reconnectTimer = setTimeout(connect, 2_000);
  });
  active.on("error", (error) => {
    console.error("Host connection error:", error.message);
  });
}

function send(message: NodeToHostMessage): void {
  NodeToHostMessageSchema.parse(message);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

const heartbeatTimer = setInterval(() => {
  send({
    type: "heartbeat",
    activeSessionIds: router.activeSessionIds,
    sentAt: new Date().toISOString(),
  });
}, 5_000);
heartbeatTimer.unref();

async function register(): Promise<Credentials> {
  const enrollmentToken = process.env.FLEET_ENROLLMENT_TOKEN;
  if (!enrollmentToken) {
    throw new Error("FLEET_ENROLLMENT_TOKEN is required for first registration");
  }
  const body = RegisterNodeSchema.parse({
    enrollmentToken,
    name: settings.nodeName,
    os: platform(),
    arch: arch(),
    version: VERSION,
    capabilities: ["copilot-acp", "host-yolo"],
    maxSessions: settings.maxSessions,
    homeDir: homedir(),
  });
  const response = await fetch(new URL("/api/nodes/register", settings.hostUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Node registration failed (${response.status}): ${await response.text()}`);
  }
  const result = (await response.json()) as { nodeId: string; secret: string };
  return {
    hostUrl: settings.hostUrl,
    nodeId: result.nodeId,
    secret: result.secret,
    name: settings.nodeName,
  };
}

async function shutdown(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  // An unref'd timer does not hold the loop open, but it does keep firing while
  // the process winds down, which resurrects a socket we are trying to close.
  clearInterval(heartbeatTimer);
  configServer.close();
  socket?.close();
  await router.stopAll();
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
