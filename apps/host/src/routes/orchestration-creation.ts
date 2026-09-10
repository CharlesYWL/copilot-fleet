import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OrchestrationCreationResult } from "@fleet/protocol";
import type { OrchestrationCreationService } from "../orchestrator/creation.js";
import { DriError } from "../dri/safety.js";

export function creationError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof DriError)
    return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof z.ZodError)
    return reply.code(400).send({ error: "Invalid bounded orchestration input" });
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)
  )
    return reply
      .code(error.statusCode)
      .send({ error: "Invalid or oversized orchestration request" });
  request.log.error("Orchestration creation failed safely");
  return reply.code(500).send({ error: "Orchestration creation failed safely" });
}

export function sendCreation(reply: FastifyReply, result: OrchestrationCreationResult) {
  if (result.kind === "confirmation_required")
    return reply.code(409).send({
      ...result,
      error: result.classification.explanation,
    });
  return reply.code(result.replayed ? 200 : 201).send(result);
}

export const orchestrationCreationRoutes: FastifyPluginAsync<{
  creation: OrchestrationCreationService;
}> = async (app, { creation }) => {
  app.setErrorHandler(creationError);
  app.post("/api/orchestrations/preview", { bodyLimit: 32_768 }, async (request) =>
    creation.preview(request.body),
  );
  app.post("/api/orchestrations", { bodyLimit: 32_768 }, async (request, reply) =>
    sendCreation(reply, creation.create(request.body)),
  );
};
