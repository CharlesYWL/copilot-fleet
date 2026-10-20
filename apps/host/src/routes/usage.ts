import type { FastifyPluginAsync } from "fastify";
import { UsageReportQuerySchema } from "@fleet/protocol";
import type { FleetStore } from "../store.js";

/** The server's central operator guard protects this route like every other API read. */
export const usageRoutes: FastifyPluginAsync<{
  store: Pick<FleetStore, "usage">;
}> = async (app, { store }) => {
  app.get("/api/usage", async (request, reply) => {
    const parsed = UsageReportQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Invalid usage filters, date range, or timezone" });
    return store.usage.report(parsed.data);
  });
};
