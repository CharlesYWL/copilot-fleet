import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { LOCAL_AGENT_DEFAULT_PORT } from "@fleet/protocol";
import type { FleetAuth } from "../auth/service.js";
import type { LocalAgentListener } from "../local-agent-server.js";
import {
  localAgentErrorResponse,
  type LocalAgentManager,
  type LocalAgentService,
} from "../local-agent-service.js";
import { requireAdministrator } from "./require-administrator.js";

/**
 * Settings → Security for the local agent API, on the main Host behind its
 * ordinary browser guard (session, origin and CSRF). Every route also demands a
 * Microsoft administrator. Anything that leaves the API on — enabling it, or
 * changing the port or what it exposes while on — demands a recent sign-in as
 * well. Turning it off, and abandoning a stuck request, do not: those only ever
 * narrow what a local program can do, and should not wait on Microsoft.
 *
 * With sign-in deliberately skipped there is no administrator to ask, and the
 * operator on a local or private-tunnel address may already drive every
 * orchestrator through the Host itself, so the operator manages it — as it
 * manages Nodes.
 */
export const localAgentSettingsRoutes: FastifyPluginAsync<{
  auth: FleetAuth;
  agent: LocalAgentService;
  listener: LocalAgentListener;
  mainPort: number;
}> = async (app, { auth, agent, listener, mainPort }) => {
  const fail = (reply: FastifyReply, error: unknown) => {
    const mapped = localAgentErrorResponse(error);
    if (mapped.statusCode >= 500)
      app.log.error({ err: error }, "Local agent settings request failed");
    return reply.code(mapped.statusCode).send(mapped.body);
  };
  const manager = (
    request: FastifyRequest,
    reply: FastifyReply,
    recent: boolean,
  ): LocalAgentManager | undefined => {
    if (auth.noAuthEnabled() && auth.noAuthEndpointAllowed(request.headers.host))
      return { kind: "operator", id: "", username: "The operator" };
    const administrator = requireAdministrator(auth, request, reply, recent);
    return administrator
      ? { kind: "administrator", id: administrator.id, username: administrator.username }
      : undefined;
  };
  const view = () => ({
    config: agent.config(),
    status: listener.status(),
    hostPort: mainPort,
    defaultPort: LOCAL_AGENT_DEFAULT_PORT,
    choices: agent.choices(),
  });

  app.get("/api/local-agent/config", async (request, reply) => {
    if (!manager(request, reply, false)) return reply;
    return view();
  });

  app.put("/api/local-agent/config", async (request, reply) => {
    const leavesOn = (request.body as { enabled?: unknown } | null)?.enabled !== false;
    const actor = manager(request, reply, leavesOn);
    if (!actor) return reply;
    try {
      agent.updateConfig(request.body, actor, mainPort);
    } catch (error) {
      return fail(reply, error);
    }
    await listener.reconcile();
    return view();
  });

  app.get("/api/local-agent/requests", async (request, reply) => {
    if (!manager(request, reply, false)) return reply;
    try {
      return agent.listRequests(request.query as Record<string, unknown>);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { operationId: string } }>(
    "/api/local-agent/requests/:operationId/disposition",
    async (request, reply) => {
      const actor = manager(request, reply, false);
      if (!actor) return reply;
      try {
        return agent.dispose(request.params.operationId, request.body, actor);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
};
