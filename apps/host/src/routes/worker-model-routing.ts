import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { DecisionProviderDraftSchema, UpdateWorkerRoutingSchema } from "@fleet/protocol";
import type { FleetAuth } from "../auth/service.js";
import type { WorkerModelRoutingService } from "../worker-model-routing.js";
import { requireNodeOperator } from "./require-administrator.js";

export const workerModelRoutingRoutes: FastifyPluginAsync<{
  routing: WorkerModelRoutingService;
  auth: FleetAuth;
}> = async (app, { routing, auth }) => {
  app.get("/api/worker-model-routing", async (request, reply) => {
    if (!requireNodeOperator(auth, request, reply, false)) return;
    return routing.view();
  });

  app.put(
    "/api/worker-model-routing",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const actor = requireNodeOperator(auth, request, reply, false);
      if (!actor) return;
      const input = UpdateWorkerRoutingSchema.parse(request.body);
      const settings = await routing.update(input, `${actor.actorKind}:${actor.actorId}`);
      auth.audit({
        ...actor,
        outcome: "success",
        eventType: "worker_model_routing_updated",
        targetId: "worker-model-routing",
        detail: `Mode ${settings.mode}; revision ${input.expectedRevision} -> ${settings.revision}; ${settings.providers.length} decision models; ${settings.profiles.length} worker profiles.`,
      });
      return settings;
    },
  );

  app.post(
    "/api/worker-model-routing/test",
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const actor = requireNodeOperator(auth, request, reply, false);
      if (!actor) return;
      const input = DecisionProviderDraftSchema.parse(request.body);
      const result = await routing.test(input, `${actor.actorKind}:${actor.actorId}`);
      auth.audit({
        ...actor,
        outcome: result.success ? "success" : "failure",
        eventType: "worker_model_routing_tested",
        targetId: input.provider.id,
        detail: `${input.provider.kind}; ${result.success ? "valid decision" : result.code}; no worker started.`,
      });
      return result;
    },
  );

  app.post("/api/worker-model-routing/proposals/:id", async (request, reply) => {
    const actor = requireNodeOperator(auth, request, reply, false);
    if (!actor) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z
      .object({
        action: z.enum(["apply", "reject"]),
        expectedRevision: z.number().int().nonnegative(),
      })
      .parse(request.body);
    const result = routing.reviewProposal(id, input.action, input.expectedRevision);
    auth.audit({
      ...actor,
      outcome: "success",
      eventType: "worker_model_routing_proposal_reviewed",
      targetId: id,
      detail: `${input.action}; policy revision ${result.revision}.`,
    });
    return result;
  });
};
