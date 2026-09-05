import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HostPortableBackupSchema, PORTABLE_BACKUP_VERSION } from "@fleet/protocol";
import {
  BINDING_COOKIE,
  BOOTSTRAP_COOKIE,
  OPERATOR_COOKIE,
  readCookie,
} from "../auth.js";
import {
  MAX_BACKUP_PASSPHRASE_LENGTH,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  openSecurityEnvelope,
  sealSecurityEnvelope,
} from "../auth/security-backup.js";
import type { HostIdentityService } from "../auth/host-identity.js";
import type { FleetAuth } from "../auth/service.js";
import type { LegacyEnrollment } from "../config.js";
import type { FleetService } from "../fleet-service.js";
import { isTransferableHostUrl } from "../host-url.js";
import type { LeadTokens } from "../orchestrator/lead-tokens.js";
import { requireAdministrator } from "./require-administrator.js";

/** The same ceiling the data restore uses; the security half adds kilobytes. */
export const PORTABLE_BACKUP_BODY_LIMIT = 50 * 1024 * 1024;

export const PORTABLE_BACKUP_PATH = "/api/backup/portable";
export const PORTABLE_BACKUP_IMPORT_PATH = "/api/backup/portable/import";

const PassphraseSchema = z
  .string()
  .min(MIN_BACKUP_PASSPHRASE_LENGTH)
  .max(MAX_BACKUP_PASSPHRASE_LENGTH);

const ExportSchema = z.object({ passphrase: PassphraseSchema });
const ImportSchema = z.object({ passphrase: PassphraseSchema, backup: z.unknown() });

const SHORT_PASSPHRASE = `A backup passphrase must be at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters.`;

export type PortableBackupRouteOptions = {
  service: FleetService;
  auth: FleetAuth;
  enrollment: LegacyEnrollment;
  enrollmentHostUrl: () => string;
  leadTokens: LeadTokens;
  /**
   * The Host's own key pair, which the archive replaces.
   *
   * Every enrolled machine has pinned the origin's fingerprint. The restore
   * writes another Host's identity underneath a service that read this one's at
   * startup, so unless it is told to look again the Host advertises the key it
   * imported while signing with the one it just overwrote — and every Node
   * refuses the handshake for a reason nobody can see.
   */
  identity: HostIdentityService;
};

declare module "fastify" {
  interface FastifyRequest {
    fleetPortableRestoreAuthorization?: "administrator" | "bootstrap";
  }
}

/**
 * Moving a Host, rather than moving what is on one.
 *
 * The data restore deliberately preserves the security envelope of the machine
 * it lands on, which is what makes it safe and also what makes it useless for
 * a move: the administrators, the Entra registration and every key stay
 * behind. These two routes are the other operation — the one that does change
 * who owns a Host — so each end of it is a separate proof.
 *
 * Producing an archive needs a Microsoft administrator who has signed in
 * recently and a passphrase; accepting one needs either the same, or, on a
 * Host nobody owns yet, the code printed on its console. Neither end stores
 * the passphrase.
 */
export const portableBackupRoutes: FastifyPluginAsync<
  PortableBackupRouteOptions
