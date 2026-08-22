import { config as loadEnv } from "dotenv";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { connectDevTunnel, type DevTunnelConnection } from "./devtunnel.js";
import {
  HOST_URL_SYNC_CAPABILITY,
  HostToNodeMessageSchema,
  NODE_NAME_SYNC_CAPABILITY,
  NodeToHostMessageSchema,
  RegisterNodeSchema,
  SELF_UPDATE_CAPABILITY,
  SESSION_ACTIVITY_CAPABILITY,
  SESSION_CONFIG_CAPABILITY,
  decodeFrame,
  errorMessage,
  sameHostUrl,
  type NodeBackup,
  type NodeToHostMessage,
  type NodeUpdateStage,
  type SessionEvent,
} from "@fleet/protocol";
import { gitRevision, repoRoot } from "@fleet/protocol/runtime";
import { createLogBuffer } from "@fleet/protocol/log-buffer";
import { AcpAgentFactory, MockAgentFactory } from "./agents.js";
import { CliError, USAGE, argvForRestart, parseNodeArgs } from "./cli.js";
import {
  configDirectory,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "./config.js";
import { planCredentials } from "./enrollment.js";
import {
  adoptHostUrl,
  dialableInMode,
  endpointsAfterOperatorEdit,
  endpointsBehindLocalForward,
  firstDialUrl,
  nextHostUrl,
  promoteHostUrl,
  recordHostUrl,
  type HostEndpoints,
  type TunnelMode,
} from "./host-endpoints.js";
import { envFilePath, packageVersion } from "./paths.js";
import {
  AUTH_FAILED_CLOSE_CODE,
  SUPERSEDED_CLOSE_CODE,
  acquireInstanceLock,
  shouldReconnectAfterClose,
} from "./instance-lock.js";
import { CommandRouter, validateWorkspacePath } from "./router.js";
import { EventOutbox } from "./outbox.js";
import { closeQuietly, HOST_DIAL_TIMEOUT_MS, watchHostLiveness } from "./socket.js";
import { configServerPort, startConfigServer } from "./config-server.js";
import {
  loadSettings,
  needsReconnect,
  saveSettings,
  settingsOverridesFromEnv,
  SettingsSchema,
  type Settings,
} from "./settings.js";
import {
  RESTART_EXIT_CODE,
  RESTART_MODE_ENV,
  UPDATE_PARENT_PID_ENV,
  respawn,
  restartHandledBySupervisor,
  restartTarget,
  restartWouldRaceAWatcher,
  updateCheckout,
  waitForParentExit,
} from "./updater.js";

const VERSION = packageVersion();
const REVISION = gitRevision();
const NODE_CAPABILITIES = [
  "copilot-acp",
  "host-yolo",
  HOST_URL_SYNC_CAPABILITY,
  SELF_UPDATE_CAPABILITY,
  NODE_NAME_SYNC_CAPABILITY,
  SESSION_ACTIVITY_CAPABILITY,
  SESSION_CONFIG_CAPABILITY,
];
const RECONNECT_DELAY_MS = 2_000;
/**
 * Dials that never reached the Host before the tunnel is assumed dead.
 *
 * Three is roughly six seconds — long enough to ride out a Host restart or a
 * brief relay hiccup, short enough that a genuinely broken tunnel is rebuilt
 * while the operator is still looking at the screen.
 */
const UNREACHABLE_DIALS_BEFORE_RECYCLE = 3;

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

  /**
   * What this process has been saying, kept so the config page can show it.
   *
   * A node's console is on a machine the operator is usually not sitting at —
   * which is the whole problem with diagnosing one remotely. Everything that
   * goes to the console goes here too, so the page served from this machine can
   * answer "what happened just before it stopped working".
   */
  const logs = createLogBuffer();

  const startupLog = (message: string): void => {
    logs.record("info", message);
    console.log(`${new Date().toISOString()} [node] ${message}`);
  };

  /** Failures worth surfacing on the page, not just on a console nobody reads. */
  const errorLog = (message: string): void => {
    logs.record("error", message);
    console.error(message);
  };

  /**
   * A problem raised before the main `warn` exists.
   *
   * The tunnel comes up before settings are read, so its failures need somewhere
   * to go while the rest of the process is still being assembled.
   */
  const startupWarn = (message: string): void => {
    logs.record("warn", message);
    console.log(`${new Date().toISOString()} [node] ${message}`);
  };

  /**
   * A private Dev Tunnel has to be dialed through a local forward, so the
   * tunnel comes up before settings are read: the forwarded port is what the
   * host URL has to be, and it is only known once the CLI reports it. Writing
   * it into the flag overrides keeps it ahead of the stored settings, which
   * still hold whatever port a previous run happened to get.
   */
  let devTunnel: DevTunnelConnection | undefined;
  /**
   * Installed once settings exist. The tunnel is started before them — its
   * forwarded port is what the host URL has to be — so the handler cannot
   * close over `settings` at construction time.
   */
  let onTunnelUrlChanged: (url: string) => void = () => {};
  const devTunnelId = env.FLEET_DEVTUNNEL_ID;
  /**
   * Which addresses this node is willing to dial, for the whole run.
   *
   * Started with `--devtunnel` means the Host is reachable through one local
   * forward and nowhere else, so every other address on file — a public
   * `*.devtunnels.ms` URL, a named tunnel this node once used — is not a
   * fallback but a fast failure, and fast failures are what drive the recycler
   * into killing the forward. Fixed here rather than inferred per dial so the
   * rule cannot change under a reconnect.
   */
  const tunnelMode: TunnelMode = devTunnelId ? "devtunnel" : "direct";
  if (devTunnelId) {
    startupLog(`Connecting to dev tunnel ${devTunnelId}`);
    devTunnel = await connectDevTunnel(devTunnelId, {
      log: startupLog,
      // A tunnel that will not come up is the thing being debugged, so its
      // failures have to clear the page's problems-only filter.
      warn: startupWarn,
      onUrlChanged: (url) => onTunnelUrlChanged(url),
    });
    // Seeds the first run only. The stored address is adopted below instead of
    // being overwritten here, so the one this forward displaces survives as a
    // fallback rather than being lost with the tunnel that replaced it.
    env.FLEET_HOST_URL ??= devTunnel.url;
    process.once("exit", () => devTunnel?.stop());
  }

  let settings = await loadSettings(env, settingsOverridesFromEnv(flags.env));
  if (devTunnel) {
    settings = endpointsBehindLocalForward(settings, devTunnel.url);
  }

  // A respawned tunnel can land on a different port. Without following it the
  // node keeps dialing the old one, which nothing is listening on any more.
  onTunnelUrlChanged = (url) => {
    // Not an operator edit: this is the same Host arriving on a new local port,
    // so the addresses this node has reached it on before stay on the list.
    void applySettings(endpointsBehindLocalForward(settings, url), {
      operatorEdit: false,
    }).catch((error: unknown) => {
      errorLog(`Failed to follow the dev tunnel: ${errorMessage(error)}`);
    });
  };

  const mockAgent = env.FLEET_MOCK_AGENT === "1";

  const log = (message: string): void => {
    logs.record("info", message);
    console.log(`${new Date().toISOString()} [node] ${message}`);
  };

  /** A problem the page should show without the operator opening a terminal. */
  const warn = (message: string): void => {
    logs.record("warn", message);
    console.log(`${new Date().toISOString()} [node] ${message}`);
  };

  log(`copilot-fleet node ${VERSION}${REVISION ? ` (${REVISION})` : ""} starting`);
  log(`  name        ${settings.nodeName}`);
  log(`  host        ${settings.hostUrl}`);
  if (devTunnelId) log(`  route       dev tunnel ${devTunnelId} (exclusive)`);
  log(`  agent       ${mockAgent ? "mock" : "copilot --acp"}`);
  log(`  permissions ${mockAgent ? "n/a" : "per session (Host decides)"}`);
  log(`  capacity    ${settings.maxSessions} concurrent sessions`);
  if (!mockAgent) log(`  context     ${settings.contextTier}`);
  log(`  config      ${configDirectory()}`);
  const overridden = Object.keys(flags.env);
  // Naming the keys (never the values — one of them is a token) explains why
  // this run disagrees with the config page.
  if (overridden.length > 0) log(`  overrides   ${overridden.join(", ")} (command line)`);

  // A process started by an update inherits the lock from the one it replaces,
  // so it has to let that one finish exiting first. Without this the successor
  // loses the race it was guaranteed to win and the machine ends up with no
  // Node running at all.
  const parentPid = Number(env[UPDATE_PARENT_PID_ENV]);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    log(`Waiting for the process this update replaces (pid ${parentPid}) to exit`);
    const exited = await waitForParentExit(parentPid);
    log(
      exited
        ? "Predecessor exited; taking over"
        : "Predecessor outlived its grace period; continuing",
    );
  }

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
  let dialUrl = firstDialUrl(settings, credentials.hostUrl, tunnelMode);
  /** Consecutive dials that never produced a welcome; see the close handler. */
  let unreachableDials = 0;
  /** Whether this outage has already reported that there is nowhere to rotate. */
  let strandedReported = false;

  const factory = mockAgent
    ? new MockAgentFactory()
    : new AcpAgentFactory(
        settings.permissionTimeoutMs,
        settings.copilotCommand,
        settings.contextTier,
      );
  let socket: WebSocket | undefined;
  /**
   * Stops the liveness watchdog on whichever socket is current.
   *
   * Held out here rather than beside the socket because the socket can be
   * abandoned without ever closing: retargeting a node drops the listeners
   * first, so the watchdog's own `close` hook is exactly what does not run.
   */
  let stopLiveness: () => void = () => {};
  const releaseLiveness = (): void => {
    stopLiveness();
    stopLiveness = () => {};
  };
  let shuttingDown = false;
  let updating = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  const outbox = new EventOutbox();
  const router = new CommandRouter(
    factory,
    settings.maxSessions,
    (event) => {
      // Held rather than dropped when the Host is unreachable: the agent keeps
      // working through a Host restart, and these are the only record of it.
      if (!sendEvent(event)) outbox.add(event);
    },
    validateWorkspacePath,
    () => settings.hostUrl,
  );

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
   *
   * `operatorEdit` is what decides whether the learned fallbacks survive. A
   * person typing a new address is repointing this machine at a different Host,
   * and every fallback was learned from the old one; a tunnel reporting a new
   * local port is the same Host seen through a rebuilt forward, and dropping
   * the addresses it can also be reached at is exactly how a node ends up with
   * one dead port and nothing else to try.
   */
  async function applySettings(
    next: Settings,
    { operatorEdit = true }: { operatorEdit?: boolean } = {},
  ): Promise<void> {
    const previous = settings;
    const settled = operatorEdit ? endpointsAfterOperatorEdit(previous, next) : next;
    settings = settled;
    await saveSettings(settled);
    router.setMaxSessions(settled.maxSessions);
    if (factory instanceof AcpAgentFactory) {
      factory.configure(
        settled.permissionTimeoutMs,
        settled.copilotCommand,
        settled.contextTier,
      );
    }
    if (!needsReconnect(previous, settled)) {
      log("Settings updated; no reconnect needed");
      return;
    }
    log(`Settings changed; reconnecting to ${settled.hostUrl}`);
    credentials = await ensureCredentials();
    reconnect();
  }

  /**
   * Takes over this process as the imported machine: stop local agents, write
   * both identity files, and dial the Host as that node.
   */
  async function applyBackup(archive: NodeBackup): Promise<void> {
    await router.stopAll();
    credentials = archive.credentials;
    settings = SettingsSchema.parse(archive.settings);
    await saveCredentials(credentials);
    await saveSettings(settings);
    router.setMaxSessions(settings.maxSessions);
    if (factory instanceof AcpAgentFactory) {
      factory.configure(
        settings.permissionTimeoutMs,
        settings.copilotCommand,
        settings.contextTier,
      );
    }
    log(
      `Imported node identity ${credentials.nodeId}; reconnecting to ${settings.hostUrl}`,
    );
    reconnect();
  }

  /** Drops the current socket so the next connect uses the latest credentials. */
  function reconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    dialUrl = firstDialUrl(settings, credentials.hostUrl, tunnelMode);
    const current = socket;
    socket = undefined;
    // Removing listeners first stops the close handler from scheduling its own
    // retry against the URL we are moving away from.
    current?.removeAllListeners();
    // Which also removes the hook that would have retired the watchdog, so it
    // is retired here instead of being left pinging a socket nobody holds.
    releaseLiveness();
    if (current) closeQuietly(current);
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
   * Adopts the name the Host says it has for this node.
   *
   * Sent when a browser renames the machine, and when the Host refuses a rename
   * proposed from here because another node already answers to it. Both files
   * are written: settings.json is what the config page shows, and node.json is
   * what the next `hello` reports as the last name synced with the Host —
   * leaving that stale would make the next reconnect propose the rename again.
   */
  async function applyAnnouncedName(name: string): Promise<void> {
    if (name === settings.nodeName && name === credentials.name) return;
    const previous = settings.nodeName;
    settings = { ...settings, nodeName: name };
    await saveSettings(settings);
    credentials = { ...credentials, name };
    await saveCredentials(credentials);
    if (previous !== name) log(`Host renamed this node "${previous}" -> "${name}"`);
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
    // Recorded but not followed when it belongs to the other tunnel mode. A
    // node behind its own `devtunnel connect` reaches the Host on one loopback
    // port; being moved to the public URL of that same tunnel would send it to
    // a Microsoft login it cannot answer, and it would then be unreachable for
    // a correction. Keeping the address means a node whose mode changes later
    // still knows where the Host lives.
    if (!dialableInMode(hostUrl, tunnelMode)) {
      await persistEndpoints(recordHostUrl(settings, hostUrl));
      log(
        `Host announced ${hostUrl}; noted it, but this node reaches the Host over its own ${tunnelMode} route and stays on ${settings.hostUrl}`,
      );
      return;
    }
    const moved = adoptHostUrl(settings, hostUrl);
    await persistEndpoints(moved);
    dialUrl = moved.hostUrl;
    log(
      `Host moved to ${moved.hostUrl}; this connection stays up and the next one uses it`,
    );
  }

  /**
   * Pulls, rebuilds and restarts this Node on the Host's instruction.
   *
   * The build runs before anything is torn down, so a checkout that fails to
   * compile leaves the machine exactly as it was — connected and running the
   * code it already had — instead of exiting into a broken tree that nobody is
   * there to fix.
   */
  async function runSelfUpdate(updateId: string): Promise<void> {
    if (updating) {
      report("failed", "An update is already running");
      return;
    }
    updating = true;
    const root = repoRoot();
    log(`Self-update requested; using checkout ${root}`);
    try {
      const outcome = await updateCheckout({ repoRoot: root, report });
      if (outcome.action === "failed") {
        log(`Self-update failed: ${outcome.reason}`);
        report("failed", outcome.reason);
        return;
      }
      if (outcome.action === "none") {
        log(`Self-update: ${outcome.reason}`);
        report("up_to_date", outcome.reason);
        return;
      }
      log(`Updated to ${outcome.revision}; restarting`);
      const supervised = restartHandledBySupervisor(env);
      if (restartWouldRaceAWatcher(env)) {
        // The new build is on disk and compiles; only the restart is declined.
        // Launching a successor here would hand it to a race it cannot win
        // against the watcher's own child, which reports success and leaves the
        // machine running the build the update just replaced. Saying so plainly
        // costs one manual restart and is true.
        log("Updated, but a file watcher owns this process; not restarting");
        report(
          "failed",
          `Updated to ${outcome.revision}, but this Node runs under a file watcher, which cannot restart it. ` +
            `Stop this terminal and start it again with "npm run node" to run the new build under the supervisor.`,
        );
        return;
      }
      const scriptPath = supervised ? undefined : restartTarget(root, process.argv[1]);
      if (!supervised && !scriptPath) {
        // Nothing to re-launch: the new build is on disk but this process
        // cannot name itself, so staying up is better than exiting into a
        // machine with no Node on it.
        report(
          "failed",
          "Updated, but this process could not identify its own entry point; restart it by hand",
        );
        return;
      }
      // Sent before the process goes, because nothing can be reported from the
      // other side of an exit.
      report("restarting", `Updated to ${outcome.revision}; restarting`);
      // The successor reads settings.json rather than inheriting the flags this
      // process was started with, so what is in memory now has to be on disk
      // before it looks. Without this a node whose address was corrected from
      // the config page comes back on the address it was launched with.
      await saveSettings(settings);
      if (supervised) {
        log(`Exiting for the supervisor to restart (${RESTART_MODE_ENV}=exit)`);
      } else {
        const restartArgs = argvForRestart(argv);
        const dropped = argv.length - restartArgs.length;
        if (dropped > 0) {
          log(
            `Restarting from saved settings; ${dropped} launch flag(s) superseded by settings.json`,
          );
        }
        log(`Launching ${scriptPath}`);
        const logPath = join(configDirectory(), "node.log");
        log(`Its output goes to ${logPath}; this terminal stops here`);
        respawn(root, scriptPath!, restartArgs, logPath);
      }
      await shutdown();
      releaseInstanceLock();
      // A supervisor has to be able to tell an update apart from a stop, or
      // Ctrl-C would bring the Node straight back. The successor of an
      // unsupervised restart is already running, so this one just leaves.
      process.exit(supervised ? RESTART_EXIT_CODE : 0);
    } finally {
      updating = false;
    }

    function report(stage: NodeUpdateStage, detail: string): void {
      send({ type: "update_status", updateId, stage, detail });
    }
  }

  /** Remembers the address that worked, so the next start leads with it. */ async function promoteDialUrl(): Promise<void> {
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
      ...(devTunnelId
        ? { devTunnel: { id: devTunnelId, url: devTunnel?.url ?? "" } }
        : {}),
    }),
    applySettings,
    getCredentials: () => credentials,
    applyBackup,
    log,
    // Offered only when there is a tunnel to rebuild, so the page can hide a
    // control that could not do anything on a node dialing the Host directly.
    ...(devTunnel ? { rebuildDevTunnel: () => devTunnel?.rebuildNow() } : {}),
    recentLogs: () => logs.entries(),
    port: configServerPort(env),
  });

  function connect(): void {
    const auth = credentials;
    const url = new URL("/ws/node", dialUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    log(`Connecting to ${url}`);
    // Bounded, because an unanswered dial is the one failure this loop cannot
    // see: a dev tunnel whose relay is gone still accepts the connection, and
    // without a deadline the node waits on it for the operating system's whole
    // retransmission budget instead of failing and rebuilding the tunnel.
    const active = new WebSocket(url, { handshakeTimeout: HOST_DIAL_TIMEOUT_MS });
    const attemptUrl = dialUrl;
    // Distinguishes "this address does not reach the Host" from "the Host hung
    // up on us", which is what decides whether to try a different address.
    let welcomed = false;
    // A dial that replaces one still in flight must not leave its watchdog
    // behind; the only socket worth watching is the one being opened here.
    releaseLiveness();
    socket = active;
    // Registered before the close handler below so the watchdog is gone before
    // anything decides what to do about the disconnection.
    active.once("close", () => {
      if (socket === active) releaseLiveness();
    });
    active.on("open", () => {
      stopLiveness = watchHostLiveness(active, {
        onDead: (silentMs) =>
          warn(
            `Host stopped answering for ${Math.round(silentMs / 1000)}s; dropping the connection so it can be rebuilt`,
          ),
      });
      send({
        type: "hello",
        nodeId: auth.nodeId,
        secret: auth.secret,
        os: platform(),
        arch: arch(),
        version: VERSION,
        revision: REVISION,
        capabilities: [...NODE_CAPABILITIES, mockAgent ? "mock" : "real"],
        maxSessions: settings.maxSessions,
        homeDir: homedir(),
        name: settings.nodeName,
        // What the Host last told us it has. A difference from `name` is an
        // operator edit here; a difference from the Host's row means the Host
        // was renamed while this node was away, and the Host wins.
        knownName: auth.name,
        activeSessionIds: router.activeSessionIds,
        // What each of those is doing. Without it the Host assumes idle, and a
        // socket that drops mid-turn leaves the UI offering a composer over an
        // agent that cannot take another prompt.
        busySessionIds: router.busySessionIds,
      });
    });
    active.on("message", async (raw: unknown) => {
      const frame = decodeFrame(String(raw), HostToNodeMessageSchema);
      if (!frame.ok) {
        errorLog(`Rejected Host message: ${frame.detail}`);
        active.close(frame.code, frame.reason);
        return;
      }
      if (frame.value.type === "welcome") {
        welcomed = true;
        log(`Authenticated with Host, waiting for commands`);
        await promoteDialUrl();
        flushOutbox();
        return;
      }
      if (frame.value.type === "host_url") {
        await applyAnnouncedHostUrl(frame.value.hostUrl);
        return;
      }
      if (frame.value.type === "node_name") {
        await applyAnnouncedName(frame.value.name);
        return;
      }
      if (frame.value.type === "update_node") {
        await runSelfUpdate(frame.value.updateId);
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
        fatal: result.fatal ?? true,
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
          errorLog(`Re-enrollment failed: ${errorMessage(error)}`);
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
        const candidate = nextHostUrl(settings, attemptUrl, tunnelMode);
        if (!sameHostUrl(candidate, attemptUrl)) {
          log(`No Host at ${attemptUrl}; trying ${candidate} next`);
          dialUrl = candidate;
          strandedReported = false;
        } else if (!strandedReported) {
          // Rotation that has nowhere to go looks exactly like rotation that
          // has not started yet: both print nothing. A node down to its last
          // address then retries it every two seconds in silence, and the only
          // way to tell that apart from an ordinary outage is to know that the
          // "trying X next" line is missing — which is not something a log
          // should ask of whoever is reading it at the time.
          strandedReported = true;
          warn(
            tunnelMode === "devtunnel"
              ? `No Host at ${attemptUrl}, which is the only address a node behind \`devtunnel connect ${devTunnelId}\` can use — retrying it while the tunnel is rebuilt. Check that the Host is hosting that tunnel.`
              : `No Host at ${attemptUrl}, and it is the only address this node knows — retrying it until the Host returns. Add another Host URL on the node config page to give this node somewhere to fall back to.`,
          );
        }
        // Repeated silence from a dev tunnel's forwarded port is the only
        // reliable sign that the tunnel died: its local listener keeps
        // accepting connections after the far end is gone, so the client
        // neither exits nor logs, and only this end can tell. Rebuilding it
        // here is what stops an overnight outage from needing a manual restart.
        unreachableDials += 1;
        if (devTunnel && unreachableDials >= UNREACHABLE_DIALS_BEFORE_RECYCLE) {
          unreachableDials = 0;
          devTunnel.recycle();
        }
      } else {
        unreachableDials = 0;
        strandedReported = false;
      }
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
    active.on("error", (error) => {
      errorLog(`Host connection error: ${error.message}`);
    });
  }

  function send(message: NodeToHostMessage): void {
    NodeToHostMessageSchema.parse(message);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  /** Reports whether the event actually left, so the caller can hold it if not. */
  function sendEvent(event: SessionEvent): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(NodeToHostMessageSchema.parse({ type: "event", event })));
    return true;
  }

  /**
   * Delivers what the agents produced while the Host was away.
   *
   * Runs on `welcome` rather than on `open`, because the Host discards anything
   * that arrives before it has authenticated the hello.
   */
  function flushOutbox(): void {
    if (outbox.size === 0) return;
    const held = outbox.size;
    const { sent, dropped } = outbox.flush(sendEvent);
    log(
      `Delivered ${sent}/${held} event(s) buffered while the Host was unreachable` +
        (dropped > 0 ? `; ${dropped} older one(s) were dropped for capacity` : ""),
    );
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
      revision: REVISION,
      capabilities: NODE_CAPABILITIES,
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
      busySessionIds: router.busySessionIds,
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
    releaseLiveness();
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
