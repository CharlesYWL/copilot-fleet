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
import { requireNodeOperator } from "./require-administrator.js";
import { HOST_ARCHIVE_BYTES } from "../backup-limits.js";

/** Large enough for a personal fleet's event log; not a license to dump binaries. */
export const HOST_BACKUP_BODY_LIMIT = HOST_ARCHIVE_BYTES;

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
  /** Bounded runtime output, newest last, for the Diagnostics panel. */
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

  /** The recorder keeps runtime output but omits routine HTTP request traffic. */
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
   * A live administrator session is sufficient; the grant remains single-use,
   * expires after fifteen minutes, and is audited under that administrator.
   */
  app.post("/api/enrollment-grants", async (request, reply) => {
    const actor = requireNodeOperator(auth, request, reply, false);
    if (!actor) return reply;
    const host = identity.identity();
    const issued = grants.create(actor.actorId);
    auth.audit({
      eventType: "enrollment_grant_created",
      ...actor,
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
    const actor = requireNodeOperator(auth, request, reply, true);
    if (!actor) return reply;
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
      ...actor,
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
      tunnel: tunnel.backupSettings(store.getTunnelBackupSettings()),
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
        tunnel.assertCanRestore(backup.tunnel);
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
        await tunnel.restoreSettings(store.getTunnelBackupSettings());
      } catch (error) {
        request.log.error({ err: error }, "Fleet restored, but tunnel setup failed");
        return reply.code(503).send({
          error: `Fleet data was restored, but tunnel setup failed: ${errorMessage(error)}. Check the provider's login and retry from Settings -> Tunnel; do not import the backup again.`,
          kind: HOST_BACKUP_KIND,
          restored: true,
        });
      }
      return { ok: true };
    },
  );

  app.get("/api/defaults", async (request) => ({
    managedWorktreesRevision: Number(store.getSetting("defaults.managedRevision") ?? 0),
    managedWorktreesEnabled: store.getManagedWorktreesEnabled(),
    managedWorktreePolicy: store.getManagedWorktreePolicy(),
    yolo: store.getDefaultYolo(),
    contextTier: store.getDefaultContextTier(),
    agencyMode: store.getAgencyMode(),
    agencyModeAvailable: auth.agencyAvailableFor(request.fleetSession),
    autoResume: store.getAutoResume(),
    notificationLifecycleEnabled: store.getDefaultNotificationLifecycleEnabled(),
    model: store.getDefaultModel(),
    reasoningEffort: store.getDefaultReasoningEffort(),
  }));

  app.post("/api/defaults", async (request, reply) => {
    const input = UpdateDefaultsSchema.parse(request.body);
    const managedChange =
      input.managedWorktreesEnabled !== undefined ||
      input.managedWorktreePolicy !== undefined;
    if (managedChange) {
      if (!input.operationId || input.expectedRevision === undefined)
        return reply.code(409).send({
          code: "revision_required",
          error:
            "Managed defaults require an operationId and the current expectedRevision.",
        });
      const replay = store.managedApiReplay("managed-defaults", input.operationId, input);
      if (replay !== undefined) return replay;
      if (
        input.expectedRevision !==
        Number(store.getSetting("defaults.managedRevision") ?? 0)
      )
        return reply.code(409).send({
          code: "stale_revision",
          error: "Defaults changed; refresh before applying this setting.",
        });
    }
    const agencyModeAvailable = auth.agencyAvailableFor(request.fleetSession);
    if (input.agencyMode !== undefined && !agencyModeAvailable) {
      return reply.code(403).send({
        error:
          "Agency mode is an internal feature for Microsoft employees. Sign in with your @microsoft.com corporate account to change it.",
      });
    }
    // Each field is optional so a client that knows about one setting cannot
    // reset the others merely by not mentioning them.
    if (input.yolo !== undefined) store.setDefaultYolo(input.yolo);
    if (input.contextTier !== undefined) store.setDefaultContextTier(input.contextTier);
    if (input.managedWorktreesEnabled !== undefined)
      store.setManagedWorktreesEnabled(input.managedWorktreesEnabled);
    if (input.managedWorktreePolicy !== undefined)
      store.setManagedWorktreePolicy(input.managedWorktreePolicy);
    if (input.agencyMode !== undefined) store.setAgencyMode(input.agencyMode);
    if (input.autoResume !== undefined) store.setAutoResume(input.autoResume);
    if (input.notificationLifecycleEnabled !== undefined) {
      store.setDefaultNotificationLifecycleEnabled(input.notificationLifecycleEnabled);
    }
    if (input.model !== undefined) store.setDefaultModel(input.model);
    if (input.reasoningEffort !== undefined) {
      store.setDefaultReasoningEffort(input.reasoningEffort);
    }
    if (managedChange)
      store.setSetting("defaults.managedRevision", String(input.expectedRevision! + 1));
    const result = {
      managedWorktreesRevision: Number(store.getSetting("defaults.managedRevision") ?? 0),
      managedWorktreesEnabled: store.getManagedWorktreesEnabled(),
      managedWorktreePolicy: store.getManagedWorktreePolicy(),
      yolo: store.getDefaultYolo(),
      contextTier: store.getDefaultContextTier(),
      agencyMode: store.getAgencyMode(),
      agencyModeAvailable,
      autoResume: store.getAutoResume(),
      notificationLifecycleEnabled: store.getDefaultNotificationLifecycleEnabled(),
      model: store.getDefaultModel(),
      reasoningEffort: store.getDefaultReasoningEffort(),
    };
    if (managedChange)
      store.recordManagedApiRequest(
        "managed-defaults",
        input.operationId!,
        input,
        result,
      );
    return result;
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
    const privateOnly = auth.noAuthEnabled();
    if (
      input.enabled &&
      (!providerSpecs[provider].controlPlaneEligible ||
        (privateOnly && providerSpecs[provider].access !== "creator-private"))
    ) {
      return reply.code(400).send({
        error: ineligibleProviderMessage(provider, privateOnly),
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
