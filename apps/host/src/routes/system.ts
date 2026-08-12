import type { FastifyPluginAsync } from "fastify";
import { UpdateDefaultsSchema, UpdateTunnelSchema, errorMessage } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { TunnelManager } from "../tunnel.js";

export type SystemRouteOptions = {
  service: FleetService;
  tunnel: TunnelManager;
  version: string;
  enrollmentToken: string;
  /** The URL to hand a Node when no tunnel is up. */
  fallbackPublicUrl: () => string;
  enrollmentHostUrl: () => string;
};

/** Health, enrollment, snapshot, defaults and tunnel control. */
export const systemRoutes: FastifyPluginAsync<SystemRouteOptions> = async (
  app,
  { service, tunnel, version, enrollmentToken, fallbackPublicUrl, enrollmentHostUrl },
) => {
  const { store } = service;

  app.get("/api/health", async () => ({ ok: true, version }));

  app.get("/api/enrollment", async () => ({
    hostUrl: enrollmentHostUrl(),
    enrollmentToken,
  }));

  app.get("/api/snapshot", async () => service.snapshot());

  app.get("/api/defaults", async () => ({
    yolo: store.getDefaultYolo(),
    autoResume: store.getAutoResume(),
  }));

  app.post("/api/defaults", async (request) => {
    const input = UpdateDefaultsSchema.parse(request.body);
    // Each field is optional so a client that knows about one setting cannot
    // reset the others merely by not mentioning them.
    if (input.yolo !== undefined) store.setDefaultYolo(input.yolo);
    if (input.autoResume !== undefined) store.setAutoResume(input.autoResume);
    return { yolo: store.getDefaultYolo(), autoResume: store.getAutoResume() };
  });

  app.get("/api/tunnel", async () => tunnel.info(fallbackPublicUrl()));

  app.post("/api/tunnel", async (request, reply) => {
    const input = UpdateTunnelSchema.parse(request.body);
    const provider = input.provider ?? store.getTunnelProvider();
    store.setTunnelProvider(provider);
    store.setTunnelEnabled(input.enabled);
    try {
      await tunnel.setEnabled(input.enabled, provider);
    } catch (error) {
      store.setTunnelEnabled(false);
      return reply.code(503).send({
        error: errorMessage(error, "Tunnel failed to start"),
        tunnel: await tunnel.info(fallbackPublicUrl()),
      });
    }
    return tunnel.info(fallbackPublicUrl());
  });
};
