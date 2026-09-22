import Fastify from "fastify";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrMaintenanceEnableSchema,
  prMaintenanceUrl,
  prMaintenanceProgress,
} from "@fleet/protocol";
import { z } from "zod";
import { fleet } from "../orchestrator/fleet-harness.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { PreparePrMaintenanceSchema } from "../orchestrator/tools.js";
import { LeadTokens } from "../orchestrator/lead-tokens.js";
import { mcpRoutes } from "../orchestrator/mcp-routes.js";
import { orchestratorRoutes } from "./orchestrators.js";
import { runRoutes } from "./runs.js";
import { sessionRoutes } from "./sessions.js";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";

const fixtureUrl = new URL(
  "../../../node/src/fixtures/ado-maintenance.mjs",
  import.meta.url,
);
const cliUrl = new URL(
  "../../../node/skills/pr-maintenance/github-snapshot.mjs",
  import.meta.url,
);
const { fixtureInput, observeFixture } = await import(fixtureUrl.href);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(provider: "github" | "azure-devops" = "github", dbPath?: string) {
  const state = fleet(dbPath);
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
    { stepKey: "repair", title: "Repair", prompt: "repair", category: "implement" },
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
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    store.close();
  };
  cleanup.push(close);
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
    close,
  };
}

describe("authenticated PR maintenance controls", () => {
  it("requires authenticated pinned repair reauthorization for a retained legacy grant, then explicit resume", async () => {
    const { store, run, registration, authorize, mcp, app, worker } =
      await setup("azure-devops");
    expect((await authorize()).statusCode).toBe(200);
    const backup = store.prMaintenance.exportBackup();
    backup.registrations[0]!.authorization.scope.publicationAuthorized = false;
    const oldGrant = structuredClone(backup.registrations[0]!.authorization);
    store.writeAtomically(() => store.prMaintenance.importBackup(backup));
    const result = await mcp("fleet_prepare_pr_maintenance", {
      taskId: run.id,
      workerSessionId: worker.id,
      prUrl: prMaintenanceUrl(registration.identity),
      identity: registration.identity,
      headSha: registration.headSha,
      observedAt: new Date().toISOString(),
      method: "provider_mcp",
      evidence: "Fresh synthetic provider metadata",
      publicationEvidence:
        "Existing task permits repair and ordinary push to this exact PR",
      verification: registration.scope.verification,
      eligibilityEvidence: registration.eligibilityEvidence,
    });
    expect(result.ok, result.text).toBe(true);
    const proposal = store.prMaintenance.getProposal(run.id)!;
    expect(proposal.reauthorization).toBeDefined();
    const payload = {
      action: "authorize_proposal",
      proposalId: proposal.id,
      expectedVersion: proposal.version,
    };
    for (const headers of [{}, { "fixture-node": "yes" }])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/runs/${run.id}/pr-maintenance`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(403);
    expect(store.prMaintenance.list().records[0]!.authorization).toEqual(oldGrant);
    const approved = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
      payload,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const record = approved.json();
    expect(record).toMatchObject({
      id: proposal.reauthorization!.recordId,
      generation: 1,
      workerSessionId: worker.id,
      lifecycle: "paused",
      authorization: {
        operatorId: "real-browser-principal",
        scope: {
          publicationAuthorized: true,
          replies: false,
          resolveThreads: false,
          retryChecks: false,
          reviewers: [],
        },
      },
      authorizationHistory: [oldGrant],
    });
    expect(store.prMaintenance.list().records).toHaveLength(1);
    expect(
      (
        await mcp("fleet_set_pr_maintenance", {
          recordId: record.id,
          expectedVersion: record.version,
          action: "resume",
        })
      ).ok,
    ).toBe(false);
    const resumed = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
      payload: {
        action: "update",
        recordId: record.id,
        expectedVersion: record.version,
        operation: { action: "resume" },
      },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().lifecycle).toBe("active");
  });

  it("roundtrips 291675 helper observation bytes through exposed MCP and SQLite restart unchanged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-maintenance-handoff-"));
    const dbPath = join(directory, "host.sqlite");
    const state = await setup("azure-devops", dbPath);
    const { store, service, leadId, authorize, mcp, close } = state;
    expect((await authorize()).statusCode).toBe(200);
    const record = store.prMaintenance.list().records[0]!;
    const at = new Date().toISOString();
    const input = fixtureInput(at, 10);
    const small = await observeFixture(input, 3000);
    expect(small.error?.code).toBe("budget_exhausted");
    const targetBytes = 291_675;
    const padding = targetBytes - Buffer.byteLength(JSON.stringify(small.observation));
    expect(padding).toBeGreaterThanOrEqual(0);
    const cli = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { main } from ${JSON.stringify(cliUrl.href)};
       import { observeFixture } from ${JSON.stringify(fixtureUrl.href)};
       await main(input => observeFixture(input, 3000, ${padding}), result => result.observation);`,
      ],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
        maxBuffer: 1_048_576,
        timeout: 10_000,
      },
    );
    expect(cli.error).toBeUndefined();
    expect(cli.status).toBe(2);
    const helper = JSON.parse(cli.stdout);
    const observation = helper.observation;
    const serialized = JSON.stringify(observation);
    expect(Buffer.byteLength(serialized)).toBe(targetBytes);
    expect(observation).toMatchObject({
      complete: false,
      attemptedAt: at,
      requestsConsumed: 10,
      elapsedMs: 0,
    });
    expect(helper.resume).toBeUndefined();
    expect(observation.helperState.resume).toBeTruthy();
    const args = {
      recordId: record.id,
      expectedVersion: record.version,
      checkpoint: { kind: "observation", observation },
    };
    expect((await mcp("fleet_checkpoint_pr_maintenance", args)).ok).toBe(false);
    service.dispatch(store.getSession(leadId)!.nodeId, {
      type: "prompt",
      sessionId: leadId,
      prompt: "Fixture evidence collection",
      attachments: [],
    });
    expect((await mcp("fleet_get_pr_maintenance", { takeDue: true })).ok).toBe(true);
    const rejected = await state.app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fleet_checkpoint_pr_maintenance", arguments: args },
      },
    });
    expect(rejected.statusCode).toBe(401);
    const saved = await mcp("fleet_checkpoint_pr_maintenance", args);
    expect(saved.ok, saved.text).toBe(true);
    expect(JSON.stringify(JSON.parse(saved.text).lastAttempt)).toBe(serialized);
    expect((await mcp("fleet_checkpoint_pr_maintenance", args)).ok).toBe(false);
    const savedVersion = store.prMaintenance.get(record.id)!.version;
    const overflow = await mcp("fleet_checkpoint_pr_maintenance", {
      ...args,
      expectedVersion: savedVersion,
      checkpoint: {
        kind: "observation",
        observation: {
          ...observation,
          helperState: { oversized: "x".repeat(1_048_576) },
        },
      },
    });
    expect(overflow.ok).toBe(false);
    expect(JSON.stringify(store.prMaintenance.get(record.id)!.lastAttempt)).toBe(
      serialized,
    );
    await close();
    const reopened = new FleetStore(dbPath);
    const app = Fastify({ logger: false });
    const restarted = new FleetService(reopened, app.log, "test");
    const tokens = new LeadTokens(reopened);
    await app.register(mcpRoutes, { service: restarted, tokens });
    cleanup.push(async () => {
      await app.close();
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const readback = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${tokens.mint(state.leadSubject)}`,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fleet_get_pr_maintenance", arguments: { recordId: record.id } },
      },
    });
    const restored = JSON.parse(readback.json().result.content[0].text);
    expect(JSON.stringify(restored.lastAttempt)).toBe(serialized);
    expect(
      createHash("sha256").update(JSON.stringify(restored.lastAttempt)).digest("hex"),
    ).toBe(createHash("sha256").update(serialized).digest("hex"));
    expect(
      reopened.prMaintenance.remainingWake(
        leadId,
        reopened.getSessionDispatchAttempt(leadId)!.commandId,
      ).requests,
    ).toBe(1);
    expect(Buffer.byteLength(cli.stdout)).toBe(291_959);
    expect(Buffer.byteLength(JSON.stringify(args))).toBe(291_797);
  });

  it("admits exactly one retained-worker batch from forty-thread complete helper evidence within the existing wake", async () => {
    const { store, service, leadId, worker, registration, authorize, mcp } =
      await setup("azure-devops");
    expect((await authorize()).statusCode).toBe(200);
    let record = store.prMaintenance.list().records[0]!;
    service.dispatch(store.getSession(leadId)!.nodeId, {
      type: "prompt",
      sessionId: leadId,
      prompt: "Fixture maintenance wake",
      attachments: [],
    });
    const claim = JSON.parse(
      (await mcp("fleet_get_pr_maintenance", { takeDue: true })).text,
    );
    expect(claim.observationAllowance.requests).toBe(39);
    const helper = await observeFixture(fixtureInput(new Date().toISOString(), 39));
    expect(helper).toMatchObject({
      complete: true,
      requestsConsumed: 19,
      progress: { pages: 8, verifiedPages: 8 },
    });
    expect(helper.observation).toMatchObject({
      identity: registration.identity,
      checksComplete: false,
      reviewsComplete: false,
    });
    expect(helper.observation.sources).toHaveLength(80);
    const saved = await mcp("fleet_checkpoint_pr_maintenance", {
      recordId: record.id,
      expectedVersion: record.version,
      checkpoint: { kind: "observation", observation: helper.observation },
    });
    expect(saved.ok, saved.text).toBe(true);
    record = JSON.parse(saved.text);
    const batch = {
      id: "synthetic-repair-1",
      kind: "repair",
      sources: record.observation!.sources,
      headSha: registration.headSha,
      prompt:
        "Repair synthetic findings within the existing contract; native verification; ordinary push only. No replies or resolutions.",
      scope: registration.scope.baseline,
      reservedMutations: 1,
    };
    const prepared = await mcp("fleet_checkpoint_pr_maintenance", {
      recordId: record.id,
      expectedVersion: record.version,
      checkpoint: { kind: "prepare_batch", batch },
    });
    expect(prepared.ok, prepared.text).toBe(true);
    const followUp = {
      sessionId: worker.id,
      prompt: batch.prompt,
      maintenance: {
        recordId: record.id,
        generation: record.generation,
        batchId: batch.id,
      },
    };
    expect(
      (
        await mcp("fleet_follow_up", {
          ...followUp,
          maintenance: { ...followUp.maintenance, generation: 2 },
        })
      ).ok,
    ).toBe(false);
    const accepted = await mcp("fleet_follow_up", followUp);
    expect(accepted.ok, accepted.text).toBe(true);
    expect((await mcp("fleet_follow_up", followUp)).ok).toBe(true);
    record = store.prMaintenance.get(record.id)!;
    expect(record.batches).toHaveLength(1);
    expect(record.batches[0]).toMatchObject({
      state: "accepted",
      attempt: 2,
      authorizationId: record.authorization.id,
    });
    expect(record.batches[0]!.stepId).toBeTruthy();
    expect(
      store.listSessions().filter((session) => session.runRole === "worker"),
    ).toHaveLength(1);
    expect(record.readyFingerprint).toBeUndefined();
    expect(record.counters.repairBatches).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(helper.observation))).toBe(34_084);
    expect(Buffer.byteLength(JSON.stringify(helper))).toBe(154_748);
  });

  it("runs claimed helper failure through the real MCP recovery seam without admitting repairs", async () => {
    const { store, service, leadId, registration, authorize, mcp } =
      await setup("azure-devops");
    await authorize();
    let record = store.prMaintenance.list().records[0]!;
    const lead = store.getSession(leadId)!;
    const wake = () =>
      service.dispatch(lead.nodeId, {
        type: "prompt",
        sessionId: leadId,
        prompt: "Read-only recovery",
        attachments: [],
      });
    wake();
    const observation = {
      attemptedAt: new Date().toISOString(),
      complete: false,
      failure: "capability",
      requestsConsumed: 1,
      evidence: "Local CLI has no usable login",
      helperState: {
        error: {
          code: "local_auth_unavailable",
          message: "Local CLI has no usable login",
        },
      },
    };
    const checkpoint = async (input: unknown) =>
      mcp("fleet_checkpoint_pr_maintenance", {
        recordId: record.id,
        expectedVersion: record.version,
        checkpoint: input,
      });
    expect(
      (await checkpoint({ kind: "fallback", error: observation.evidence, observation }))
        .ok,
    ).toBe(false);
    expect(
      (await mcp("fleet_get_pr_maintenance", { takeDue: true, reserveRequests: 40 })).ok,
    ).toBe(true);
    const failed = await checkpoint({
      kind: "fallback",
      error: observation.evidence,
      observation,
    });
    expect(failed.ok, failed.text).toBe(true);
    record = JSON.parse(failed.text);
    const incidentId = record.incidents[0]!.id;
    const attempt = {
      kind: "alternate_attempt",
      incidentId,
      resolutionId: "mcp-metadata-1",
      requests: 1,
      provenance: {
        source: "existing-provider-mcp",
        method: "repo_pull_request.get",
        evidenceRef: "session-local-test-metadata",
      },
    };
    expect((await checkpoint(attempt)).ok).toBe(false);
    wake();
    const recoveryVisit = await mcp("fleet_get_pr_maintenance", { takeDue: true });
    expect(JSON.parse(recoveryVisit.text).record?.id, recoveryVisit.text).toBe(record.id);
    expect(JSON.parse(recoveryVisit.text).observationAllowance.requests).toBe(1);
    expect(JSON.parse(recoveryVisit.text).instruction).toContain("alternate_attempt");
    const reserved = await checkpoint(attempt);
    expect(reserved.ok, reserved.text).toBe(true);
    record = JSON.parse(reserved.text);
    const partial = await checkpoint({
      kind: "alternate_observation",
      incidentId,
      resolutionId: attempt.resolutionId,
      observation: {
        attemptedAt: new Date().toISOString(),
        complete: false,
        requestsConsumed: 1,
        identity: registration.identity,
        headSha: registration.headSha,
        state: "open",
        draft: true,
        mergeability: "conflicting",
        checksComplete: false,
        reviewsComplete: false,
        failure: "incomplete",
        evidence:
          "Fresh metadata only: draft and conflicts; policy/thread pages not fully collected.",
      },
    });
    expect(partial.ok, partial.text).toBe(true);
    record = JSON.parse(partial.text);
    expect(record.lastAttempt).toMatchObject({ draft: true, complete: false });
    expect(record.lastError).toBeTruthy();
    expect(record.readyFingerprint).toBeUndefined();
    expect(record.batches).toHaveLength(0);
    expect(prMaintenanceProgress(record).stage).toBe("blocked");
    expect(record.incidents[0]!.attempts[0]).toMatchObject({
      id: attempt.resolutionId,
      state: "incomplete",
      provenance: attempt.provenance,
    });
  });

  it.each([
    [true, 39],
    [false, 0],
  ] as const)(
    "reserves a usable ADO default without starving continuation, repair=%s",
    async (publicationAuthorized, requests) => {
      const { registration, authorize, store, service, leadId, mcp } =
        await setup("azure-devops");
      registration.scope.publicationAuthorized = publicationAuthorized;
      registration.scope.replies = publicationAuthorized;
      registration.scope.resolveThreads = publicationAuthorized;
      const authorization = await authorize();
      if (!publicationAuthorized) {
        expect(authorization.statusCode).toBe(400);
        expect(authorization.body).toContain("Observation-only");
        expect(store.prMaintenance.list().records).toEqual([]);
        return;
      }
      expect(authorization.statusCode).toBe(200);
      const lead = store.getSession(leadId)!;
      service.dispatch(lead.nodeId, {
        type: "prompt",
        sessionId: lead.id,
        prompt: "Observe maintained PR",
        attachments: [],
      });
      const claim = await mcp("fleet_get_pr_maintenance", { takeDue: true });
      expect(claim.ok, claim.text).toBe(true);
      expect(JSON.parse(claim.text)).toMatchObject({
        observationAllowance: { requests },
        allowance: { requests: 40 - requests },
      });
    },
  );

  it("requests preparation with only a URL, without granting authority or creating workers", async () => {
    const { app, service, store, run, worker } = await setup();
    const dispatch = vi.spyOn(service, "dispatch");
    const count = store.listSessions().length;
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
      payload: { action: "prepare", prUrl: "https://github.com/owner/repo/pull/17" },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(
      worker.nodeId,
      expect.objectContaining({
        type: "prompt",
        prompt: expect.stringContaining("fleet_prepare_pr_maintenance"),
      }),
    );
    expect(store.listSessions()).toHaveLength(count);
    expect(store.prMaintenance.list().records).toEqual([]);
    expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
    expect(store.getRun(run.id)?.state).toBe("running");
  });

  it("deduplicates pending durable preparation but permits a deliberate retry after settlement", async () => {
    const { app, service, store, run } = await setup();
    vi.spyOn(service.commands, "durableLead").mockReturnValue(true);
    vi.spyOn(service.commands, "pumpLead").mockImplementation(() => {});
    const request = () =>
      app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/pr-maintenance`,
        headers: { "fixture-browser": "yes" },
        payload: { action: "prepare" },
      });
    expect((await request()).statusCode).toBe(202);
    expect((await request()).statusCode).toBe(202);
    const [delivery] = store.commands.prompts();
    expect(store.commands.prompts()).toHaveLength(1);
    expect(delivery!.delivery.prompt).toContain("Discover the PR URL");
    store.commands.updatePrompt({ ...delivery!, state: "settled" });
    expect((await request()).statusCode).toBe(202);
    expect(store.commands.prompts()).toHaveLength(1);
    expect(store.commands.prompts()[0]!.delivery.deliveryId).not.toBe(
      delivery!.delivery.deliveryId,
    );
    expect(store.commands.prompt(delivery!.delivery.deliveryId)?.state).toBe("settled");
  });

  it.each(["github", "azure-devops"] as const)(
    "automatically binds verified %s metadata to the sole existing task and coder",
    async (provider) => {
      const { store, run, registration, mcp, app } = await setup(provider);
      const result = await mcp("fleet_prepare_pr_maintenance", {
        prUrl: prMaintenanceUrl(registration.identity),
        identity: registration.identity,
        headSha: registration.headSha,
        observedAt: new Date().toISOString(),
        method: "provider_mcp",
        evidence: "Authenticated read-only provider metadata; exact repository/ref pins.",
        publicationEvidence:
          "Existing writing task authorizes normal pushes to the pinned source ref.",
        verification: registration.scope.verification,
        eligibilityEvidence: registration.eligibilityEvidence,
      });
      expect(result.ok, result.text).toBe(true);
      const proposal = store.prMaintenance.getProposal(run.id)!;
      expect(proposal.registration).toMatchObject({
        taskId: run.id,
        workerSessionId: registration.workerSessionId,
        scope: {
          baseline: run.objective,
          publicationAuthorized: true,
          replies: false,
          resolveThreads: false,
          reviewers: [],
          retryChecks: false,
        },
      });
      expect(store.prMaintenance.list().records).toHaveLength(0);
      const approval = await app.inject({
        method: "POST",
        url: `/api/runs/${run.id}/pr-maintenance`,
        headers: { "fixture-browser": "yes" },
        payload: {
          action: "authorize_proposal",
          proposalId: proposal.id,
          expectedVersion: proposal.version,
        },
      });
      expect(approval.statusCode, approval.body).toBe(200);
      expect(approval.json()).toMatchObject({
        taskId: run.id,
        workerSessionId: registration.workerSessionId,
        authorization: { operatorId: "real-browser-principal" },
      });
    },
  );

  it("never expands a read-only task into publication or feedback mutations when preparation omits permissions", async () => {
    const { store, run, registration, mcp } = await setup("azure-devops");
    const objective =
      "Observe the linked PR only. No repair, publication, review changes or merge.";
    store.updateRun(run.id, { objective });
    const input = {
      taskId: run.id,
      prUrl: prMaintenanceUrl(registration.identity),
      identity: registration.identity,
      headSha: registration.headSha,
      observedAt: new Date().toISOString(),
      method: "provider_mcp",
      evidence: "Fresh PR metadata; draft and conflicts",
      verification:
        "Read-only provider metadata; no execution or publication verification.",
      eligibilityEvidence:
        "No verified mutable checkout or publication path; observation-only scope.",
    };
    const result = await mcp("fleet_prepare_pr_maintenance", input);
    expect(result.ok, result.text).toBe(false);
    expect(result.text).toContain("publication authority");
    expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
    expect(store.prMaintenance.list().records).toHaveLength(0);
    const mutation = await mcp("fleet_prepare_pr_maintenance", {
      ...input,
      mode: "observe",
      replies: true,
    });
    expect(mutation.ok, mutation.text).toBe(false);
    const noPublicationEvidence = await mcp("fleet_prepare_pr_maintenance", {
      ...input,
      mode: "repair",
    });
    expect(noPublicationEvidence.ok, noPublicationEvidence.text).toBe(false);
    expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
  });

  it("rejects explicit legacy observation mode through the exposed preparation MCP", async () => {
    const { store, run, worker, mcp, registration } = await setup("azure-devops");
    const identity = registration.identity;
    const result = await mcp("fleet_prepare_pr_maintenance", {
      taskId: run.id,
      workerSessionId: worker.id,
      prUrl: prMaintenanceUrl(identity),
      identity,
      headSha: "a".repeat(40),
      observedAt: new Date().toISOString(),
      method: "provider_mcp",
      mode: "observe",
      evidence: "Synthetic metadata fixture; helper discovery was incomplete.",
      eligibilityEvidence: "No repair authority; only requesting observation.",
      verification: "Bounded read-only provider evidence; no readiness claim.",
    });
    expect(result.ok, result.text).toBe(false);
    expect(result.text).toContain("Observation-only");
    expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
    expect(store.prMaintenance.list().records).toHaveLength(0);
  });

  it("advertises the actual provider-specific identity contract in tools/list", async () => {
    const { app, leadToken } = await setup("azure-devops");
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${leadToken}`,
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const tool = response
      .json()
      .result.tools.find(
        (entry: { name: string }) => entry.name === "fleet_prepare_pr_maintenance",
      );
    const identity = tool.inputSchema.properties.identity;
    expect(tool.description).toContain("Before registration");
    expect(tool.inputSchema.properties.evidence.description).toContain("metadata-only");
    expect(identity.description).toContain("snapshot.identity unchanged");
    const ado = identity.oneOf.find(
      (entry: any) => entry.properties.provider.const === "azure-devops",
    );
    expect(ado.required).toEqual(
      expect.arrayContaining(["provider", "organization", "projectId", "prNumber"]),
    );
    expect(ado.additionalProperties).toBe(false);
    expect(ado.properties.repository.description).toContain("Project/Repo");
    expect(ado.properties.project.description).toContain("not its GUID");
    expect(ado.properties.projectId.description).toContain("Provider");
    expect(ado.properties.headRef.description).toContain("case-sensitive");
  });

  it.each([
    [{ repository: "Repo" }, "identity.repository", "Project/Repo"],
    [{ headRepository: "Other/Repo" }, "identity.headRepository", "Project prefix"],
    [
      { baseRepositoryId: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
      "identity.baseRepositoryId",
      "must match",
    ],
    [{ baseRepository: "Sample Project/Other" }, "identity.baseRepository", "must match"],
    [{ projectId: "PRIVATE_VALUE_DO_NOT_ECHO" }, "identity.projectId", "GUID"],
    [{ headRef: "main" }, "identity.headRef", "refs/heads/"],
    [{ provider: "PRIVATE_VALUE_DO_NOT_ECHO" }, "identity.provider", "discriminator"],
  ])(
    "rejects malformed ADO identity %j with safe field-specific MCP feedback",
    async (patch, field, message) => {
      const { mcp, registration, store, run } = await setup("azure-devops");
      const result = await mcp("fleet_prepare_pr_maintenance", {
        prUrl: prMaintenanceUrl(registration.identity),
        identity: { ...registration.identity, ...patch },
        headSha: registration.headSha,
        observedAt: new Date().toISOString(),
        method: "provider_mcp",
        evidence: "Current fixture provider evidence",
        verification: registration.scope.verification,
        eligibilityEvidence: "Observation only; not publication authority.",
      });
      expect(result.ok).toBe(false);
      expect(result.text).toContain(field);
      expect(result.text).toContain(message);
      expect(result.text).not.toContain("PRIVATE_VALUE_DO_NOT_ECHO");
      expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
      expect(store.prMaintenance.list().records).toHaveLength(0);
    },
  );

  it("proposes only explicitly requested repair actions and still requires operator approval", async () => {
    const { store, run, registration, mcp } = await setup();
    const result = await mcp("fleet_prepare_pr_maintenance", {
      taskId: run.id,
      prUrl: prMaintenanceUrl(registration.identity),
      identity: registration.identity,
      headSha: registration.headSha,
      observedAt: new Date().toISOString(),
      method: "packaged_helper",
      evidence: "Current pinned PR, source/base branches and HEAD verified",
      verification: registration.scope.verification,
      eligibilityEvidence: registration.eligibilityEvidence,
      mode: "repair",
      publicationEvidence:
        "Existing task grant permits ordinary pushes to this exact PR source ref.",
      replies: true,
    });
    expect(result.ok, result.text).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      mode: "repair",
      status: "awaiting_operator_authorization",
      proposedActions: {
        repairAndPublish: true,
        replies: true,
        resolveThreads: false,
        reviewers: [],
        retryChecks: false,
      },
    });
    expect(store.prMaintenance.getProposal(run.id)?.registration.scope).toMatchObject({
      publicationAuthorized: true,
      replies: true,
      resolveThreads: false,
      reviewers: [],
      retryChecks: false,
    });
    expect(store.prMaintenance.list().records).toHaveLength(0);
  });

  it("refuses stale, mismatched or fabricated preparation authority and asks for ambiguous task choice", async () => {
    const { store, run, registration, mcp, leadId } = await setup();
    const input = {
      prUrl: prMaintenanceUrl(registration.identity),
      identity: registration.identity,
      headSha: registration.headSha,
      observedAt: new Date().toISOString(),
      method: "provider_cli",
      evidence: "Current provider metadata",
      publicationEvidence:
        "Existing writing task permits normal publication to the pinned source.",
      verification: registration.scope.verification,
      eligibilityEvidence: registration.eligibilityEvidence,
    };
    for (const patch of [
      { observedAt: new Date(Date.now() - 6 * 60_000).toISOString() },
      { prUrl: "https://github.com/owner/repo/pull/18" },
      { taskId: "another-lead-task" },
    ]) {
      const result = await mcp("fleet_prepare_pr_maintenance", { ...input, ...patch });
      expect(result.ok, result.text).toBe(false);
    }
    expect(
      PreparePrMaintenanceSchema.safeParse({ ...input, approved: true }).success,
    ).toBe(false);
    const second = store.createRun({
      workspaceId: run.workspaceId,
      name: "Another task",
      objective: "Unrelated",
    });
    store.updateRun(second.id, { leadSessionId: leadId, state: "running" });
    const choice = await mcp("fleet_prepare_pr_maintenance", input);
    expect(choice.ok, choice.text).toBe(true);
    expect(JSON.parse(choice.text)).toMatchObject({ status: "needs_task_choice" });
    expect(store.prMaintenance.getProposal(run.id)).toBeUndefined();
  });

  it("keeps released PR history visible when the same task starts its next job", async () => {
    const { app, store, run, registration, authorize, leadId, mcp } = await setup();
    expect((await authorize()).statusCode).toBe(200);
    const first = store.prMaintenance.list().records[0]!;
    store.prMaintenance.operatorAction(
      first.id,
      first.version,
      {
        action: "release",
        reason: "Settled, continue with the next PR",
      },
      "operator",
    );
    store.prMaintenance.enableFromOperator(
      {
        ...registration,
        identity: { ...registration.identity, prNumber: 18 },
      },
      "operator",
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/pr-maintenance`,
      headers: { "fixture-browser": "yes" },
    });
    expect(response.json().records).toHaveLength(2);
    const records = JSON.parse(
      (await mcp("fleet_get_pr_maintenance", { taskId: run.id })).text,
    ).records;
    expect(records).toHaveLength(2);
    expect(
      records.filter(
        (record: { ownershipReleasedAt?: string }) => !record.ownershipReleasedAt,
      ),
    ).toHaveLength(1);
    expect(store.prMaintenance.get(first.id, leadId)?.ownershipReleasedAt).toBeTruthy();
    expect(
      (await mcp("fleet_list_work", { query: "owner/repo/pull/17" })).text,
    ).toContain(run.id);
    expect(
      (await mcp("fleet_list_work", { query: "owner/repo/pull/18" })).text,
    ).toContain(run.id);
  });

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