> = async (
  app,
  { service, auth, enrollment, enrollmentHostUrl, leadTokens, identity },
) => {
  const { store } = service;

  app.post(
    PORTABLE_BACKUP_PATH,
    {
      bodyLimit: PORTABLE_BACKUP_BODY_LIMIT,
      onRequest: async (request, reply) => {
        if (!requireAdministrator(auth, request, reply, true)) return reply;
      },
    },
    async (request, reply) => {
      const administrator = auth.administratorFor(request.fleetSession!);
      if (!administrator)
        return reply.code(403).send({ error: "Administrator required" });
      const input = ExportSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: SHORT_PASSPHRASE });
      const url = enrollmentHostUrl();
      const data = store.exportHostBackup({
        enrollmentToken: enrollment.token ?? "",
        ...(isTransferableHostUrl(url) ? { publicUrl: url } : {}),
      });
      const {
        enrollmentToken: _enrollmentToken,
        nodes: securedNodes,
        ...portable
      } = data;
      const nodes = securedNodes.map(({ secretHash: _secretHash, ...node }) => node);
      const security = sealSecurityEnvelope(
        store.exportSecurityBackup(),
        input.data.passphrase,
      );
      auth.audit({
        eventType: "security_backup_exported",
        actorKind: "administrator",
        actorId: administrator.id,
        outcome: "allowed",
      });
      return reply.send({
        ...portable,
        nodes,
        version: PORTABLE_BACKUP_VERSION,
        security,
      });
    },
  );

  app.post(
    PORTABLE_BACKUP_IMPORT_PATH,
    {
      bodyLimit: PORTABLE_BACKUP_BODY_LIMIT,
      onRequest: async (request, reply) => {
        if (auth.claimed()) {
          // Import also accepts bootstrap grants, so the global guard leaves
          // its session and CSRF checks to this route.
          const session = auth.verifySession(
            readCookie(request.headers.cookie, OPERATOR_COOKIE),
          );
          if (!session || !auth.sessionStillAuthorized(session)) {
            return reply.code(401).send({ error: "Sign in to use this Host" });
          }
          request.fleetSession = session;
          if (!requireAdministrator(auth, request, reply, true)) return reply;
          const presented = request.headers["x-csrf-token"];
          const token = Array.isArray(presented) ? presented[0] : presented;
          if (!auth.sessions.verifyCsrf(session.tokenHash, token)) {
            return reply.code(403).send({ error: "Missing or invalid CSRF token" });
          }
          request.fleetPortableRestoreAuthorization = "administrator";
          return;
        }
        const grant = auth.claim.verifyBootstrap(
          readCookie(request.headers.cookie, BOOTSTRAP_COOKIE),
          readCookie(request.headers.cookie, BINDING_COOKIE) ?? "",
        );
        if (!grant) {
          auth.audit({
            eventType: "security_backup_import_refused",
            actorKind: "anonymous",
            outcome: "denied",
            detail: "no console claim grant",
          });
          return reply.code(401).send({
            error: "Enter the claim code printed on the Host console first.",
          });
        }
        request.fleetPortableRestoreAuthorization = "bootstrap";
      },
    },
    async (request, reply) => {
      const input = ImportSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: SHORT_PASSPHRASE });
      const archive = HostPortableBackupSchema.safeParse(input.data.backup);
      if (!archive.success) {
        return reply
          .code(400)
          .send({ error: "That file is not a Copilot Fleet portable archive." });
      }
      /*
       * Two ways in, because there are two situations. A Host with
       * administrators is asking one of them to approve being replaced; a
       * Host nobody owns has no one to ask, so it asks for the code on its
       * console instead — the same proof a first claim takes.
       */
      const opened = openSecurityEnvelope(archive.data.security, input.data.passphrase);
      if (!opened.ok) {
        auth.audit({
          eventType: "security_backup_import_refused",
          actorKind: auth.claimed() ? "administrator" : "anonymous",
          outcome: "denied",
          detail: "envelope did not open",
        });
        return reply.code(400).send({ error: opened.error });
      }

      const {
        kind: _kind,
        version: _version,
        security: _security,
        ...data
      } = archive.data;
      const { revokedSessions } = service.importPortableBackup({
        data,
        security: opened.payload,
      });
      /*
       * The order here is the restore. The store has committed, so the Host now
       * has another machine's identity, keys and administrators on disk; each
       * of the services that read one of those at startup is told to look
       * again, every session the old Host issued is closed, and only then is a
       * snapshot published — so nothing observes a Host that is half of each.
       */
      identity.reload();
      // Only what the archive still uses. An enforced fleet retired the
      // fleet-wide token, and restoring it would bring back a credential its
      // operator had deliberately ended.
      enrollment.token = store.mutualNodeAuthenticationRequired()
        ? undefined
        : opened.payload.enrollmentToken || undefined;
      // Spent only once the restore has happened, so a failed attempt does
      // not cost the operator the code printed on their console.
      if (request.fleetPortableRestoreAuthorization === "bootstrap") {
        auth.claim.consumeBootstrap(readCookie(request.headers.cookie, BOOTSTRAP_COOKIE));
      }
      leadTokens.adoptKey(opened.payload.leadTokenKey);
      auth.adoptRestoredSecurity(revokedSessions);
      service.publishSnapshot();
      /*
       * No session is issued here, on either path. The identities that may
       * operate this Host are the ones the archive named, and they sign in
       * through the Entra configuration it just restored.
       */
      return reply.send({ ok: true, administrators: auth.listAdministrators().length });
    },
  );
};
