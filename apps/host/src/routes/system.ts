import type { FastifyPluginAsync } from "fastify";
import {
  ConnectCommandSchema,
  HOST_BACKUP_KIND,
  HostBackupSchema,
  NODE_BACKUP_KIND,
  PORTABLE_BACKUP_VERSION,
  UpdateDefaultsSchema,
  UpdateTunnelSchema,
  backupFormatVersion,
  backupKind,
  errorMessage,
} from "@fleet/protocol";
import type { LogEntry } from "@fleet/protocol/log-buffer";
import { z } from "zod";
import type { LegacyEnrollment } from "../config.js";
import type { FleetService } from "../fleet-service.js";

/** The switch itself: one boolean, stated rather than toggled. */
const MutualNodeAuthenticationSchema = z.object({ required: z.boolean() });
import { isTransferableHostUrl } from "../host-url.js";
import { ineligibleProviderMessage, type TunnelSupervisor } from "../tunnel.js";
import { providerSpecs } from "../tunnel-providers.js";
import type { EnrollmentGrants } from "../auth/enrollment-grants.js";
import type { HostIdentityService } from "../auth/host-identity.js";
import type { FleetAuth } from "../auth/service.js";
import { requireAdministrator } from "./require-administrator.js";

/** Large enough for a personal fleet's event log; not a license to dump binaries. */
export const HOST_BACKUP_BODY_LIMIT = 50 * 1024 * 1024;

