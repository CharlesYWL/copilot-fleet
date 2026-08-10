import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { errorMessage } from "@fleet/protocol";
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
import { envFilePath } from "./paths.js";
import { startPresenceMonitor } from "./presence.js";
import { catalogRoutes } from "./routes/catalog.js";
import { nodeRoutes } from "./routes/nodes.js";
import { sessionRoutes } from "./routes/sessions.js";
import { systemRoutes } from "./routes/system.js";
import { FleetStore } from "./store.js";
import { TunnelManager } from "./tunnel.js";

loadEnv({ path: envFilePath(), quiet: true });

const VERSION = "0.1.0";

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
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const enrollmentToken = resolveEnrollmentToken(
    options.enrollmentToken ?? process.env.ENROLLMENT_TOKEN,
    process.env.NODE_ENV,
  );
  const store = new FleetStore(
    options.databasePath ?? resolveDatabasePath(process.env.DATABASE_PATH),
  );
  store.resetConnectivity();
  const service = new FleetService(store, app.log);
  const heartbeatTimeoutMs = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 15_000);
  const listenPort = process.env.PORT ?? "8787";

  const tunnel = new TunnelManager({
    localTarget: `http://127.0.0.1:${listenPort}`,
    onEnabledCleared: () => store.setTunnelEnabled(false),
  });
  void tunnel.setEnabled(false, store.getTunnelProvider());

  const fallbackPublicUrl = () =>
    resolvePublicHostUrl(
      process.env.FLEET_PUBLIC_URL,
      process.env.HOST,
      process.env.PORT,
    );
  const enrollmentHostUrl = () =>
    resolveEnrollmentHostUrl(tunnel.activeTunnelUrl(), fallbackPublicUrl());

  // Nodes reached over a path that outlives a tunnel rotation — a LAN address,
  // a named tunnel — are told where the Host moved to, so they follow it
  // instead of dialing an address that stopped existing.
  const hostUrlMonitor = startHostUrlMonitor(enrollmentHostUrl, (hostUrl) =>
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
  await app.register(systemRoutes, {
    service,
    tunnel,
    version: VERSION,
    enrollmentToken,
    fallbackPublicUrl,
    enrollmentHostUrl,
  });
  await app.register(nodeRoutes, { service, enrollmentToken });
  await app.register(catalogRoutes, { service });
  await app.register(sessionRoutes, { service });

  registerBrowserGateway(app, service);
  registerNodeGateway(app, service);
  const presenceTimer = startPresenceMonitor(service, heartbeatTimeoutMs);

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
    if (!store.getTunnelEnabled()) return;
    void tunnel.setEnabled(true, store.getTunnelProvider()).catch((error) => {
      store.setTunnelEnabled(false);
      app.log.error({ err: error }, "Failed to restore tunnel");
    });
  });

  app.addHook("onClose", async () => {
    clearInterval(presenceTimer);
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
