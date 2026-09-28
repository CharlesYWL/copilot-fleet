import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import {
  MANAGED_WORKTREES_CAPABILITY,
  WORKER_RESUME_LIMITS,
  type SessionEvent,
} from "@fleet/protocol";
import { FleetService } from "../fleet-service.js";
import { FleetStore } from "../store.js";
import { WorkerResumeConflict } from "../worker-resume-store.js";
import { workerResumeRoutes } from "../routes/worker-resume.js";
import { sessionRoutes } from "../routes/sessions.js";
import { OrchestratorEngine } from "./engine.js";
import { LeadTokens } from "./lead-tokens.js";
import { stopSessions } from "./lifecycle.js";
import { MCP_PATH, mcpRoutes } from "./mcp-routes.js";
import { FleetTools } from "./tools.js";

type Frame = {
  type: string;
  command?: {
    type: string;
    sessionId: string;
    prompt?: string;
    agentSessionId?: string;
    commandId?: string;
  };
};

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
} as unknown as FastifyBaseLogger;

function fakeSocket() {
  const sent: Frame[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as Frame),
  };
  return { sent, socket: socket as unknown as WebSocket };
}

const QUEUED = "Revise the SAME S03 amendment PR for the closed-slice review.";
const opened: FleetStore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of opened.splice(0)) store.close();
});

/**
 * A Node holding one repository checkout and one unrelated checkout, with the
 * task's lead on a machine of its own so it never takes the worker Node's slots.
 */
