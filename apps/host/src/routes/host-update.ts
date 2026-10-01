import type { FastifyPluginAsync } from "fastify";
import { UpdateHostSchema } from "@fleet/protocol";
import type { HostSelfUpdate } from "../self-update.js";

export type HostUpdateRouteOptions = { hostUpdate: HostSelfUpdate };

/** The Host's own update, from Settings → General. */
export const hostUpdateRoutes: FastifyPluginAsync<HostUpdateRouteOptions> = async (
  app,
  { hostUpdate },
) => {
  app.get("/api/host/update", async () => hostUpdate.status());

  app.post("/api/host/update", async (request, reply) => {
    const input = UpdateHostSchema.parse(request.body ?? {});
    const result = await hostUpdate.request({
      stopSessions: input.stopSessions,
      sessionIds: input.sessionIds,
    });
    if (!result.started) {
      // As for a Node: the sessions in the way travel with the refusal, so the
      // browser can name them and offer to stop them.
      return reply.code(result.status).send({
        error: result.reason,
        ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
      });
    }
    return { started: true, status: hostUpdate.status() };
  });
};
