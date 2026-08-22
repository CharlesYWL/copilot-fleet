import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { errorMessage } from "@fleet/protocol";
import { cachedGitRevision } from "./host-revision.js";
import { OperatorAuth, PASSWORD_SETTING_KEY, SESSION_KEY_SETTING } from "./auth.js";
import {
  resolveDatabasePath,
  resolveEnrollmentHostUrl,
  resolveEnrollmentToken,
  resolvePublicHostUrl,
} from "./config.js";
import { FleetService } from "./fleet-service.js";
import { registerBrowserGateway } from "./gateway/browser-socket.js";
import { registerNodeGateway } from "./gateway/node-socket.js";
import { startHostUrlMonitor } from "./host-url.js";
import { envFilePath, packageVersion } from "./paths.js";
import { startPresenceMonitor } from "./presence.js";
import { OrchestratorEngine } from "./orchestrator/engine.js";
import { LeadTokens } from "./orchestrator/lead-tokens.js";
import { MCP_PATH, mcpRoutes } from "./orchestrator/mcp-routes.js";
import { startRunDeadlineMonitor } from "./orchestrator/deadlines.js";
import { registerRequestGuard } from "./request-guard.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { nodeRoutes } from "./routes/nodes.js";
import { sessionRoutes } from "./routes/sessions.js";
import { runRoutes } from "./routes/runs.js";
import { orchestratorRoutes } from "./routes/orchestrators.js";
import { systemRoutes } from "./routes/system.js";
import { FleetStore } from "./store.js";
import { TunnelSupervisor } from "./tunnel.js";
import { recordingLogStream } from "./log-stream.js";
import { createLogBuffer } from "@fleet/protocol/log-buffer";

loadEnv({ path: envFilePath(), quiet: true });

const VERSION = packageVersion();

export {
  resolveDatabasePath,
  resolveEnrollmentHostUrl,
  resolveEnrollmentToken,
  resolvePublicHostUrl,
} from "./config.js";
export { yoloUnsupportedReason } from "./session-policy.js";

/**
 * Wires the Host together: store, service, routes, gateways, presence sweep.
 *
 * The behaviour itself lives in the modules registered below — this stayed a
 * closure only so that everything sharing one store also shares one lifetime,
 * which is what makes `app.inject()` tests possible against an in-memory DB.
 */
