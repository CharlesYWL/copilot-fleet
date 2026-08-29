import type { FastifyReply, FastifyRequest } from "fastify";
import type { Administrator } from "../store.js";
import type { FleetAuth } from "../auth/service.js";

/**
 * The administrator behind a request, or the refusal that has already been sent.
 *
 * Shared between the auth routes and the Connect card because the rule is the
 * same in both places and a second copy of it is a second place for the recency
 * check to be forgotten. `recent` asks for an authorization-code login within
 * the last few minutes: it is required for anything that cannot be undone by
 * the person it was done to, which includes minting the authority for a new
 * machine to join the fleet.
 */
export function requireAdministrator(
  auth: FleetAuth,
  request: FastifyRequest,
  reply: FastifyReply,
  recent: boolean,
): Administrator | undefined {
  const session = request.fleetSession;
  const administrator = session ? auth.administratorFor(session) : undefined;
  if (!session || !administrator) {
    reply.code(403).send({ error: "Only a Microsoft administrator can do that." });
    return undefined;
  }
  if (recent && !auth.requireRecentReauth(session)) {
    reply.code(403).send({
      error: "Sign in with Microsoft again to confirm this change.",
      // Named so the page can offer the sign-in that fixes it, rather than
      // showing a refusal whose only remedy is guessing.
      reauthRequired: true,
    });
    return undefined;
  }
  return administrator;
}
