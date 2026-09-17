import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { COMMAND_LIMITS, CommandDecisionSchema } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { FleetAuth } from "../auth/service.js";
import { requireAdministrator } from "./require-administrator.js";

const IdSchema = z.object({ id: z.string().uuid() });
const ListSchema = z.object({
  leadSessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});
const PageSchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limitBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(COMMAND_LIMITS.pageBytes)
    .default(16_384),
  format: z.enum(["text", "raw"]).default("text"),
});

/** Authentication and same-origin request protection are inherited from the Host. */
export const commandExecutionRoutes: FastifyPluginAsync<{
  service: FleetService;
  auth: FleetAuth;
}> = async (app, { service, auth }) => {
  app.get("/api/command-executions", async (request) => ({
    executions: service.commands.list(ListSchema.parse(request.query)),
  }));
  app.get("/api/command-executions/:id", async (request) =>
    service.commands.read(undefined, {
      executionId: IdSchema.parse(request.params).id,
      ...PageSchema.parse(request.query),
    }),
  );
  app.post("/api/command-executions/:id/decision", async (request, reply) => {
    const administrator = requireAdministrator(auth, request, reply, false);
    if (!administrator) return;
    return {
      execution: service.commands.decide(
        IdSchema.parse(request.params).id,
        CommandDecisionSchema.parse(request.body),
        administrator.id,
      ),
    };
  });
  app.post("/api/command-executions/:id/cancel", async (request, reply) => {
    if (!requireAdministrator(auth, request, reply, false)) return;
    return { execution: service.commands.cancel(IdSchema.parse(request.params).id) };
  });
};
