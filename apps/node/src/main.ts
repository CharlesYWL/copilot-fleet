import { config as loadEnv } from "dotenv";
import { arch, homedir, platform } from "node:os";
import WebSocket from "ws";
import {
  HOST_URL_SYNC_CAPABILITY,
  HostToNodeMessageSchema,
  NodeToHostMessageSchema,
  RegisterNodeSchema,
  decodeFrame,
  errorMessage,
  sameHostUrl,
  type NodeToHostMessage,
} from "@fleet/protocol";
import { AcpAgentFactory, MockAgentFactory } from "./agents.js";
import { CliError, USAGE, parseNodeArgs } from "./cli.js";
import {
  configDirectory,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "./config.js";
import { planCredentials } from "./enrollment.js";
import {
  adoptHostUrl,
  endpointsAfterOperatorEdit,
  nextHostUrl,
  promoteHostUrl,
  type HostEndpoints,
} from "./host-endpoints.js";
import { envFilePath } from "./paths.js";
import {
  AUTH_FAILED_CLOSE_CODE,
  SUPERSEDED_CLOSE_CODE,
  acquireInstanceLock,
  shouldReconnectAfterClose,
} from "./instance-lock.js";
import { CommandRouter } from "./router.js";
import { configServerPort, startConfigServer } from "./config-server.js";
import {
  loadSettings,
  needsReconnect,
  saveSettings,
  settingsOverridesFromEnv,
  type Settings,
} from "./settings.js";

const VERSION = "0.1.0";
const RECONNECT_DELAY_MS = 2_000;

export type NodeRuntime = { shutdown: () => Promise<void> };

/**
 * Starts the node agent.
 *
 * Everything below used to run at module scope, so merely importing this file
 * grabbed the instance lock, registered over the network and opened the config
 * server — which is why none of the reconnect or credential-rotation behaviour
 * could be covered by a test.
 */
export async function main(argv: readonly string[] = []): Promise<NodeRuntime> {
  const flags = parseNodeArgs(argv);
  loadEnv({ path: envFilePath(), quiet: true });
  // One lookup path for both sources; the flags are already the last word.
  const env: NodeJS.ProcessEnv = { ...process.env, ...flags.env };

  let settings = await loadSettings(env, settingsOverridesFromEnv(flags.env));
  const mockAgent = env.FLEET_MOCK_AGENT === "1";

  const log = (message: string): void => {
    console.log(`${new Date().toISOString()} [node] ${message}`);
  };

  log(`copilot-fleet node ${VERSION} starting`);
  log(`  name        ${settings.nodeName}`);
  log(`  host        ${settings.hostUrl}`);
  log(`  agent       ${mockAgent ? "mock" : "copilot --acp"}`);
  log(`  permissions ${mockAgent ? "n/a" : "per session (Host decides)"}`);
  log(`  capacity    ${settings.maxSessions} concurrent sessions`);
  log(`  config      ${configDirectory()}`);
  const overridden = Object.keys(flags.env);
  // Naming the keys (never the values — one of them is a token) explains why
  // this run disagrees with the config page.
  if (overridden.length > 0) log(`  overrides   ${overridden.join(", ")} (command line)`);

  const instanceLock = acquireInstanceLock(configDirectory());
  if (!instanceLock.ok) {
    console.error(instanceLock.reason);
    process.exit(1);
  }
  const releaseInstanceLock = instanceLock.release;
  process.once("exit", () => releaseInstanceLock());

  let credentials = await ensureCredentials();
  /**
   * The address this attempt is dialing.
   *
   * Separate from the stored primary because a dial that fails rotates through
   * the fallbacks without rewriting settings.json on every retry — only the
   * address that actually produces a welcome is written back.
   */
  let dialUrl = credentials.hostUrl;

  const factory = mockAgent
    ? new MockAgentFactory()
    : new AcpAgentFactory(settings.permissionTimeoutMs, settings.copilotCommand);
  let socket: WebSocket | undefined;
  let shuttingDown = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  const router = new CommandRouter(factory, settings.maxSessions, (event) => {
    send({ type: "event", event });
  });

  /** Registers when the stored identity is missing or the operator renamed this node. */
  async function ensureCredentials(): Promise<Credentials> {
    const plan = planCredentials(await loadCredentials(), settings);
    if (plan.action === "register") {
      log(plan.reason);
      const registered = await register();
      await saveCredentials(registered);
      log(`Registered as node ${registered.nodeId}`);
      return registered;
    }
    if (plan.action === "move") {
      log(
        `Host URL changed to ${settings.hostUrl}, reusing node ${plan.credentials.nodeId}`,
      );
      await saveCredentials(plan.credentials);
      return plan.credentials;
    }
    log(`Reusing stored credentials for node ${plan.credentials.nodeId}`);
    return plan.credentials;
  }

  /**
   * Applies edits from the local config UI without restarting the process, so a
   * rotated tunnel URL no longer costs a manual restart on every node.
   */
  async function applySettings(next: Settings): Promise<void> {
    const previous = settings;
    const settled = endpointsAfterOperatorEdit(previous, next);
    settings = settled;
    await saveSettings(settled);
    router.setMaxSessions(settled.maxSessions);
    if (factory instanceof AcpAgentFactory) {
      factory.configure(settled.permissionTimeoutMs, settled.copilotCommand);
    }
    if (!needsReconnect(previous, settled)) {
      log("Settings updated; no reconnect needed");
      return;
    }
    log(`Settings changed; reconnecting to ${settled.hostUrl}`);
    credentials = await ensureCredentials();
    reconnect();
  }

  /** Drops the current socket so the next connect uses the latest credentials. */
  function reconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    dialUrl = credentials.hostUrl;
    const current = socket;
    socket = undefined;
    // Removing listeners first stops the close handler from scheduling its own
    // retry against the URL we are moving away from.
    current?.removeAllListeners();
    current?.close();
    connect();
  }

  /** Writes a change of Host address to both files that remember one. */
  async function persistEndpoints(endpoints: HostEndpoints): Promise<void> {
    settings = { ...settings, ...endpoints };
    await saveSettings(settings);
    if (sameHostUrl(credentials.hostUrl, settings.hostUrl)) return;
    credentials = { ...credentials, hostUrl: settings.hostUrl };
    await saveCredentials(credentials);
  }

  /**
   * Follows the Host to the address it just announced.
   *
   * The socket carrying the announcement is deliberately left alone: it is
   * working, and the whole point of being told in advance is that this node does
   * not have to lose a connection — and the sessions on it — to learn where the
   * Host went. The new address is what the next dial uses.
   */
  async function applyAnnouncedHostUrl(hostUrl: string): Promise<void> {
    if (sameHostUrl(hostUrl, settings.hostUrl)) return;
    const moved = adoptHostUrl(settings, hostUrl);
    await persistEndpoints(moved);
    dialUrl = moved.hostUrl;
    log(
      `Host moved to ${moved.hostUrl}; this connection stays up and the next one uses it`,
    );
  }

  /** Remembers the address that worked, so the next start leads with it. */
  async function promoteDialUrl(): Promise<void> {
    const promoted = promoteHostUrl(settings, dialUrl);
    if (!promoted) return;
    await persistEndpoints(promoted);
    log(`Reached the Host at ${promoted.hostUrl}; dialing it first from now on`);
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
    port: configServerPort(env),
  });

  function connect(): void {
    const auth = credentials;
    const url = new URL("/ws/node", dialUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    log(`Connecting to ${url}`);
    const active = new WebSocket(url);
    const attemptUrl = dialUrl;
    // Distinguishes "this address does not reach the Host" from "the Host hung
    // up on us", which is what decides whether to try a different address.
    let welcomed = false;
    socket = active;
    active.on("open", () => {
      send({
        type: "hello",
        nodeId: auth.nodeId,
        secret: auth.secret,
        os: platform(),
        arch: arch(),
        version: VERSION,
        capabilities: [
          "copilot-acp",
          "host-yolo",
          HOST_URL_SYNC_CAPABILITY,
          mockAgent ? "mock" : "real",
        ],
        maxSessions: settings.maxSessions,
        homeDir: homedir(),
        activeSessionIds: router.activeSessionIds,
      });
    });
    active.on("message", async (raw: unknown) => {
      const frame = decodeFrame(String(raw), HostToNodeMessageSchema);
      if (!frame.ok) {
        console.error("Rejected Host message:", frame.detail);
        active.close(frame.code, frame.reason);
        return;
      }
      if (frame.value.type === "welcome") {
        welcomed = true;
        log(`Authenticated with Host, waiting for commands`);
        await promoteDialUrl();
        return;
      }
      if (frame.value.type === "host_url") {
        await applyAnnouncedHostUrl(frame.value.hostUrl);
        return;
      }
      if (frame.value.type !== "command") return;
      const { command } = frame.value;
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
          console.error("Re-enrollment failed:", errorMessage(error));
        }
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
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
      // A dial that never got a welcome says nothing about the credentials and
      // everything about the address, so the next attempt tries another one.
      // Rotating only here — and not after an auth failure, which proves the
      // Host was reached — keeps a working address from being blamed for a
      // problem that is not its own.
      if (!welcomed) {
        const candidate = nextHostUrl(settings, attemptUrl);
        if (!sameHostUrl(candidate, attemptUrl)) {
          log(`No Host at ${attemptUrl}; trying ${candidate} next`);
          dialUrl = candidate;
        }
      }
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
    active.on("error", (error) => {
      console.error("Host connection error:", error.message);
    });
  }

  function send(message: NodeToHostMessage): void {
    NodeToHostMessageSchema.parse(message);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  async function register(): Promise<Credentials> {
    const enrollmentToken = env.FLEET_ENROLLMENT_TOKEN;
    if (!enrollmentToken) {
      throw new Error(
        "An enrollment token is required for first registration: pass --token=<token> or set FLEET_ENROLLMENT_TOKEN",
      );
    }
    const body = RegisterNodeSchema.parse({
      enrollmentToken,
      name: settings.nodeName,
      os: platform(),
      arch: arch(),
      version: VERSION,
      capabilities: ["copilot-acp", "host-yolo", HOST_URL_SYNC_CAPABILITY],
      maxSessions: settings.maxSessions,
      homeDir: homedir(),
    });
    const response = await fetch(new URL("/api/nodes/register", settings.hostUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Node registration failed (${response.status}): ${await response.text()}`,
      );
    }
    const result = (await response.json()) as { nodeId: string; secret: string };
    return {
      hostUrl: settings.hostUrl,
      nodeId: result.nodeId,
      secret: result.secret,
      name: settings.nodeName,
    };
  }

  connect();

  const heartbeatTimer = setInterval(() => {
    send({
      type: "heartbeat",
      activeSessionIds: router.activeSessionIds,
      sentAt: new Date().toISOString(),
    });
  }, 5_000);
  heartbeatTimer.unref();

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

  return { shutdown };
}

if (process.env.NODE_ENV !== "test") {
  const argv = process.argv.slice(2);
  // Usage and argument errors belong to the entry point: main() is also called
  // by tests, which must not have the process exit under them.
  try {
    if (parseNodeArgs(argv).wantsHelp) {
      console.log(USAGE);
      process.exit(0);
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const runtime = await main(argv);
  process.once("SIGINT", () => void runtime.shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void runtime.shutdown().finally(() => process.exit(0)));
}