function world({ maxSessions = 2 }: { maxSessions?: number } = {}) {
  const store = new FleetStore(":memory:");
  opened.push(store);
  const service = new FleetService(store, silentLog, "");
  const node = store.registerNode({
    name: "CharlesDevBox4",
    os: "win32",
    arch: "x64",
    version: "0.1.0",
    capabilities: ["copilot-acp", "host-yolo", MANAGED_WORKTREES_CAPABILITY],
    maxSessions,
  }).node;
  const wire = fakeSocket();
  service.attachNode(node.id, wire.socket);
  store.setNodeOnline(node.id, true, 0);
  const leadNode = store.registerNode({
    name: "lead-box",
    os: "win32",
    arch: "x64",
    version: "0.1.0",
    capabilities: ["copilot-acp", "host-yolo"],
    maxSessions: 4,
  }).node;
  const leadWire = fakeSocket();
  service.attachNode(leadNode.id, leadWire.socket);
  store.setNodeOnline(leadNode.id, true, 0);

  const repo = store.createWorkspace("TridentWarehouse-UX", "");
  const checkout = store.createPlacement(
    repo.id,
    node.id,
    "Q:\\Repos\\TridentWarehouse-UX",
  );
  const other = store.createWorkspace("Schema tools", "");
  const otherCheckout = store.createPlacement(
    other.id,
    node.id,
    "Q:\\Repos\\SchemaTools",
  );
  const orchestration = store.createWorkspace("Orchestration", "");
  const leadPlacement = store.createPlacement(orchestration.id, leadNode.id, "C:\\lead");

  const engine = new OrchestratorEngine(service);
  service.attachOrchestration({
    leadTokens: { mint: () => "flt_test" },
    mcpUrl: () => "http://127.0.0.1/mcp",
    tickRun: (runId) => engine.tickRun(runId),
    resume: engine.resume,
  });
  service.onSessionEvent((event) => engine.handleSessionEvent(event));

  const lead = store.createSession(leadPlacement, "orchestrate", true, "Orchestrator", {
    runRole: "lead",
    readOnly: true,
  });
  store.transitionSession(lead.id, "starting");
  store.transitionSession(lead.id, "idle");
  const tools = new FleetTools(service, lead.id);

  const emit = (
    sessionId: string,
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
  ) => {
    const sequence = store.maxEventSequence(sessionId) + 1;
    return service.handleEvent({
      eventId: `${sessionId}-${sequence}`,
      sessionId,
      sequence,
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  };
  const commands = (type: string) =>
    wire.sent
      .filter((frame) => frame.command?.type === type)
      .map((frame) => frame.command!);

  /** A settled implementer, parked the way the scheduler parks one for a checkout handoff. */
  const retainedWorker = () => {
    const run = store.createRun({
      workspaceId: repo.id,
      name: "S03 - Miles action-log comparison prototype",
      objective: "Build an isolated, reviewable action-log alternative.",
      policy: { wakePolicy: "on_any_settle" },
    });
    store.replaceRunSteps(run.id, [
      {
        stepKey: "step-1",
        title: "Build isolated S03 action-log alternative",
        prompt: "Implement the prototype.",
        category: "implement",
      },
    ]);
    store.updateRun(run.id, { leadSessionId: lead.id, state: "running" });
    engine.tickRun(run.id);
    const step = store.listRunSteps(run.id)[0]!;
    const workerId = step.sessionId;
    emit(workerId, "agent_session", { agentSessionId: "copilot-worker-1" });
    emit(workerId, "state", { state: "starting" });
    emit(workerId, "state", { state: "running" });
    emit(workerId, "agent_text", { text: "Prototype implemented." });
    emit(workerId, "turn_complete", { stopReason: "end_turn" });
    emit(workerId, "state", { state: "idle" });
    engine.tick();
    expect(store.getRunStep(step.id)?.state).toBe("succeeded");
    stopSessions(service, [store.getSession(workerId)!]);
    emit(workerId, "state", { state: "stopped", activity: "Process stopped" });
    expect(store.getSession(workerId)).toMatchObject({
      state: "stopped",
      stopRequested: false,
      agentSessionId: "copilot-worker-1",
    });
    return { run, step, workerId };
  };

  /** Queues the next revision exactly as the orchestrator does. */
  const followUp = (workerId: string) => {
    const result = tools.followUp({ sessionId: workerId, prompt: QUEUED });
    expect(result.ok, result.text).toBe(true);
    return result.text;
  };

  /** A live session nobody's task manages, in whichever checkout is named. */
  const liveSession = (placement = otherCheckout, name = "Unrelated work") => {
    const session = store.createSession(placement, "other work", true, name);
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "running");
    return session;
  };

  /** Another task's worker running in the same physical checkout. */
  const otherTasksWriter = () => {
    const otherRun = store.createRun({
      workspaceId: repo.id,
      name: "Roll out Go Extension Ontology to PROD",
      objective: "Publish and link the Ontology PR.",
    });
    store.updateRun(otherRun.id, { state: "running" });
    const session = store.createSession(
      checkout,
      "publish",
      true,
      "Publish and link Ontology MSIT PR",
      { runId: otherRun.id, runRole: "worker" },
    );
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "running");
    return { otherRun, session };
  };

  const approve = (requestId: string, operator = "administrator-1") => {
    const request = store.resumeRequests.get(requestId)!;
    return engine.resume.decide(
      requestId,
      {
        decision: "approve_once",
        expectedVersion: request.version,
        fingerprint: request.fingerprint,
      },
      operator,
    );
  };

  return {
    store,
    service,
    engine,
    tools,
    node,
    lead,
    checkout,
    otherCheckout,
    emit,
    commands,
    retainedWorker,
    followUp,
    liveSession,
    otherTasksWriter,
    approve,
  };
}

describe("queued follow-up admission", () => {
  it("names the same-checkout writer that holds a retained worker back, and never offers to override it", () => {
    const w = world({ maxSessions: 10 });
    const { run, step, workerId } = w.retainedWorker();
    const { session: occupant } = w.otherTasksWriter();

    const queued = w.followUp(workerId);

    expect(w.commands("resume_session")).toHaveLength(0);
    expect(queued).toContain("checkout_busy");
    expect(queued).toContain("Roll out Go Extension Ontology to PROD");
    const admission = w.engine.resume.admission(run.id, step.id)!;
    expect(admission).toMatchObject({
      state: "blocked",
      code: "checkout_busy",
      nodeName: "CharlesDevBox4",
      localPath: "Q:\\Repos\\TridentWarehouse-UX",
      resumable: true,
      conflicts: [
        expect.objectContaining({
          sessionId: occupant.id,
          name: "Publish and link Ontology MSIT PR",
          taskName: "Roll out Go Extension Ontology to PROD",
          sameTask: false,
        }),
      ],
    });
    expect(admission.exception).toBeUndefined();
    // Eight writing slots were free: node capacity was never the reason.
    expect(w.tools.listNodes().text).toContain("8 free for changes");

    const outcome = w.engine.resume.request(
      { stepId: step.id },
      { kind: "operator", id: "administrator-1" },
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.message).toContain("No approval can override this");
    expect(w.store.resumeRequests.list()).toHaveLength(0);
    expect(w.commands("resume_session")).toHaveLength(0);
    const work = w.tools.listWork().text;
    expect(work).toContain("checkout_busy");
    expect(work).toContain(
      'Publish and link Ontology MSIT PR (running, task "Roll out Go Extension Ontology to PROD")',
    );
  });

  it("keeps ordinary same-node scheduling automatic for a different checkout", () => {
    const w = world({ maxSessions: 4 });
    const { run, step, workerId } = w.retainedWorker();
    w.liveSession(w.otherCheckout);

    w.followUp(workerId);

    const resumed = w.commands("resume_session");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      sessionId: workerId,
      agentSessionId: "copilot-worker-1",
    });
    const outcome = w.engine.resume.request(
      { stepId: step.id },
      { kind: "operator", id: "administrator-1" },
    );
    expect(outcome.status).toBe("starting");
    expect(w.store.resumeRequests.list()).toHaveLength(0);
    expect(w.engine.resume.admission(run.id, step.id)).toMatchObject({
      state: "starting",
      code: "resuming",
    });
  });
});

