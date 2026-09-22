import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  NODE_ID_HEADER,
  NODE_SECRET_HEADER,
  ORCHESTRATOR_STOP_REASON,
  type NodeCommand,
  type SessionEvent,
} from "@fleet/protocol";
import { CommandRouter } from "../../../node/src/router.js";
import { fleet } from "../orchestrator/fleet-harness.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { archiveRun } from "../orchestrator/lifecycle.js";
import { FleetTools } from "../orchestrator/tools.js";
import { FleetService } from "../fleet-service.js";
import { FleetAuth, AUTH_MODE_SETTING, NO_AUTH_PRINCIPAL } from "../auth/service.js";
import { OPERATOR_COOKIE } from "../auth.js";
import { registerRequestGuard } from "../request-guard.js";
import { sessionRoutes } from "./sessions.js";
import { orchestratorRoutes } from "./orchestrators.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const headSha = "a".repeat(40);
const source = { id: "thread", revision: "1", groupKey: "bug", evidence: "fixture" };

async function setup(
  mode: "password" | "recovery" | "microsoft-code" | "no-auth" = "password",
  publicationAuthorized = false,
) {
  const f = fleet();
  const { store, service, leadId } = f;
  const placement = store.listPlacements()[0]!;
  const task = store.createRun({
    workspaceId: placement.workspaceId,
    name: "Retained",
    objective: "Preserve design",
  });
  store.updateRun(task.id, { leadSessionId: leadId, state: "running" });
  const worker = store.createSession(placement, "original", false, "Worker", {
    runId: task.id,
    runRole: "worker",
  });
  store.transitionSession(worker.id, "starting");
  store.transitionSession(worker.id, "idle");
  const step = store.upsertRunStep(task.id, {
    stepKey: "work",
    title: "Work",
    prompt: "original",
    category: "implement",
    placementId: placement.id,
  });
  store.updateRunStep(step.id, { state: "succeeded", sessionId: worker.id });
  let record = store.prMaintenance.enableFromOperator(
    {
      taskId: task.id,
      workerSessionId: worker.id,
      identity: {
        host: "github.com",
        repositoryId: "repo",
        repository: "test/repo",
        prNumber: 1,
        headRepositoryId: "repo",
        headRepository: "test/repo",
        headRef: "refs/heads/fix",
        baseRepositoryId: "repo",
        baseRepository: "test/repo",
        baseRef: "refs/heads/main",
      },
      scope: {
        baseline: "Preserve design",
        verification: "Native tests",
        publicationAuthorized: true,
      },
      headSha,
      eligibilityEvidence: "Fixture existing bound checkout",
    },
    "original-operator",
  );
  if (!publicationAuthorized) {
    const backup = store.prMaintenance.exportBackup();
    backup.registrations[0]!.authorization.scope.publicationAuthorized = false;
    store.writeAtomically(() => store.prMaintenance.importBackup(backup));
    record = store.prMaintenance.get(record.id)!;
  }
  if (mode === "no-auth") store.setSetting(AUTH_MODE_SETTING, NO_AUTH_PRINCIPAL);
  const auth = new FleetAuth({
    store,
    configuredPassword: mode === "no-auth" ? undefined : "fixture-password",
    announceClaimCode: () => {},
    warn: () => {},
    externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
  });
  let administratorId = "";
  if (mode === "microsoft-code") {
    administratorId = store.claimFirstAdministrator({
      tenantId: "tenant",
      objectId: "person",
      displayName: "Supervisor",
      username: "supervisor@example.test",
    })!.id;
  }
  const session =
    mode === "no-auth"
      ? undefined
      : auth.sessions.issue({ administratorId, authMethod: mode });
  const headers: Record<string, string> = {
    "x-csrf-token": auth.sessions.csrfToken(session?.tokenHash ?? NO_AUTH_PRINCIPAL),
    ...(session ? { cookie: `${OPERATOR_COOKIE}=${session.token}` } : {}),
  };
  const sent: NodeCommand[] = [];
  const link = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => {
      const message = JSON.parse(raw) as { type: string; command: NodeCommand };
      if (message.type === "command") sent.push(message.command);
    },
    close: () => {},
  };
  service.attachNode(worker.nodeId, link);
  const app = Fastify();
  registerRequestGuard(app, { store, auth, allowlist: {} });
  app.setErrorHandler((error, _request, reply) => {
    reply
      .code(
        error instanceof z.ZodError
          ? 400
          : Number((error as { statusCode?: number }).statusCode ?? 500),
      )
      .send({ error: error instanceof Error ? error.message : String(error) });
  });
  await app.register(sessionRoutes, { service });
  await app.register(orchestratorRoutes, {
    service,
    engine: new OrchestratorEngine(service),
  });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    store.close();
  });
  const command = (
    kind: "prompt" | "resume",
    payload: Record<string, unknown> = {},
    requestHeaders = headers,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${worker.id}/${kind}`,
      headers: requestHeaders,
      payload: {
        ...(kind === "prompt"
          ? { prompt: "Implement the supervisor's requested fix" }
          : {}),
        ...payload,
      },
    });
  let sequence = 0;
  const event = (type: SessionEvent["type"], payload: unknown) => {
    const result = service.handleEvent({
      eventId: randomUUID(),
      sessionId: worker.id,
      nodeId: worker.nodeId,
      sequence: ++sequence,
      createdAt: new Date().toISOString(),
      type,
      payload,
    } as SessionEvent);
    expect(result).toBe(true);
  };
  const settle = () => {
    event("state", { state: "running" });
    event("turn_complete", {});
    event("state", { state: "idle" });
  };
  const resumable = () => {
    event("agent_session", { agentSessionId: "existing-conversation" });
    store.transitionSession(worker.id, "stopped");
  };
  const queue = () => {
    let current = store.prMaintenance.get(record.id)!;
    current = store.prMaintenance.checkpoint(leadId, record.id, current.version, {
      kind: "observation",
      observation: {
        attemptedAt: new Date().toISOString(),
        complete: true,
        identity: record.identity,
        snapshotId: "snapshot",
        headSha,
        state: "open",
        fingerprint: "fixture",
        mergeability: "mergeable",
        sources: [source],
        evidence: "Complete fixture observation",
      },
    });
    current = store.prMaintenance.checkpoint(leadId, record.id, current.version, {
      kind: "prepare_batch",
      batch: {
        id: "queued",
        kind: "repair",
        sources: [source],
        headSha,
        prompt: "automatic repair",
        scope: "Preserve design",
        reservedMutations: 1,
      },
    });
    return store.writeAtomically(() => {
      const retry = store.retryRunStepInSession(
        task.id,
        {
          stepKey: "work",
          title: "Work",
          prompt: "automatic repair",
          placementId: placement.id,
        },
        worker.id,
        0,
      );
      return store.prMaintenance.acceptBatch(
        leadId,
        record.id,
        current.generation,
        "queued",
        retry.id,
        retry.attempts,
        retry.prompt,
      );
    });
  };
  return {
    ...f,
    task,
    worker,
    step,
    record,
    app,
    auth,
    headers,
    session,
    sent,
    link,
    command,
    event,
    settle,
    resumable,
    queue,
  };
}

describe("trusted supervisor session handoff", () => {
  it.each(["subscription", "restart", "failure"] as const)(
    "never settles a stopped repair with a later manual %s event",
    async (path) => {
      const f = await setup("password", true);
      f.event("agent_session", { agentSessionId: "existing-conversation" });
      f.queue();
      let engine = new OrchestratorEngine(f.service);
      let unsubscribe = f.service.onSessionEvent((event) =>
        engine.handleSessionEvent(event),
      );
      archiveRun(f.service, f.task.id, ORCHESTRATOR_STOP_REASON, {
        stoppedByOrchestrator: true,
      });
      f.event("state", { state: "stopped" });
      let record = f.store.prMaintenance.get(f.record.id)!;
      record = f.store.prMaintenance.checkpoint(f.leadId, record.id, record.version, {
        kind: "batch",
        batchId: "queued",
        generation: record.generation,
        state: "cancelled",
        executionSettled: true,
        usedMutations: 0,
        findings: [
          {
            source,
            outcome: "incomplete",
            stage: "not_attempted",
            evidence: [],
            responseRequired: false,
            responseIds: [],
            nextAction: "Wait for explicit direction.",
            progress: false,
          },
        ],
        effects: [],
        evidence: "Queued attempt stopped; no execution or remote effects.",
      });
      const stopped = f.store.getRunStep(f.step.id)!;
      expect(stopped).toMatchObject({
        state: "cancelled",
        stoppedByOrchestrator: true,
      });
      expect((await f.command("resume", { operationId: randomUUID() })).statusCode).toBe(
        202,
      );
      f.event("state", { state: "idle" });
      expect(
        (await f.command("prompt", { prompt: "Explain only", operationId: randomUUID() }))
          .statusCode,
      ).toBe(202);
      if (path === "restart") unsubscribe();
      f.event("state", { state: "running" });
      f.event("agent_text", { text: "Explanation only." });
      if (path === "failure")
        f.event("state", { state: "failed", activity: "Manual failure" });
      else {
        f.event("turn_complete", {});
        if (path === "restart") {
          engine = new OrchestratorEngine(f.service);
          unsubscribe = f.service.onSessionEvent((event) =>
            engine.handleSessionEvent(event),
          );
        }
        f.event("state", { state: "idle" });
      }
      unsubscribe();
      expect(f.store.getRunStep(f.step.id)).toEqual(stopped);
      expect(f.store.getRun(f.task.id)?.state).toBe("cancelled");
      expect(f.store.prMaintenance.get(record.id)).toMatchObject({
        lifecycle: "paused",
        batches: [{ state: "cancelled" }],
      });
    },
  );

  it.each(["released", "re-enabled"] as const)(
    "keeps UUID receipts across %s maintenance with the actual Node command cache",
    async (boundary) => {
      const f = await setup();
      const prompt = vi.fn(async () => f.settle());
      const router = new CommandRouter(
        {
          async start() {
            return {
              prompt,
              async cancel() {},
              async stop() {},
              resolvePermission() {},
              denyPendingPermissions() {},
              async setConfigOption() {},
              busy: false,
              resync() {},
            };
          },
        },
        8,
        () => {},
        async (path) => path,
      );
      expect(
        await router.route({
          type: "resume_session",
          commandId: randomUUID(),
          sessionId: f.worker.id,
          localPath: "C:\\fixture",
          agentSessionId: "conversation",
          additionalDirectories: [],
          sequenceOffset: 0,
          yolo: false,
          mcpServers: [],
          agent: "",
          config: [],
          readOnly: false,
        }),
      ).toMatchObject({ ok: true });
      const operationId = randomUUID();
      expect((await f.command("prompt", { operationId })).statusCode).toBe(202);
      const original = f.sent.at(-1)!;
      expect(await router.route(original)).toMatchObject({ ok: true });
      expect(prompt).toHaveBeenCalledTimes(1);
      let record = f.store.prMaintenance.get(f.record.id)!;
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "release", reason: "Settled" },
        "operator",
      );
      if (boundary === "re-enabled")
        record = f.store.prMaintenance.enableFromOperator(
          {
            taskId: f.task.id,
            workerSessionId: f.worker.id,
            identity: record.identity,
            scope: { ...record.authorization.scope, publicationAuthorized: true },
            headSha,
            eligibilityEvidence: "Same retained checkout",
          },
          "operator",
        );
      expect((await f.command("prompt", { operationId })).statusCode).toBe(202);
      expect(f.sent).toHaveLength(1);
      expect(
        (await f.command("prompt", { operationId, prompt: "Changed input" })).statusCode,
      ).toBe(409);
      const other = f.auth.sessions.issue({
        administratorId: "",
        authMethod: "recovery",
      });
      expect(
        (
          await f.command(
            "prompt",
            { operationId },
            {
              cookie: `${OPERATOR_COOKIE}=${other.token}`,
              "x-csrf-token": f.auth.sessions.csrfToken(other.tokenHash),
            },
          )
        ).statusCode,
      ).toBe(409);
      const freshId = randomUUID();
      expect((await f.command("prompt", { operationId: freshId })).statusCode).toBe(202);
      expect(() =>
        f.service.dispatch(f.worker.nodeId, {
          type: "prompt",
          sessionId: f.worker.id,
          prompt: "Automatic work",
          attachments: [],
        }),
      ).toThrow(boundary === "released" ? /manual_execution_unsettled/ : /paused/);
      if (boundary === "released")
        expect(() =>
          f.store.prMaintenance.enableFromOperator(
            {
              taskId: f.task.id,
              workerSessionId: f.worker.id,
              identity: record.identity,
              scope: { ...record.authorization.scope, publicationAuthorized: true },
              headSha,
              eligibilityEvidence: "Same checkout, but delivery has no receipt yet",
            },
            "operator",
          ),
        ).toThrow(/settle/);
      const fresh = f.sent.at(-1)!;
      expect(fresh.commandId).not.toBe(original.commandId);
      expect(await router.route(fresh)).toMatchObject({ ok: true });
      expect(await router.route(fresh)).toMatchObject({ ok: true });
      expect(prompt).toHaveBeenCalledTimes(2);
      expect((await f.command("prompt", { operationId: freshId })).statusCode).toBe(202);
      expect(f.sent).toHaveLength(2);
      expect((await f.command("prompt", { operationId: randomUUID() })).statusCode).toBe(
        202,
      );
      expect(await router.route(f.sent.at(-1)!)).toMatchObject({ ok: true });
      expect(prompt).toHaveBeenCalledTimes(3);
      await router.stopAll();
    },
  );

  it("keeps no-sign-in control and reconnect working beyond 1000 settled receipts without Release", async () => {
    const f = await setup("no-auth");
    f.event("agent_session", { agentSessionId: "existing-conversation" });
    const operationId = randomUUID();
    await f.command("prompt", { operationId });
    f.settle();
    const backup = f.store.prMaintenance.exportBackup();
    const manual = backup.registrations[0]!.manualControl!;
    const first = manual.commands[0]!;
    manual.commands.push(
      ...Array.from({ length: 998 }, (_, index) => ({
        ...first,
        id: `historic-${index}`,
        digest: `historic-${index}`,
      })),
    );
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
    f.service.disconnectNode(f.worker.nodeId, "Fixture reconnect");
    f.service.attachNode(f.worker.nodeId, f.link);
    f.store.setNodeOnline(f.worker.nodeId, true, 0);
    f.service.reconcile(f.worker.nodeId, []);
    expect(f.sent.at(-1)?.type).toBe("resume_session");
    f.event("state", { state: "idle" });
    for (let i = 0; i < 3; i++) {
      const reply = await f.command("prompt", { operationId: randomUUID() });
      expect(reply.statusCode, reply.body).toBe(202);
      f.settle();
    }
    const sent = f.sent.length;
    expect((await f.command("prompt", { operationId })).statusCode).toBe(202);
    expect(f.sent).toHaveLength(sent);
    const record = f.store.prMaintenance.get(f.record.id)!;
    expect(record.manualControl!.commands.length).toBeLessThanOrEqual(32);
    expect(record.authorization).toEqual(f.record.authorization);
    const release = await f.app.inject({
      method: "POST",
      url: `/api/runs/${f.task.id}/pr-maintenance`,
      headers: f.headers,
      payload: {
        action: "update",
        recordId: record.id,
        expectedVersion: record.version,
        operation: { action: "release", reason: "Not authorized" },
      },
    });
    expect(release.statusCode).toBe(403);
  });

  it("retains uncertain manual delivery after Release across reconnect and cleanup paths", async () => {
    const f = await setup();
    f.event("agent_session", { agentSessionId: "conversation" });
    await f.command("prompt", { operationId: randomUUID() });
    f.settle();
    const record = f.store.prMaintenance.get(f.record.id)!;
    f.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      {
        action: "release",
        reason: "Settled",
      },
      "operator",
    );
    const operationId = randomUUID();
    expect((await f.command("prompt", { operationId })).statusCode).toBe(202);
    const dispatch = f.store.getSessionDispatchAttempt(f.worker.id);
    expect(f.store.prMaintenance.hasSessionRetentionBlockers(f.worker.id)).toBe(true);
    expect(() => f.store.prMaintenance.assertTaskCleanupAllowed(f.task.id)).toThrow(
      /receipts/,
    );
    f.service.disconnectNode(f.worker.nodeId, "No delivery receipt");
    f.service.attachNode(f.worker.nodeId, f.link);
    f.store.setNodeOnline(f.worker.nodeId, true, 0);
    expect(() => f.service.reconcile(f.worker.nodeId, [])).not.toThrow();
    expect(f.sent).toHaveLength(2);
    expect(f.store.getSessionDispatchAttempt(f.worker.id)).toEqual(dispatch);
    expect((await f.command("prompt", { operationId })).statusCode).toBe(409);
    expect(f.store.prMaintenance.pendingManualCommands(f.worker.id)).toMatchObject([
      { id: dispatch!.commandId, state: "unknown" },
    ]);
  });

  it.each([
    ["store", "unknown"],
    ["route", "unknown"],
    ["store", "accepted"],
    ["route", "accepted"],
  ] as const)(
    "retains manual evidence during mixed ended-session cleanup through %s (%s)",
    async (path, state) => {
      const f = await setup();
      await f.command("prompt", { operationId: randomUUID() });
      f.settle();
      const record = f.store.prMaintenance.get(f.record.id)!;
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        {
          action: "release",
          reason: "Settled",
        },
        "operator",
      );
      expect(f.store.getSession(f.worker.id)?.agentSessionId).toBe("");
      expect((await f.command("prompt", { operationId: randomUUID() })).statusCode).toBe(
        202,
      );
      const dispatch = f.store.getSessionDispatchAttempt(f.worker.id)!;
      if (state === "accepted")
        f.store.prMaintenance.recordManualReceipt(
          f.worker.id,
          dispatch.commandId,
          "accepted",
        );
      f.event("agent_text", { text: "Unsettled execution evidence" });
      f.service.disconnectNode(f.worker.nodeId, "Delivery unknown");
      f.service.attachNode(f.worker.nodeId, f.link);
      f.store.setNodeOnline(f.worker.nodeId, true, 0);
      f.service.reconcile(f.worker.nodeId, []);
      expect(f.store.getSession(f.worker.id)?.state).toBe("failed");
      const events = f.store.listEvents(f.worker.id);
      const disposable = f.store.createSession(f.store.listPlacements()[0]!, "Ended");
      f.store.transitionSession(disposable.id, "failed");
      expect(() => f.store.deleteSession(f.worker.id)).toThrow(/maintenance/i);
      const clear = async () => {
        if (path === "store") return f.store.deleteEndedSessions();
        const response = await f.app.inject({
          method: "DELETE",
          url: "/api/sessions",
          headers: f.headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{ removed: number }>().removed;
      };
      expect(await clear()).toBe(1);
      expect(f.store.getSession(disposable.id)).toBeUndefined();
      expect(f.store.getSession(f.worker.id)).toBeDefined();
      expect(f.store.getSessionDispatchAttempt(f.worker.id)).toEqual(dispatch);
      expect(f.store.listEvents(f.worker.id)).toEqual(events);
      expect(f.store.getRunStep(f.step.id)?.sessionId).toBe(f.worker.id);
      expect(() => f.store.deleteRun(f.task.id)).toThrow(/receipts/);
      expect(() => f.store.deletePlacement(f.worker.placementId)).toThrow(
        /retains.*checkout/,
      );
      expect(() =>
        f.store.requestSessionCleanup({
          sessionId: f.worker.id,
          nodeId: f.worker.nodeId,
          commandId: randomUUID(),
          inactiveBefore: "2099-01-01T00:00:00.000Z",
          retentionDays: 30,
          requestedAt: new Date().toISOString(),
          inFlight: true,
        }),
      ).toThrow(/retained/);
      f.event("turn_complete", {});
      expect(
        f.store.prMaintenance.manualCommand(f.worker.id, dispatch.commandId)?.state,
      ).toBe("settled");
      expect(await clear()).toBe(1);
      expect(f.store.getSession(f.worker.id)).toBeUndefined();
      expect(() =>
        f.store.prMaintenance.assertTaskCleanupAllowed(f.task.id),
      ).not.toThrow();
    },
  );

  it("treats settled keyless Resume after Stop as a new lifecycle intent, not a successful no-op", async () => {
    const f = await setup();
    f.resumable();
    expect((await f.command("resume")).statusCode).toBe(202);
    expect((await f.command("resume")).statusCode).toBe(409);
    f.event("state", { state: "idle" });
    expect((await f.command("resume")).statusCode).toBe(409);
    f.resumable();
    expect((await f.command("resume")).statusCode).toBe(202);
    expect(f.store.getSession(f.worker.id)?.state).toBe("starting");
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.commandId).not.toBe(f.sent[0]!.commandId);
    f.event("state", { state: "idle" });
    for (let i = 0; i < 2; i++) {
      expect((await f.command("prompt")).statusCode).toBe(202);
      expect((await f.command("prompt")).statusCode).toBe(409);
      f.settle();
    }
    expect(f.sent).toHaveLength(4);
    f.service.disconnectNode(f.worker.nodeId, "Keyless conversation reconnect");
    f.service.attachNode(f.worker.nodeId, f.link);
    f.store.setNodeOnline(f.worker.nodeId, true, 0);
    f.service.reconcile(f.worker.nodeId, []);
    expect(f.sent.at(-1)?.type).toBe("resume_session");
    f.event("state", { state: "idle" });
    expect((await f.command("resume")).statusCode).toBe(409);
    expect(f.sent).toHaveLength(5);
  });

  it.each(["password", "recovery", "microsoft-code", "no-auth"] as const)(
    "admits normal observation-only prompt and paused resume through real %s guards",
    async (mode) => {
      const f = await setup(mode);
      const original = f.record.authorization;
      const prompt = await f.command("prompt", { operationId: randomUUID() });
      expect(prompt.statusCode, prompt.body).toBe(202);
      expect(f.sent.at(-1)).toMatchObject({ type: "prompt", sessionId: f.worker.id });
      expect(f.sent.at(-1)).toHaveProperty(
        "prompt",
        expect.stringContaining("supervisor's requested fix"),
      );
      f.settle();
      expect(f.store.prMaintenance.get(f.record.id)).toMatchObject({
        lifecycle: "paused",
        pauseReason: "manual_control",
        authorization: original,
        manualControl: { commands: [{ kind: "prompt", state: "settled" }] },
      });
      f.resumable();
      const resumed = await f.command("resume", { operationId: randomUUID() });
      expect(resumed.statusCode, resumed.body).toBe(202);
      expect(f.sent.at(-1)).toMatchObject({
        type: "resume_session",
        agentSessionId: "existing-conversation",
      });
      f.event("state", { state: "idle" });
      expect(f.store.prMaintenance.get(f.record.id)?.lifecycle).toBe("paused");
    },
  );

  it("retains a pending design decision, review state and scope without approving or renewing them", async () => {
    const f = await setup();
    const held = f.store.prMaintenance.holdForDecision(
      f.leadId,
      f.record.id,
      f.record.version,
      {
        id: "design",
        version: 1,
        proposal: "Change API?",
        scope: "Public API",
        headSha,
      },
      () => f.store.updateRun(f.task.id, { state: "awaiting_human" }),
    );
    const reply = await f.command("prompt");
    expect(reply.statusCode, reply.body).toBe(202);
    f.settle();
    const record = f.store.prMaintenance.get(f.record.id)!;
    expect(record.decision).toEqual(held.decision);
    expect(record.authorization).toEqual(held.authorization);
    expect(record.renewedAt).toEqual(held.renewedAt);
    expect(f.store.getRun(f.task.id)?.state).toBe("awaiting_human");
    expect(record.readyFingerprint).toBeUndefined();
    expect(
      new FleetTools(f.service, f.leadId).setPrMaintenance({
        recordId: record.id,
        expectedVersion: record.version,
        action: "resume",
      }).ok,
    ).toBe(false);
  });

  it.each(["active", "paused"] as const)(
    "takes direct Resume from %s observation-only maintenance without a prior prompt",
    async (state) => {
      const f = await setup();
      if (state === "paused")
        f.store.prMaintenance.operatorAction(
          f.record.id,
          f.record.version,
          { action: "pause", reason: "Operator pause" },
          "operator",
        );
      f.resumable();
      const operationId = randomUUID();
      const reply = await f.command("resume", { operationId });
      expect(reply.statusCode, reply.body).toBe(202);
      expect((await f.command("resume", { operationId })).statusCode).toBe(409);
      f.event("state", { state: "idle" });
      expect((await f.command("resume", { operationId })).statusCode).toBe(202);
      expect(f.sent).toHaveLength(1);
      expect(f.store.prMaintenance.get(f.record.id)).toMatchObject({
        lifecycle: "paused",
        authorization: f.record.authorization,
        manualControl: { commands: [{ kind: "resume_session", state: "settled" }] },
      });
    },
  );

  it("refuses changed checkout identity before manual takeover without clearing the binding", async () => {
    const f = await setup();
    const binding = {
      worktreeId: "",
      generation: 1,
      sourcePlacementId: f.worker.placementId,
      cwd: "C:\\other-checkout",
      checkoutKey: "other-checkout",
      leaseAttempt: "other-owner",
      accessClass: "shell" as const,
      quarantined: false,
    };
    f.store.setSessionExecutionBinding(f.worker.id, binding);
    const reply = await f.command("prompt");
    expect(reply.statusCode, reply.body).toBe(409);
    expect(reply.body).toMatch(/binding_changed/);
    expect(f.store.getSession(f.worker.id)?.executionBinding).toEqual(binding);
    expect(f.store.prMaintenance.get(f.record.id)?.manualControl).toBeUndefined();
    expect(f.sent).toHaveLength(0);
  });

  it("does not accept a revoked operator session as supervisor provenance", async () => {
    const f = await setup();
    f.auth.logout(f.session!.token);
    expect((await f.command("prompt", { operatorId: "forged" })).statusCode).toBe(401);
    expect(f.sent).toHaveLength(0);
    expect(f.store.prMaintenance.get(f.record.id)?.manualControl).toBeUndefined();
  });

  it.each(["prompt", "resume"] as const)(
    "rejects missing, Node, MCP and forged credentials for %s",
    async (kind) => {
      const f = await setup();
      if (kind === "resume") f.resumable();
      const node = f.store.registerNode({
        name: "untrusted",
        os: "win32",
        arch: "x64",
        version: "1",
        capabilities: [],
        maxSessions: 1,
      });
      const forged = {
        human: true,
        supervisor: true,
        operatorId: "operator",
        fleetHumanActor: "operator",
        operationId: randomUUID(),
      };
      for (const headers of [
        {},
        { "x-supervisor": "true", "x-fleet-human-actor": "operator" },
        { authorization: "Bearer autonomous-mcp-token" },
        { ...f.headers, authorization: "Bearer autonomous-mcp-token" },
        {
          ...f.headers,
          [NODE_ID_HEADER]: node.node.id,
          [NODE_SECRET_HEADER]: node.secret,
        },
      ]) {
        const reply = await f.command(kind, forged, headers);
        expect(reply.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(f.sent).toHaveLength(0);
      expect(f.store.prMaintenance.get(f.record.id)?.manualControl).toBeUndefined();
      if (kind === "prompt")
        expect(() =>
          f.service.promptSession(f.worker.id, {
            prompt: "I am the supervisor",
            attachments: [],
          }),
        ).toThrow();
      else
        expect(f.service.resumeSession(f.worker.id)).toMatchObject({
          ok: false,
          status: 409,
        });
    },
  );

  it("does not convert no-sign-in MCP bearer/Node flags into human provenance", async () => {
    const f = await setup("no-auth");
    for (const headers of [
      {},
      { ...f.headers, authorization: "Bearer lead" },
      { ...f.headers, [NODE_ID_HEADER]: f.worker.nodeId },
    ]) {
      expect(
        (await f.command("prompt", { supervisor: true }, headers)).statusCode,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(f.sent).toHaveLength(0);
  });

  it("atomically fences accepted-but-never-sent queued maintenance and cannot revive it after the manual turn", async () => {
    const f = await setup("password", true);
    const queued = f.queue();
    f.store.prMaintenance.beginWake(f.leadId, "stale-automatic-wake");
    const reference = f.store.prMaintenance.referenceForStep(f.step.id)!;
    const reply = await f.command("prompt", { operationId: randomUUID() });
    expect(reply.statusCode, reply.body).toBe(202);
    const record = f.store.prMaintenance.get(f.record.id)!;
    expect(record.batches[0]).toMatchObject({
      id: queued.batches[0]!.id,
      state: "cancelled",
      executionSettled: true,
      executionNotDispatched: true,
    });
    expect(f.store.getRunStep(f.step.id)?.state).toBe("cancelled");
    expect(
      f.store.prMaintenance.admission({
        action: "execute",
        sessionId: f.worker.id,
        ...reference,
      }).allowed,
    ).toBe(false);
    expect(f.store.prMaintenance.wakeEligibleLeadIds()).not.toContain(f.leadId);
    expect(
      f.store.prMaintenance.takeDue(f.leadId, "stale-automatic-wake"),
    ).toBeUndefined();
    expect(() =>
      f.service.dispatch(f.worker.nodeId, {
        type: "prompt",
        sessionId: f.worker.id,
        prompt: "automatic repair",
        attachments: [],
      }),
    ).toThrow(/paused/);
    f.settle();
    new OrchestratorEngine(f.service).tick();
    expect(f.sent.filter((entry) => entry.sessionId === f.worker.id)).toHaveLength(1);
    expect(f.store.prMaintenance.get(f.record.id)?.lifecycle).toBe("paused");
  });

  it.each(["sent", "unknown-effect"] as const)(
    "refuses %s maintenance without deleting receipts, pausing or cancelling its worker",
    async (state) => {
      const f = await setup("password", true);
      let record = f.queue();
      if (state === "sent") {
        f.store.updateRunStep(f.step.id, {
          state: "starting",
          dispatchedAt: new Date().toISOString(),
        });
        f.service.dispatch(f.worker.nodeId, {
          type: "prompt",
          sessionId: f.worker.id,
          prompt: "automatic repair",
          attachments: [],
        });
      } else {
        record = f.store.prMaintenance.checkpoint(f.leadId, record.id, record.version, {
          kind: "batch",
          batchId: "queued",
          generation: record.generation,
          state: "uncertain",
          findings: [],
          effects: [],
          executionSettled: false,
          evidence: "Lost execution receipt",
        });
      }
      const before = f.store.prMaintenance.get(record.id);
      const sent = f.sent.length;
      const reply = await f.command("prompt");
      expect(reply.statusCode, reply.body).toBe(409);
      expect(reply.body).toMatch(/receipts/);
      expect(f.sent).toHaveLength(sent);
      expect(f.store.prMaintenance.get(record.id)).toEqual(before);
    },
  );

  it("deduplicates uncertain, accepted and settled retries across service restart and rejects key reuse with new input", async () => {
    const f = await setup();
    const operationId = randomUUID();
    expect((await f.command("prompt", { operationId })).statusCode).toBe(202);
    expect((await f.command("prompt", { operationId })).statusCode).toBe(409);
    f.store.prMaintenance.recordManualReceipt(
      f.worker.id,
      f.sent[0]!.commandId,
      "accepted",
    );
    expect((await f.command("prompt", { operationId })).statusCode).toBe(202);
    expect((await f.command("prompt", { operationId: randomUUID() })).statusCode).toBe(
      409,
    );
    f.settle();
    const restarted = new FleetService(f.store, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    restarted.attachNode(f.worker.nodeId, f.link);
    expect(
      restarted.promptSession(
        f.worker.id,
        {
          prompt: "Implement the supervisor's requested fix",
          attachments: [],
          operationId,
        },
        "operator:password",
      ),
    ).toEqual({ ok: true });
    expect(
      (await f.command("prompt", { operationId, prompt: "different" })).statusCode,
    ).toBe(409);
    expect(f.sent).toHaveLength(1);
  });

  it("reattaches settled manual control on reconnect without replaying a turn or reviving maintenance", async () => {
    const f = await setup();
    f.event("agent_session", { agentSessionId: "existing-conversation" });
    await f.command("prompt", { operationId: randomUUID() });
    f.settle();
    f.service.disconnectNode(f.worker.nodeId, "Fixture disconnected");
    f.service.attachNode(f.worker.nodeId, f.link);
    f.store.setNodeOnline(f.worker.nodeId, true, 0);
    f.service.reconcile(f.worker.nodeId, []);
    expect(f.sent.map((command) => command.type)).toEqual(["prompt", "resume_session"]);
    expect(f.store.prMaintenance.get(f.record.id)?.lifecycle).toBe("paused");
  });

  it("does not replay or automatically reattach an unknown manual delivery", async () => {
    const f = await setup();
    f.event("agent_session", { agentSessionId: "existing-conversation" });
    await f.command("prompt", { operationId: randomUUID() });
    f.service.disconnectNode(f.worker.nodeId, "Unknown delivery");
    f.service.attachNode(f.worker.nodeId, f.link);
    f.store.setNodeOnline(f.worker.nodeId, true, 0);
    expect(() => f.service.reconcile(f.worker.nodeId, [])).not.toThrow();
    expect(f.sent).toHaveLength(1);
    expect((await f.command("resume")).statusCode).toBe(409);
  });

  it.each(["busy", "stopping", "offline", "checkout"] as const)(
    "preserves %s refusal without creating a manual grant",
    async (condition) => {
      const f = await setup();
      if (condition === "busy") f.store.transitionSession(f.worker.id, "running");
      if (condition === "stopping")
        f.store.setSessionControls(f.worker.id, { stopRequested: true });
      if (condition === "offline") f.link.readyState = 3;
      if (condition === "checkout")
        vi.spyOn(f.service.worktrees, "validateSession").mockImplementation(() => {
          throw new Error("Checkout locked");
        });
      const reply = await f.command("prompt");
      expect(reply.statusCode).toBe(
        condition === "offline" ? 503 : condition === "checkout" ? 500 : 409,
      );
      expect(f.sent).toHaveLength(0);
      expect(f.store.prMaintenance.get(f.record.id)?.manualControl).toBeUndefined();
    },
  );

  it("preserves ordinary direct-session prompts without retained maintenance", async () => {
    const f = await setup();
    f.store.prMaintenance.operatorAction(
      f.record.id,
      f.record.version,
      { action: "release", reason: "Settled release" },
      "operator",
    );
    expect((await f.command("prompt")).statusCode).toBe(202);
    expect(f.sent.at(-1)).toMatchObject({
      prompt: "Implement the supervisor's requested fix",
    });
  });
});
