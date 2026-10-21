import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PrMaintenanceObservationSchema,
  PrMaintenanceRegistrationSchema,
  prMaintenanceStatus,
  type PrMaintenanceRegistration,
} from "@fleet/protocol";
import { fleet } from "./fleet-harness.js";
import { FleetTools } from "./tools.js";
import { OrchestratorEngine } from "./engine.js";
import { FleetStore } from "../store.js";

/**
 * The simplified PR maintenance state machine, scenario by scenario.
 *
 * Each test names the transition it proves. They run against the real store,
 * tools and engine through the shared fleet harness, so admission, the durable
 * lead queue and the operator actions are the production code paths.
 */
describe("PR maintenance state machine scenarios", () => {
  let world: ReturnType<typeof fleet>;
  let tools: FleetTools;
  const headSha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  const identity = {
    host: "github.com",
    repositoryId: "r1",
    repository: "example/repo",
    prNumber: 42,
    headRepositoryId: "r1",
    headRepository: "example/repo",
    headRef: "refs/heads/fix",
    baseRepositoryId: "r1",
    baseRepository: "example/repo",
    baseRef: "refs/heads/main",
  };
  const source = {
    id: "thread-1",
    revision: "rev-1",
    groupKey: "null-check",
    evidence: "Reviewer: add the missing null check.",
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-20T19:00:00.000Z");
    world = fleet();
    tools = new FleetTools(world.service, world.leadId);
    world.store.transitionSession(world.leadId, "starting");
    world.store.transitionSession(world.leadId, "idle");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    world.store.close();
  });

  const pm = () => world.store.prMaintenance;
  const get = (id: string) => pm().get(id)!;

  /** An owned task with a retained writing worker, optionally awaiting human review. */
  const task = (state: "running" | "awaiting_human" | "completed" = "running") => {
    const lead = world.store.getSession(world.leadId)!;
    const placement = world.store.getPlacement(lead.placementId)!;
    const run = world.store.createRun({
      workspaceId: lead.workspaceId,
      name: "S06 search",
      objective: "Ship the bounded search-first implementation.",
    });
    world.store.updateRun(run.id, { leadSessionId: lead.id, state: "running" });
    const worker = world.store.createSession(placement, "coder", true, "Coder", {
      runId: run.id,
      runRole: "worker",
    });
    world.store.transitionSession(worker.id, "starting");
    world.store.transitionSession(worker.id, "idle");
    const step = world.store.upsertRunStep(run.id, {
      stepKey: "implement",
      title: "Implement",
      prompt: "original brief",
      category: "implement",
      placementId: placement.id,
    });
    world.store.updateRunStep(step.id, { sessionId: worker.id, state: "succeeded" });
    if (state !== "running") world.store.setRunState(run.id, state);
    return { run, worker, step };
  };

  const enable = (state: Parameters<typeof task>[0] = "running") => {
    const t = task(state);
    const record = pm().enableFromOperator(
      {
        taskId: t.run.id,
        workerSessionId: t.worker.id,
        identity,
        headSha,
        scope: {
          baseline: "Keep the approved API and storage design unchanged.",
          verification: "Run the focused regression suite.",
          publicationAuthorized: true,
          replies: true,
          resolveThreads: true,
        },
        eligibilityEvidence: "Operator verified the PR, branch HEAD and retained worker.",
      },
      "operator",
    );
    return { ...t, record };
  };

  /** A fresh lead turn, as the Host records it when it delivers a prompt. */
  const turn = (prompt = "PR review turn") => {
    world.service.dispatch(world.store.getSession(world.leadId)!.nodeId, {
      type: "prompt",
      sessionId: world.leadId,
      prompt,
      attachments: [],
    });
    return world.store.getSessionDispatchAttempt(world.leadId)!.commandId;
  };

  const observation = (overrides: Record<string, unknown> = {}) =>
    PrMaintenanceObservationSchema.parse({
      attemptedAt: new Date().toISOString(),
      complete: true,
      identity,
      snapshotId: `snapshot-${randomUUID()}`,
      headSha,
      baseSha,
      state: "open",
      fingerprint: `fingerprint-${randomUUID()}`,
      mergeability: "mergeable",
      sources: [source],
      evidence: "Complete bounded helper observation.",
      ...overrides,
    });

  /** Claim the review in this turn and checkpoint a fresh observation. */
  const review = (recordId: string, overrides: Record<string, unknown> = {}) => {
    turn();
    const claim = tools.getPrMaintenance({ takeDue: true });
    expect(claim.ok, claim.text).toBe(true);
    expect(JSON.parse(claim.text).record?.id, claim.text).toBe(recordId);
    const saved = tools.checkpointPrMaintenance({
      recordId,
      expectedVersion: get(recordId).version,
      checkpoint: { kind: "observation", observation: observation(overrides) },
    });
    expect(saved.ok, saved.text).toBe(true);
    return get(recordId);
  };

  const dispatchRoutine = (recordId: string, workerId: string, batchId = "batch-1") => {
    const prepared = tools.checkpointPrMaintenance({
      recordId,
      expectedVersion: get(recordId).version,
      checkpoint: {
        kind: "prepare_batch",
        batch: {
          id: batchId,
          kind: "repair",
          sources: [source],
          headSha,
          prompt: `Add the missing null check (${batchId}); verify and push normally.`,
          scope: "Routine reviewer fix",
          reservedMutations: 2,
        },
      },
    });
    expect(prepared.ok, prepared.text).toBe(true);
    const record = get(recordId);
    const sent = tools.followUp({
      sessionId: workerId,
      maintenance: { recordId, generation: record.generation, batchId },
    });
    expect(sent.ok, sent.text).toBe(true);
    return get(recordId);
  };

  /** The retained worker finishes its turn and the step settles. */
  const finishWorker = (
    t: { run: { id: string }; worker: { id: string }; step: { id: string } },
    recordId: string,
    progress = true,
  ) => {
    world.store.updateRunStep(t.step.id, { state: "running" });
    const sequence = world.store.maxEventSequence(t.worker.id) + 1;
    world.store.appendEvent({
      eventId: `done-${sequence}`,
      sessionId: t.worker.id,
      sequence,
      type: "turn_complete",
      payload: {},
      createdAt: new Date().toISOString(),
    });
    world.store.appendEvent({
      eventId: `idle-${sequence + 1}`,
      sessionId: t.worker.id,
      sequence: sequence + 1,
      type: "state",
      payload: { state: "idle" },
      createdAt: new Date().toISOString(),
    });
    world.service.settleOrchestrationStep({
      runId: t.run.id,
      stepId: t.step.id,
      state: "succeeded",
      output: "Worker finished.",
    });
    const batch = get(recordId).batches.at(-1)!;
    const settled = tools.checkpointPrMaintenance({
      recordId,
      expectedVersion: get(recordId).version,
      checkpoint: {
        kind: "batch",
        batchId: batch.id,
        generation: batch.generation,
        state: progress ? "succeeded" : "failed",
        executionSettled: true,
        published: progress,
        usedMutations: progress ? 2 : 0,
        effects: [],
        findings: [
          {
            source,
            outcome: progress ? "addressed" : "failed",
            stage: progress ? "replied" : "inspected",
            evidence: progress ? ["tests passed", "reply posted"] : ["still failing"],
            responseRequired: progress,
            responseIds: progress ? ["reply-1"] : [],
            ...(progress ? { publishedCommit: "c".repeat(40) } : {}),
            nextAction: progress ? undefined : "Try again",
            progress,
          },
        ],
        evidence: "Correlated terminal step and provider receipts.",
      },
    });
    expect(settled.ok, settled.text).toBe(true);
    return get(recordId);
  };

  const phase = (record: PrMaintenanceRegistration) => prMaintenanceStatus(record).phase;

  it("initial enablement starts Reviewing even when the task awaits an unrelated human review", () => {
    const { record, run } = enable("awaiting_human");
    expect(record.hold).toBeUndefined();
    expect(record.review).toMatchObject({ source: "enable" });
    expect(phase(record)).toBe("reviewing");
    // The task's own review is untouched.
    expect(world.store.getRun(run.id)?.state).toBe("awaiting_human");
  });

  it("refresh_required vs wait_for_human regression: an awaiting_human task still refreshes and dispatches", () => {
    const t = enable("awaiting_human");
    expect(
      pm().admission({ action: "discover", recordId: t.record.id, taskId: t.run.id }),
    ).toEqual({ allowed: true });
    review(t.record.id);
    const working = dispatchRoutine(t.record.id, t.worker.id);
    expect(phase(working)).toBe("working");
    // Maintenance work never changes the task's own review state.
    expect(world.store.getRun(t.run.id)?.state).toBe("awaiting_human");
  });

  it("heartbeat due check opens a review only after nextCheckAt, at least an hour after the last read", () => {
    const t = enable();
    review(t.record.id);
    const idle = tools.checkpointPrMaintenance({
      recordId: t.record.id,
      expectedVersion: get(t.record.id).version,
      checkpoint: { kind: "review_done", summary: "Waiting for required checks." },
    });
    expect(idle.ok, idle.text).toBe(true);
    const record = get(t.record.id);
    expect(phase(record)).toBe("idle");
    expect(Date.parse(record.nextCheckAt) - Date.now()).toBeGreaterThanOrEqual(
      60 * 60_000 - 1_000,
    );
    expect(pm().openDueReviews()).toBe(0);
    vi.setSystemTime(Date.parse(record.nextCheckAt) + 1);
    expect(pm().openDueReviews()).toBe(1);
    expect(get(t.record.id).review).toMatchObject({ source: "heartbeat" });
  });

  it("manual Review now before the due time opens a review without changing the schedule", () => {
    const t = enable();
    review(t.record.id);
    tools.checkpointPrMaintenance({
      recordId: t.record.id,
      expectedVersion: get(t.record.id).version,
      checkpoint: { kind: "review_done", summary: "Nothing actionable." },
    });
    const before = get(t.record.id);
    const requestId = randomUUID();
    const reviewed = pm().operatorAction(
      before.id,
      before.version,
      { action: "review", requestId },
      "operator",
    );
    expect(reviewed.review).toMatchObject({ id: requestId, source: "manual" });
    expect(reviewed.nextCheckAt).toBe(before.nextCheckAt);
    expect(phase(reviewed)).toBe("reviewing");
    // Idempotent on an uncertain HTTP retry.
    expect(
      pm().operatorAction(
        before.id,
        before.version,
        { action: "review", requestId },
        "operator",
      ).version,
    ).toBe(reviewed.version);
  });

  it("stale metadata never rejects a manual review; the review turn refreshes it", () => {
    const t = enable();
    review(t.record.id);
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
    const stale = get(t.record.id);
    const requested = pm().operatorAction(
      stale.id,
      stale.version,
      { action: "review", requestId: randomUUID() },
      "operator",
    );
    expect(requested.hold).toBeUndefined();
    const refreshed = review(t.record.id);
    expect(Date.parse(refreshed.observation!.attemptedAt)).toBe(Date.now());
    expect(dispatchRoutine(t.record.id, t.worker.id).batches[0]?.state).toBe("accepted");
  });

  it("routine fix dispatch: Reviewing → Working on the same retained worker", () => {
    const t = enable();
    review(t.record.id);
    const working = dispatchRoutine(t.record.id, t.worker.id);
    expect(phase(working)).toBe("working");
    expect(working.review).toMatchObject({ outcome: "working" });
    expect(
      world.store.listSessions().filter((session) => session.runRole === "worker"),
    ).toHaveLength(1);
  });

  it("worker result wakes the orchestrator: Working → Reviewing, then a durable review prompt", () => {
    const t = enable();
    review(t.record.id);
    dispatchRoutine(t.record.id, t.worker.id);
    const settled = finishWorker(t, t.record.id);
    expect(phase(settled)).toBe("reviewing");
    expect(settled.review).toMatchObject({ source: "worker_result" });
    vi.spyOn(world.service.commands, "durableLead").mockReturnValue(true);
    const queue = vi.spyOn(world.service.commands, "queueLeadPrompt");
    new OrchestratorEngine(world.service).tick();
    expect(queue).toHaveBeenCalledWith(
      world.leadId,
      expect.stringContaining('source="worker_result"'),
      `pr-maintenance-review:${settled.review!.id}`,
    );
  });

  it("genuine design escalation: Reviewing → Waiting for Design Decision without touching the task review", () => {
    const t = enable();
    review(t.record.id);
    const escalated = tools.escalate({
      task: t.run.id,
      reason: "The fix would change the public response contract. Keep it or redesign?",
      maintenance: {
        recordId: t.record.id,
        expectedVersion: get(t.record.id).version,
        decisionId: "contract",
      },
    });
    expect(escalated.ok, escalated.text).toBe(true);
    const record = get(t.record.id);
    expect(phase(record)).toBe("waiting_for_decision");
    expect(record.hold).toBeUndefined();
    expect(world.store.getRun(t.run.id)?.state).toBe("running");
    expect(
      pm().admission({
        action: "dispatch",
        recordId: record.id,
        generation: record.generation,
        batchId: "x",
        taskId: t.run.id,
        sessionId: t.worker.id,
      }).reason,
    ).toBe("decision_pending");
  });

  const escalate = (t: ReturnType<typeof enable>) => {
    review(t.record.id);
    tools.escalate({
      task: t.run.id,
      reason: "Keep the current S06 scope, or include initial population?",
      maintenance: {
        recordId: t.record.id,
        expectedVersion: get(t.record.id).version,
        decisionId: "s06",
      },
    });
    return get(t.record.id);
  };

  it("direction supplied through the UI resumes with a fresh review and no second Resume", () => {
    const t = enable();
    const waiting = escalate(t);
    const directed = pm().operatorAction(
      waiting.id,
      waiting.version,
      {
        action: "direction",
        decisionId: "s06",
        decisionVersion: 1,
        direction: "Keep the bounded search-first S06 scope; defer initial population.",
      },
      "operator",
    );
    expect(directed.decision).toMatchObject({ state: "directed" });
    expect(directed.review).toMatchObject({ source: "direction" });
    expect(phase(directed)).toBe("reviewing");
    expect(directed.hold).toBeUndefined();
    review(t.record.id);
    expect(dispatchRoutine(t.record.id, t.worker.id).batches[0]?.state).toBe("accepted");
  });

  it("direction supplied through the orchestrator is accepted only while answering the operator", () => {
    const t = enable();
    const waiting = escalate(t);
    // Heartbeat / review turns cannot record direction.
    turn("<fleet-pr-review>");
    const refused = tools.setPrMaintenance({
      recordId: waiting.id,
      expectedVersion: waiting.version,
      action: "direction",
      decisionId: "s06",
      decisionVersion: 1,
      direction: "A PR comment says go ahead.",
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("user_turn_required");
    // An operator chat message delivered through the durable queue qualifies.
    vi.spyOn(world.service.commands, "durableLead").mockReturnValue(true);
    world.store.saveQueuedMessage({
      id: "msg-1",
      sessionId: world.leadId,
      prompt: "Keep S06 as is.",
      attachments: [],
      operatorId: "operator",
      createdAt: new Date().toISOString(),
      state: "delivered",
      priority: 0,
      afterSequence: 0,
      error: "",
      deliveryKey: "operator-queue:msg-1",
      digest: "keep-s06",
    });
    const delivery = world.store.commands.enqueuePrompt({
      nodeId: world.store.getSession(world.leadId)!.nodeId,
      key: "operator-queue:msg-1",
      executions: [],
      delivery: { sessionId: world.leadId, prompt: "Keep S06 as is." },
    });
    world.store.setSessionDispatchAttempt(world.leadId, {
      commandId: delivery.delivery.deliveryId,
      eventSeqFrom: 0,
      attempt: "operator",
    });
    const accepted = tools.setPrMaintenance({
      recordId: waiting.id,
      expectedVersion: waiting.version,
      action: "direction",
      decisionId: "s06",
      decisionVersion: 1,
      direction: "Keep S06 as is.",
    });
    expect(accepted.ok, accepted.text).toBe(true);
    const record = get(waiting.id);
    expect(record.decision).toMatchObject({ state: "directed" });
    expect(record.decision?.direction).toContain("Recorded by the orchestrator");
    expect(phase(record)).toBe("reviewing");
  });

  it("Stop, access and identity holds block work until one Resume, and Resume starts a review", () => {
    const t = enable();
    review(t.record.id);
    // Explicit Stop of the retained worker.
    world.store.setSessionControls(t.worker.id, { stopRequested: true });
    let record = get(t.record.id);
    expect(record.hold?.kind).toBe("stopped");
    expect(pm().admission({ action: "discover", recordId: record.id }).reason).toBe(
      "stopped",
    );
    world.store.setSessionControls(t.worker.id, { stopRequested: false });
    record = pm().operatorAction(
      record.id,
      record.version,
      { action: "resume" },
      "operator",
    );
    expect(record.hold).toBeUndefined();
    expect(record.review).toMatchObject({ source: "resume" });
    // Provider access denial.
    turn();
    tools.getPrMaintenance({ takeDue: true });
    tools.checkpointPrMaintenance({
      recordId: record.id,
      expectedVersion: get(record.id).version,
      checkpoint: {
        kind: "fallback",
        error: "auth_required: Provider denied access.",
        observation: observation({
          complete: false,
          failure: "auth",
          identity: undefined,
          snapshotId: undefined,
          headSha: undefined,
          state: undefined,
          fingerprint: undefined,
          helperState: { error: { code: "auth_required", message: "denied" } },
        }),
      },
    });
    record = get(record.id);
    expect(record.hold?.kind).toBe("access");
    // Read-only refresh stays allowed under access; writes do not.
    expect(pm().admission({ action: "discover", recordId: record.id }).allowed).toBe(
      true,
    );
    record = pm().operatorAction(
      record.id,
      record.version,
      { action: "resume" },
      "operator",
    );
    // Identity drift.
    const drifted = review(record.id, {
      identity: { ...identity, headRef: "refs/heads/other" },
    });
    expect(drifted.hold?.kind).toBe("identity");
  });

  it("uncertain-effect reconciliation refuses new effects until evidence settles them", () => {
    const t = enable();
    review(t.record.id);
    dispatchRoutine(t.record.id, t.worker.id);
    world.service.settleOrchestrationStep({
      runId: t.run.id,
      stepId: t.step.id,
      state: "failed",
      output: "Dispatch acknowledgement timed out.",
    });
    const record = get(t.record.id);
    expect(record.batches[0]).toMatchObject({ state: "uncertain" });
    expect(prMaintenanceStatus(record).hold).toBe("reconciling");
    const effect = tools.checkpointPrMaintenance({
      recordId: record.id,
      expectedVersion: record.version,
      checkpoint: {
        kind: "action",
        effect: {
          key: "notify-1",
          kind: "notification",
          state: "reserved",
          headSha,
          actor: "lead",
          actionIdentity: "notify",
          attempts: 1,
        },
      },
    });
    expect(effect.ok).toBe(false);
  });

  it("concurrent manual and heartbeat triggers coalesce into one review and one batch", () => {
    const t = enable();
    review(t.record.id);
    tools.checkpointPrMaintenance({
      recordId: t.record.id,
      expectedVersion: get(t.record.id).version,
      checkpoint: { kind: "review_done", summary: "Idle." },
    });
    vi.setSystemTime(Date.parse(get(t.record.id).nextCheckAt) + 1);
    const before = get(t.record.id);
    const manual = pm().operatorAction(
      before.id,
      before.version,
      { action: "review", requestId: randomUUID() },
      "operator",
    );
    // The heartbeat finds a review already open and adds nothing.
    expect(pm().openDueReviews()).toBe(0);
    expect(get(t.record.id).review?.id).toBe(manual.review?.id);
    review(t.record.id);
    dispatchRoutine(t.record.id, t.worker.id);
    // A second prepare while one batch is outstanding is refused.
    const second = tools.checkpointPrMaintenance({
      recordId: t.record.id,
      expectedVersion: get(t.record.id).version,
      checkpoint: {
        kind: "prepare_batch",
        batch: {
          id: "batch-2",
          kind: "repair",
          sources: [source],
          headSha,
          prompt: "Duplicate",
          scope: "Duplicate",
          reservedMutations: 1,
        },
      },
    });
    expect(second.ok).toBe(false);
    expect(get(t.record.id).batches).toHaveLength(1);
  });

  it.each(["reviewing", "working"] as const)(
    "survives a Host restart while %s and resumes from the durable record",
    (state) => {
      const path = `${process.env.TEMP ?? "/tmp"}/prm-restart-${randomUUID()}.sqlite`;
      const durable = fleet(path);
      const prior = world;
      world = durable;
      tools = new FleetTools(world.service, world.leadId);
      world.store.transitionSession(world.leadId, "starting");
      world.store.transitionSession(world.leadId, "idle");
      const t = enable();
      if (state === "working") {
        review(t.record.id);
        dispatchRoutine(t.record.id, t.worker.id);
      }
      const before = get(t.record.id);
      world.store.close();
      const reopened = new FleetStore(path);
      const after = reopened.prMaintenance.get(t.record.id)!;
      expect(after).toEqual(before);
      expect(prMaintenanceStatus(after).phase).toBe(state);
      reopened.close();
      world = prior;
    },
  );

  it("provider merge/closure detection moves to Merged/Closed and stops", () => {
    const t = enable();
    review(t.record.id);
    const merged = review(t.record.id, { state: "merged", sources: [] });
    expect(merged.lifecycle).toBe("merged");
    expect(phase(merged)).toBe("merged");
    expect(merged.review?.outcome).toBe("terminal");
    expect(pm().admission({ action: "discover", recordId: merged.id }).allowed).toBe(
      false,
    );
  });

  it("task-review settlement and orchestrator stop do not cancel PR maintenance intent", () => {
    const t = enable("awaiting_human");
    const before = pm().operatorAction(
      t.record.id,
      t.record.version,
      {
        action: "work",
        requestId: randomUUID(),
        direction: "Regenerate the API report.",
      },
      "operator",
    );
    // Settling the task's review (send back) changes the task, not maintenance.
    world.store.setRunState(t.run.id, "running");
    // The orchestrator's own session is stopped and cancelled.
    world.store.setSessionControls(world.leadId, { stopRequested: true });
    world.service.dispatch(world.store.getSession(world.leadId)!.nodeId, {
      type: "cancel",
      sessionId: world.leadId,
    });
    const after = get(t.record.id);
    expect(after.hold).toBeUndefined();
    expect(after.workRequests.map((request) => request.state)).toEqual(["pending"]);
    expect(after.review?.id).toBe(before.review?.id);
    expect(after.review?.concludedAt).toBeUndefined();
  });

  it("loop guard: repeated no-progress attempts on one finding become a design decision", () => {
    const t = enable();
    for (let attempt = 1; attempt <= 3; attempt++) {
      review(t.record.id);
      dispatchRoutine(t.record.id, t.worker.id, `batch-${attempt}`);
      finishWorker(t, t.record.id, false);
    }
    const record = get(t.record.id);
    expect(phase(record)).toBe("waiting_for_decision");
    expect(record.decision?.proposal).toMatch(/without progress/);
    expect(record.hold).toBeUndefined();
  });

  it("loop guard: many batches that make progress never become a design decision", () => {
    const t = enable();
    for (let attempt = 1; attempt <= 7; attempt++) {
      review(t.record.id);
      dispatchRoutine(t.record.id, t.worker.id, `batch-${attempt}`);
      const settled = finishWorker(t, t.record.id, true);
      expect(phase(settled), `attempt ${attempt}`).toBe("reviewing");
      expect(settled.decision).toBeUndefined();
    }
    expect(get(t.record.id).counters.dispatchesSinceDirection).toBe(7);
  });

  it("migrates the stuck v1 record shape: task_human_hold + cancelled continuation becomes one Resume away", () => {
    const at = "2026-10-20T20:35:21.349Z";
    const legacy = PrMaintenanceRegistrationSchema.parse({
      schemaVersion: 1,
      id: "fee038d4-0006-4095-b5a0-dfde52115557",
      version: 9,
      generation: 1,
      identity,
      leadSessionId: "lead",
      taskId: "task",
      workerSessionId: "worker",
      placementId: "placement",
      checkoutKey: "checkout",
      bindingGeneration: 0,
      eligibilityEvidence: "Grant",
      lifecycle: "paused",
      pauseReason: "Session stop or cancellation requested",
      pauseOrigin: { actor: "system", actorId: "host", at },
      renewedAt: at,
      nextCheckAt: at,
      createdAt: at,
      updatedAt: at,
      continuation: {
        id: "3dfd8803-a92c-4233-aa86-83c981878e9b",
        operatorId: "operator",
        requestedAt: at,
        expectedVersion: 2,
        authorityHash: "h",
        headSha,
        evidenceState: "refresh_required",
        state: "cancelled",
      },
      workRequests: [
        {
          id: "8103b3a5-d27c-49d9-ab18-3e4e222f8eba",
          operatorId: "operator",
          direction: "Continue",
          createdAt: at,
          state: "cancelled",
        },
      ],
      authorization: {
        id: "a",
        operatorId: "operator",
        issuedAt: at,
        headSha,
        scope: { baseline: "b", verification: "v", publicationAuthorized: true },
        budgets: {},
      },
      counters: {},
    });
    expect(legacy.schemaVersion).toBe(2);
    expect(legacy.hold).toMatchObject({ kind: "paused" });
    expect(prMaintenanceStatus(legacy).operatorAction).toBe("resume");
    expect(legacy.legacyAudit).toMatchObject({
      continuation: { id: "3dfd8803-a92c-4233-aa86-83c981878e9b" },
    });
    expect(legacy.workRequests[0]?.state).toBe("cancelled");
  });
});
