import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  NODE_ID_HEADER,
  NODE_SECRET_HEADER,
  type NodeCommand,
  type SessionEvent,
} from "@fleet/protocol";
import { fleet } from "../orchestrator/fleet-harness.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { FleetTools } from "../orchestrator/tools.js";
import { FleetService } from "../fleet-service.js";
import { FleetAuth, AUTH_MODE_SETTING, NO_AUTH_PRINCIPAL } from "../auth/service.js";
import { OPERATOR_COOKIE } from "../auth.js";
import { registerRequestGuard } from "../request-guard.js";
import { sessionRoutes } from "./sessions.js";

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
    placementId: placement.id,
  });
  store.updateRunStep(step.id, { state: "succeeded", sessionId: worker.id });
  const record = store.prMaintenance.enableFromOperator(
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
        publicationAuthorized,
      },
      headSha,
      eligibilityEvidence: "Fixture existing bound checkout",
    },
    "original-operator",
  );
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