export async function buildServer(
  options: {
    databasePath?: string;
    enrollmentToken?: string;
    /**
     * The operator password. Defaults to `FLEET_OPERATOR_PASSWORD`, and to one
     * generated on first boot when neither is set.
     */
    operatorPassword?: string;
  } = {},
): Promise<FastifyInstance> {
  const logs = createLogBuffer();
  const app = Fastify({ logger: { stream: recordingLogStream(logs) } });
  const store = new FleetStore(
    options.databasePath ?? resolveDatabasePath(process.env.DATABASE_PATH),
  );
  store.resetConnectivity();
  const enrollment = {
    token: resolveRuntimeEnrollmentToken(store, options.enrollmentToken),
  };
  const auth = new OperatorAuth({
    getStoredHash: () => store.getSetting(PASSWORD_SETTING_KEY),
    setStoredHash: (hash) => store.setSetting(PASSWORD_SETTING_KEY, hash),
    // Persisted so a restart does not sign the operator out. In development the
    // Host restarts on every file save, which made that constant.
    getSessionKey: () => store.getSetting(SESSION_KEY_SETTING),
    setSessionKey: (key) => store.setSetting(SESSION_KEY_SETTING, key),
    configuredPassword: options.operatorPassword ?? process.env.FLEET_OPERATOR_PASSWORD,
    // Info rather than warn: the buffer behind /api/logs keeps warnings and
    // errors, and this is the one line that must never be readable over HTTP.
    announce: (password) =>
      app.log.info(
        `No FLEET_OPERATOR_PASSWORD set, so this Host generated one. Sign in with: ${password}`,
      ),
  });
  const service = new FleetService(store, app.log, cachedGitRevision());
  const heartbeatTimeoutMs = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 15_000);
  const listenPort = process.env.PORT ?? "8787";

  const tunnel = new TunnelSupervisor({
    localTarget: `http://127.0.0.1:${listenPort}`,
    onEnabledCleared: () => store.setTunnelEnabled(false),
    persistedTunnelId: {
      get: (provider) => store.getSetting(`tunnel.${provider}.id`),
      set: (provider, id) => store.setSetting(`tunnel.${provider}.id`, id),
    },
  });
  tunnel.setPrimary(store.getTunnelProvider());

  const fallbackPublicUrl = () =>
    resolvePublicHostUrl(
      process.env.FLEET_PUBLIC_URL || store.getSetting("host.publicUrl"),
      process.env.HOST,
      process.env.PORT,
    );
  const enrollmentHostUrl = () =>
    resolveEnrollmentHostUrl(tunnel.activeTunnelUrl(), fallbackPublicUrl());
  /**
   * What a node already running should be told to dial.
   *
   * Narrower than the enrollment URL on purpose: a private tunnel is a fine
   * thing to advertise on the Connect card, which comes with the command to
   * reach it, and a catastrophic thing to push to a live node, which would
   * follow it into a login it cannot answer and go silent.
   */
  const broadcastHostUrl = () =>
    resolveEnrollmentHostUrl(tunnel.broadcastTunnelUrl(), fallbackPublicUrl());

  // Nodes reached over a path that outlives a tunnel rotation — a LAN address,
  // a named tunnel — are told where the Host moved to, so they follow it
  // instead of dialing an address that stopped existing.
  const hostUrlMonitor = startHostUrlMonitor(broadcastHostUrl, (hostUrl) =>
    service.broadcastHostUrl(hostUrl),
  );
  // Registered before the routes: a child plugin context inherits the error
  // handler that was in place when it was created, so setting it afterwards
  // would leave every route on Fastify's default 500.
  app.setErrorHandler((error, _request, reply) => {
    const status = hasIssues(error) ? 400 : getStatusCode(error);
    reply.code(status).send({ error: errorMessage(error, "Internal server error") });
  });

  await app.register(websocket);
  registerRequestGuard(app, {
    store,
    auth,
    allowlist: {
      extra: process.env.FLEET_ALLOWED_HOSTS,
      publicUrl: () => process.env.FLEET_PUBLIC_URL || store.getSetting("host.publicUrl"),
      tunnelUrls: () => tunnel.allTunnelUrls(),
    },
  });
  await app.register(authRoutes, { auth });
  await app.register(systemRoutes, {
    service,
    tunnel,
    version: VERSION,
    enrollment,
    fallbackPublicUrl,
    enrollmentHostUrl,
    recentLogs: () => logs.entries(),
  });
  await app.register(nodeRoutes, { service, enrollment });
  await app.register(catalogRoutes, { service });
  await app.register(sessionRoutes, { service });

  /*
   * Constructed after the service and subscribed to its events, so the engine
   * reacts to the same facts browsers do. The dependency only points this way:
   * FleetService knows nothing about orchestration, and this file is the one
   * place that knows both halves.
   */
  const engine = new OrchestratorEngine(service);
  service.onSessionEvent((event) => engine.handleSessionEvent(event));

  /**
   * The orchestrator's tools reach the Host over its own HTTP MCP endpoint,
   * which means the Node has to be able to dial it. The Host names the path;
   * the Node resolves it against the address it is connected on.
   */
  const leadTokens = new LeadTokens(store);
  service.attachOrchestration({
    leadTokens,
    /*
     * Only the path here really matters: the Node rebases this onto the address
     * it is actually connected on, because it knows which one works from where
     * it stands and the Host does not. The rest is still resolved the way
     * enrollment is, so the value is a sensible one to read in a log or hand to
     * anything that has no better idea.
     */
    mcpUrl: () => new URL(MCP_PATH, enrollmentHostUrl()).toString(),
    tickRun: (runId) => engine.tickRun(runId),
  });
  await app.register(mcpRoutes, { service, tokens: leadTokens });
  await app.register(runRoutes, { service, engine });
  await app.register(orchestratorRoutes, { service, engine });

  registerBrowserGateway(app, service);
  registerNodeGateway(app, service);
  const presenceTimer = startPresenceMonitor(service, heartbeatTimeoutMs);
  // Timeouts are the absence of events; without a clock nothing would ever
  // notice one. See the monitor for why this is not the busy-wait the design
  // rules out.
  const runDeadlineTimer = startRunDeadlineMonitor(engine);

  const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
  if (existsSync(uiRoot)) {
    await app.register(fastifyStatic, { root: uiRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/ws/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onReady", () => {
    // Restores every provider the operator left switched on, not just one: they
    // run concurrently, so bringing back a single "current" tunnel would
    // silently drop the others across a restart.
    for (const provider of store.getEnabledTunnelProviders()) {
      void tunnel
        .setEnabled(provider, true, provider === store.getTunnelProvider())
        .catch((error) => {
          store.setTunnelProviderEnabled(provider, false);
          app.log.error({ err: error, provider }, "Failed to restore tunnel");
        });
    }
  });

  app.addHook("onClose", async () => {
    clearInterval(presenceTimer);
    clearInterval(runDeadlineTimer);
    clearInterval(hostUrlMonitor);
    await tunnel.stop();
    service.shutdown();
    store.close();
  });
  return app;
}

function hasIssues(value: unknown): value is { issues: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "issues" in value &&
    Array.isArray(value.issues)
  );
}

/**
 * Tests pass a token explicitly; a moved Host reads the one restored into the
 * database; a first boot falls through to the environment.
 */
function resolveRuntimeEnrollmentToken(
  store: FleetStore,
  optionsToken: string | undefined,
): string {
  if (optionsToken) return resolveEnrollmentToken(optionsToken, process.env.NODE_ENV);
  const stored = store.getSetting("enrollment.token");
  if (stored) return stored;
  return resolveEnrollmentToken(process.env.ENROLLMENT_TOKEN, process.env.NODE_ENV);
}

function getStatusCode(value: unknown): number {
  if (
    typeof value === "object" &&
    value !== null &&
    "statusCode" in value &&
    typeof value.statusCode === "number"
  ) {
    return value.statusCode;
  }
  return 500;
}

if (process.env.NODE_ENV !== "test") {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
}
