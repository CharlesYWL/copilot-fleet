import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  NODE_ID_HEADER,
  NODE_SECRET_HEADER,
  ORCHESTRATOR_STOP_REASON,
  SessionEventSchema,
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
  vi.useRealTimers();
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
  it("records a local console as a non-human controller without granting human handback authority", async () => {
    const f = await setup();
    const actor = { kind: "node_console" as const, nodeId: f.worker.nodeId };
    const result = f.service.messages.submit(
      f.worker.id,
      {
        prompt: "Local console follow-up",
        attachments: [],
        operationId: randomUUID(),
      },
      undefined,
      actor,
    );
    expect(result).toEqual({ ok: true });
    const record = f.store.prMaintenance.get(f.record.id)!;
    expect(record.manualControl?.actor).toEqual(actor);
    expect(record.manualControl?.operatorId).toBeUndefined();
    expect(record.pauseOrigin).toMatchObject({
      actor: "node_console",
      actorId: f.worker.nodeId,
    });
    expect(record.manualControl?.commands[0]?.actor).toEqual(actor);
    expect(f.sent[0]?.type === "prompt" && f.sent[0].prompt).toContain(
      "local Node console",
    );
    expect(
      f.service.promptSession(
        f.worker.id,
        {
          prompt: "Cannot authorize handback",
          attachments: [],
          handback: "after_turn",
        },
        undefined,
        undefined,
        actor,
      ),
    ).toMatchObject({ ok: false, status: 403 });
  });
  it.each(["terminal worker", "terminal worker cold ledger", "manual worker", "lead"])(
    "streams authoritative permission holds for a %s without publishing stale attempt events",
    async (path) => {
      const f = await setup("password", true);
      if (path === "manual worker")
        expect((await f.command("prompt")).statusCode).toBe(202);
      if (!path.endsWith("cold ledger")) f.service.snapshot();
      const sessionId = path === "lead" ? f.leadId : f.worker.id;
      const otherSessionId = path === "lead" ? f.worker.id : f.leadId;
      const record = f.store.prMaintenance.get(f.record.id);
      const step = f.store.getRunStep(f.step.id);
      const worker = f.store.getSession(f.worker.id);
      const sent = [...f.sent];
      const broadcast = vi.spyOn(f.service, "broadcast");
      const listener = vi.fn();
      f.service.onSessionEvent(listener);
      let sequence = 10;
      const permissionEvent = (target: string, requestId: string, resolve = false) =>
        SessionEventSchema.parse({
          eventId: randomUUID(),
          sessionId: target,
          sequence: ++sequence,
          createdAt: new Date().toISOString(),
          type: resolve ? "permission_result" : "permission",
          payload: resolve ? { requestId, outcome: "deny" } : { requestId, options: [] },
        });
      const deliver = (event: SessionEvent) => {
        broadcast.mockClear();
        listener.mockClear();
        expect(f.service.handleEvent(event)).toBe(true);
      };
      const projected = () => {
        const snapshots = broadcast.mock.calls
          .map(([message]) => message)
          .filter((message) => message.type === "snapshot");
        expect(snapshots).toHaveLength(1);
        return snapshots[0]!.data.prMaintenanceTasks?.find(
          (status) => status.taskId === f.task.id,
        )?.effective;
      };
      const held = async () => {
        expect(projected()).toMatchObject({
          status: "needs_decision",
          reason: expect.stringMatching(/permission/i),
          action: expect.stringMatching(/permission/i),
        });
        expect((await f.command("prompt")).statusCode).toBe(409);
        expect(f.store.prMaintenance.get(f.record.id)).toEqual(record);
        expect(f.store.getRunStep(f.step.id)).toEqual(step);
        expect(f.sent).toEqual(sent);
      };

      const first = permissionEvent(sessionId, "first");
      deliver(first);
      await held();
      if (path.startsWith("terminal worker")) {
        expect(broadcast.mock.calls.map(([message]) => message.type)).toEqual([
          "snapshot",
        ]);
        expect(listener).not.toHaveBeenCalled();
        expect(f.store.getSession(f.worker.id)).toEqual({
          ...worker,
          lastActivityAt: expect.any(String),
        });
      } else {
        expect(listener).toHaveBeenCalledWith(first);
      }
      deliver(first);
      expect(broadcast).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(f.sent).toEqual(sent);

      deliver(permissionEvent(sessionId, "second"));
      await held();
      deliver(permissionEvent(sessionId, "wrong-request", true));
      await held();
      deliver(permissionEvent(otherSessionId, "first", true));
      await held();
      deliver(permissionEvent(sessionId, "first", true));
      await held();
      const last = permissionEvent(sessionId, "second", true);
      deliver(last);
      expect(projected()?.status).toBe(
        path === "manual worker" ? "running_manually" : "checking",
      );
      expect(f.store.prMaintenance.get(f.record.id)).toEqual(record);
      expect(f.store.getRunStep(f.step.id)).toEqual(step);
      expect(f.sent).toEqual(sent);
      deliver(last);
      deliver(first);
      expect(broadcast).not.toHaveBeenCalled();
      expect(
        f.service
          .snapshot()
          .permissionEvents?.filter((event) => event.type === "permission"),
      ).toEqual([]);

      // A different session's permission is not this registration's authority.
      const unrelated = f.store.createSession(f.store.listPlacements()[0]!, "unrelated");
      deliver(permissionEvent(unrelated.id, "first"));
      expect(broadcast.mock.calls.some(([message]) => message.type === "snapshot")).toBe(
        false,
      );
      expect(
        f.service
          .snapshot()
          .prMaintenanceTasks?.find((status) => status.taskId === f.task.id)?.effective
          ?.status,
      ).toBe(path === "manual worker" ? "running_manually" : "checking");
      if (path.startsWith("terminal worker")) {
        deliver(
          SessionEventSchema.parse({
            eventId: randomUUID(),
            sessionId,
            sequence: ++sequence,
            createdAt: new Date().toISOString(),
            type: "state",
            payload: { state: "running" },
          }),
        );
        expect(broadcast).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        expect(f.store.getSession(f.worker.id)).toEqual({
          ...worker,
          lastActivityAt: expect.any(String),
        });
      }
    },
  );

  function observeHandback(f: Awaited<ReturnType<typeof setup>>) {
    const record = f.store.prMaintenance.get(f.record.id)!;
    return f.store.prMaintenance.checkpoint(f.leadId, record.id, record.version, {
      kind: "observation",
      observation: {
        attemptedAt: new Date().toISOString(),
        complete: true,
        identity: record.identity,
        headSha,
        baseSha: "b".repeat(40),
        state: "open",
        snapshotId: `manual-${Date.now()}`,
        fingerprint: "manual-current",
        evidence: "Fresh complete post-turn provider reconciliation",
        sources: [source],
      },
    });
  }

  it.each(["stale", "missing"] as const)(
    "accepts a real operator one-turn continuation with %s cached evidence",
    async (evidence) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime("2026-10-13T20:37:34.401Z");
      const f = await setup("password", true);
      if (evidence === "stale") observeHandback(f);
      vi.setSystemTime("2026-10-13T21:10:03.953Z");
      const before = f.store.prMaintenance.get(f.record.id)!;
      const response = await f.command("prompt", {
        prompt: "Regenerate the API report from the accepted code, then hand back.",
        handback: "after_turn",
        operationId: randomUUID(),
      });
      expect(response.statusCode, response.body).toBe(202);
      const accepted = f.store.prMaintenance.get(f.record.id)!;
      expect(accepted.observation).toEqual(before.observation);
      expect(accepted.authorization).toEqual(before.authorization);
      expect(accepted.continuation).toMatchObject({
        state: "handback",
        evidenceState: "refresh_required",
        operatorId: expect.any(String),
      });
      expect(f.sent.filter((entry) => entry.type === "prompt")).toHaveLength(1);
    },
  );

  it("hands back only the selected completed turn after quiescence and fresh reconciliation, without renewing its grant", async () => {
    const f = await setup("password", true);
    const before = observeHandback(f);
    const payload = {
      prompt: "Repair the bounded defect then hand back.",
      handback: "after_turn",
      operationId: randomUUID(),
    };
    const response = await f.command("prompt", payload);
    expect(response.statusCode, response.body).toBe(202);
    const intent = f.store.prMaintenance.get(f.record.id)!.continuation!;
    expect(intent).toMatchObject({
      state: "handback",
      operatorId: expect.any(String),
      manualCommandId: expect.any(String),
    });
    expect((await f.command("prompt", payload)).statusCode).toBe(409);
    expect(f.sent.filter((entry) => entry.type === "prompt")).toHaveLength(1);
    const engine = new OrchestratorEngine(f.service);
    f.event("state", { state: "idle" });
    engine.tick();
    expect(
      f.store.prMaintenance.get(f.record.id)!.continuation?.completedAt,
    ).toBeUndefined();
    f.event("state", { state: "running" });
    f.event("turn_complete", { reason: "end_turn" });
    engine.tick();
    expect(
      f.store.prMaintenance.get(f.record.id)!.manualControl?.endedAt,
    ).toBeUndefined();
    f.event("state", { state: "idle" });
    engine.tick();
    expect(
      f.store.prMaintenance.get(f.record.id)!.continuation?.completedAt,
    ).toBeDefined();
    expect(
      f.store.prMaintenance.get(f.record.id)!.manualControl?.endedAt,
    ).toBeUndefined();
    observeHandback(f);
    engine.tick();
    const handedBack = f.store.prMaintenance.get(f.record.id)!;
    expect(handedBack.lifecycle).toBe("active");
    expect(handedBack.manualControl?.endedAt).toBeDefined();
    expect(handedBack.continuation?.state).toBe("checking");
    expect(handedBack.authorization).toEqual(before.authorization);
    expect(handedBack.counters).toEqual(before.counters);
    expect(handedBack.renewedAt).toBe(before.renewedAt);
    engine.tick();
    expect(f.sent.filter((entry) => entry.type === "prompt")).toHaveLength(1);
  });

  it.each(["stop", "pause", "task", "worker"] as const)(
    "keeps a selected handback held after a later %s change",
    async (change) => {
      const f = await setup("password", true);
      observeHandback(f);
      expect(
        (await f.command("prompt", { prompt: "One turn", handback: "after_turn" }))
          .statusCode,
      ).toBe(202);
      if (change === "stop")
        f.store.setSessionControls(f.worker.id, { stopRequested: true });
      if (change === "pause") {
        const record = f.store.prMaintenance.get(f.record.id)!;
        f.store.prMaintenance.operatorAction(
          record.id,
          record.version,
          { action: "pause", reason: "Independent operator hold" },
          "operator",
        );
      }
      if (change === "task")
        f.store.updateRun(f.task.id, { objective: "A different objective" });
      if (change === "worker")
        f.event("agent_session", { agentSessionId: "different-conversation" });
      f.settle();
      const engine = new OrchestratorEngine(f.service);
      engine.tick();
      expect(
        f.store.prMaintenance.get(f.record.id)!.manualControl?.endedAt,
      ).toBeUndefined();
      expect(f.store.prMaintenance.get(f.record.id)!.continuation?.state).toBe(
        "cancelled",
      );
    },
  );

  it("binds one-turn consent to its operation digest and rejects an unauthenticated handback", async () => {
    const f = await setup("password", true);
    observeHandback(f);
    const payload = {
      prompt: "One turn",
      operationId: randomUUID(),
      handback: "after_turn",
    };
    expect((await f.command("prompt", payload)).statusCode).toBe(202);
    expect(
      (await f.command("prompt", { ...payload, handback: "ongoing" })).statusCode,
    ).toBe(409);
    expect((await f.command("prompt", payload, {})).statusCode).toBe(401);
    expect(f.sent.filter((entry) => entry.type === "prompt")).toHaveLength(1);
  });

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

  it("resumes a stopped worker with correlated quiescence while its maintenance batch awaits final bookkeeping", async () => {
    const f = await setup("password", true);
    f.queue();
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
    const unsubscribe = f.service.onSessionEvent((event) =>
      f.engine.handleSessionEvent(event),
    );
    f.settle();
    unsubscribe();
    expect(f.store.getRunStep(f.step.id)?.state).toBe("succeeded");
    const before = f.store.prMaintenance.get(f.record.id)!;
    expect(before.batches).toMatchObject([
      {
        state: "reconciling",
        executionSettled: true,
        effects: [],
      },
    ]);
    const step = f.store.getRunStep(f.step.id);
    f.resumable();
    const reply = await f.command("resume", { operationId: randomUUID() });
    expect(reply.statusCode, reply.body).toBe(202);
    expect(f.sent.map((command) => command.type)).toEqual(["prompt", "resume_session"]);
    f.event("state", { state: "idle" });
    const manual = f.store.prMaintenance.get(f.record.id)!;
    expect(manual).toMatchObject({
      lifecycle: "paused",
      pauseReason: "manual_control",
      batches: before.batches,
      authorization: before.authorization,
      manualControl: { commands: [{ kind: "resume_session", state: "settled" }] },
    });
    expect(f.store.getRunStep(f.step.id)).toEqual(step);
    const prompt = await f.command("prompt", { operationId: randomUUID() });
    expect(prompt.statusCode, prompt.body).toBe(202);
    f.settle();
    expect(f.store.prMaintenance.get(f.record.id)?.batches).toEqual(manual.batches);
  });

  it.each([
    "sent",
    "unknown execution",
    "reserved effect",
    "uncertain effect",
    "uncertain batch",
  ] as const)(
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
        const executionSettled = state !== "unknown execution";
        if (executionSettled) f.store.updateRunStep(f.step.id, { state: "succeeded" });
        record = f.store.prMaintenance.checkpoint(f.leadId, record.id, record.version, {
          kind: "batch",
          batchId: "queued",
          generation: record.generation,
          state:
            state === "reserved effect" || state === "uncertain effect"
              ? "reconciling"
              : "uncertain",
          findings: [],
          effects:
            state === "reserved effect" || state === "uncertain effect"
              ? [
                  {
                    key: "unsettled-push",
                    kind: "push",
                    state: state === "reserved effect" ? "reserved" : "uncertain",
                    headSha,
                    actor: "worker",
                    actionIdentity: "publish-head",
                    attempts: 1,
                  },
                ]
              : [],
          executionSettled,
          evidence: "Retain unresolved execution or effect evidence",
        });
      }
      const before = f.store.prMaintenance.get(record.id);
      const sent = f.sent.length;
      const reply = await f.command("prompt");
      expect(reply.statusCode, reply.body).toBe(409);
      expect(reply.body).toMatch(/receipts/);
      expect(f.sent).toHaveLength(sent);
      expect(f.store.prMaintenance.get(record.id)).toEqual(before);
      f.resumable();
      const resume = await f.command("resume", { operationId: randomUUID() });
      expect(resume.statusCode, resume.body).toBe(409);
      expect(resume.body).toMatch(/receipts/);
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
    "queues busy input and preserves %s safety without creating a manual grant",
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
        condition === "busy"
          ? 202
          : condition === "offline"
            ? 503
            : condition === "checkout"
              ? 500
              : 409,
      );
      expect(f.sent).toHaveLength(0);
      expect(f.store.prMaintenance.get(f.record.id)?.manualControl).toBeUndefined();
      expect(f.store.queuedMessages(f.worker.id)).toHaveLength(
        condition === "busy" ? 1 : 0,
      );
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
