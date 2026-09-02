import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORCHESTRATOR_STOP_REASON } from "@fleet/protocol";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { fleet } from "../orchestrator/fleet-harness.js";
import { orchestratorRoutes } from "./orchestrators.js";
import { sessionRoutes } from "./sessions.js";

describe("orchestrator lifecycle routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const setup = async () => {
    const state = fleet();
    const { store, service, leadId } = state;
    const lead = store.getSession(leadId)!;
    store.transitionSession(leadId, "starting");
    store.transitionSession(leadId, "idle");
    store.appendEvent({
      eventId: "lead-agent",
      sessionId: leadId,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "lead-agent-session" },
      createdAt: new Date().toISOString(),
    });

    const run = store.createRun({
      workspaceId: lead.workspaceId,
      name: "Lifecycle",
      objective: "exercise stop and resume",
    });
    store.updateRun(run.id, { leadSessionId: leadId, state: "running" });
    const [done, active, descendant] = store.replaceRunSteps(run.id, [
      { stepKey: "done", title: "Done", prompt: "done" },
      { stepKey: "active", title: "Active", prompt: "active", dependsOn: ["done"] },
      {
        stepKey: "descendant",
        title: "Descendant",
        prompt: "descendant",
        dependsOn: ["active"],
      },
    ]);
    store.updateRunStep(done!.id, { state: "succeeded", output: "preserved" });

    const worker = store.createSession(
      store.getPlacement(lead.placementId)!,
      "active",
      false,
      "Active",
      { runId: run.id, runRole: "worker" },
    );
    store.transitionSession(worker.id, "starting");
    store.transitionSession(worker.id, "running");
    store.appendEvent({
      eventId: "worker-agent",
      sessionId: worker.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "worker-agent-session" },
      createdAt: new Date().toISOString(),
    });
    store.updateRunStep(active!.id, {
      state: "running",
      sessionId: worker.id,
      eventSeqFrom: 1,
    });

    const engine = new OrchestratorEngine(service);
    service.onSessionEvent((event) => engine.handleSessionEvent(event));
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(orchestratorRoutes, { service, engine });
    await app.register(sessionRoutes, { service });
    await app.ready();
    return {
      app,
      ...state,
      run,
      done: done!,
      active: active!,
      descendant: descendant!,
      worker,
    };
  };

  it("stops atomically, preserves terminal outcomes, and is idempotent", async () => {
    const { app, store, service, leadId, run, done, active, descendant, worker } =
      await setup();
    const dispatch = vi.spyOn(service, "dispatch");

    const first = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/stop`,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/stop`,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(store.getRun(run.id)).toMatchObject({
      state: "cancelled",
      failureReason: ORCHESTRATOR_STOP_REASON,
    });
    expect(store.getRunStep(done.id)).toMatchObject({
      state: "succeeded",
      output: "preserved",
    });
    expect(store.getRunStep(active.id)).toMatchObject({
      state: "cancelled",
      stoppedByOrchestrator: true,
    });
    expect(store.getRunStep(descendant.id)).toMatchObject({
      state: "cancelled",
      stoppedByOrchestrator: true,
    });
    expect(store.getSession(leadId)).toMatchObject({
      state: "idle",
      stopRequested: true,
    });
    expect(store.getSession(worker.id)).toMatchObject({
      state: "running",
      stopRequested: true,
    });
    expect(
      dispatch.mock.calls.filter(([, command]) => command.type === "stop"),
    ).toHaveLength(2);

    const newTask = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/runs`,
      payload: {
        workspaceId: store.getSession(leadId)!.workspaceId,
        name: "Too late",
        objective: "must not start",
      },
    });
    const newPrompt = await app.inject({
      method: "POST",
      url: `/api/sessions/${leadId}/prompt`,
      payload: { prompt: "must not send" },
    });
    expect(newTask.statusCode).toBe(409);
    expect(newPrompt.statusCode).toBe(409);
    expect(store.listRuns()).toHaveLength(1);
    expect(
      dispatch.mock.calls.filter(([, command]) => command.type === "prompt"),
    ).toHaveLength(0);
  });

  it("blocks early resume, then continues only stopped unfinished work once", async () => {
    const { app, store, service, leadId, run, done, active, descendant, worker } =
      await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });

    const early = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/resume`,
    });
    expect(early.statusCode).toBe(409);

    service.handleEvent({
      eventId: "worker-stopped",
      sessionId: worker.id,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    service.handleEvent({
      eventId: "lead-stopped",
      sessionId: leadId,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    const dispatch = vi.spyOn(service, "dispatch");

    const resumed = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/resume`,
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/resume`,
    });

    expect(resumed.statusCode).toBe(202);
    expect(repeated.statusCode).toBe(409);
    expect(store.getRun(run.id)?.state).toBe("running");
    expect(store.getRunStep(done.id)?.state).toBe("succeeded");
    expect(store.getRunStep(active.id)).toMatchObject({
      state: "pending",
      stoppedByOrchestrator: false,
      sessionId: worker.id,
    });
    expect(store.getRunStep(descendant.id)?.state).toBe("pending");
    expect(
      dispatch.mock.calls.filter(([, command]) => command.type === "resume_session"),
    ).toHaveLength(2);
  });

  it("resumes after reconnect inventory clears stale persisted Stop intents", async () => {
    const { app, store, service, leadId, run, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });

    expect(store.getSession(leadId)?.stopRequested).toBe(true);
    expect(store.getSession(worker.id)?.stopRequested).toBe(true);

    // A restarted Node has no live processes to acknowledge the old commands.
    // Its empty inventory is the authoritative acknowledgement instead.
    service.reconcile(store.getSession(leadId)!.nodeId, []);

    expect(store.getSession(leadId)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
    expect(store.getSession(worker.id)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });

    const resumed = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/resume`,
    });

    expect(resumed.statusCode).toBe(202);
    expect(store.getRun(run.id)?.state).toBe("running");
  });

  it("lets an operator confirm Stop when the owning node never reconnects", async () => {
    const { app, store, service, leadId, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    service.disconnectNode(store.getSession(leadId)!.nodeId, "Node unavailable");

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/stop`,
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      ok: true,
      confirmedStopped: true,
    });
    expect(store.getSession(leadId)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
    expect(store.getSession(worker.id)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
  });

  it("dismisses and restores visibility without mutating or deleting execution", async () => {
    const { app, store, service, leadId, run, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    service.handleEvent({
      eventId: "worker-stopped",
      sessionId: worker.id,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    service.handleEvent({
      eventId: "lead-stopped",
      sessionId: leadId,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });

    const dismissed = await app.inject({
      method: "DELETE",
      url: `/api/orchestrators/${leadId}`,
    });
    expect(dismissed.statusCode).toBe(200);
    expect(store.getSession(leadId)?.dismissed).toBe(true);
    expect(store.getRun(run.id)?.state).toBe("cancelled");

    const restored = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(store.getSession(leadId)?.dismissed).toBe(false);
    expect(store.getRun(run.id)?.state).toBe("cancelled");
  });

  it("finishes run reopening after a restart interrupted lead resume", async () => {
    const { app, store, service, leadId, run, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    service.handleEvent({
      eventId: "worker-stopped",
      sessionId: worker.id,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    service.handleEvent({
      eventId: "lead-stopped",
      sessionId: leadId,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });

    expect(service.resumeSession(leadId).ok).toBe(true);
    expect(store.getSession(leadId)?.state).toBe("starting");
    expect(store.getRun(run.id)?.state).toBe("cancelled");

    const recovered = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/resume`,
    });

    expect(recovered.statusCode).toBe(202);
    expect(recovered.json()).toMatchObject({ ok: true, recovered: true });
    expect(store.getRun(run.id)?.state).toBe("running");
  });
});