describe("Resume now with an operator-approved exception", () => {
  const headroomWorld = () => {
    const w = world({ maxSessions: 2 });
    const retained = w.retainedWorker();
    const other = w.liveSession(w.otherCheckout, "Unrelated work on the same Node");
    w.followUp(retained.workerId);
    expect(w.commands("resume_session")).toHaveLength(0);
    return { ...w, ...retained, other };
  };

  it("holds a follow-up for the reserved slot until an authenticated approval, then resumes the same conversation once", () => {
    const w = headroomWorld();
    const admission = w.engine.resume.admission(w.run.id, w.step.id)!;
    expect(admission).toMatchObject({
      state: "queued",
      code: "node_headroom",
      exception: "node_headroom",
    });

    const asked = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    );

    expect(asked.status).toBe("awaiting_approval");
    const request = asked.request!;
    expect(request).toMatchObject({
      state: "awaiting_approval",
      sessionId: w.workerId,
      agentSessionId: "copilot-worker-1",
      nodeName: "CharlesDevBox4",
      localPath: "Q:\\Repos\\TridentWarehouse-UX",
      queuedPrompt: QUEUED,
      restriction: "node_headroom",
      capacity: { kind: "writing", reserved: 1, limit: 2 },
    });
    expect(request.activeSessions.map((session) => session.sessionId)).toContain(
      w.other.id,
    );
    expect(request.risk).toContain("hard limit");
    expect(w.commands("resume_session")).toHaveLength(0);
    expect(
      w.store
        .listNotifications()
        .notifications.filter(
          (notice) =>
            notice.kind === "worker_resume_approval" && notice.status === "active",
        ),
    ).toHaveLength(1);
    // Repeated clicks and tool retries return the same request.
    const again = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    );
    expect(again.request?.id).toBe(request.id);
    expect(w.store.resumeRequests.list()).toHaveLength(1);
    // A scheduling pass alone never spends a request that has not been approved.
    w.engine.tick();
    expect(w.commands("resume_session")).toHaveLength(0);

    const approved = w.approve(request.id);

    expect(approved.state).toBe("launching");
    const resumed = w.commands("resume_session");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      sessionId: w.workerId,
      agentSessionId: "copilot-worker-1",
    });
    expect(w.commands("start_session")).toHaveLength(1);
    expect(w.engine.resume.admission(w.run.id, w.step.id)).toMatchObject({
      state: "starting",
      code: "resuming",
    });

    w.emit(w.workerId, "state", {
      state: "idle",
      activity: "Resumed; ready for follow-up",
    });
    const prompts = w.commands("prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionId: w.workerId, prompt: QUEUED });
    expect(w.store.resumeRequests.get(request.id)?.state).toBe("launching");

    w.emit(w.workerId, "state", { state: "running" });
    expect(w.store.getRunStep(w.step.id)?.state).toBe("running");
    expect(w.store.resumeRequests.get(request.id)).toMatchObject({
      state: "launched",
      acknowledgedAt: expect.any(String),
    });

    w.engine.tick();
    expect(w.commands("resume_session")).toHaveLength(1);
    expect(w.commands("prompt")).toHaveLength(1);
    expect(w.store.listRunSteps(w.run.id)).toHaveLength(1);
    expect(w.store.getRunStep(w.step.id)?.sessionId).toBe(w.workerId);
    expect(() => w.approve(request.id)).toThrow(WorkerResumeConflict);
    expect(w.commands("resume_session")).toHaveLength(1);
    expect(
      w.store
        .listSecurityAudit(50)
        .filter((entry) => entry.targetId === request.id)
        .map((entry) => `${entry.eventType}:${entry.outcome}:${entry.actorId}`),
    ).toEqual(
      expect.arrayContaining([
        "worker_resume_requested:requested:administrator-1",
        "worker_resume_decision:approved:administrator-1",
        "worker_resume_launch:sent:",
        "worker_resume_launch:launched:",
      ]),
    );
    expect(
      w.store
        .listRunNotes(w.run.id)
        .some((note) => note.body.includes("approved once by administrator-1")),
    ).toBe(true);
  });

  it("lets an orchestrator ask but never approve, and keeps the queued work when a person cancels", () => {
    const w = headroomWorld();

    const asked = w.tools.requestResume({
      sessionId: w.workerId,
      reason: "The person asked for the S03 revision today.",
    });

    expect(asked.ok, asked.text).toBe(true);
    expect(asked.text).toContain("awaiting_approval");
    expect(asked.text).toContain("You cannot approve this");
    const request = w.store.resumeRequests.active(w.step.id)!;
    expect(request.requestedBy).toEqual({ kind: "orchestrator", id: w.lead.id });
    expect(request.reason).toBe("The person asked for the S03 revision today.");
    expect(w.commands("resume_session")).toHaveLength(0);

    const cancelled = w.engine.resume.decide(
      request.id,
      {
        decision: "cancel",
        expectedVersion: request.version,
        fingerprint: request.fingerprint,
      },
      "administrator-1",
    );

    expect(cancelled.state).toBe("cancelled");
    expect(w.store.getRunStep(w.step.id)).toMatchObject({
      state: "pending",
      attempts: 2,
      prompt: QUEUED,
      sessionId: w.workerId,
    });
    expect(w.commands("resume_session")).toHaveLength(0);
    expect(
      w.store
        .listNotifications()
        .notifications.find((notice) => notice.kind === "worker_resume_approval")?.status,
    ).toBe("resolved");

    const repeated = w.tools.requestResume({ sessionId: w.workerId });
    expect(repeated.text).toContain("Do not ask again");
    expect(w.store.resumeRequests.list()).toHaveLength(1);
    expect(w.tools.listWork().text).toContain("Latest resume-now request: cancelled");

    // The operator's own click is not throttled.
    const byOperator = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    );
    expect(byOperator.status).toBe("awaiting_approval");
    expect(w.store.resumeRequests.list()).toHaveLength(2);
  });

  it("expires an unanswered request without launching or discarding the follow-up", () => {
    const w = headroomWorld();
    const request = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    ).request!;

    w.engine.tick(Date.parse(request.expiresAt) + 1);

    expect(w.store.resumeRequests.get(request.id)?.state).toBe("expired");
    expect(() => w.approve(request.id)).toThrow(/already expired/);
    expect(w.commands("resume_session")).toHaveLength(0);
    expect(w.store.getRunStep(w.step.id)).toMatchObject({
      state: "pending",
      prompt: QUEUED,
    });
    expect(
      w.store
        .listNotifications()
        .notifications.find((notice) => notice.kind === "worker_resume_approval")?.status,
    ).toBe("resolved");
  });

  it("refuses a stale approval when the sessions holding the Node change", () => {
    const w = headroomWorld();
    const request = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    ).request!;
    // Same count, different holder: what was reviewed is no longer what would run beside it.
    w.store.transitionSession(w.other.id, "stopped");
    w.liveSession(w.otherCheckout, "A different session");

    expect(() => w.approve(request.id)).toThrow(WorkerResumeConflict);

    expect(w.store.resumeRequests.get(request.id)?.state).toBe("stale");
    expect(w.commands("resume_session")).toHaveLength(0);
    expect(w.store.getRunStep(w.step.id)?.state).toBe("pending");
  });

  it("refuses approval while the worker's Node is offline", () => {
    const w = headroomWorld();
    const request = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    ).request!;
    w.service.disconnectNode(w.node.id, "Connection lost");

    expect(() => w.approve(request.id)).toThrow(WorkerResumeConflict);

    expect(w.store.resumeRequests.get(request.id)?.state).toBe("stale");
    expect(w.commands("resume_session")).toHaveLength(0);
  });

  it("never spends the exception when ordinary scheduling frees a slot first", () => {
    const w = headroomWorld();
    const request = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    ).request!;

    w.emit(w.other.id, "state", { state: "stopped" });
    w.engine.tick();

    expect(w.commands("resume_session")).toHaveLength(1);
    expect(w.store.resumeRequests.get(request.id)?.state).toBe("stale");
    expect(() => w.approve(request.id)).toThrow(WorkerResumeConflict);
    expect(w.commands("resume_session")).toHaveLength(1);
  });

  it("lets only one of two concurrent approvals launch", () => {
    const w = headroomWorld();
    const request = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    ).request!;
    const decision = {
      decision: "approve_once" as const,
      expectedVersion: request.version,
      fingerprint: request.fingerprint,
    };

    w.engine.resume.decide(request.id, decision, "administrator-1");
    expect(() => w.engine.resume.decide(request.id, decision, "administrator-2")).toThrow(
      WorkerResumeConflict,
    );

    expect(w.commands("resume_session")).toHaveLength(1);
    expect(w.store.resumeRequests.get(request.id)?.decidedBy).toBe("administrator-1");
  });

  it("reports a refused resume as a failure instead of running", () => {
    const w = headroomWorld();
    const request = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    ).request!;
    w.approve(request.id);
    const resumed = w.commands("resume_session")[0]!;

    w.service.settleRefusedLaunch(
      w.workerId,
      resumed.commandId!,
      "Node is at capacity for writing work",
    );
    w.engine.tick();

    expect(w.store.getRunStep(w.step.id)).toMatchObject({
      state: "failed",
      output: expect.stringContaining("Node is at capacity for writing work"),
    });
    expect(w.store.resumeRequests.get(request.id)).toMatchObject({
      state: "failed",
      outcome: expect.stringContaining("Node is at capacity for writing work"),
    });
    expect(w.commands("prompt")).toHaveLength(0);
  });

  it("launches an approval recorded before a Host restart exactly once", () => {
    const w = headroomWorld();
    const request = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    ).request!;
    // The approval committed, and the Host stopped before its scheduling pass.
    w.store.resumeRequests.update(request.id, request.version, {
      state: "approved",
      decidedBy: "administrator-1",
      decidedAt: new Date().toISOString(),
      launchBy: new Date(Date.now() + WORKER_RESUME_LIMITS.launchMs).toISOString(),
    });

    const restarted = new OrchestratorEngine(w.service);
    w.service.attachOrchestration({
      leadTokens: { mint: () => "flt_test" },
      mcpUrl: () => "http://127.0.0.1/mcp",
      tickRun: (runId) => restarted.tickRun(runId),
      resume: restarted.resume,
    });
    restarted.tick();
    restarted.tick();

    expect(w.commands("resume_session")).toHaveLength(1);
    expect(w.store.resumeRequests.get(request.id)?.state).toBe("launching");

    const again = new OrchestratorEngine(w.service);
    again.tick();
    expect(w.commands("resume_session")).toHaveLength(1);
  });

  it("never bypasses a human hold on the task", () => {
    const w = headroomWorld();
    w.store.setRunState(w.run.id, "awaiting_human");

    const outcome = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.admission).toMatchObject({ code: "task_held" });
    expect(w.store.resumeRequests.list()).toHaveLength(0);
    expect(w.commands("resume_session")).toHaveLength(0);
  });

  it("never bypasses an unacknowledged Stop", () => {
    const w = headroomWorld();
    w.store.setSessionControls(w.workerId, { stopRequested: true });

    const outcome = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.admission).toMatchObject({ code: "stop_pending" });
    expect(w.store.resumeRequests.list()).toHaveLength(0);
  });

  it("keeps same-checkout exclusivity even after an approval", () => {
    const w = headroomWorld();
    const request = w.engine.resume.request(
      { stepId: w.step.id },
      { kind: "operator", id: "administrator-1" },
    ).request!;
    w.store.transitionSession(w.other.id, "stopped");
    w.otherTasksWriter();

    expect(() => w.approve(request.id)).toThrow(WorkerResumeConflict);
    expect(w.commands("resume_session")).toHaveLength(0);
    expect(w.engine.resume.admission(w.run.id, w.step.id)).toMatchObject({
      state: "blocked",
      code: "checkout_busy",
    });
  });
});

