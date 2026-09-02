import Fastify, { type FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORCHESTRATOR_STOP_REASON } from "@fleet/protocol";
import { FleetService } from "../fleet-service.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { FleetStore } from "../store.js";
import { orchestratorRoutes } from "./orchestrators.js";
import { runRoutes } from "./runs.js";

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
} as unknown as FastifyBaseLogger;

describe("review notification lifecycle", () => {
  let app: FastifyInstance;
  let store: FleetStore;
  let service: FleetService;
  let workspaceId: string;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    store = new FleetStore(":memory:");
    service = new FleetService(store, silentLog, "");
    const engine = new OrchestratorEngine(service);
    workspaceId = store.createWorkspace("repo", "").id;
    await app.register(orchestratorRoutes, { service, engine });
    await app.register(runRoutes, { service, engine });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const awaitingReview = (name: string) => {
    const run = store.createRun({
      workspaceId,
      name,
      objective: "private objective",
    });
    store.setRunState(run.id, "running");
    return service.requestRunReview({
      runId: run.id,
      note: "private handover note",
      reason: "completed",
    })!;
  };

  it("resolves the active record on approval without changing the approval flow", async () => {
    const run = awaitingReview("Approve me");

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/review`,
      payload: { approved: true, note: "Looks good." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      run: { id: run.id, state: "completed" },
    });
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)).toMatchObject({
      status: "resolved",
    });
  });

  it("resolves send-back, then creates a new active record on resubmit", async () => {
    const run = awaitingReview("Send me back");

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/review`,
      payload: { approved: false, note: "Add the missing migration." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      run: { id: run.id, state: "running" },
    });
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)).toMatchObject({
      status: "resolved",
    });

    const resubmitted = service.requestRunReview({
      runId: run.id,
      note: "The migration is now included.",
      reason: "completed",
    })!;
    expect(resubmitted.reviewSeq).toBe(2);
    expect(store.getNotificationBySourceKey(`review:${run.id}:2`)).toMatchObject({
      status: "active",
      subject: { id: run.id, label: "Send me back" },
      navigation: { type: "run", runId: run.id },
    });
  });

  it("resolves the active record when the task is cancelled", async () => {
    const run = awaitingReview("Cancel me");

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/cancel`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run: { id: run.id, state: "cancelled" },
    });
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)).toMatchObject({
      status: "resolved",
    });
  });

  it("resolves reviews while preserving resumable orchestrator cancellation", async () => {
    const { node } = store.registerNode({
      name: "node",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 2,
    });
    const placement = store.createPlacement(workspaceId, node.id, "/repo");
    const lead = store.createSession(placement, "orchestrate", true, "Lead", {
      runRole: "lead",
    });
    const run = store.createRun({
      workspaceId,
      name: "Owned review",
      objective: "finish it",
    });
    store.updateRun(run.id, {
      state: "running",
      leadSessionId: lead.id,
    });
    service.requestRunReview({
      runId: run.id,
      note: "ready",
      reason: "completed",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${lead.id}/stop`,
    });

    expect(response.statusCode).toBe(200);
    expect(store.getRun(run.id)).toMatchObject({
      state: "cancelled",
      failureReason: ORCHESTRATOR_STOP_REASON,
    });
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)).toMatchObject({
      status: "resolved",
    });
  });
});
