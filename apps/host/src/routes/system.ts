import type { FastifyPluginAsync } from "fastify";
import {
  HOST_BACKUP_KIND,
  HostBackupSchema,
  NODE_BACKUP_KIND,
  UpdateDefaultsSchema,
  UpdateTunnelSchema,
  backupKind,
  errorMessage,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { isTransferableHostUrl } from "../host-url.js";
import type { TunnelManager } from "../tunnel.js";

/** Large enough for a personal fleet's event log; not a license to dump binaries. */
export const HOST_BACKUP_BODY_LIMIT = 50 * 1024 * 1024;

export type SystemRouteOptions = {
  service: FleetService;
  tunnel: TunnelManager;
  version: string;
  enrollment: { token: string };
  /** The URL to hand a Node when no tunnel is up. */
  fallbackPublicUrl: () => string;
  enrollmentHostUrl: () => string;
};

/** Health, enrollment, snapshot, defaults, backup and tunnel control. */
export const systemRoutes: FastifyPluginAsync<SystemRouteOptions> = async (
  app,
  { service, tunnel, version, enrollment, fallbackPublicUrl, enrollmentHostUrl },
) => {
  const { store } = service;

  app.get("/api/health", async () => ({ ok: true, version }));

  app.get("/api/enrollment", async () => ({
    hostUrl: enrollmentHostUrl(),
    enrollmentToken: enrollment.token,
  }));

  app.get("/api/snapshot", async () => service.snapshot());

  app.get("/api/backup", async () => {
    const url = enrollmentHostUrl();
    return store.exportHostBackup({
      enrollmentToken: enrollment.token,
      ...(isTransferableHostUrl(url) ? { publicUrl: url } : {}),
    });
  });

  app.post(
    "/api/backup",
    { bodyLimit: HOST_BACKUP_BODY_LIMIT },
    async (request, reply) => {
      if (backupKind(request.body) === NODE_BACKUP_KIND) {
        return reply.code(400).send({
          error:
            "This file is a node identity archive. Import it on the node's config page at http://127.0.0.1:8788.",
        });
      }
      const parsed = HostBackupSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Not a Copilot Fleet Host archive." });
      }
      const backup = parsed.data;
      const { publicUrl: archivedUrl, ...rest } = backup;
      const publicUrl =
        archivedUrl && isTransferableHostUrl(archivedUrl) ? archivedUrl : undefined;
      service.importHostBackup(publicUrl ? { ...rest, publicUrl } : rest);
      enrollment.token = backup.enrollmentToken;
      try {
        await tunnel.setEnabled(backup.tunnel.enabled, backup.tunnel.provider);
      } catch (error) {
        store.setTunnelEnabled(false);
        return reply.code(503).send({
          error: errorMessage(error, "Fleet restored, but the tunnel failed to start"),
          kind: HOST_BACKUP_KIND,
        });
      }
      return { ok: true };
    },
  );

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
