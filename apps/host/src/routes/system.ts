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
import type { LogEntry } from "@fleet/protocol/log-buffer";
import type { FleetService } from "../fleet-service.js";
import { isTransferableHostUrl } from "../host-url.js";
import type { TunnelSupervisor } from "../tunnel.js";

/** Large enough for a personal fleet's event log; not a license to dump binaries. */
export const HOST_BACKUP_BODY_LIMIT = 50 * 1024 * 1024;

export type SystemRouteOptions = {
  service: FleetService;
  tunnel: TunnelSupervisor;
  version: string;
  enrollment: { token: string };
  /** The URL to hand a Node when no tunnel is up. */
  fallbackPublicUrl: () => string;
  enrollmentHostUrl: () => string;
  /** Recent warnings and errors, newest last, for the Diagnostics panel. */
  recentLogs?: () => LogEntry[];
};

/** Health, enrollment, snapshot, defaults, backup and tunnel control. */
export const systemRoutes: FastifyPluginAsync<SystemRouteOptions> = async (
  app,
  {
    service,
    tunnel,
    version,
    enrollment,
    fallbackPublicUrl,
    enrollmentHostUrl,
    recentLogs,
  },
) => {
  const { store } = service;

  app.get("/api/health", async () => ({ ok: true, version }));

  /**
   * What the Host has complained about lately.
   *
   * Only warnings and errors are kept: the Host logs every request it serves,
   * and a buffer holding those would evict the one line worth reading by the
   * time anyone came looking for it.
   */
  app.get("/api/logs", async () => ({ entries: recentLogs ? recentLogs() : [] }));

  app.get("/api/enrollment", async () => {
    const tunnelId = tunnel.activeTunnelId();
    return {
      hostUrl: enrollmentHostUrl(),
      enrollmentToken: enrollment.token,
      ...(tunnelId ? { tunnelId } : {}),
    };
  });

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
        await tunnel.setEnabled(backup.tunnel.provider, backup.tunnel.enabled);
      } catch (error) {
        store.setTunnelProviderEnabled(backup.tunnel.provider, false);
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
    notificationLifecycleEnabled: store.getDefaultNotificationLifecycleEnabled(),
    model: store.getDefaultModel(),
    reasoningEffort: store.getDefaultReasoningEffort(),
  }));

  app.post("/api/defaults", async (request) => {
    const input = UpdateDefaultsSchema.parse(request.body);
    // Each field is optional so a client that knows about one setting cannot
    // reset the others merely by not mentioning them.
    if (input.yolo !== undefined) store.setDefaultYolo(input.yolo);
    if (input.autoResume !== undefined) store.setAutoResume(input.autoResume);
    if (input.notificationLifecycleEnabled !== undefined) {
      store.setDefaultNotificationLifecycleEnabled(input.notificationLifecycleEnabled);
    }
    if (input.model !== undefined) store.setDefaultModel(input.model);
    if (input.reasoningEffort !== undefined) {
      store.setDefaultReasoningEffort(input.reasoningEffort);
    }
    return {
      yolo: store.getDefaultYolo(),
      autoResume: store.getAutoResume(),
      notificationLifecycleEnabled: store.getDefaultNotificationLifecycleEnabled(),
      model: store.getDefaultModel(),
      reasoningEffort: store.getDefaultReasoningEffort(),
    };
  });

  app.get("/api/tunnel", async () => tunnel.info(fallbackPublicUrl()));

  app.post("/api/tunnel", async (request, reply) => {
    const input = UpdateTunnelSchema.parse(request.body);
    const provider = input.provider ?? store.getTunnelProvider();
    // Providers run side by side, so switching one never implies switching the
    // others off; only this provider's own flag moves.
    store.setTunnelProviderEnabled(provider, input.enabled);
    try {
      await tunnel.setEnabled(provider, input.enabled, input.primary ?? true);
    } catch (error) {
      store.setTunnelProviderEnabled(provider, false);
      return reply.code(503).send({
        error: errorMessage(error, "Tunnel failed to start"),
        tunnel: await tunnel.info(fallbackPublicUrl()),
      });
    }
    return tunnel.info(fallbackPublicUrl());
  });
};