export type SystemRouteOptions = {
  service: FleetService;
  tunnel: TunnelSupervisor;
  version: string;
  enrollment: LegacyEnrollment;
  auth: FleetAuth;
  identity: HostIdentityService;
  grants: EnrollmentGrants;
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
    auth,
    identity,
    grants,
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

  /**
   * What a Node needs to find this Host, and what it needs to recognise it.
   *
   * The fingerprint is the whole point: a Node that has pinned it will not send
   * an enrollment completion — or a protocol frame — to anything that cannot
   * sign for the matching key, which is what makes a relay merely a relay. The
   * fleet-wide token is still here for machines that predate Node keys.
   */
  app.get("/api/enrollment", async () => {
    const tunnelId = tunnel.activeTunnelId();
    const host = identity.identity();
    const mutualAuthenticationRequired = store.mutualNodeAuthenticationRequired();
    /*
     * Published only while it is still a credential this Host would accept. A
     * fresh grant-only Host never had one, and an enforced fleet has retired
     * the one it had — handing either out here would keep a fleet-wide secret
     * readable on an unauthenticated endpoint as an authority nobody is
     * watching.
     */
    const legacyToken =
      mutualAuthenticationRequired || !enrollment.token ? undefined : enrollment.token;
    return {
      hostUrl: enrollmentHostUrl(),
      hostId: host.hostId,
      hostFingerprint: host.fingerprint,
      hostPublicKey: host.publicKey,
      ...(legacyToken ? { enrollmentToken: legacyToken } : {}),
      nodeAuthentication: store.nodeAuthenticationSummary(),
      mutualAuthenticationRequired,
      ...(tunnelId ? { tunnelId } : {}),
    };
  });

  /**
   * Mints the one-time authority for a single new machine.
   *
   * A recent authorization-code login is required because this is how a machine
   * joins a fleet that can run commands on all of them, and because the grant
   * it returns is printed once and never stored.
   */
  app.post("/api/enrollment-grants", async (request, reply) => {
    const administrator = requireAdministrator(auth, request, reply, true);
    if (!administrator) return reply;
    const host = identity.identity();
    const issued = grants.create(administrator.id);
    auth.audit({
      eventType: "enrollment_grant_created",
      actorKind: "administrator",
      actorId: administrator.id,
      targetId: issued.id,
      outcome: "allowed",
    });
    const tunnelId = tunnel.activeTunnelId();
    return reply.code(201).send({
      id: issued.id,
      grant: issued.grant,
      expiresAt: issued.expiresAt,
      command: ConnectCommandSchema.parse({
        hostUrl: enrollmentHostUrl(),
        hostId: host.hostId,
        hostFingerprint: host.fingerprint,
        enrollmentGrant: issued.grant,
        ...(tunnelId ? { tunnelId } : {}),
      }),
    });
  });

  /**
   * Declares the migration finished, or reopens it.
   *
   * Refused while any Node still authenticates with a shared secret: turning it
   * on then would lock those machines out of their own fleet, and the operator
   * would have no way to reach them to upgrade them. The refusal names how many
   * are left, so "why can't I?" has an answer.
   */
  app.post("/api/nodes/mutual-authentication", async (request, reply) => {
    const administrator = requireAdministrator(auth, request, reply, true);
    if (!administrator) return reply;
    const input = MutualNodeAuthenticationSchema.parse(request.body ?? {});
    const summary = store.nodeAuthenticationSummary();
    if (input.required && summary.legacy > 0) {
      return reply.code(409).send({
        error: `${summary.legacy} of ${summary.total} Nodes still authenticate with a shared secret. Re-enrol each one with a fresh Connect command before enforcing mutual authentication.`,
        nodeAuthentication: summary,
      });
    }
    store.setMutualNodeAuthenticationRequired(input.required);
    // Enforcement is the operator saying the shared secret is over, so it goes.
    // Leaving the hashes behind would mean relaxing the switch — or restoring a
    // database copy taken after it — brings back a credential the fleet has
    // moved past, on machines that no longer need one.
    const clearedSecrets = input.required ? store.clearLegacyNodeSecrets() : 0;
    auth.audit({
      eventType: input.required
        ? "mutual_node_authentication_enforced"
        : "mutual_node_authentication_relaxed",
      actorKind: "administrator",
      actorId: administrator.id,
      outcome: "allowed",
      ...(clearedSecrets ? { detail: `cleared ${clearedSecrets} legacy secret(s)` } : {}),
    });
    return reply.send({
      mutualAuthenticationRequired: input.required,
      nodeAuthentication: summary,
    });
  });

  app.get("/api/snapshot", async () => service.snapshot());

  app.get("/api/backup", async () => {
    const url = enrollmentHostUrl();
    return store.exportHostBackup({
      // Empty on a Host that has none, which the archive format allows: a
      // grant-only install has nothing here to carry.
      enrollmentToken: enrollment.token ?? "",
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
      /*
       * A portable archive is a valid file for a different operation: this
       * endpoint deliberately preserves the security envelope it lands in, so
       * applying one here would restore the data and silently drop the
       * administrators and keys the operator was trying to move.
       */
      if (backupFormatVersion(request.body) === PORTABLE_BACKUP_VERSION) {
        return reply.code(400).send({
          error:
            "This is a portable Fleet archive. Restore it from Settings with its backup passphrase.",
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
      try {
        service.importHostBackup(publicUrl ? { ...rest, publicUrl } : rest);
      } catch (error) {
        /*
         * The restore refused itself and rolled back, so the operator still has
         * the Host they had a moment ago. The reason is the useful part — a
         * version 1 archive naming a key-based Node this Host has no key for
         * has a next step, and a 500 carrying none reads as a broken Host.
         */
        return reply.code(409).send({
          error: errorMessage(error, "That archive could not be restored."),
        });
      }
      // An archive from a grant-only Host carries no token, and restoring an
      // empty string as one would be a credential that matches an empty body.
      enrollment.token = backup.enrollmentToken || undefined;
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
    /*
     * A provider with no TLS is not a door the console may stand behind.
     * The refusal is here rather than only in the panel because this route is
     * reachable by anything holding an operator session, and because the
     * consequence — the Fleet session cookie and every transcript behind it
     * crossing a relay in clear text — does not depend on which client asked.
     */
    if (input.enabled && !providerSpecs[provider].controlPlaneEligible) {
      return reply.code(400).send({
        error: ineligibleProviderMessage(provider),
        tunnel: await tunnel.info(fallbackPublicUrl()),
      });
    }
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
