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
        kind: "prepare_work_order",
        plan: {
          batchId,
          summary: `Routine reviewer fix (${batchId})`,
          conflictResolution: false,
          reservedMutations: 2,
          findings: [
            {
              sourceId: source.id,
              revision: source.revision,
              task: "repair",
              instructions: "Add the missing null check; verify and push normally.",
            },
          ],
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

  /** The worker's final message: one tagged prm.work-report/1. */
  const workReport = (batchId: string, progress: boolean) => {
    const published = "c".repeat(40);
    return `Done.\n<prm-work-report>\n${JSON.stringify({
      schema: "prm.work-report/1",
      batchId,
      summary: progress ? "Fixed and pushed." : "Still failing.",
      mutationAttempts: progress ? 1 : 0,
      findings: [
        {
          sourceId: source.id,
          revision: source.revision,
          outcome: progress ? "addressed" : "failed",
          stage: progress ? "published" : "inspected",
          ...(progress ? { verifiedHeadSha: published, publishedCommit: published } : {}),
          evidence: progress ? ["tests passed"] : ["still failing"],
          ...(progress ? {} : { nextAction: "Try again" }),
        },
      ],
      effects: progress
        ? [
            {
              kind: "push",
              state: "known",
              commit: published,
              expectedRemoteSha: headSha,
            },
          ]
        : [],
    })}\n</prm-work-report>`;
  };

  /**
   * The retained worker finishes its turn with a work report and the step
   * settles. The Host settles the batch from that report itself; the lead
   * relays nothing.
   */
  const finishWorker = (
    t: { run: { id: string }; worker: { id: string }; step: { id: string } },
    recordId: string,
    progress = true,
  ) => {
    world.store.updateRunStep(t.step.id, { state: "running" });
    const batch = get(recordId).batches.at(-1)!;
    const sequence = world.store.maxEventSequence(t.worker.id) + 1;
    world.store.appendEvent({
      eventId: `text-${sequence}`,
      sessionId: t.worker.id,
      sequence,
      type: "agent_text",
      payload: { text: workReport(batch.id, progress) },
      createdAt: new Date().toISOString(),
    });
    world.store.appendEvent({
      eventId: `done-${sequence + 1}`,
      sessionId: t.worker.id,
      sequence: sequence + 1,
      type: "turn_complete",
      payload: {},
      createdAt: new Date().toISOString(),
    });
    world.store.appendEvent({
      eventId: `idle-${sequence + 2}`,
      sessionId: t.worker.id,
      sequence: sequence + 2,
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
    const settled = get(recordId).batches.find((entry) => entry.id === batch.id)!;
    expect(settled.settlementError, settled.settlementError).toBeUndefined();
    expect(settled.state).toBe(progress ? "succeeded" : "failed");
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
  /*
   * Charles's simplified PR maintenance decisions, one regression per criterion.
   */
  describe("simplified maintenance decisions", () => {
    const published = "c".repeat(40);
    const reportText = (body: Record<string, unknown>) =>
      `Done.\n<prm-work-report>\n${JSON.stringify({
        schema: "prm.work-report/1",
        mutationAttempts: 1,
        summary: "Worker summary.",
        effects: [],
        ...body,
      })}\n</prm-work-report>`;
    const addressed = {
      sourceId: source.id,
      revision: source.revision,
      outcome: "addressed",
      stage: "published",
      verifiedHeadSha: published,
      publishedCommit: published,
      evidence: ["verification passed"],
    };
    /** The worker ends its turn with `text`; the Host settles from it itself. */
    const finishWith = (
      t: { run: { id: string }; worker: { id: string }; step: { id: string } },
      text: string,
    ) => {
      world.store.updateRunStep(t.step.id, {
        state: "running",
        dispatchedAt: new Date().toISOString(),
      });
      const sequence = world.store.maxEventSequence(t.worker.id) + 1;
      for (const [offset, type, payload] of [
        [0, "agent_text", { text }],
        [1, "turn_complete", {}],
        [2, "state", { state: "idle" }],
      ] as const)
        world.store.appendEvent({
          eventId: `${t.worker.id}-${type}-${sequence + offset}`,
          sessionId: t.worker.id,
          sequence: sequence + offset,
          type,
          payload,
          createdAt: new Date().toISOString(),
        });
      world.service.settleOrchestrationStep({
        runId: t.run.id,
        stepId: t.step.id,
        state: "succeeded",
        output: "Worker finished.",
      });
    };
    const plan = (batchId: string, conflictResolution = false) => ({
      kind: "prepare_work_order" as const,
      plan: {
        batchId,
        summary: conflictResolution ? "Rebase onto the current base." : "Routine fix.",
        conflictResolution,
        reservedMutations: 2,
        findings: [
          {
            sourceId: source.id,
            revision: source.revision,
            task: "repair" as const,
            instructions: "Fix it within the accepted design and verify.",
          },
        ],
      },
    });
    const checkpoint = (recordId: string, input: unknown) =>
      tools.checkpointPrMaintenance({
        recordId,
        expectedVersion: get(recordId).version,
        checkpoint: input as never,
      });
    const follow = (recordId: string, workerId: string, batchId: string) =>
      tools.followUp({
        sessionId: workerId,
        maintenance: { recordId, generation: get(recordId).generation, batchId },
      });

    it.each(["active", "paused", "released"] as const)(
      "never reserves the task, checkout or worker against a direct turn (%s)",
      (state) => {
        const t = enable();
        review(t.record.id);
        if (state === "paused")
          pm().operatorAction(
            t.record.id,
            get(t.record.id).version,
            { action: "pause", reason: "Hold automatic work" },
            "operator",
          );
        if (state === "released")
          pm().operatorAction(
            t.record.id,
            get(t.record.id).version,
            { action: "release", reason: "Done with it" },
            "operator",
          );
        const before = get(t.record.id);
        for (const action of ["dispatch", "execute", "prompt", "resume"] as const)
          expect(
            pm().admission({
              action,
              taskId: t.run.id,
              sessionId: t.worker.id,
              placementId: t.worker.placementId,
            }),
          ).toEqual({ allowed: true });
        const direct = tools.followUp({
          sessionId: t.worker.id,
          prompt: "A direct question from the person.",
        });
        expect(direct.ok, direct.text).toBe(true);
        expect(world.store.getRunStep(t.step.id)?.prompt).toBe(
          "A direct question from the person.",
        );
        const after = get(t.record.id);
        expect(after.hold).toEqual(before.hold);
        expect(after.ownershipReleasedAt).toEqual(before.ownershipReleasedAt);
      },
    );

    it("lets direct work take precedence over queued maintenance without duplicate writes", () => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      expect(checkpoint(t.record.id, plan("queued-1")).ok).toBe(true);
      expect(follow(t.record.id, t.worker.id, "queued-1").ok).toBe(true);
      const queuedPrompt = get(t.record.id).batches[0]!.prompt;
      expect(get(t.record.id).batches[0]!.state).toBe("accepted");
      const direct = tools.followUp({
        sessionId: t.worker.id,
        prompt: "Direct fix first.",
      });
      expect(direct.ok, direct.text).toBe(true);
      // The queued batch yielded: settled at once, no effects, never replayed.
      expect(get(t.record.id).batches[0]).toMatchObject({
        state: "cancelled",
        reason: "direct_work",
        executionSettled: true,
        executionNotDispatched: true,
        effects: [],
      });
      const step = world.store.getRunStep(t.step.id)!;
      expect(step).toMatchObject({ prompt: "Direct fix first.", state: "pending" });
      expect(pm().referenceForStep(step.id, step.attempts)).toBeUndefined();
      // One writer: new maintenance waits while the direct turn is outstanding.
      expect(checkpoint(t.record.id, plan("after-direct")).ok).toBe(true);
      const record = get(t.record.id);
      expect(
        pm().admission({
          action: "dispatch",
          taskId: t.run.id,
          sessionId: t.worker.id,
          recordId: record.id,
          generation: record.generation,
          batchId: "after-direct",
        }).reason,
      ).toBe("direct_work_active");
      expect(follow(t.record.id, t.worker.id, "after-direct").ok).toBe(false);
      expect(world.store.getRunStep(t.step.id)?.prompt).not.toBe(queuedPrompt);
    });

    it("waits for a running maintenance turn instead of writing beside it", () => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      expect(checkpoint(t.record.id, plan("running-1")).ok).toBe(true);
      expect(follow(t.record.id, t.worker.id, "running-1").ok).toBe(true);
      world.store.updateRunStep(t.step.id, {
        state: "running",
        dispatchedAt: new Date().toISOString(),
      });
      const refused = tools.followUp({ sessionId: t.worker.id, prompt: "Direct now." });
      expect(refused.ok).toBe(false);
      expect(refused.text).toMatch(/maintenance_in_flight|maintenance turn/i);
      expect(() =>
        world.service.dispatch(t.worker.nodeId, {
          type: "prompt",
          sessionId: t.worker.id,
          prompt: "Direct now.",
          attachments: [],
        }),
      ).toThrow(/maintenance_in_flight/);
      const started = world.service.createAndStartSession({
        placement: world.store.getPlacement(t.worker.placementId)!,
        prompt: "A second writer on the same checkout.",
        yolo: false,
        runId: t.run.id,
        runRole: "worker",
      });
      expect(started).toMatchObject({ ok: false, status: 409 });
      expect(!started.ok && started.error).toMatch(/maintenance_in_flight/);
      finishWith(t, reportText({ batchId: "running-1", findings: [addressed] }));
      expect(get(t.record.id).batches[0]!.state).toBe("succeeded");
      expect(
        tools.followUp({ sessionId: t.worker.id, prompt: "Direct after it." }).ok,
      ).toBe(true);
    });

    it("pause keeps operator work and stops automatic work only; release always succeeds and keeps history", () => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      const requestId = randomUUID();
      let record = pm().operatorAction(
        t.record.id,
        get(t.record.id).version,
        { action: "work", requestId, direction: "Also update the changelog." },
        "operator",
      );
      record = pm().operatorAction(
        record.id,
        record.version,
        { action: "pause", reason: "Hold automatic work" },
        "operator",
      );
      expect(record.hold?.kind).toBe("paused");
      expect(record.workRequests[0]).toMatchObject({ id: requestId, state: "pending" });
      record = pm().operatorAction(
        record.id,
        record.version,
        { action: "resume" },
        "operator",
      );
      expect(record.workRequests[0]?.state).toBe("pending");
      expect(record.review).toMatchObject({ source: "resume" });
      // A running batch and a pending decision never block Release.
      review(record.id);
      expect(checkpoint(record.id, plan("running-2")).ok).toBe(true);
      expect(follow(record.id, t.worker.id, "running-2").ok).toBe(true);
      world.store.updateRunStep(t.step.id, {
        state: "running",
        dispatchedAt: new Date().toISOString(),
      });
      record = pm().holdForDecision(world.leadId, record.id, get(record.id).version, {
        id: "decision-1",
        version: 1,
        proposal: "Change the public contract?",
        headSha,
        scope: "public contract",
      });
      const stale = record.version - 1;
      const released = pm().operatorAction(
        record.id,
        stale,
        { action: "release", reason: "Stop maintaining this PR." },
        "operator",
      );
      expect(released.ownershipReleasedAt).toBeDefined();
      expect(released.decision).toMatchObject({ state: "withdrawn" });
      expect(released.workRequests[0]?.state).toBe("cancelled");
      expect(released.batches[0]).toMatchObject({
        id: "running-2",
        state: "accepted",
        cancellationRequestedAt: expect.any(String),
      });
      expect(released.reviewHistory.length).toBeGreaterThan(0);
      // Idempotent.
      expect(
        pm().operatorAction(
          record.id,
          1,
          { action: "release", reason: "Again" },
          "operator",
        ),
      ).toEqual(released);
    });

    it("settles a queued batch with zero effects when released", () => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      expect(checkpoint(t.record.id, plan("queued-2")).ok).toBe(true);
      expect(follow(t.record.id, t.worker.id, "queued-2").ok).toBe(true);
      const released = pm().operatorAction(
        t.record.id,
        get(t.record.id).version,
        { action: "release", reason: "No longer needed." },
        "operator",
      );
      expect(released.batches[0]).toMatchObject({
        state: "cancelled",
        executionNotDispatched: true,
        effects: [],
      });
      expect(world.store.getRunStep(t.step.id)?.state).toBe("cancelled");
    });

    const release = (recordId: string, reason = "Stop maintaining this PR.") =>
      pm().operatorAction(
        recordId,
        get(recordId).version,
        { action: "release", reason },
        "operator",
      );
    const runningBatch = (batchId: string) => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      expect(checkpoint(t.record.id, plan(batchId)).ok).toBe(true);
      expect(follow(t.record.id, t.worker.id, batchId).ok).toBe(true);
      world.store.updateRunStep(t.step.id, {
        state: "running",
        dispatchedAt: new Date().toISOString(),
      });
      return t;
    };
    const attentions = () =>
      world.store
        .listNotifications()
        .notifications.filter(
          (entry) =>
            (entry.data as { reason?: string } | undefined)?.reason === "attention",
        );
    const reportOf = (text: string) =>
      JSON.parse(text.split("<prm-work-report>")[1]!.split("</prm-work-report>")[0]!);

    it("keeps a turn running at Release: it blocks a second writer and work_report still recovers its late result", () => {
      const t = runningBatch("late-1");
      const released = release(t.record.id);
      expect(released.ownershipReleasedAt).toBeDefined();
      expect(released.batches[0]).toMatchObject({ id: "late-1", state: "accepted" });
      // The second writer still waits for the running maintenance turn.
      const refused = tools.followUp({ sessionId: t.worker.id, prompt: "Direct now." });
      expect(refused.ok).toBe(false);
      expect(refused.text).toMatch(/maintenance_in_flight/);
      expect(pm().admission({ action: "prompt", sessionId: t.worker.id }).reason).toBe(
        "maintenance_in_flight",
      );
      expect(pm().hasSessionRetentionBlockers(t.worker.id)).toBe(true);
      // The late result is still admitted; without a report it waits for recovery.
      finishWith(t, "Done, but no report.");
      let batch = get(t.record.id).batches[0]!;
      expect(batch).toMatchObject({ state: "reconciling", executionSettled: true });
      expect(batch.settlementError).toMatch(/report_missing/);
      // Released, so no review will pick it up: a person is told.
      world.service.cancelPausedPrMaintenance();
      expect(attentions().map((entry) => entry.body)).toEqual([
        expect.stringContaining("could not settle it: report_missing"),
      ]);
      const recovered = checkpoint(t.record.id, {
        kind: "work_report",
        batchId: "late-1",
        generation: batch.generation,
        report: reportOf(reportText({ batchId: "late-1", findings: [addressed] })),
      });
      expect(recovered.ok, recovered.text).toBe(true);
      const record = get(t.record.id);
      batch = record.batches[0]!;
      expect(batch).toMatchObject({ state: "succeeded", published: true });
      expect(record.ownershipReleasedAt).toBe(released.ownershipReleasedAt);
      expect(record.review?.source).not.toBe("worker_result");
      expect(record.decision?.state).not.toBe("pending");
      // Settled: direct work proceeds, and nothing new starts.
      expect(pm().hasSessionRetentionBlockers(t.worker.id)).toBe(false);
      expect(tools.followUp({ sessionId: t.worker.id, prompt: "Direct now." }).ok).toBe(
        true,
      );
      const fresh = checkpoint(t.record.id, plan("after-release"));
      expect(fresh.ok).toBe(false);
      expect(fresh.text).toContain("released");
    });

    it("settles a valid late result automatically after Release without a new review", () => {
      const t = runningBatch("late-2");
      release(t.record.id);
      finishWith(t, reportText({ batchId: "late-2", findings: [addressed] }));
      const record = get(t.record.id);
      expect(record.batches[0]!.settlementError).toBeUndefined();
      expect(record.batches[0]).toMatchObject({ state: "succeeded", published: true });
      expect(record.review?.source).not.toBe("worker_result");
      expect(
        pm().admission({
          action: "dispatch",
          taskId: t.run.id,
          sessionId: t.worker.id,
          recordId: record.id,
          generation: record.generation,
          batchId: "late-2",
        }),
      ).toMatchObject({ allowed: false });
    });

    it("records a rewrite in a turn that finished after Release and tells a person", () => {
      const t = runningBatch("late-3");
      release(t.record.id);
      finishWith(
        t,
        reportText({
          batchId: "late-3",
          findings: [addressed],
          effects: [
            {
              kind: "push",
              state: "known",
              commit: published,
              force: true,
              expectedRemoteSha: headSha,
            },
          ],
        }),
      );
      const record = get(t.record.id);
      expect(record.batches[0]).toMatchObject({ state: "succeeded", published: true });
      expect(record.batches[0]!.lineage?.state).toBe("rewritten");
      expect(record.hold).toBeUndefined();
      world.service.cancelPausedPrMaintenance();
      expect(attentions().map((entry) => entry.body)).toEqual([
        expect.stringContaining("outside a conflict-resolution repair"),
      ]);
    });

    it("reads a settled batch's report only from its own attempt, never later direct work", () => {
      const t = runningBatch("bounded-1");
      finishWith(t, "No report in this turn.");
      let batch = get(t.record.id).batches[0]!;
      expect(batch.eventSeqTo).toBe(world.store.maxEventSequence(t.worker.id));
      expect(batch.settlementError).toMatch(/report_missing/);
      expect(
        tools.followUp({ sessionId: t.worker.id, prompt: "Direct question." }).ok,
      ).toBe(true);
      const sequence = world.store.maxEventSequence(t.worker.id) + 1;
      world.store.appendEvent({
        eventId: `direct-${sequence}`,
        sessionId: t.worker.id,
        sequence,
        type: "agent_text",
        payload: { text: reportText({ batchId: "bounded-1", findings: [addressed] }) },
        createdAt: new Date().toISOString(),
      });
      const retry = checkpoint(t.record.id, {
        kind: "work_report",
        batchId: "bounded-1",
        generation: batch.generation,
      });
      expect(retry.ok).toBe(false);
      expect(retry.text).toContain("report_missing");
      batch = get(t.record.id).batches[0]!;
      expect(batch.state).toBe("reconciling");
      expect(batch.published).toBe(false);
    });

    it("dispatches maintenance only onto a clean checkout at the batch head; a refusal settles unsent for a person", () => {
      const dispatch = vi.spyOn(world.service, "dispatch");
      const prompts = () =>
        dispatch.mock.calls
          .map(([, command]) => command as Record<string, unknown>)
          .filter(
            (command) => command.type === "prompt" && command.sessionId !== world.leadId,
          );
      const t = enable();
      review(t.record.id);
      dispatchRoutine(t.record.id, t.worker.id);
      expect(prompts().at(-1)).toMatchObject({
        sessionId: t.worker.id,
        checkoutPrecondition: { headSha, requireClean: true },
      });
      const reason =
        "PR maintenance was not sent: the checkout has uncommitted changes that may be a person's work.";
      const commandId = world.store.getSessionDispatchAttempt(t.worker.id)!.commandId;
      expect(world.store.getRunStep(t.step.id)?.state).toBe("starting");
      // A stale refusal of some other command never cancels the batch.
      world.service.refusePrMaintenanceCheckout(t.worker.id, "older-command", reason);
      expect(get(t.record.id).batches[0]!.state).toBe("accepted");
      world.service.refusePrMaintenanceCheckout(t.worker.id, commandId, reason);
      const record = get(t.record.id);
      expect(record.batches[0]).toMatchObject({
        state: "cancelled",
        reason: "checkout_precondition",
        executionNotDispatched: true,
        effects: [],
        published: false,
      });
      expect(record.batches[0]!.findings[0]?.outcome).toBe("needs_human");
      expect(record.decision).toMatchObject({ state: "pending" });
      expect(phase(record)).toBe("waiting_for_decision");
      expect(world.store.getRunStep(t.step.id)?.state).toBe("cancelled");
      // Direct turns never carry the precondition.
      dispatch.mockClear();
      expect(tools.followUp({ sessionId: t.worker.id, prompt: "Direct work." }).ok).toBe(
        true,
      );
      const direct = prompts().at(-1);
      expect(direct).toMatchObject({ sessionId: t.worker.id, prompt: "Direct work." });
      expect(direct).not.toHaveProperty("checkoutPrecondition");
    });

    it("ignores a refusal once the maintenance turn has started", () => {
      const t = enable();
      review(t.record.id);
      dispatchRoutine(t.record.id, t.worker.id);
      const commandId = world.store.getSessionDispatchAttempt(t.worker.id)!.commandId;
      world.store.updateRunStep(t.step.id, { state: "running" });
      world.service.refusePrMaintenanceCheckout(t.worker.id, commandId, "late refusal");
      expect(get(t.record.id).batches[0]!.state).toBe("accepted");
      expect(world.store.getRunStep(t.step.id)?.state).toBe("running");
    });

    it("never sends maintenance to a Node that cannot check the checkout; direct turns still go", () => {
      const dispatch = vi.spyOn(world.service, "dispatch");
      const getNode = world.store.getNode.bind(world.store);
      vi.spyOn(world.store, "getNode").mockImplementation((id) => {
        const node = getNode(id);
        return node && { ...node, capabilities: ["copilot-acp", "host-yolo"] };
      });
      const workerPrompts = (sessionId: string) =>
        dispatch.mock.calls
          .map(([, command]) => command as Record<string, unknown>)
          .filter(
            (command) => command.type === "prompt" && command.sessionId === sessionId,
          );
      const t = enable();
      review(t.record.id);
      dispatchRoutine(t.record.id, t.worker.id);
      expect(workerPrompts(t.worker.id)).toEqual([]);
      const record = get(t.record.id);
      expect(record.batches[0]).toMatchObject({
        state: "cancelled",
        reason: "node_upgrade_required",
        executionNotDispatched: true,
        effects: [],
        published: false,
      });
      expect(record.decision).toMatchObject({ state: "pending" });
      expect(record.decision?.proposal).toContain("node_upgrade_required");
      expect(world.store.getRunStep(t.step.id)?.state).toBe("cancelled");
      expect(tools.followUp({ sessionId: t.worker.id, prompt: "Direct work." }).ok).toBe(
        true,
      );
      expect(workerPrompts(t.worker.id)).toEqual([
        expect.objectContaining({ prompt: "Direct work." }),
      ]);
      expect(workerPrompts(t.worker.id)[0]).not.toHaveProperty("checkoutPrecondition");
    });

    it("re-prepares unsent work when the grant narrows, and records nothing for a no-op edit", () => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      expect(checkpoint(t.record.id, plan("wide-1")).ok).toBe(true);
      expect(follow(t.record.id, t.worker.id, "wide-1").ok).toBe(true);
      const before = get(t.record.id);
      const noop = pm().operatorAction(
        t.record.id,
        before.version,
        { action: "scope", scope: { replies: true } },
        "operator",
        () => {
          throw new Error("A no-op edit writes no audit note.");
        },
      );
      expect(noop.version).toBe(before.version);
      expect(noop.scopeHistory).toHaveLength(0);
      const widened = pm().operatorAction(
        t.record.id,
        before.version,
        { action: "scope", scope: { retryChecks: true } },
        "operator",
      );
      expect(widened.batches[0]!.state).toBe("accepted");
      const narrowed = pm().operatorAction(
        t.record.id,
        widened.version,
        { action: "scope", scope: { replies: false } },
        "operator",
      );
      expect(narrowed.scopeHistory).toHaveLength(2);
      expect(narrowed.batches[0]).toMatchObject({
        state: "cancelled",
        reason: "scope_changed",
        executionNotDispatched: true,
        effects: [],
      });
      expect(world.store.getRunStep(t.step.id)?.state).toBe("cancelled");
    });

    it("reads a legacy manual-control hold as a pause that needs an explicit Resume", () => {
      const t = enable();
      const raw = JSON.parse(JSON.stringify(get(t.record.id)));
      raw.hold = {
        kind: "manual_control",
        reason: "Operator took manual control.",
        actor: "operator",
        actorId: "alice",
        at: new Date().toISOString(),
      };
      raw.manualControl = {
        operatorId: "alice",
        takenAt: new Date().toISOString(),
        commands: [],
      };
      (
        world.store as unknown as {
          db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
        }
      ).db
        .prepare("UPDATE pr_maintenance SET data=? WHERE id=?")
        .run(JSON.stringify(raw), t.record.id);
      let record = get(t.record.id);
      expect(record.hold).toMatchObject({ kind: "paused", actorId: "alice" });
      expect(record.hold?.reason).toMatch(/manual control/);
      expect(prMaintenanceStatus(record).operatorAction).toBe("resume");
      // A finished direct turn never clears it on its own.
      pm().reconcileHandbacks();
      expect(get(t.record.id).hold?.kind).toBe("paused");
      record = pm().operatorAction(
        t.record.id,
        get(t.record.id).version,
        { action: "resume" },
        "operator",
      );
      expect(record.hold).toBeUndefined();
      expect(record.review?.concludedAt).toBeUndefined();
      const at = "2026-10-20T20:35:21.349Z";
      const v1 = PrMaintenanceRegistrationSchema.parse({
        schemaVersion: 1,
        id: "fee038d4-0006-4095-b5a0-dfde52115558",
        version: 3,
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
        pauseReason: "manual_control",
        pauseOrigin: { actor: "operator", actorId: "bob", at },
        renewedAt: at,
        nextCheckAt: at,
        createdAt: at,
        updatedAt: at,
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
      expect(v1.hold).toMatchObject({
        kind: "paused",
        actor: "operator",
        actorId: "bob",
      });
      expect(prMaintenanceStatus(v1).operatorAction).toBe("resume");
    });

    it("tells the batch's own step from direct work by step id and attempt, not prompt", () => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      expect(checkpoint(t.record.id, plan("own-1")).ok).toBe(true);
      expect(follow(t.record.id, t.worker.id, "own-1").ok).toBe(true);
      const batch = get(t.record.id).batches[0]!;
      const admit = () =>
        pm().admission({
          action: "execute",
          taskId: t.run.id,
          sessionId: t.worker.id,
          recordId: t.record.id,
          generation: get(t.record.id).generation,
          batchId: "own-1",
        });
      expect(admit()).toEqual({ allowed: true });
      const other = world.store.upsertRunStep(t.run.id, {
        stepKey: "copy",
        title: "Copy",
        prompt: batch.prompt,
        category: "implement",
        placementId: t.worker.placementId,
      });
      world.store.updateRunStep(other.id, { sessionId: t.worker.id, state: "pending" });
      expect(admit().reason).toBe("direct_work_active");
      world.store.updateRunStep(other.id, { state: "cancelled" });
      expect(admit()).toEqual({ allowed: true });
    });
    it("grants replies and thread resolution by default and edits the grant in place", () => {
      const t = task();
      const record = pm().enableFromOperator(
        {
          taskId: t.run.id,
          workerSessionId: t.worker.id,
          identity,
          headSha,
          scope: {
            baseline: "Keep the approved API.",
            verification: "Run the focused suite.",
            publicationAuthorized: true,
          },
          eligibilityEvidence: "Operator verified the PR, branch HEAD and worker.",
        },
        "operator",
      );
      expect(record.authorization.scope).toMatchObject({
        replies: true,
        resolveThreads: true,
        retryChecks: false,
      });
      review(record.id);
      const edited = pm().operatorAction(
        record.id,
        get(record.id).version,
        { action: "scope", scope: { resolveThreads: false } },
        "operator",
      );
      expect(edited.authorization.id).toBe(record.authorization.id);
      expect(edited.authorization.scope).toMatchObject({
        replies: true,
        resolveThreads: false,
      });
      expect(edited.scopeHistory).toHaveLength(1);
      expect(edited.hold).toBeUndefined();
      expect(checkpoint(record.id, plan("scoped-1")).ok).toBe(true);
      expect(get(record.id).batches[0]!.workOrder).toMatchObject({
        permissions: { push: true, reply: true, resolveThreads: false },
      });
    });

    it("settles from the worker report itself and keeps work_report as the one recovery path", () => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      // No lead relay of large observations or alternate evidence.
      const relayed = checkpoint(t.record.id, {
        kind: "observation",
        observation: observation({ helperState: { pad: "x".repeat(40_000) } }),
      });
      expect(relayed.ok).toBe(false);
      expect(relayed.text).toContain("observation_relay_refused");
      expect(checkpoint(t.record.id, plan("report-1")).ok).toBe(true);
      expect(follow(t.record.id, t.worker.id, "report-1").ok).toBe(true);
      finishWith(t, "Done, but I forgot the report.");
      let batch = get(t.record.id).batches[0]!;
      expect(batch).toMatchObject({ state: "reconciling", executionSettled: true });
      expect(batch.settlementError).toMatch(/report_missing/);
      // No hand-built per-finding settlement for a work order.
      const handBuilt = checkpoint(t.record.id, {
        kind: "batch",
        batchId: "report-1",
        generation: batch.generation,
        state: "succeeded",
        executionSettled: true,
        usedMutations: 1,
        published: true,
        effects: [],
        findings: [],
        evidence: "Lead says it worked.",
      });
      expect(handBuilt.ok).toBe(false);
      expect(handBuilt.text).toContain("host_settlement");
      const recovered = checkpoint(t.record.id, {
        kind: "work_report",
        batchId: "report-1",
        generation: batch.generation,
        report: JSON.parse(
          reportText({ batchId: "report-1", findings: [addressed] })
            .split("<prm-work-report>")[1]!
            .split("</prm-work-report>")[0]!,
        ),
      });
      expect(recovered.ok, recovered.text).toBe(true);
      batch = get(t.record.id).batches[0]!;
      expect(batch.state).toBe("succeeded");
      expect(batch.settlementError).toBeUndefined();
      expect(get(t.record.id).review).toMatchObject({ source: "worker_result" });
    });

    it("does not pause after a routine fix, its normal push and the next observation", () => {
      const t = enable();
      review(t.record.id);
      dispatchRoutine(t.record.id, t.worker.id);
      finishWorker(t, t.record.id);
      vi.setSystemTime(Date.now() + 60_000);
      const record = review(t.record.id, { headSha: "c".repeat(40) });
      expect(record.batches[0]!.lineage).toMatchObject({
        state: "reported",
        fromSha: headSha,
        toSha: "c".repeat(40),
      });
      expect(record.batches[0]!.reportSource).toBe("host");
      expect(record.hold).toBeUndefined();
      expect(phase(record)).toBe("reviewing");
      world.service.cancelPausedPrMaintenance();
      expect(attentions()).toEqual([]);
    });

    it.each(["unverified", "rewritten"] as const)(
      "refreshes a same-ref source-head move after a settled repair without Pause or Resume (%s)",
      (lineage) => {
        const t = enable();
        review(t.record.id);
        dispatchRoutine(t.record.id, t.worker.id);
        const settled = finishWorker(t, t.record.id).batches[0]!;
        expect(settled.effects).toEqual([
          expect.objectContaining({ kind: "push", state: "known", headSha: published }),
        ]);
        const currentHead = "d".repeat(40);
        vi.setSystemTime(Date.now() + 60_000);
        const record = review(t.record.id, {
          headSha: currentHead,
          ...(lineage === "rewritten"
            ? {
                headLineage: {
                  fromSha: headSha,
                  fastForward: false,
                  evidence: "The same registered source ref now has divergent history.",
                },
              }
            : {}),
        });
        expect(record.observation).toMatchObject({ identity, headSha: currentHead });
        expect(record.hold).toBeUndefined();
        expect(phase(record)).toBe("reviewing");
        expect(prMaintenanceStatus(record).operatorAction).not.toBe("resume");
        expect(record.batches[0]).toMatchObject({
          state: "succeeded",
          executionSettled: true,
          published: true,
          effects: settled.effects,
          findings: settled.findings,
        });
        expect(follow(t.record.id, t.worker.id, settled.id).ok).toBe(false);
        const prepared = checkpoint(t.record.id, plan("fresh-head"));
        expect(prepared.ok, prepared.text).toBe(true);
        expect(get(t.record.id).batches[1]).toMatchObject({
          headSha: currentHead,
          sources: [source],
          workOrder: { pr: { headSha: currentHead } },
        });
        const dispatched = follow(t.record.id, t.worker.id, "fresh-head");
        expect(dispatched.ok, dispatched.text).toBe(true);
        expect(phase(get(t.record.id))).toBe("working");
        expect(get(t.record.id).batches[0]!.effects).toEqual(settled.effects);
        world.service.cancelPausedPrMaintenance();
        expect(attentions()).toEqual([]);
      },
    );

    it("never lets a recovered report explain another writer's push", () => {
      const t = runningBatch("recovered-1");
      finishWith(t, "Done, but no report.");
      const other = "e".repeat(40);
      const recovered = checkpoint(t.record.id, {
        kind: "work_report",
        batchId: "recovered-1",
        generation: get(t.record.id).generation,
        report: reportOf(
          reportText({
            batchId: "recovered-1",
            findings: [addressed],
            effects: [
              { kind: "push", state: "known", commit: other, expectedRemoteSha: headSha },
            ],
          }),
        ),
      });
      expect(recovered.ok, recovered.text).toBe(true);
      let record = get(t.record.id);
      expect(record.batches[0]).toMatchObject({
        state: "succeeded",
        published: true,
        reportSource: "lead",
      });
      expect(record.hold).toBeUndefined();
      vi.setSystemTime(Date.now() + 60_000);
      record = review(t.record.id, { headSha: other });
      expect(record.batches[0]!.lineage).toMatchObject({
        state: "unverified",
        toSha: other,
      });
      expect(record.batches[0]!.lineage?.evidence).toMatch(/orchestrator supplied/);
      expect(record.hold).toMatchObject({ kind: "paused", actor: "system" });
    });

    it("maintains a PR while its task awaits a human, without touching the task", () => {
      const t = enable("awaiting_human");
      review(t.record.id);
      dispatchRoutine(t.record.id, t.worker.id);
      expect(phase(get(t.record.id))).toBe("working");
      finishWorker(t, t.record.id);
      expect(world.store.getRun(t.run.id)?.state).toBe("awaiting_human");
      expect(phase(get(t.record.id))).toBe("reviewing");
    });

    describe("merge conflicts", () => {
      const conflictReport = (batchId: string, effect: Record<string, unknown>) =>
        reportText({
          batchId,
          findings: [addressed],
          effects: [{ kind: "push", state: "known", commit: published, ...effect }],
        });
      const conflicted = () => {
        vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
        const t = enable();
        review(t.record.id, { mergeability: "conflicting" });
        return t;
      };

      it("rebases and force-pushes with a lease on the exact PR head", () => {
        const t = conflicted();
        const plain = checkpoint(t.record.id, plan("plain"));
        expect(plain.ok).toBe(false);
        expect(plain.text).toContain("observation_blocked");
        expect(checkpoint(t.record.id, plan("rebase-1", true)).ok).toBe(true);
        const batch = get(t.record.id).batches[0]!;
        expect(batch).toMatchObject({ conflictResolution: true, baseSha });
        expect(batch.prompt).toContain("rebase");
        expect(batch.prompt).toContain(`--force-with-lease=<headRef>:<pr.headSha>`);
        expect(batch.prompt).toContain("Preserve user work");
        expect(follow(t.record.id, t.worker.id, "rebase-1").ok).toBe(true);
        finishWith(
          t,
          conflictReport("rebase-1", { force: true, expectedRemoteSha: headSha }),
        );
        const settled = get(t.record.id).batches[0]!;
        expect(settled.settlementError).toBeUndefined();
        expect(settled).toMatchObject({ state: "succeeded", published: true });
        expect(settled.effects[0]).toMatchObject({
          kind: "push",
          force: true,
          expectedRemoteSha: headSha,
        });
      });

      it("records a forced push leased on another remote head as a fact and holds for a person", () => {
        const t = conflicted();
        expect(checkpoint(t.record.id, plan("rebase-2", true)).ok).toBe(true);
        expect(follow(t.record.id, t.worker.id, "rebase-2").ok).toBe(true);
        finishWith(
          t,
          conflictReport("rebase-2", { force: true, expectedRemoteSha: "d".repeat(40) }),
        );
        const record = get(t.record.id);
        const batch = record.batches[0]!;
        // Settled, not stranded in reconciling: the push happened.
        expect(batch.settlementError).toBeUndefined();
        expect(batch).toMatchObject({ state: "succeeded", published: true });
        expect(batch.effects[0]).toMatchObject({
          kind: "push",
          force: true,
          expectedRemoteSha: "d".repeat(40),
        });
        expect(record.hold).toMatchObject({ kind: "paused", actor: "system" });
        expect(record.hold?.reason).toMatch(
          /not the head .* this batch was prepared from/,
        );
        expect(record.review).toMatchObject({ outcome: "held" });
        // Nothing automatic happens until a person resumes.
        expect(checkpoint(t.record.id, plan("after-rewrite", true)).ok).toBe(false);
      });

      it("stops on unknown remote changes, user work or an ambiguous conflict", () => {
        const t = conflicted();
        expect(checkpoint(t.record.id, plan("rebase-3", true)).ok).toBe(true);
        expect(follow(t.record.id, t.worker.id, "rebase-3").ok).toBe(true);
        finishWith(
          t,
          reportText({
            batchId: "rebase-3",
            mutationAttempts: 0,
            findings: [
              {
                sourceId: source.id,
                revision: source.revision,
                outcome: "needs_human",
                stage: "inspected",
                evidence: ["The remote head moved past pr.headSha; nothing was pushed."],
                nextAction: "Ask whether to keep the other writer's commits.",
              },
            ],
          }),
        );
        const record = get(t.record.id);
        expect(record.batches[0]).toMatchObject({ effects: [], published: false });
        expect(record.decision).toMatchObject({ state: "pending" });
        expect(phase(record)).toBe("waiting_for_decision");
      });

      it("records a forced push outside a conflict-resolution batch, or an unreported rewrite, and holds", () => {
        vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
        const t = enable();
        review(t.record.id);
        expect(checkpoint(t.record.id, plan("routine-force")).ok).toBe(true);
        expect(follow(t.record.id, t.worker.id, "routine-force").ok).toBe(true);
        finishWith(
          t,
          conflictReport("routine-force", { force: true, expectedRemoteSha: headSha }),
        );
        const record = get(t.record.id);
        expect(record.batches[0]).toMatchObject({ state: "succeeded", published: true });
        expect(record.batches[0]!.settlementError).toBeUndefined();
        expect(record.hold?.kind).toBe("paused");
        expect(record.hold?.reason).toMatch(/outside a conflict-resolution repair/);
      });

      it("flags a push reported as normal that replaced a head other than the batch's", () => {
        vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
        const t = enable();
        review(t.record.id);
        expect(checkpoint(t.record.id, plan("hidden-force")).ok).toBe(true);
        expect(follow(t.record.id, t.worker.id, "hidden-force").ok).toBe(true);
        finishWith(
          t,
          conflictReport("hidden-force", { expectedRemoteSha: "d".repeat(40) }),
        );
        const record = get(t.record.id);
        expect(record.batches[0]).toMatchObject({ state: "succeeded", published: true });
        expect(record.hold?.kind).toBe("paused");
        expect(record.hold?.reason).toMatch(/reported as a normal push but replaced/);
      });

      it("settles a push reported without the head it replaced; its reported commit explains the next head", () => {
        vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
        const pushedWithoutLease = (observed: string) => {
          const t = enable();
          review(t.record.id);
          expect(checkpoint(t.record.id, plan("no-lease")).ok).toBe(true);
          expect(follow(t.record.id, t.worker.id, "no-lease").ok).toBe(true);
          finishWith(t, conflictReport("no-lease", {}));
          let record = get(t.record.id);
          // Never stranded: the push is a fact and the batch settles.
          expect(record.batches[0]!.settlementError).toBeUndefined();
          expect(record.batches[0]).toMatchObject({
            state: "succeeded",
            published: true,
          });
          expect(record.hold).toBeUndefined();
          vi.setSystemTime(Date.now() + 60_000);
          record = review(t.record.id, { headSha: observed });
          release(t.record.id, "next scenario");
          return record;
        };
        const explained = pushedWithoutLease(published);
        expect(explained.batches[0]!.lineage?.state).toBe("reported");
        expect(explained.hold).toBeUndefined();
        const unexplained = pushedWithoutLease("d".repeat(40));
        expect(unexplained.batches[0]!.lineage?.state).toBe("unverified");
        expect(unexplained.hold).toMatchObject({ kind: "paused", actor: "system" });
        expect(unexplained.hold?.reason).toMatch(
          /no push that batch reported explains it/,
        );
        world.service.cancelPausedPrMaintenance();
        expect(attentions().map((entry) => entry.body)).toEqual([
          expect.stringContaining("No push in a worker report the Host read"),
        ]);
      });

      it("lets a rewrite replace an orchestrator pause, which the orchestrator then cannot clear", () => {
        const t = runningBatch("lead-paused");
        pm().set(world.leadId, {
          id: t.record.id,
          expectedVersion: get(t.record.id).version,
          action: "pause",
          reason: "The orchestrator paused.",
        });
        finishWith(
          t,
          conflictReport("lead-paused", { force: true, expectedRemoteSha: headSha }),
        );
        const record = get(t.record.id);
        expect(record.batches[0]!.state).toBe("succeeded");
        expect(record.hold).toMatchObject({ kind: "paused", actor: "system" });
        expect(record.hold?.reason).toMatch(/outside a conflict-resolution repair/);
        expect(record.holdHistory.at(-1)).toMatchObject({ actor: "lead" });
        expect(() =>
          pm().set(world.leadId, {
            id: record.id,
            expectedVersion: record.version,
            action: "resume",
          }),
        ).toThrow(/operator_required|Only the person/);
        expect(get(record.id).hold?.actor).toBe("system");
      });

      it("keeps a person's pause, adds the rewrite to it and raises attention", () => {
        const t = runningBatch("operator-paused");
        pm().operatorAction(
          t.record.id,
          get(t.record.id).version,
          { action: "pause", reason: "Operator pause." },
          "operator",
        );
        finishWith(
          t,
          conflictReport("operator-paused", { force: true, expectedRemoteSha: headSha }),
        );
        const record = get(t.record.id);
        expect(record.hold).toMatchObject({ kind: "paused", actor: "operator" });
        expect(record.hold?.reason).toMatch(
          /^Operator pause\. Also: .*outside a conflict-resolution repair/,
        );
        world.service.cancelPausedPrMaintenance();
        expect(attentions().map((entry) => entry.body)).toEqual([
          expect.stringContaining("outside a conflict-resolution repair"),
        ]);
      });

      it("checks the next head after a published batch: fast-forward, leased rewrite, rewrite or unverified", () => {
        vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
        const run = (
          head: string,
          lineage: Record<string, unknown> | undefined,
          conflict = false,
        ) => {
          const t = conflict ? conflicted() : enable();
          if (!conflict) review(t.record.id);
          expect(checkpoint(t.record.id, plan("pushed", conflict)).ok).toBe(true);
          expect(follow(t.record.id, t.worker.id, "pushed").ok).toBe(true);
          finishWith(
            t,
            conflictReport(
              "pushed",
              conflict
                ? { force: true, expectedRemoteSha: headSha }
                : { expectedRemoteSha: headSha },
            ),
          );
          const finished = get(t.record.id);
          expect(finished.batches[0]!.state, JSON.stringify(finished)).toBe("succeeded");
          vi.setSystemTime(Date.now() + 60_000);
          const observed = review(t.record.id, {
            headSha: head,
            ...(lineage ? { headLineage: lineage } : {}),
          });
          // One registration per PR: release before the next scenario.
          pm().operatorAction(
            t.record.id,
            observed.version,
            { action: "release", reason: "next scenario" },
            "operator",
          );
          return observed;
        };
        // The batch's own reported push explains the move: no pause.
        const reported = run(published, undefined);
        expect(reported.batches[0]!.lineage).toMatchObject({
          state: "reported",
          fromSha: headSha,
          toSha: published,
        });
        expect(reported.hold).toBeUndefined();
        // Nothing recorded explains this head: a person checks the branch.
        const unverified = run("d".repeat(40), undefined);
        expect(unverified.batches[0]!.lineage).toMatchObject({
          state: "unverified",
          toSha: "d".repeat(40),
        });
        expect(unverified.hold).toMatchObject({ kind: "paused", actor: "system" });
        expect(unverified.hold?.reason).toMatch(
          /no push that batch reported explains it/,
        );
        const forward = run(published, {
          fromSha: headSha,
          fastForward: true,
          evidence: "compare: ahead 1, behind 0",
        });
        expect(forward.batches[0]!.lineage?.state).toBe("fast_forward");
        expect(forward.hold).toBeUndefined();
        const rewritten = run(published, {
          fromSha: headSha,
          fastForward: false,
          evidence: "compare: diverged",
        });
        expect(rewritten.batches[0]!.lineage?.state).toBe("rewritten");
        expect(rewritten.hold?.reason).toMatch(/without a fast-forward/);
        const leased = run(published, undefined, true);
        expect(leased.batches[0]!.lineage?.state).toBe("leased_rewrite");
        expect(leased.hold).toBeUndefined();
        const movedPastLease = run("d".repeat(40), undefined, true);
        expect(movedPastLease.batches[0]!.lineage?.state).toBe("unverified");
        expect(movedPastLease.hold?.kind).toBe("paused");
      });
    });

    it("keeps the hard safeguards: no merge, preserved user work, holds refuse automatic writes only", () => {
      vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
      const t = enable();
      review(t.record.id);
      expect(checkpoint(t.record.id, plan("rules-1")).ok).toBe(true);
      const batch = get(t.record.id).batches[0]!;
      expect(batch.prompt).toContain("merge the PR, enable auto-merge/auto-complete");
      expect(batch.prompt).toContain("Never force-push, rebase or reset the PR branch");
      expect(batch.prompt).toContain("Preserve user work");
      // An operator pause refuses the maintenance dispatch, not direct work.
      const paused = pm().operatorAction(
        t.record.id,
        get(t.record.id).version,
        { action: "pause", reason: "Hold" },
        "operator",
      );
      expect(paused.batches[0]!.state).toBe("cancelled");
      expect(
        pm().admission({
          action: "dispatch",
          taskId: t.run.id,
          sessionId: t.worker.id,
          recordId: paused.id,
          generation: paused.generation,
          batchId: "rules-1",
        }).allowed,
      ).toBe(false);
      expect(pm().admission({ action: "prompt", sessionId: t.worker.id }).allowed).toBe(
        true,
      );
      const resent = follow(t.record.id, t.worker.id, "rules-1");
      expect(resent.text).toContain("no prompt was sent");
      expect(world.store.getRunStep(t.step.id)?.prompt).not.toBe(batch.prompt);
      expect(get(t.record.id).batches[0]!.state).toBe("cancelled");
    });
  });
});
