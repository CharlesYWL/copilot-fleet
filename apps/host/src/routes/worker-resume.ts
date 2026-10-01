import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OrchestratorEngine } from "../orchestrator/engine.js";
import { WorkerResumeConflict } from "../worker-resume-store.js";

const ResumeNowSchema = z
  .object({ reason: z.string().max(1_000).optional() })
  .strict()
  .default({});

const ListSchema = z.object({
  runId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

/**
 * A signed-in browser operator, the only principal that may decide.
 *
 * Node credentials, the orchestrator's MCP token and no-login access never
 * reach a decision: the same rule PR-maintenance authorization uses.
 */
function authenticatedOperator(request: FastifyRequest): string | undefined {
  const session = request.fleetSession;
  if (request.fleetNodeId || !session || session.expiresAt <= Date.now())
    return undefined;
  return session.administratorId || `operator:${session.authMethod}`;
}

function conflict(reply: FastifyReply, error: unknown) {
  if (!(error instanceof WorkerResumeConflict)) throw error;
  return reply.code(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.request ? { request: error.request } : {}),
  });
}

/**
 * "Resume now" for a queued follow-up, and the approval dialog's decision.
 *
 * Asking is open to any operator on this Host because asking changes nothing:
 * ordinary scheduling runs first and an exception only becomes a request.
 * Deciding requires an authenticated browser operator.
 */
export const workerResumeRoutes: FastifyPluginAsync<{
  engine: OrchestratorEngine;
}> = async (app, { engine }) => {
  app.post("/api/runs/:id/steps/:stepId/resume-now", async (request, reply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const actor = request.fleetNodeId ? undefined : request.fleetHumanActor;
    if (!actor)
      return reply
        .code(403)
        .send({ error: "Only a person operating this Host can ask to resume a worker." });
    const step = engine.resume.stepOf(stepId);
    if (!step || step.runId !== id)
      return reply.code(404).send({ error: "That step does not belong to this task." });
    const input = ResumeNowSchema.parse(request.body ?? {});
    try {
      const outcome = engine.resume.request(
        { stepId, ...(input.reason ? { reason: input.reason } : {}) },
        { kind: "operator", id: actor },
      );
      return reply.code(outcome.status === "blocked" ? 409 : 202).send({
        ...outcome,
        ...(outcome.status === "blocked"
          ? { error: outcome.message, code: "blocked" }
          : {}),
      });
    } catch (error) {
      return conflict(reply, error);
    }
  });

  app.get("/api/worker-resume-requests", async (request) => {
    const query = ListSchema.parse(request.query);
    return {
      requests: engine.resume.list({
        limit: query.limit,
        ...(query.runId ? { runId: query.runId } : {}),
      }),
    };
  });

  app.post("/api/worker-resume-requests/:id/decision", async (request, reply) => {
    const { id } = request.params as { id: string };
    const operator = authenticatedOperator(request);
    if (!operator)
      return reply.code(403).send({
        error:
          "Only a signed-in operator can approve or cancel a resume exception; Node, MCP and no-login access cannot.",
      });
    try {
      return { request: engine.resume.decide(id, request.body, operator) };
    } catch (error) {
      return conflict(reply, error);
    }
  });
};
