import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_TIER_CONFIG_ID, ORCHESTRATOR_STOP_REASON } from "@fleet/protocol";
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

  it("sends /compact without renaming an orchestrator or discarding its history", async () => {
    const { app, store, service, leadId } = await setup();
    const dispatch = vi.spyOn(service, "dispatch");
    const name = store.getSession(leadId)!.name;
    const events = store.listEvents(leadId);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${leadId}/prompt`,
          payload: { prompt: "/compact" },
        })
      ).statusCode,
    ).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: "prompt",
        sessionId: leadId,
        prompt: "/compact",
        attachments: [],
      }),
      expect.anything(),
    );
    expect(store.getSession(leadId)!.name).toBe(name);
    expect(store.listEvents(leadId)).toEqual(events);
  });

  it("gates context changes on an idle session with a context picker", async () => {
    const { app, store, service, leadId } = await setup();
    const change = () =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${leadId}/config`,
        payload: { configId: CONTEXT_TIER_CONFIG_ID, value: "default" },
      });
    expect((await change()).statusCode).toBe(409);
    const session = store.getSession(leadId)!;
    store.setNodeIdentity(session.nodeId, {
      version: "0.6.0",
      capabilities: ["copilot-acp", "session-config"],
    });
    store.appendEvent({
      eventId: "context",
      sessionId: leadId,
      sequence: 2,
      type: "config",
      payload: {
        options: [
          { id: CONTEXT_TIER_CONFIG_ID, name: "Context", currentValue: "long_context" },
        ],
      },
      createdAt: new Date().toISOString(),
    });
    const dispatch = vi.spyOn(service, "dispatch");
    expect((await change()).statusCode).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(session.nodeId, {
      type: "set_config_option",
      sessionId: leadId,
      configId: CONTEXT_TIER_CONFIG_ID,
      value: "default",
    });
    store.transitionSession(leadId, "running");
    expect((await change()).statusCode).toBe(409);
    store.transitionSession(leadId, "idle");
    store.setSessionControls(leadId, { stopRequested: true });
    expect((await change()).statusCode).toBe(409);
  });

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

  it("creates managed tasks with a remote-main development branch target", async () => {
    const { app, store, service, leadId } = await setup();
    store.setManagedWorktreesEnabled(true);
    vi.spyOn(service.worktrees, "prepare").mockResolvedValue();
    const lead = store.getSession(leadId)!;

    const response = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/runs`,
      payload: {
        operationId: randomUUID(),
        workspaceMode: "managed",
        sourcePlacementId: lead.placementId,
        workspaceId: lead.workspaceId,
        name: "Read-only Dependencies Failing in Object Overview",
        objective: "Create and validate the fix.",
      },
    });

    expect(response.statusCode).toBe(201);
    const created = response.json().run;
    expect(created.workspaceBinding).toMatchObject({
      integrationBaseRef: "",
      integrationTargetRef: `refs/heads/dev/operator/fleet-${created.id.slice(0, 20)}`,
      integrationRemote: "origin",
    });
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

  it("resumes while retained child agents are idle", async () => {
    const { app, store, service, leadId, run, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    service.handleEvent({
      eventId: "lead-stopped-idle-worker",
      sessionId: leadId,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    store.transitionSession(worker.id, "idle", "Ready for follow-up");
    store.setSessionControls(worker.id, { stopRequested: false });

    const resumed = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/resume`,
    });

    expect(resumed.statusCode).toBe(202);
    expect(store.getRun(run.id)?.state).toBe("running");
    expect(store.getSession(worker.id)?.state).toBe("idle");
  });

  it("bulk stops only agents owned by the selected orchestrator", async () => {
    const { app, store, leadId, worker } = await setup();
    const lead = store.getSession(leadId)!;
    const unrelated = store.createSession(
      store.getPlacement(lead.placementId)!,
      "unrelated",
      false,
      "Unrelated",
    );
    store.transitionSession(unrelated.id, "starting");
    store.transitionSession(unrelated.id, "idle");

    const stopped = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/agents/stop`,
      payload: { sessionIds: [worker.id] },
    });

    expect(stopped.statusCode).toBe(202);
    expect(stopped.json()).toMatchObject({ matched: 1, requested: 1 });
    expect(store.getSession(worker.id)?.stopRequested).toBe(true);
    expect(store.getSession(leadId)?.stopRequested).toBe(false);
    expect(store.getSession(unrelated.id)?.stopRequested).toBe(false);
  });

  it("bulk stops all non-orchestrator agents without stopping leads", async () => {
    const { app, store, leadId, worker } = await setup();
    const lead = store.getSession(leadId)!;
    const manual = store.createSession(
      store.getPlacement(lead.placementId)!,
      "manual",
      false,
      "Manual",
    );
    store.transitionSession(manual.id, "starting");
    store.transitionSession(manual.id, "idle");

    const stopped = await app.inject({
      method: "POST",
      url: "/api/sessions/stop",
      payload: { sessionIds: [worker.id, manual.id] },
    });

    expect(stopped.statusCode).toBe(202);
    expect(stopped.json()).toMatchObject({ matched: 2, requested: 2 });
    expect(store.getSession(worker.id)?.stopRequested).toBe(true);
    expect(store.getSession(manual.id)?.stopRequested).toBe(true);
    expect(store.getSession(leadId)?.stopRequested).toBe(false);
  });

  it("favorites agents and orchestrator conversations persistently", async () => {
    const { app, store, leadId, worker } = await setup();

    const favoriteLead = await app.inject({
      method: "PUT",
      url: `/api/sessions/${leadId}/favorite`,
      payload: { favorite: true },
    });
    const favoriteWorker = await app.inject({
      method: "PUT",
      url: `/api/sessions/${worker.id}/favorite`,
      payload: { favorite: true },
    });

    expect(favoriteLead.statusCode).toBe(200);
    expect(favoriteWorker.statusCode).toBe(200);
    expect(store.getSession(leadId)?.favorite).toBe(true);
    expect(store.getSession(worker.id)?.favorite).toBe(true);
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

  it("bulk cleans up selected stopped orchestrators without deleting history", async () => {
    const { app, store, service, leadId, run, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    service.handleEvent({
      eventId: "worker-stopped-for-cleanup",
      sessionId: worker.id,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    service.handleEvent({
      eventId: "lead-stopped-for-cleanup",
      sessionId: leadId,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });

    const cleaned = await app.inject({
      method: "POST",
      url: "/api/orchestrators/cleanup",
      payload: { sessionIds: [leadId] },
    });

    expect(cleaned.statusCode).toBe(200);
    expect(cleaned.json()).toMatchObject({ ok: true, cleaned: 1 });
    expect(store.getSession(leadId)?.dismissed).toBe(true);
    expect(store.getRun(run.id)?.state).toBe("cancelled");
    expect(store.listRunSteps(run.id)).toHaveLength(3);
  });

  it("refuses a bulk cleanup if any selected orchestrator still has live work", async () => {
    const { app, store, leadId } = await setup();
    store.transitionSession(leadId, "stopped");

    const cleaned = await app.inject({
      method: "POST",
      url: "/api/orchestrators/cleanup",
      payload: { sessionIds: [leadId] },
    });

    expect(cleaned.statusCode).toBe(409);
    expect(store.getSession(leadId)?.dismissed).toBe(false);
  });

  it("validates every selected orchestrator before cleaning up any of them", async () => {
    const { app, store, service, leadId, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    service.handleEvent({
      eventId: "worker-stopped-before-validation",
      sessionId: worker.id,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    service.handleEvent({
      eventId: "lead-stopped-before-validation",
      sessionId: leadId,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });

    const cleaned = await app.inject({
      method: "POST",
      url: "/api/orchestrators/cleanup",
      payload: { sessionIds: [leadId, "missing-orchestrator"] },
    });

    expect(cleaned.statusCode).toBe(409);
    expect(store.getSession(leadId)?.dismissed).toBe(false);
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
