import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_TIER_CONFIG_ID,
  HostToNodeMessageSchema,
  ORCHESTRATOR_STOP_REASON,
  type FleetSession,
  type NodeCommand,
} from "@fleet/protocol";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { fleet } from "../orchestrator/fleet-harness.js";
import { archiveRun } from "../orchestrator/lifecycle.js";
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
    /**
     * What Stop did before it became lead-only: cancel every owned task as
     * orchestration-stopped, then stop the lead. Databases written by an older
     * Host still hold tasks in this state, and Resume must still reopen them.
     */
    const legacyStop = async () => {
      archiveRun(service, run.id, ORCHESTRATOR_STOP_REASON, {
        stoppedByOrchestrator: true,
      });
      return app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    };
    return {
      app,
      ...state,
      run,
      done: done!,
      active: active!,
      descendant: descendant!,
      worker,
      legacyStop,
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

  it("selects a Hermes-capable placement and keeps the backend/profile through resume", async () => {
    const { app, store, service, leadId, addNode } = await setup();
    const node = addNode("Hermes Node");
    store.registerNode({
      ...node,
      agents: [{ name: "fleet-orchestrator", description: "Copilot persona" }],
    });
    store.setNodeIdentity(node.id, {
      capabilities: ["copilot-acp", "host-yolo", "agent-kinds"],
      agentKinds: [{ kind: "copilot" }, { kind: "hermes" }],
    });
    const params = { kind: "hermes", profile: "fleet-orchestrator" } as const;
    store.setOrchestratorAgent(params);
    store.setDefaultModel("copilot-only-model");
    store.setAgencyMode(true);
    const sent = vi.spyOn(service, "send");
    const commands = () =>
      sent.mock.calls.flatMap(([, frame]) => {
        const parsed = HostToNodeMessageSchema.safeParse(frame);
        return parsed.success && parsed.data.type === "command"
          ? [parsed.data.command]
          : [];
      });
    const response = await app.inject({
      method: "POST",
      url: "/api/orchestrators",
      payload: { workspaceId: store.getSession(leadId)!.workspaceId },
    });
    expect(response.statusCode).toBe(201);
    const session = response.json<{ session: FleetSession }>().session;
    expect(session).toMatchObject({ nodeId: node.id, agentParams: params });
    const start = commands().find((command) => command.type === "start_session")!;
    expect(start).toMatchObject({
      agentParams: params,
      agent: "",
      config: [],
      yolo: true,
    });
    expect(start).toMatchObject({
      prompt: expect.stringContaining("You do not write code yourself"),
    });
    expect(start).not.toHaveProperty("agencyMode");
    expect(start).not.toHaveProperty("contextTier");
    expect(start).toMatchObject({ mcpServers: [{ name: "fleet" }] });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/orchestrators",
      payload: { workspaceId: session.workspaceId },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toMatch(/profile.*already belongs/);

    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "idle");
    store.appendEvent({
      eventId: randomUUID(),
      sessionId: session.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "hermes-saved" },
      createdAt: new Date().toISOString(),
    });
    store.transitionSession(session.id, "stopped");
    store.setOrchestratorAgent({ kind: "copilot" });
    expect(service.resumeSession(session.id).ok).toBe(true);
    expect(commands().at(-1)).toMatchObject({
      type: "resume_session",
      agentParams: params,
      agentSessionId: "hermes-saved",
      agent: "",
      config: [],
      mcpServers: [{ name: "fleet" }],
    });
    store.transitionSession(session.id, "stopped");
    store.setNodeIdentity(node.id, {
      capabilities: ["copilot-acp", "host-yolo"],
      agentKinds: [],
    });
    const before = commands().length;
    expect(service.resumeSession(session.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Hermes is unavailable"),
    });
    expect(commands()).toHaveLength(before);
  });

  it("falls back visibly only for a new lead and never changes workers", async () => {
    const { app, store, service, leadId } = await setup();
    store.setOrchestratorAgent({ kind: "hermes", profile: "fleet-orchestrator" });
    const sent = vi.spyOn(service, "send");
    const response = await app.inject({
      method: "POST",
      url: "/api/orchestrators",
      payload: { workspaceId: store.getSession(leadId)!.workspaceId },
    });
    expect(response.statusCode).toBe(201);
    const session = response.json<{ session: FleetSession }>().session;
    expect(session.agentParams).toEqual({ kind: "copilot" });
    const commands: NodeCommand[] = sent.mock.calls.flatMap(([, frame]) => {
      const parsed = HostToNodeMessageSchema.safeParse(frame);
      return parsed.success && parsed.data.type === "command"
        ? [parsed.data.command]
        : [];
    });
    expect(commands.at(-1)).toMatchObject({
      type: "start_session",
      agentParams: { kind: "copilot" },
      startupNotice: `Preferred agent Hermes is unavailable on the online Nodes holding this workspace. Started with Copilot on ${session.nodeName}.`,
    });
    const worker = service.createAndStartSession({
      placement: store.getPlacement(session.placementId)!,
      prompt: "Work",
      yolo: false,
      runRole: "worker",
    });
    expect(worker.ok && worker.session.agentParams).toEqual({ kind: "copilot" });
    expect(
      service.createAndStartSession({
        placement: store.getPlacement(session.placementId)!,
        prompt: "Work",
        yolo: true,
        runRole: "worker",
        agentParams: { kind: "hermes", profile: "fleet-orchestrator" },
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("creates a Copilot orchestrator when a stored preference cannot be parsed", async () => {
    const { app, store, leadId } = await setup();
    store.setSetting("orchestrator.agent", "{invalid");
    const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/orchestrators",
        payload: { workspaceId: store.getSession(leadId)!.workspaceId },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json<{ session: FleetSession }>().session.agentParams).toEqual({
        kind: "copilot",
      });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("using Auto (Copilot)"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("releases an offline Hermes profile through confirmed Stop, not by hiding a possibly live process", async () => {
    const { app, store, service, leadId, addNode } = await setup();
    const placement = store.getPlacement(store.getSession(leadId)!.placementId)!;
    store.setNodeIdentity(placement.nodeId, {
      capabilities: ["copilot-acp", "host-yolo", "agent-kinds"],
      agentKinds: [{ kind: "copilot" }, { kind: "hermes" }],
    });
    const node = store.getNode(placement.nodeId)!;
    const params = { kind: "hermes", profile: "fleet-orchestrator" } as const;
    const lead = store.createSession(placement, "Plan", true, "Hermes", {
      runRole: "lead",
      agentParams: params,
      readOnly: true,
    });
    store.transitionSession(lead.id, "starting");
    store.transitionSession(lead.id, "idle");
    expect(
      (await app.inject({ method: "DELETE", url: `/api/orchestrators/${lead.id}` }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: "POST", url: `/api/orchestrators/${lead.id}/stop` }))
        .statusCode,
    ).toBe(202);
    expect(service.agentLaunchProblem(node, params)).toContain("already belongs");
    service.disconnectNode(node.id, "Node unavailable");
    expect(store.getSession(lead.id)).toMatchObject({
      state: "offline",
      stopRequested: true,
    });
    expect(service.agentLaunchProblem(node, params)).toContain("Mark stopped");
    expect(
      (await app.inject({ method: "DELETE", url: `/api/orchestrators/${lead.id}` }))
        .statusCode,
    ).toBe(409);
    const anotherNode = addNode("another-hermes-node");
    store.setNodeIdentity(anotherNode.id, {
      capabilities: ["copilot-acp", "host-yolo", "agent-kinds"],
      agentKinds: [{ kind: "hermes" }],
    });
    expect(
      service.agentLaunchProblem(store.getNode(anotherNode.id)!, params),
    ).toBeUndefined();

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${lead.id}/stop`,
    });
    expect(confirmed.json()).toMatchObject({ confirmedStopped: true });
    expect(store.getSession(lead.id)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
    expect(service.agentLaunchProblem(node, params)).toBeUndefined();
    expect(
      (await app.inject({ method: "DELETE", url: `/api/orchestrators/${lead.id}` }))
        .statusCode,
    ).toBe(200);
    expect(store.getSession(lead.id)?.dismissed).toBe(true);
    expect(service.agentLaunchProblem(node, params)).toBeUndefined();
    store.deleteSession(lead.id);
    expect(service.agentLaunchProblem(node, params)).toBeUndefined();
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

  it("stops only the lead conversation, leaving its tasks and workers running", async () => {
    const { app, store, service, leadId, run, done, active, descendant, worker } =
      await setup();
    const dispatch = vi.spyOn(service, "dispatch");
    const steps = store.listRunSteps(run.id);

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
    expect(store.getRun(run.id)).toMatchObject({ state: "running", failureReason: "" });
    expect(store.listRunSteps(run.id)).toEqual(steps);
    expect(store.getRunStep(done.id)).toMatchObject({
      state: "succeeded",
      output: "preserved",
    });
    expect(store.getRunStep(active.id)).toMatchObject({
      state: "running",
      stoppedByOrchestrator: false,
    });
    expect(store.getRunStep(descendant.id)).toMatchObject({
      state: "pending",
      stoppedByOrchestrator: false,
    });
    expect(store.getSession(leadId)).toMatchObject({
      state: "idle",
      stopRequested: true,
    });
    expect(store.getSession(worker.id)).toMatchObject({
      state: "running",
      stopRequested: false,
    });
    expect(
      dispatch.mock.calls
        .filter(([, command]) => command.type === "stop")
        .map(([, command]) => command.sessionId),
    ).toEqual([leadId]);

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

    // Once the lead is gone its work carries on; the result is owed to it.
    service.handleEvent({
      eventId: "lead-stopped-work-continues",
      sessionId: leadId,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    expect(store.getRun(run.id)?.state).toBe("running");
    expect(store.getSession(worker.id)).toMatchObject({
      state: "running",
      stopRequested: false,
    });
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
      integrationTargetRef:
        "refs/heads/dev/operator/read-only-dependencies-failing-in-object-overvie",
      integrationRemote: "origin",
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/runs`,
      payload: {
        operationId: randomUUID(),
        workspaceMode: "managed",
        sourcePlacementId: lead.placementId,
        workspaceId: lead.workspaceId,
        name: "Read-only Dependencies Failing in Object Overview",
        objective: "Create and validate another fix.",
      },
    });

    expect(duplicate.statusCode).toBe(201);
    const duplicateRun = duplicate.json().run;
    expect(duplicateRun.workspaceBinding.integrationTargetRef).toBe(
      `refs/heads/dev/operator/read-only-dependencies-failing-in-objec-${duplicateRun.id.slice(0, 8)}`,
    );
  });

  it("blocks early resume, then continues only stopped unfinished work once", async () => {
    const {
      app,
      store,
      service,
      leadId,
      run,
      done,
      active,
      descendant,
      worker,
      legacyStop,
    } = await setup();
    await legacyStop();

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
    const { app, store, service, leadId, run, worker, legacyStop } = await setup();
    await legacyStop();
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

  it.each(["running", "cancelling", "offline", "idle"] as const)(
    "resumes a failed lead without interrupting a worker in %s state",
    async (workerState) => {
      const { app, store, service, leadId, run, worker } = await setup();
      store.transitionSession(worker.id, workerState);
      service.handleEvent({
        eventId: "lead-mcp-refresh-failed",
        sessionId: leadId,
        sequence: 2,
        type: "state",
        payload: {
          state: "failed",
          activity: "Copilot could not be restarted to restore MCP tools",
        },
        createdAt: new Date().toISOString(),
      });
      const originalWorker = store.getSession(worker.id);
      const originalRun = store.getRun(run.id);
      const originalSteps = store.listRunSteps(run.id);
      const originalEvents = store.listEvents(leadId);
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
      expect(resumed.json()).toMatchObject({ ok: true, recovered: false });
      expect(repeated.statusCode).toBe(409);
      expect(store.getSession(leadId)).toMatchObject({
        state: "starting",
        agentSessionId: "lead-agent-session",
        stopRequested: false,
      });
      expect(store.getSession(worker.id)).toEqual(originalWorker);
      expect(store.getRun(run.id)).toEqual(originalRun);
      expect(store.listRunSteps(run.id)).toEqual(originalSteps);
      expect(store.listEvents(leadId)).toEqual(originalEvents);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        store.getSession(leadId)!.nodeId,
        expect.objectContaining({
          type: "resume_session",
          sessionId: leadId,
          agentSessionId: "lead-agent-session",
          mcpServers: [expect.objectContaining({ name: "fleet" })],
        }),
        expect.anything(),
      );
    },
  );

  it.each([
    ["running", true],
    ["idle", true],
    ["offline", true],
    ["running", false],
    ["offline", false],
  ] as const)(
    "keeps Stop safeguards for worker state=%s, stopRequested=%s after the lead acknowledges",
    async (workerState, stopRequested) => {
      const { app, store, service, leadId, run, worker, legacyStop } = await setup();
      await legacyStop();
      service.handleEvent({
        eventId: "lead-stopped-before-worker",
        sessionId: leadId,
        sequence: 2,
        type: "state",
        payload: { state: "stopped", activity: "Stopped" },
        createdAt: new Date().toISOString(),
      });
      store.transitionSession(worker.id, workerState);
      store.setSessionControls(worker.id, { stopRequested });
      const originalSteps = store.listRunSteps(run.id);
      const dispatch = vi.spyOn(service, "dispatch");

      const resumed = await app.inject({
        method: "POST",
        url: `/api/orchestrators/${leadId}/resume`,
      });

      expect(resumed.statusCode).toBe(409);
      expect(resumed.json()).toEqual({
        error: "Wait for every node to acknowledge Stop before resuming",
      });
      expect(store.getSession(leadId)).toMatchObject({
        state: "stopped",
        stopRequested: false,
      });
      expect(store.getRun(run.id)?.state).toBe("cancelled");
      expect(store.listRunSteps(run.id)).toEqual(originalSteps);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["failed", "stopped"] as const)(
    "resumes a %s lead while one of its workers is still being stopped",
    async (leadState) => {
      // The scheduler parks settled workers while the lead is away, and an
      // operator may stop one; neither is a Stop the lead has to wait out.
      const { app, store, service, leadId, run, worker } = await setup();
      store.transitionSession(leadId, leadState);
      store.setSessionControls(worker.id, { stopRequested: true });
      const originalRun = store.getRun(run.id);
      const dispatch = vi.spyOn(service, "dispatch");

      const resumed = await app.inject({
        method: "POST",
        url: `/api/orchestrators/${leadId}/resume`,
      });

      expect(resumed.statusCode).toBe(202);
      expect(store.getRun(run.id)).toEqual(originalRun);
      expect(store.getSession(leadId)?.state).toBe("starting");
      expect(store.getSession(worker.id)?.stopRequested).toBe(true);
      expect(
        dispatch.mock.calls.map(([, command]) => [command.type, command.sessionId]),
      ).toEqual([["resume_session", leadId]]);
    },
  );

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
    expect(store.getSession(worker.id)?.stopRequested).toBe(false);

    // A restarted Node has no live processes to acknowledge the old commands.
    // Its empty inventory is the authoritative acknowledgement instead.
    service.reconcile(store.getSession(leadId)!.nodeId, []);

    expect(store.getSession(leadId)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
    expect(store.getSession(worker.id)).toMatchObject({
      state: "running",
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
    // Stopped by its own action, not by the lead's: confirming the lead's Stop
    // also settles a Stop already asked of a worker on the same lost machine.
    const parked = store.createSession(
      store.getPlacement(store.getSession(leadId)!.placementId)!,
      "parked",
      false,
      "Parked",
      { runId: worker.runId, runRole: "worker" },
    );
    store.transitionSession(parked.id, "starting");
    store.transitionSession(parked.id, "offline");
    store.setSessionControls(parked.id, { stopRequested: true });

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
    expect(store.getSession(parked.id)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
    expect(store.getSession(worker.id)).toMatchObject({
      state: "offline",
      stopRequested: false,
    });
  });

  it("dismisses and restores visibility without mutating or deleting execution", async () => {
    const { app, store, service, leadId, run, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    service.handleEvent({
      eventId: "lead-stopped",
      sessionId: leadId,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });

    const early = await app.inject({
      method: "DELETE",
      url: `/api/orchestrators/${leadId}`,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({
      error: "Archive or finish this orchestrator's tasks before dismissing it",
    });
    expect(store.getSession(leadId)?.dismissed).toBe(false);

    archiveRun(service, run.id, "Archived by an operator");
    service.handleEvent({
      eventId: "worker-stopped",
      sessionId: worker.id,
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
    archiveRun(service, run.id, "Archived by an operator");
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
    const { app, store, service, leadId, run, worker } = await setup();
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    archiveRun(service, run.id, "Archived by an operator");
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
    const { app, store, service, leadId, run, worker, addNode, legacyStop } =
      await setup();
    await legacyStop();
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

    const remoteNode = addNode("remote");
    const ongoingRun = store.createRun({
      workspaceId: run.workspaceId,
      name: "Already resumed",
      objective: "keep working",
    });
    store.updateRun(ongoingRun.id, { leadSessionId: leadId, state: "running" });
    const ongoingWorker = store.createSession(
      store
        .listPlacements()
        .find(
          (placement) =>
            placement.nodeId === remoteNode.id &&
            placement.workspaceId === run.workspaceId,
        )!,
      "keep working",
      false,
      "Remote worker",
      { runId: ongoingRun.id, runRole: "worker" },
    );
    store.transitionSession(ongoingWorker.id, "starting");
    store.transitionSession(ongoingWorker.id, "running");
    const [ongoingStep] = store.replaceRunSteps(ongoingRun.id, [
      { stepKey: "active", title: "Active", prompt: "keep working" },
    ]);
    store.updateRunStep(ongoingStep!.id, {
      state: "running",
      sessionId: ongoingWorker.id,
    });
    const originalWorker = store.getSession(ongoingWorker.id);
    const originalRun = store.getRun(ongoingRun.id);
    const originalSteps = store.listRunSteps(ongoingRun.id);
    const dispatch = vi.spyOn(service, "dispatch");

    const recovered = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/resume`,
    });

    expect(recovered.statusCode).toBe(202);
    expect(recovered.json()).toMatchObject({ ok: true, recovered: true });
    expect(store.getRun(run.id)?.state).toBe("running");
    expect(store.getSession(ongoingWorker.id)).toEqual(originalWorker);
    expect(store.getRun(ongoingRun.id)).toEqual(originalRun);
    expect(store.listRunSteps(ongoingRun.id)).toEqual(originalSteps);
    expect(
      dispatch.mock.calls.some(
        ([, command]) =>
          "sessionId" in command &&
          (command.sessionId === ongoingWorker.id || command.sessionId === leadId),
      ),
    ).toBe(false);
  });
});

describe("task transfer routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const setup = async () => {
    const world = fleet();
    const { store, service, leadId } = world;
    const idle = (id: string) => {
      store.transitionSession(id, "starting");
      store.transitionSession(id, "idle");
    };
    idle(leadId);
    const next = store.createSession(
      store.listPlacements()[0]!,
      "orchestrate",
      true,
      "Relief",
      { runRole: "lead" },
    );
    idle(next.id);
    const task = (
      name: string,
      state: "running" | "completed" | "awaiting_human" = "running",
      owner = leadId,
    ) => {
      const run = store.createRun({
        workspaceId: store.getSession(leadId)!.workspaceId,
        name,
        objective: `${name}, carefully`,
      });
      return store.updateRun(run.id, { leadSessionId: owner, state })!;
    };
    const engine = new OrchestratorEngine(service);
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(orchestratorRoutes, { service, engine });
    await app.ready();
    return { ...world, app, next, task };
  };

  it("moves one task to another conversation and briefs it there", async () => {
    const { app, store, service, leadId, next, task } = await setup();
    const run = task("One");
    const dispatch = vi.spyOn(service, "dispatch");

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/transfer`,
      payload: { toSessionId: next.id, note: "Review is next." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      changed: true,
      from: leadId,
      run: { id: run.id, leadSessionId: next.id },
    });
    expect(store.getRun(run.id)!.leadSessionId).toBe(next.id);
    expect(dispatch).toHaveBeenCalledWith(
      next.nodeId,
      expect.objectContaining({
        type: "prompt",
        sessionId: next.id,
        prompt: expect.stringContaining("Review is next."),
      }),
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/orchestrators" }))
        .json()
        .orchestrators.find(
          (entry: { session: { id: string } }) => entry.session.id === next.id,
        )
        .runs.map((entry: { id: string }) => entry.id),
    ).toEqual([run.id]);
  });

  it("explains why a task cannot move", async () => {
    const { app, store, next, task } = await setup();
    const run = task("One");
    store.setSessionControls(next.id, { stopRequested: true });

    const stopped = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/transfer`,
      payload: { toSessionId: next.id },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/runs/missing/transfer",
      payload: { toSessionId: next.id },
    });

    expect(stopped.statusCode).toBe(409);
    expect(stopped.json()).toMatchObject({ code: "orchestrator_not_live" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "task_not_found" });
  });

  it("moves every task that still needs an orchestrator, and reports the rest", async () => {
    const { app, store, leadId, next, task } = await setup();
    const open = task("Open");
    const closed = task("Closed", "completed");
    const theirs = task("Theirs", "running", next.id);

    const all = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/transfer`,
      payload: { toSessionId: next.id },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ ok: true, transferred: [open.id], failed: [] });
    expect(store.getRun(closed.id)!.leadSessionId).toBe(leadId);

    const chosen = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/transfer`,
      payload: { toSessionId: next.id, runIds: [closed.id, theirs.id] },
    });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json()).toMatchObject({
      transferred: [closed.id],
      failed: [
        { runId: theirs.id, error: expect.stringContaining("no longer assigned") },
      ],
    });
    expect(store.getRun(closed.id)!.leadSessionId).toBe(next.id);

    const nothing = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/transfer`,
      payload: { toSessionId: next.id, runIds: [theirs.id] },
    });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json().error).toContain("no longer assigned");

    const itself = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/transfer`,
      payload: { toSessionId: leadId },
    });
    expect(itself.statusCode).toBe(409);
  });

  it("keeps an unread handoff brief when the person sends the task back", async () => {
    const { app, store, next, task } = await setup();
    const run = task("Reviewed", "awaiting_human");
    // Busy, so the brief is still owed when the review arrives.
    store.transitionSession(next.id, "running");
    await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/transfer`,
      payload: { toSessionId: next.id },
    });
    expect(store.getRun(run.id)!.pendingPrompt).toContain("<fleet-task-transfer");

    const review = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/review`,
      payload: { approved: false, note: "Add a regression test." },
    });

    expect(review.statusCode).toBe(200);
    const owed = store.getRun(run.id)!.pendingPrompt;
    expect(owed.indexOf("<fleet-task-transfer")).toBe(0);
    expect(owed).toContain("Add a regression test.");
  });
});
