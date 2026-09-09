import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DriKey,
  DriPageInputSchema,
  DriProposalScopeSchema,
  renderDriReport,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { DriCoordinator } from "../dri/coordinator.js";
import { DriError } from "../dri/safety.js";

const Collections = z.enum([
  "incidents",
  "timeline",
  "evidence",
  "artifacts",
  "queries",
  "hypotheses",
  "similar",
  "changes",
  "reports",
  "audit",
  "work",
]);
function ifMatch(request: FastifyRequest): number {
  const value = request.headers["if-match"];
  if (typeof value !== "string" || !/^"(0|[1-9]\d{0,9})"$/.test(value)) {
    throw new DriError("A quoted revision in If-Match is required", 428);
  }
  return Number(value.slice(1, -1));
}
export const driRoutes: FastifyPluginAsync<{
  service: FleetService;
  coordinator: DriCoordinator;
}> = async (app, { service, coordinator }) => {
  const store = service.store.dri;
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DriError)
      return reply.code(error.statusCode).send({ error: error.message });
    return reply.code(error instanceof z.ZodError ? 400 : 500).send({
      error:
        error instanceof z.ZodError
          ? "Invalid DRI input or bounded proposal"
          : "DRI operation failed safely",
    });
  });
  app.get("/api/dri/profiles", async () => ({
    profiles: coordinator.profiles.list(),
    liveProviders: coordinator.live.list(),
    availability: coordinator.availability(),
  }));
  app.get("/api/dri", async (request) =>
    store.list(DriPageInputSchema.parse(request.query)),
  );
  app.post("/api/dri", { bodyLimit: 32_768 }, async (request, reply) => {
    const investigation = coordinator.create(request.body);
    void coordinator.execute(investigation.id);
    return reply
      .code(201)
      .header("etag", `"${investigation.revision}"`)
      .send(investigation);
  });
  app.get("/api/dri/by-run/:runId", async (request, reply) => {
    const { runId } = z.object({ runId: DriKey }).parse(request.params);
    const investigation = store.forRun(runId);
    if (!investigation) return reply.code(404).send({ error: "Investigation not found" });
    return investigation;
  });
  app.get("/api/dri/:id", async (request, reply) => {
    const { id } = z.object({ id: DriKey }).parse(request.params);
    const investigation = store.require(id);
    return reply.header("etag", `"${investigation.revision}"`).send({
      investigation,
      providers: coordinator.registry(investigation).list(),
      work: store.all(id, "work"),
      run: service.store.getRun(investigation.runId),
      availability: coordinator.availability(),
    });
  });
  app.get("/api/dri/:id/profile", async (request) => {
    const { id } = z.object({ id: DriKey }).parse(request.params);
    return { current: store.require(id).profile, decisions: store.decisions(id) };
  });
  app.patch("/api/dri/:id/profile", async (request) => {
    const { id } = z.object({ id: DriKey }).parse(request.params);
    const { profile } = z.object({ profile: DriKey }).strict().parse(request.body);
    return coordinator.correctProfile(id, ifMatch(request), profile);
  });
  app.patch("/api/dri/:id/retention", async (request) => {
    const { id } = z.object({ id: DriKey }).parse(request.params);
    const { legalHold } = z
      .object({ legalHold: z.boolean() })
      .strict()
      .parse(request.body);
    return coordinator.setLegalHold(id, ifMatch(request), legalHold);
  });
  app.get("/api/dri/:id/:collection", async (request) => {
    const { id, collection } = z
      .object({ id: DriKey, collection: Collections })
      .parse(request.params);
    return store.page(id, collection, DriPageInputSchema.parse(request.query));
  });
  app.get("/api/dri/:id/evidence/:evidenceId", async (request, reply) => {
    const { id, evidenceId } = z
      .object({ id: DriKey, evidenceId: DriKey })
      .parse(request.params);
    const evidence = store.record(id, "evidence", evidenceId);
    if (!evidence) return reply.code(404).send({ error: "Evidence not found" });
    return evidence;
  });
  app.get("/api/dri/:id/reports/:reportId", async (request, reply) => {
    const { id, reportId } = z
      .object({ id: DriKey, reportId: DriKey })
      .parse(request.params);
    const report = store.record(id, "reports", reportId);
    if (!report) return reply.code(404).send({ error: "Report not found" });
    return { report, markdown: renderDriReport(report) };
  });
  for (const operation of ["stop", "resume", "complete"] as const) {
    app.post(`/api/dri/:id/${operation}`, async (request) => {
      const { id } = z.object({ id: DriKey }).parse(request.params);
      const result = coordinator[operation](id, ifMatch(request));
      if (operation === "resume") void coordinator.execute(id);
      return result;
    });
  }
  app.post("/api/dri/:id/fixture/execute", async (request) => {
    const { id } = z.object({ id: DriKey }).parse(request.params);
    const investigation = store.require(id);
    if (investigation.mode !== "fixture")
      throw new DriError("Fixture operation requires fixture mode", 403);
    if (investigation.revision !== ifMatch(request))
      throw new DriError("Stale revision", 412);
    await coordinator.execute(id);
    return store.require(id);
  });
  app.post("/api/dri/:id/proposals", { bodyLimit: 65_536 }, async (request) => {
    const { id } = z.object({ id: DriKey }).parse(request.params);
    const investigation = store.require(id);
    if (investigation.revision !== ifMatch(request))
      throw new DriError("Stale revision", 412);
    if (!request.fleetSession)
      throw new DriError("An authenticated operator is required", 403);
    const proposal = z
      .object({ scope: DriProposalScopeSchema, record: z.unknown() })
      .strict()
      .parse(request.body);
    // Caller authorization is the independent operator session/CSRF guard.
    // Producer coordinates are checked against persisted receipts, not treated as credentials.
    return coordinator.propose(id, proposal.record, proposal.scope);
  });
};
