import { config as loadEnv } from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { errorMessage } from "@fleet/protocol";
import { cachedGitRevision } from "./host-revision.js";
import { defaultSecureDataDeps, secureHostDataFiles } from "./data-permissions.js";
import { FleetAuth } from "./auth/service.js";
import { EnrollmentGrants } from "./auth/enrollment-grants.js";
import { HostIdentityService } from "./auth/host-identity.js";
import { NodeEnrollment } from "./auth/node-enrollment.js";
import {
  BUILT_IN_ENTRA_CONFIG,
  type EntraConfig,
  type EntraProvider,
} from "./auth/entra.js";
import {
  BrowserSessionRegistry,
  SESSION_REVALIDATION_MS,
} from "./gateway/browser-registry.js";
import {
  resolveDatabasePath,
  resolveEnrollmentHostUrl,
  resolveLegacyEnrollmentToken,
  resolvePublicHostUrl,
  type LegacyEnrollment,
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
import { portableBackupRoutes } from "./routes/portable-backup.js";
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
  resolveLegacyEnrollmentToken,
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
     * The operator password. Defaults to `FLEET_OPERATOR_PASSWORD`.
     *
     * A Host given neither generates nothing: password sign-in is a migration
     * escape hatch now, not the default way in.
     */
    operatorPassword?: string;
    /**
     * Where the one-time claim code is written.
     *
     * Defaults to stdout directly rather than through the logger, because the
     * logger's buffer is served over HTTP at `/api/logs` and this is the one
     * string that must never be readable that way.
     */
    announceClaimCode?: (code: string) => void;
    /** Injected in tests; production builds the MSAL-backed provider. */
    entraProvider?: (config: EntraConfig) => EntraProvider;
    /** Tests opt in explicitly; real local and production Hosts use it by default. */
    useBuiltInEntra?: boolean;
  } = {},
): Promise<FastifyInstance> {
  const logs = createLogBuffer();
  const app = Fastify({ logger: { stream: recordingLogStream(logs) } });
  const store = new FleetStore(
    options.databasePath ?? resolveDatabasePath(process.env.DATABASE_PATH),
    {
      // The Host database holds this Host's private key and its administrator
      // table, so what the filesystem says about it is part of the security
      // boundary rather than a detail of where it happens to live.
      secureFiles: (databasePath) =>
        secureHostDataFiles(
          databasePath,
          defaultSecureDataDeps((message) => app.log.warn(message)),
        ),
    },
  );
  store.resetConnectivity();
  const enrollment: LegacyEnrollment = {
    token: resolveRuntimeEnrollmentToken(store, options.enrollmentToken),
  };
  // Written only when there is one. A fresh Host must not leave a fleet-wide
  // credential in its settings table for a path it does not accept.
  if (enrollment.token) store.setSetting("enrollment.token", enrollment.token);
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

  /*
   * Bound after the auth service so a revocation can reach the live sockets,
   * and constructed before it so the service can call into it. The lookup is
   * the database rather than a cached copy, so a row changed by any path — a
   * removal, a logout, an expiry — is what the timer sees.
   */
  const browsers: BrowserSessionRegistry = new BrowserSessionRegistry({
    lookup: (tokenHash) => {
      const session = auth.sessions.inspect(tokenHash);
      if (!session) return undefined;
      return {
        administratorId: session.administratorId,
        expiresAt: session.expiresAt,
      };
    },
  });

  const auth = new FleetAuth({
    store,
    configuredPassword: options.operatorPassword ?? process.env.FLEET_OPERATOR_PASSWORD,
    envEntra:
      process.env.FLEET_ENTRA_TENANT_ID && process.env.FLEET_ENTRA_CLIENT_ID
        ? {
            tenantId: process.env.FLEET_ENTRA_TENANT_ID,
            clientId: process.env.FLEET_ENTRA_CLIENT_ID,
          }
        : (options.useBuiltInEntra ?? process.env.NODE_ENV !== "test")
          ? BUILT_IN_ENTRA_CONFIG
          : undefined,
    announceClaimCode:
      options.announceClaimCode ??
      ((code) =>
        process.stdout.write(
          `\nCopilot Fleet is unclaimed. Claim it at ${fallbackPublicUrl()} with this one-time code:\n\n    ${code}\n\nIt expires in 30 minutes and is printed only here.\n\n`,
        )),
    warn: (message) => app.log.warn(message),
    externalScheme: {
      publicUrl: () => process.env.FLEET_PUBLIC_URL || store.getSetting("host.publicUrl"),
      tunnels: () => tunnel.allTunnelEndpoints(),
    },
    ...(options.entraProvider ? { entraProvider: options.entraProvider } : {}),
    onSessionsRevoked: (revoked) =>
      browsers.revokeSessions(revoked.map((row) => row.tokenHash)),
    onAdministratorRemoved: (administratorId) =>
      browsers.revokeAdministrator(administratorId),
  });
  const service = new FleetService(store, app.log, cachedGitRevision());
  const leadTokens = new LeadTokens(store);
  /*
   * Minted on the first boot that needs one and kept for the life of the fleet:
   * every enrolled Node has pinned this fingerprint, so a Host that came back
   * with a different identity would be a Host none of its machines will speak to.
   */
  const hostIdentity = new HostIdentityService(store);
  const enrollmentGrants = new EnrollmentGrants({ store });
  const nodeEnrollment = new NodeEnrollment({
    store,
    identity: hostIdentity,
    grants: enrollmentGrants,
    audit: (entry) => auth.audit(entry),
  });
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
  await app.register(authRoutes, {
    auth,
    loopbackCallbackOrigin: `http://localhost:${listenPort}`,
    ...(process.env.npm_lifecycle_event === "dev"
      ? { uiOrigin: "http://localhost:5173" }
      : {}),
  });
  await app.register(systemRoutes, {
    service,
    tunnel,
    version: VERSION,
    enrollment,
    auth,
    identity: hostIdentity,
    grants: enrollmentGrants,
    fallbackPublicUrl,
    enrollmentHostUrl,
    recentLogs: () => logs.entries(),
  });
  await app.register(nodeRoutes, {
    service,
    enrollment,
    nodeEnrollment,
    // "Owned by somebody", not "owned by a Microsoft identity": a Host still
    // running on a migration password can enrol machines as it always could.
    enrollable: () => {
      const state = auth.state();
      return state !== "unclaimed" && state !== "entra-unconfigured";
    },
  });
  await app.register(portableBackupRoutes, {
    service,
    auth,
    enrollment,
    enrollmentHostUrl,
    leadTokens,
    identity: hostIdentity,
  });
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
  await app.register(mcpRoutes, {
    service,
    tokens: leadTokens,
    // A refused tool call is a security event: the endpoint is reachable
    // through whatever tunnel this Host is published on, so a run of them is
    // something an administrator has to be able to see.
    audit: (entry) => auth.audit(entry),
  });
  await app.register(runRoutes, { service, engine });
  await app.register(orchestratorRoutes, { service, engine });

  registerBrowserGateway(app, { service, auth, registry: browsers });
  registerNodeGateway(app, service, { identity: hostIdentity });
  const presenceTimer = startPresenceMonitor(service, heartbeatTimeoutMs);
  // Timeouts are the absence of events; without a clock nothing would ever
  // notice one. See the monitor for why this is not the busy-wait the design
  // rules out.
  const runDeadlineTimer = startRunDeadlineMonitor(engine);
  /*
   * A socket authorised an hour ago is not authorised now just because nobody
   * has said otherwise. Revocation closes matching sockets immediately; this
   * catches what immediacy cannot know about — an idle session lapsing, a row
   * changed by another process — and prunes the sessions nothing can use.
   */
  const sessionTimer = setInterval(() => {
    browsers.revalidate();
    auth.sessions.pruneExpired();
  }, SESSION_REVALIDATION_MS);
  sessionTimer.unref?.();

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
    clearInterval(sessionTimer);
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
 * database; an upgrade with legacy machines gets one minted; a fresh install
 * gets none, because it enrols with one-time grants instead.
 */
function resolveRuntimeEnrollmentToken(
  store: FleetStore,
  optionsToken: string | undefined,
): string | undefined {
  return resolveLegacyEnrollmentToken({
    explicit: optionsToken,
    stored: store.getSetting("enrollment.token") || undefined,
    env: process.env.ENROLLMENT_TOKEN,
    legacyNodes: store.nodeAuthenticationSummary().legacy,
    nodeEnv: process.env.NODE_ENV,
    generate: () => randomBytes(32).toString("base64url"),
  });
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
