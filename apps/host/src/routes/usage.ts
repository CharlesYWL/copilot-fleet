import type { FastifyPluginAsync } from "fastify";
import { UsageBackfillRequestSchema, UsageReportQuerySchema } from "@fleet/protocol";
import type { FleetStore } from "../store.js";
import type { FleetAuth } from "../auth/service.js";
import { requireNodeOperator } from "./require-administrator.js";
import { UsageBackfillConflict } from "../usage-backfill.js";

/** The server's central operator guard protects this route like every other API read. */
export const usageRoutes: FastifyPluginAsync<{
  store: Pick<FleetStore, "usage" | "usageBackfill">;
  auth: FleetAuth;
}> = async (app, { store, auth }) => {
  app.get("/api/usage/backfill", async (request, reply) => {
    if (!requireNodeOperator(auth, request, reply, false)) return;
    return store.usageBackfill.preview();
  });
  app.post("/api/usage/backfill", { bodyLimit: 1024 }, async (request, reply) => {
    const actor = requireNodeOperator(auth, request, reply, false);
    if (!actor) return;
    const parsed = UsageBackfillRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "A valid backfill preview is required." });
    try {
      const result = store.usageBackfill.apply(parsed.data.previewId);
      auth.audit({
        ...actor,
        eventType: "usage_credits_backfilled",
        targetId: "usage",
        outcome: "success",
        detail: `Imported ${result.importedConversations} native conversations as undated opening balances; ${result.aiCredits} credits.`,
      });
      return result;
    } catch (error) {
      if (error instanceof UsageBackfillConflict)
        return reply.code(409).send({ error: error.message });
      request.log.error({ err: error }, "Usage credit backfill failed");
      return reply.code(500).send({
        error:
          "Could not complete the credit backfill. Preview again before retrying; a database backup is required before any import.",
      });
    }
  });
  app.get("/api/usage", async (request, reply) => {
    const parsed = UsageReportQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Invalid usage filters, date range, or timezone" });
    return store.usage.report(parsed.data);
  });
};
