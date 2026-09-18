import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrMaintenanceEnableSchema } from "@fleet/protocol";
import { z } from "zod";
import { fleet } from "../orchestrator/fleet-harness.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { LeadTokens } from "../orchestrator/lead-tokens.js";
import { mcpRoutes } from "../orchestrator/mcp-routes.js";
import { orchestratorRoutes } from "./orchestrators.js";
import { runRoutes } from "./runs.js";
import { sessionRoutes } from "./sessions.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(provider: "github" | "azure-devops" = "github") {
  const state = fleet();
  const { store, service, leadId } = state;
  store.transitionSession(leadId, "starting");
  store.transitionSession(leadId, "idle");
  const lead = store.getSession(leadId)!;
  const run = store.createRun({
    workspaceId: lead.workspaceId,
    name: "PR repairs",
    objective: "Keep the existing contract",
  });
  store.updateRun(run.id, { leadSessionId: leadId, state: "running" });
  const worker = store.createSession(
    store.getPlacement(lead.placementId)!,
    "repair",
    false,
    "Retained worker",
    { runId: run.id, runRole: "worker" },
  );
  store.transitionSession(worker.id, "starting");
  store.transitionSession(worker.id, "idle");
  const [step] = store.replaceRunSteps(run.id, [
    { stepKey: "repair", title: "Repair", prompt: "repair" },
  ]);
  store.updateRunStep(step!.id, { state: "succeeded", sessionId: worker.id });
  const registration = PrMaintenanceEnableSchema.parse({
    taskId: run.id,
    workerSessionId: worker.id,
    identity: {
      host: "github.com",
      repositoryId: "123",
      repository: "owner/repo",
      prNumber: 17,
      headRepositoryId: "123",
      headRepository: "owner/repo",
      headRef: "refs/heads/Fix",
      baseRepositoryId: "123",
      baseRepository: "owner/repo",
      baseRef: "refs/heads/main",
    },
    scope: {
      baseline: "Keep the existing contract",
      verification: "Run targeted regression tests",
      publicationAuthorized: true,
    },
    headSha: "a".repeat(40),
    eligibilityEvidence:
      "Helper v1, Node credentials and non-forcing publication verified by operator",
  });
  if (provider === "azure-devops") {
    registration.identity = {
      ...registration.identity,
      provider,
      host: "dev.azure.com",
      organization: "sample-org",
      project: "Sample Project",
      projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      repositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      repository: "Sample Project/Repo",
      headRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      headRepository: "Sample Project/Repo",
      baseRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      baseRepository: "Sample Project/Repo",
    };
  }
  const engine = new OrchestratorEngine(service);
  vi.spyOn(engine, "tick").mockImplementation(() => {});
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    if (request.headers["fixture-browser"] === "yes")
      request.fleetSession = {
        tokenHash: "not-exposed",
        administratorId: "real-browser-principal",
        authMethod: "microsoft-code",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    if (request.headers["fixture-node"] === "yes") request.fleetNodeId = worker.nodeId;
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
    reply
      .code(status)
      .send({ error: error instanceof Error ? error.message : String(error) });
  });
  await app.register(orchestratorRoutes, { service, engine });
  await app.register(runRoutes, { service, engine });
  await app.register(sessionRoutes, { service });
  const tokens = new LeadTokens(store);
  const leadToken = tokens.mint(state.leadSubject);
  await app.register(mcpRoutes, { service, tokens });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    store.close();
  });
  const authorize = () =>
    app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
      payload: { action: "enable", registration },
    });
  const hold = () => {
    const record = store.prMaintenance.enableFromOperator(
      registration,
      "original-operator",
    );
    return store.prMaintenance.holdForDecision(
      leadId,
      record.id,
      record.version,
      {
        id: "decision",
        version: 1,
        proposal: "Change the contract?",
        scope: "Public API",
        headSha: "a".repeat(40),
      },
      () => {
        service.requestRunReview({
          runId: run.id,
          note: "A real defect needs a design decision",
          reason: "blocked",
        });
      },
    );
  };
  const mcp = async (name: string, args: unknown) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${leadToken}`,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    const body = response.json<{
      error?: { message: string };
      result?: { isError?: boolean; content?: { text: string }[] };
    }>();
    return {
      ok: !body.error && !body.result?.isError,
      text:
        body.error?.message ??
        body.result?.content?.map((entry) => entry.text).join("\n") ??
        "",
    };
  };
  return {
    ...state,
    app,
    run,
    worker,
    step: step!,
    registration,
    authorize,
    hold,
    mcp,
    leadToken,
  };
}

describe("authenticated PR maintenance controls", () => {
  it.each(["github", "azure-devops"] as const)(
    "turns a scoped %s MCP request into a durable, idempotent proposal, not authorization or worker execution",
    async (provider) => {
      const { store, service, run, registration, mcp } = await setup(provider);
      store.setRunState(run.id, "completed");
      const dispatch = vi.spyOn(service, "dispatch");
      const first = await mcp("fleet_propose_pr_maintenance", registration);
      expect(first.ok, first.text).toBe(true);
      const proposal = store.prMaintenance.getProposal(run.id)!;
      expect(JSON.parse(first.text)).toMatchObject({
        proposalId: proposal.id,
        version: 1,
        status: "awaiting_operator_authorization",
      });
      expect(store.prMaintenance.list().records).toHaveLength(0);
      expect(
        (
          await mcp("fleet_set_pr_maintenance", {
            recordId: proposal.id,
            expectedVersion: 1,
            action: "enable",
          })
        ).ok,
      ).toBe(false);
      expect(store.getRun(run.id)!.state).toBe("completed");
      expect(dispatch).not.toHaveBeenCalled();
      const duplicate = await mcp("fleet_propose_pr_maintenance", registration);
      expect(JSON.parse(duplicate.text).proposalId).toBe(proposal.id);
      expect(store.prMaintenance.getProposal(run.id)!.version).toBe(1);
      expect(
        store.getNotificationBySourceKey(`pr-maintenance-proposal:${proposal.id}:1`),
      ).toMatchObject({
        status: "active",
        navigation: { type: "run", runId: run.id },
      });
      const context = await mcp("fleet_get_pr_maintenance", { taskId: run.id });
      expect(JSON.parse(context.text)).toMatchObject({
        proposal: { id: proposal.id },
        records: [],
      });
      expect((await mcp("fleet_list_work", { query: "17" })).text).toContain(proposal.id);
    },
  );

  it.each(["github", "azure-devops"] as const)(
    "authorizes only the exact stored %s proposal through an authenticated operator action",
    async (provider) => {
      const { app, store, run, registration, mcp, leadToken } = await setup(provider);
      expect((await mcp("fleet_propose_pr_maintenance", registration)).ok).toBe(true);
      const proposal = store.prMaintenance.getProposal(run.id)!;
      const payload = {
        action: "authorize_proposal",
        proposalId: proposal.id,
        expectedVersion: proposal.version,
      };
      for (const headers of [
        {},
        { authorization: `Bearer ${leadToken}` },
        { "fixture-node": "yes" },
      ]) {
        const refused = await app.inject({
          method: "POST",
          url: `/api/runs/${run.id}/pr-maintenance`,
          headers,
          payload,
        });
        expect(refused.statusCode).toBe(403);
      }
      expect(store.prMaintenance.list().records).toHaveLength(0);
      const swapped = await app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/pr-maintenance`,
        headers: { "fixture-browser": "yes" },
        payload: {
          ...payload,
          registration: { ...registration, headSha: "b".repeat(40) },
        },
      });
      expect(swapped.statusCode).toBe(400);
      const accepted = await app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/pr-maintenance`,
        headers: { "fixture-browser": "yes" },
        payload,
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json()).toMatchObject({
        lifecycle: "active",
        identity: registration.identity,
        authorization: {
          operatorId: "real-browser-principal",
          scope: registration.scope,
        },
      });
      expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
      expect(
        store.getNotificationBySourceKey(`pr-maintenance-proposal:${proposal.id}:1`)
          ?.status,
      ).toBe("resolved");
    },
  );

  it("requires a versioned proposal replacement and rejects authorization of the older scope", async () => {
    const { app, store, run, registration, mcp } = await setup();
    await mcp("fleet_propose_pr_maintenance", registration);
    const first = store.prMaintenance.getProposal(run.id)!;
    const revised = {
      ...registration,
      scope: {
        ...registration.scope,
        verification: "Run updated regression tests and lint",
      },
    };
    expect((await mcp("fleet_propose_pr_maintenance", revised)).ok).toBe(false);
    expect(
      (
        await mcp("fleet_propose_pr_maintenance", {
          ...revised,
          expectedVersion: first.version,
        })
      ).ok,
    ).toBe(true);
    const second = store.prMaintenance.getProposal(run.id)!;
    expect(second).toMatchObject({ id: first.id, version: 2 });
    expect(
      store.getNotificationBySourceKey(`pr-maintenance-proposal:${first.id}:1`)?.status,
    ).toBe("resolved");
    const stale = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
      payload: {
        action: "authorize_proposal",
        proposalId: first.id,
        expectedVersion: first.version,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(store.prMaintenance.list().records).toHaveLength(0);
    expect(store.prMaintenance.getProposal(run.id)).toEqual(second);
  });

  it("cannot propose for a foreign task or overwrite an existing maintenance decision", async () => {
    const { store, run, registration, mcp, hold } = await setup();
    const foreign = store.createRun({
      workspaceId: run.workspaceId,
      name: "Foreign",
      objective: "Another lead's work",
    });
    expect(
      (await mcp("fleet_propose_pr_maintenance", { ...registration, taskId: foreign.id }))
        .ok,
    ).toBe(false);
    expect((await mcp("fleet_get_pr_maintenance", { taskId: foreign.id })).ok).toBe(
      false,
    );
    const held = hold();
    expect((await mcp("fleet_propose_pr_maintenance", registration)).ok).toBe(false);
    expect(store.prMaintenance.get(held.id)?.decision?.state).toBe("pending");
    expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
  });

  it("rolls back an invisible proposal if recording its human notification fails", async () => {
    const { store, service, run, registration, mcp } = await setup();
    const broadcast = vi.spyOn(service, "broadcast");
    vi.spyOn(service.notifications, "createPrMaintenanceProposal").mockImplementation(
      () => {
        throw new Error("simulated notification failure");
      },
    );
    expect((await mcp("fleet_propose_pr_maintenance", registration)).ok).toBe(false);
    expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rolls back authorization if its linked proposal notification cannot be resolved", async () => {
    const { app, store, service, run, registration, mcp } = await setup();
    await mcp("fleet_propose_pr_maintenance", registration);
    const proposal = store.prMaintenance.getProposal(run.id)!;
    const broadcast = vi.spyOn(service, "broadcast");
    vi.spyOn(service.notifications, "resolvePrMaintenanceProposal").mockImplementation(
      () => {
        throw new Error("simulated resolution failure");
      },
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
      payload: {
        action: "authorize_proposal",
        proposalId: proposal.id,
        expectedVersion: proposal.version,
      },
    });
    expect(response.statusCode).toBe(500);
    expect(store.prMaintenance.list().records).toHaveLength(0);
    expect(store.prMaintenance.getProposal(run.id)).toEqual(proposal);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("cannot authorize with fabricated actor, Node credentials, or no browser principal", async () => {
    const { app, run, registration, store, authorize } = await setup();
    for (const headers of [{}, { "fixture-node": "yes" }]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/pr-maintenance`,
        headers,
        payload: { action: "enable", registration, actor: "invented-human" },
      });
      expect(response.statusCode).toBe(403);
    }
    const spoof = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
      payload: { action: "enable", registration, actor: "invented-human" },
    });
    expect(spoof.statusCode).toBe(400);
    expect(store.prMaintenance.list().records).toHaveLength(0);
    const accepted = await authorize();
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().authorization.operatorId).toBe("real-browser-principal");
    expect((await authorize()).json().id).toBe(accepted.json().id);
  });

  it("refuses unknown prerequisites and foreign worker ownership", async () => {
    const { app, run, registration, store } = await setup();
    for (const invalid of [
      { ...registration, eligibilityEvidence: "" },
      { ...registration, workerSessionId: "standalone" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/pr-maintenance`,
        headers: { "fixture-browser": "yes" },
        payload: { action: "enable", registration: invalid },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(store.prMaintenance.list().records).toHaveLength(0);
  });

  it("preserves a pending decision and notification across approve/reopen/worker routes", async () => {
    const { app, run, worker, store, hold } = await setup();
    const held = hold();
    const beforeNotes = store.listRunNotes(run.id);
    for (const request of [
      { url: `/api/runs/${run.id}/review`, payload: { approved: true } },
      { url: `/api/runs/${run.id}/reopen`, payload: { note: "ignore the hold" } },
      { url: `/api/runs/${run.id}/approve` },
      {
        url: `/api/runs/${run.id}/plan`,
        payload: {
          steps: [{ stepKey: "replacement", title: "Replace", prompt: "bypass" }],
        },
      },
      { url: `/api/sessions/${worker.id}/prompt`, payload: { prompt: "just do it" } },
      { url: `/api/sessions/${worker.id}/resume` },
    ]) {
      const response = await app.inject({
        method: "POST",
        ...request,
        headers: { "fixture-browser": "yes" },
      });
      expect(response.statusCode, request.url).toBe(409);
    }
    expect(store.prMaintenance.get(held.id)?.decision?.state).toBe("pending");
    expect(store.getRun(run.id)?.state).toBe("awaiting_human");
    expect(store.listRunNotes(run.id)).toEqual(beforeNotes);
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)?.status).toBe("active");
  });

  it("records only exact versioned direction while preserving the defect and baseline", async () => {
    const { app, run, store, hold } = await setup();
    const held = hold();
    const review = (expectedVersion: number) =>
      app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/review`,
        headers: { "fixture-browser": "yes" },
        payload: {
          approved: false,
          note: "Keep the API; restore its original validation",
          maintenance: {
            recordId: held.id,
            expectedVersion,
            decisionId: "decision",
            decisionVersion: 1,
          },
        },
      });
    expect((await review(held.version - 1)).statusCode).toBe(409);
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)?.status).toBe("active");
    const directed = await review(held.version);
    expect(directed.statusCode, directed.body).toBe(200);
    expect(store.prMaintenance.get(held.id)).toMatchObject({
      lifecycle: "paused",
      decision: {
        state: "directed",
        operatorId: "real-browser-principal",
        direction: "Keep the API; restore its original validation",
      },
      authorization: { scope: { baseline: "Keep the existing contract" } },
    });
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)?.status).toBe(
      "resolved",
    );
    expect(
      store.listRunNotes(run.id).some((note) => note.body.includes("A real defect")),
    ).toBe(true);
    expect(store.getRun(run.id)?.pendingPrompt).toContain(
      "not proof that a defect is fixed",
    );
    expect(store.getRun(run.id)?.state).toBe("running");
    expect((await review(held.version)).statusCode).toBe(409);
  });

  it("rolls back direction if its linked task review mutation fails", async () => {
    const { app, run, store, hold } = await setup();
    const held = hold();
    const append = vi.spyOn(store, "appendRunNote").mockImplementation(() => {
      throw new Error("simulated write failure");
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/review`,
      headers: { "fixture-browser": "yes" },
      payload: {
        approved: false,
        note: "Keep the existing API",
        maintenance: {
          recordId: held.id,
          expectedVersion: held.version,
          decisionId: "decision",
          decisionVersion: 1,
        },
      },
    });
    append.mockRestore();
    expect(response.statusCode).toBe(500);
    expect(store.prMaintenance.get(held.id)).toMatchObject({
      version: held.version,
      decision: { state: "pending" },
    });
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)?.status).toBe("active");
  });

  it("pauses before archive/delete without resolving a design hold or deleting continuity", async () => {
    const { app, run, worker, store, hold } = await setup();
    const held = hold();
    expect(
      (await app.inject({ method: "POST", url: `/api/runs/${run.id}/archive` }))
        .statusCode,
    ).toBe(200);
    expect(store.prMaintenance.get(held.id)).toMatchObject({
      lifecycle: "paused",
      decision: { state: "pending" },
    });
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)?.status).toBe("active");
    expect(
      (await app.inject({ method: "DELETE", url: `/api/runs/${run.id}` })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/sessions/${worker.id}` }))
        .statusCode,
    ).toBe(409);
    expect(store.getRun(run.id)).toBeDefined();
    expect(store.getSession(worker.id)).toBeDefined();
  });

  it("fails stale pause/resume explicitly without overwriting a newer state", async () => {
    const { app, run, store, authorize } = await setup();
    const enabled = (await authorize()).json();
    const action = (operation: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/pr-maintenance`,
        headers: { "fixture-browser": "yes" },
        payload: {
          action: "update",
          recordId: enabled.id,
          expectedVersion: enabled.version,
          operation,
        },
      });
    const paused = await action({ action: "pause", reason: "Human pause" });
    expect(paused.statusCode, paused.body).toBe(200);
    expect((await action({ action: "resume" })).statusCode).toBe(409);
    expect(store.prMaintenance.get(enabled.id)?.lifecycle).toBe("paused");
  });

  it("cannot release or delete an unknown accepted effect even after Stop", async () => {
    const { app, run, worker, leadId, registration, store, authorize } = await setup();
    let record = (await authorize()).json();
    record = store.prMaintenance.checkpoint(leadId, record.id, record.version, {
      kind: "observation",
      observation: {
        attemptedAt: new Date().toISOString(),
        complete: true,
        identity: registration.identity,
        snapshotId: "snapshot",
        headSha: registration.headSha,
        state: "open",
        fingerprint: "external-state",
        evidence: "Complete current provider snapshot",
      },
    });
    record = store.prMaintenance.checkpoint(leadId, record.id, record.version, {
      kind: "action",
      effect: {
        key: "notification-1",
        kind: "notification",
        state: "reserved",
        headSha: registration.headSha,
        actor: "operator",
        actionIdentity: "notice-1",
      },
    });
    expect(
      (await app.inject({ method: "POST", url: `/api/sessions/${worker.id}/stop` }))
        .statusCode,
    ).toBe(202);
    const paused = store.prMaintenance.get(record.id)!;
    const released = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
      payload: {
        action: "update",
        recordId: paused.id,
        expectedVersion: paused.version,
        operation: { action: "release", reason: "Stop was requested" },
      },
    });
    expect(released.statusCode, released.body).toBe(409);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/runs/${run.id}` })).statusCode,
    ).toBe(409);
    expect(store.prMaintenance.get(record.id)).toMatchObject({
      lifecycle: "paused",
      actions: [expect.objectContaining({ key: "notification-1", state: "reserved" })],
    });
    expect(store.prMaintenance.get(record.id)?.ownershipReleasedAt).toBeUndefined();
    expect(store.getSession(worker.id)).toBeDefined();
  });

  it("resumes unrelated tasks with an active worker without reopening the maintenance-held task", async () => {
    const { app, run, worker, leadId, store, hold } = await setup();
    const held = hold();
    const unrelated = store.createRun({
      workspaceId: run.workspaceId,
      name: "Unrelated",
      objective: "Independent work",
    });
    store.updateRun(unrelated.id, { leadSessionId: leadId, state: "running" });
    store.appendEvent({
      eventId: "native-lead",
      sessionId: leadId,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "retained-native-lead" },
      createdAt: new Date().toISOString(),
    });
    await app.inject({ method: "POST", url: `/api/orchestrators/${leadId}/stop` });
    for (const id of [worker.id, leadId]) {
      store.transitionSession(id, "stopped");
      store.setSessionControls(id, { stopRequested: false });
    }
    const activePlacement = store
      .listPlacements()
      .find((entry) => entry.workspaceName === "Beta")!;
    const activeRun = store.createRun({
      workspaceId: activePlacement.workspaceId,
      name: "Ongoing independent work",
      objective: "Keep an unrelated worker running",
    });
    store.updateRun(activeRun.id, { leadSessionId: leadId, state: "running" });
    const activeWorker = store.createSession(activePlacement, "Keep working", false, "", {
      runId: activeRun.id,
      runRole: "worker",
    });
    store.transitionSession(activeWorker.id, "starting");
    store.transitionSession(activeWorker.id, "running");
    const activeStep = store.upsertRunStep(activeRun.id, {
      stepKey: "active",
      title: "Independent work",
      prompt: "Keep working",
      placementId: activePlacement.id,
    });
    store.updateRunStep(activeStep.id, {
      sessionId: activeWorker.id,
      state: "running",
      dispatchedAt: new Date().toISOString(),
    });
    const resumed = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${leadId}/resume`,
    });
    expect(resumed.statusCode, resumed.body).toBe(202);
    expect(resumed.json().blockedRuns).toEqual([
      expect.objectContaining({ runId: run.id, reason: "wait_for_human" }),
    ]);
    expect(store.getRun(unrelated.id)?.state).toBe("running");
    expect(store.getSession(activeWorker.id)?.state).toBe("running");
    expect(store.getRunStep(activeStep.id)?.state).toBe("running");
    expect(store.getRun(run.id)?.state).toBe("cancelled");
    expect(store.prMaintenance.get(held.id)?.decision?.state).toBe("pending");
    expect(store.getNotificationBySourceKey(`review:${run.id}:1`)?.status).toBe("active");
  });
});
