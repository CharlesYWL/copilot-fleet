import type { FastifyReply, FastifyRequest } from "fastify";
import type { Administrator } from "../store.js";
import type { FleetAuth } from "../auth/service.js";

/**
 * The administrator behind a request, or the refusal that has already been sent.
 *
 * High-impact actions opt into a recent authorization-code login. Routine
 * actions, such as generating a Connect command, need only a live
 * administrator session.
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

/** Node management remains available when the operator deliberately skips sign-in. */
export function requireNodeOperator(
  auth: FleetAuth,
  request: FastifyRequest,
  reply: FastifyReply,
  recent: boolean,
): { actorKind: "operator" | "administrator"; actorId: string } | undefined {
  if (auth.noAuthEnabled() && auth.noAuthEndpointAllowed(request.headers.host)) {
    return { actorKind: "operator", actorId: "" };
  }
  const administrator = requireAdministrator(auth, request, reply, recent);
  return administrator
    ? { actorKind: "administrator", actorId: administrator.id }
    : undefined;
}