describe("a person's own prompt into a worker with a queued follow-up", () => {
  it("does not let that turn's completion settle the queued follow-up", () => {
    const w = world({ maxSessions: 10 });
    const { step, workerId } = w.retainedWorker();
    const { session: occupant } = w.otherTasksWriter();
    w.followUp(workerId);
    // A person drives the worker directly through the service, as the observed
    // incident did through the session controls before they were guarded.
    expect(w.service.resumeSession(workerId, "Resuming Copilot session").ok).toBe(true);
    w.emit(workerId, "state", { state: "idle" });
    expect(
      w.service.promptSession(workerId, { prompt: "Do it by hand", attachments: [] }).ok,
    ).toBe(true);
    w.emit(workerId, "state", { state: "running" });
    w.emit(workerId, "agent_text", { text: "Handled the manual request." });
    w.emit(workerId, "turn_complete", { stopReason: "end_turn" });
    w.emit(workerId, "state", { state: "idle" });
    expect(w.store.getRunStep(step.id)?.state).toBe("pending");

    w.emit(occupant.id, "state", { state: "idle" });
    w.emit(occupant.id, "state", { state: "stopped" });
    w.engine.tick();
    const prompts = w.commands("prompt");
    expect(prompts.at(-1)).toMatchObject({ sessionId: workerId, prompt: QUEUED });
    expect(w.store.getRunStep(step.id)?.state).toBe("starting");

    // Any other scheduling pass before the Node acknowledges the queued prompt.
    w.engine.tick();

    expect(w.store.getRunStep(step.id)?.state).toBe("starting");
    expect(
      w.commands("prompt").filter((command) => command.prompt === QUEUED),
    ).toHaveLength(1);
  });
});
describe("Resume now over HTTP and MCP", () => {
  const served = async () => {
    const w = world({ maxSessions: 2 });
    const retained = w.retainedWorker();
    w.liveSession(w.otherCheckout, "Unrelated work on the same Node");
    w.followUp(retained.workerId);
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request) => {
      if (request.headers["fixture-browser"] === "yes") {
        request.fleetSession = {
          tokenHash: "not-exposed",
          administratorId: "administrator-1",
          authMethod: "microsoft-code",
          authenticatedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
        request.fleetHumanActor = "administrator-1";
      }
      if (request.headers["fixture-no-login"] === "yes")
        request.fleetHumanActor = "no-auth-operator";
      if (request.headers["fixture-node"] === "yes") request.fleetNodeId = w.node.id;
    });
    await app.register(workerResumeRoutes, { engine: w.engine });
    const tokens = new LeadTokens(w.store);
    const token = tokens.mint({
      sessionId: w.lead.id,
      runId: w.lead.runId,
      nodeId: w.lead.nodeId,
    });
    await app.register(mcpRoutes, { service: w.service, tokens });
    await app.ready();
    const rpc = async (method: string, params?: unknown) =>
      (
        await app.inject({
          method: "POST",
          url: MCP_PATH,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          payload: { jsonrpc: "2.0", id: 1, method, params },
        })
      ).json() as {
        result?: { tools?: { name: string }[]; content?: { text: string }[] };
      };
    return { ...w, ...retained, app, rpc };
  };

  it("lets an orchestrator ask over MCP but only a signed-in operator decide", async () => {
    const s = await served();
    try {
      const listed = await s.rpc("tools/list");
      const names = listed.result!.tools!.map((tool) => tool.name);
      expect(names).toContain("fleet_request_resume");
      expect(names.filter((name) => /approv|decid/i.test(name))).toEqual([]);

      const asked = await s.rpc("tools/call", {
        name: "fleet_request_resume",
        arguments: { sessionId: s.workerId, approved: true, yolo: true },
      });
      const text = (asked.result?.content ?? []).map((part) => part.text).join("\n");
      expect(text).toContain("awaiting_approval");
      expect(text).toContain("You cannot approve this");
      const request = s.store.resumeRequests.active(s.step.id)!;
      expect(request.state).toBe("awaiting_approval");
      const decision = {
        decision: "approve_once",
        expectedVersion: request.version,
        fingerprint: request.fingerprint,
      };

      for (const headers of [
        {},
        { "fixture-no-login": "yes" },
        { "fixture-node": "yes", "fixture-browser": "yes" },
        { authorization: "Bearer flt_orchestrator" },
      ]) {
        const refused = await s.app.inject({
          method: "POST",
          url: `/api/worker-resume-requests/${request.id}/decision`,
          headers,
          payload: decision,
        });
        expect(refused.statusCode).toBe(403);
      }
      expect(s.commands("resume_session")).toHaveLength(0);

      const stale = await s.app.inject({
        method: "POST",
        url: `/api/worker-resume-requests/${request.id}/decision`,
        headers: { "fixture-browser": "yes" },
        payload: { ...decision, expectedVersion: request.version + 1 },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        code: "approval_conflict",
        request: { id: request.id, state: "awaiting_approval" },
      });

      const approved = await s.app.inject({
        method: "POST",
        url: `/api/worker-resume-requests/${request.id}/decision`,
        headers: { "fixture-browser": "yes" },
        payload: decision,
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({
        request: { id: request.id, state: "launching", decidedBy: "administrator-1" },
      });
      expect(s.commands("resume_session")).toHaveLength(1);

      const replay = await s.app.inject({
        method: "POST",
        url: `/api/worker-resume-requests/${request.id}/decision`,
        headers: { "fixture-browser": "yes" },
        payload: decision,
      });
      expect(replay.statusCode).toBe(409);
      expect(s.commands("resume_session")).toHaveLength(1);
    } finally {
      await s.app.close();
    }
  });

  it("answers Resume now with the request it opened, or with why nothing can override the wait", async () => {
    const s = await served();
    try {
      const refused = await s.app.inject({
        method: "POST",
        url: `/api/runs/${s.run.id}/steps/${s.step.id}/resume-now`,
        headers: { "fixture-node": "yes" },
      });
      expect(refused.statusCode).toBe(403);

      const asked = await s.app.inject({
        method: "POST",
        url: `/api/runs/${s.run.id}/steps/${s.step.id}/resume-now`,
        headers: { "fixture-browser": "yes" },
        payload: {},
      });
      expect(asked.statusCode).toBe(202);
      expect(asked.json()).toMatchObject({
        status: "awaiting_approval",
        request: { state: "awaiting_approval", requestedBy: { kind: "operator" } },
        admission: { state: "awaiting_approval" },
      });

      s.store.setRunState(s.run.id, "awaiting_human");
      const held = await s.app.inject({
        method: "POST",
        url: `/api/runs/${s.run.id}/steps/${s.step.id}/resume-now`,
        headers: { "fixture-browser": "yes" },
        payload: {},
      });
      expect(held.statusCode).toBe(409);
      expect(held.json()).toMatchObject({ status: "blocked", code: "blocked" });
      expect(s.commands("resume_session")).toHaveLength(0);
    } finally {
      await s.app.close();
    }
  });
});

describe("the manual session Resume control", () => {
  it("refuses to put a task worker into a checkout another live session holds", async () => {
    const w = world({ maxSessions: 10 });
    const { workerId } = w.retainedWorker();
    const { session: occupant } = w.otherTasksWriter();
    const manual = w.liveSession(w.otherCheckout, "A person's own session");
    const app = Fastify({ logger: false });
    await app.register(sessionRoutes, { service: w.service });
    await app.ready();
    try {
      const refused = await app.inject({
        method: "POST",
        url: `/api/sessions/${workerId}/resume`,
        payload: {},
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: "checkout_busy" });
      expect(refused.json().error).toContain("Publish and link Ontology MSIT PR");
      expect(w.commands("resume_session")).toHaveLength(0);

      // Sessions no task manages keep the control as it was.
      w.store.transitionSession(manual.id, "stopped");
      w.emit(manual.id, "agent_session", { agentSessionId: "copilot-manual" });
      const person = await app.inject({
        method: "POST",
        url: `/api/sessions/${manual.id}/resume`,
        payload: {},
      });
      expect(person.statusCode).toBe(202);

      w.store.transitionSession(occupant.id, "stopped");
      const allowed = await app.inject({
        method: "POST",
        url: `/api/sessions/${workerId}/resume`,
        payload: {},
      });
      expect(allowed.statusCode).toBe(202);
      expect(w.commands("resume_session").map((command) => command.sessionId)).toEqual([
        manual.id,
        workerId,
      ]);
    } finally {
      await app.close();
    }
  });
});
