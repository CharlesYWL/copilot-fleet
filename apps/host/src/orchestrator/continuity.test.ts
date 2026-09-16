import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunCriterionSchema } from "@fleet/protocol";
import { fleet } from "./fleet-harness.js";
import { FleetTools } from "./tools.js";

describe("orchestrator task discovery and continuity", () => {
  let world: ReturnType<typeof fleet>;
  let tools: FleetTools;

  beforeEach(() => {
    world = fleet();
    tools = new FleetTools(world.service, world.leadId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    world.store.close();
  });

  const plan = (
    name = "Review comments",
    overrides: Partial<Parameters<FleetTools["planTask"]>[0]> = {},
  ) => {
    const result = tools.planTask({
      task: name,
      objective: "Address the latest review feedback in PR 1066416",
      phases: ["Implement and verify"],
      successCriteria: [
        RunCriterionSchema.parse({
          id: "rename",
          scenario: "All callers use getWizardIsMyWorkspace without behavior changes",
          expectedEvidence: "The focused test passes and the old name has no callers",
        }),
      ],
      stopWhen: "The rename and its callers are updated with no behavior change",
      ...overrides,
    });
    expect(result.ok, result.text).toBe(true);
    return world.store.listRuns().find((entry) => entry.name === name)!;
  };

  const start = (
    task = "Review comments",
    category: "implement" | "explore" = "explore",
  ) => {
    const result = tools.startWork({
      task,
      category,
      title: "Update the workspace helper",
      deliverable: "Rename the helper and update all of its references",
      scope: "The wizard helper and its callers only",
      verify: "Run the wizard tests and search for remaining old-name references",
      context: "PR 1066416 requests getWizardIsMyWorkspace; Save As is independent.",
    });
    expect(result.ok, result.text).toBe(true);
    const run = world.store.listRuns().find((entry) => entry.name === task)!;
    return world.store.listRunSteps(run.id).at(-1)!;
  };

  it("uses the orchestrator login username for managed publication branches", () => {
    world.store.setManagedWorktreesEnabled(true);

    const run = plan("ICM 868148454 targeted fix", {
      workspaceMode: "managed",
    });

    expect(run.workspaceBinding).toMatchObject({
      integrationUsername: "test.operator@example.com",
      integrationTargetRef: "refs/heads/dev/test-operator/icm-868148454-targeted-fix",
    });
  });

  const settle = (step: ReturnType<typeof start>, resumable = false) => {
    world.store.transitionSession(step.sessionId, "starting");
    world.store.transitionSession(step.sessionId, "running");
    world.store.transitionSession(step.sessionId, "idle");
    world.store.updateRunStep(step.id, {
      state: "succeeded",
      output: "Updated the helper; wizard tests passed.",
    });
    if (resumable) {
      world.store.appendEvent({
        eventId: `agent-${step.id}`,
        sessionId: step.sessionId,
        sequence: 1,
        type: "agent_session",
        payload: { agentSessionId: "copilot-review-worker" },
        createdAt: new Date().toISOString(),
      });
      world.store.transitionSession(step.sessionId, "stopped");
    }
  };

  const planSerial = () => {
    const run = world.store.createRun({
      workspaceId: world.store.getSession(world.leadId)!.workspaceId,
      name: "Review comments",
      objective: "Address review feedback",
      policy: { maxParallel: 1 },
    });
    world.store.updateRun(run.id, { leadSessionId: world.leadId, state: "running" });
    return plan();
  };

  it("returns stable task IDs and accepts them after the task is renamed", () => {
    const run = plan();
    expect(tools.listWork().text).toContain(run.id);
    world.store.updateRun(run.id, {
      name: "Wizard review follow-up",
      state: "completed",
    });

    const result = tools.reopenTask({
      task: run.id,
      reason: "The reviewer requested the final helper name.",
    });

    expect(result.ok, result.text).toBe(true);
    expect(world.store.getRun(run.id)?.state).toBe("running");
    expect(world.store.listRuns()).toHaveLength(1);
  });

  it("uses an existing task ID for dispatch instead of opening a task named after the ID", () => {
    const run = plan();
    const result = tools.startWork({
      task: run.id,
      category: "explore",
      title: "Inspect the helper",
      deliverable: "List every caller of the workspace helper",
      scope: "The wizard source tree, without edits",
      verify: "Search for the symbol and quote the matching locations",
    });

    expect(result.ok, result.text).toBe(true);
    expect(world.store.listRuns()).toHaveLength(1);
    expect(world.store.listRunSteps(run.id)).toHaveLength(1);
  });

  it("does not turn a missing task ID into a new task", () => {
    const result = tools.startWork({
      task: "c1780893-d65b-4695-950c-60d84941be56",
      category: "explore",
      title: "Inspect the helper",
      deliverable: "List every caller of the workspace helper",
      scope: "The wizard source tree, without edits",
      verify: "Search for the symbol and quote the matching locations",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("fleet_list_work");
    expect(world.store.listRuns()).toHaveLength(0);
  });

  it("does not interpret a name lookup miss as proof that a conversation was deleted", () => {
    const run = plan();
    world.store.setRunState(run.id, "completed");

    const result = tools.reopenTask({
      task: "Address review comments in PR 1066416",
      reason: "The reviewer requested a more specific helper name.",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("this orchestrator");
    expect(result.text).toContain("fleet_list_work");
    expect(result.text).toContain(run.id);
    expect(result.text).toContain("does not prove");
    expect(world.store.getRun(run.id)?.state).toBe("completed");
  });

  it("rejects ambiguous names and requires an ID instead of picking the first task", () => {
    const first = plan();
    const second = world.store.createRun({
      workspaceId: first.workspaceId,
      name: " review COMMENTS ",
      objective: "A different change with the same display name",
    });
    world.store.updateRun(first.id, { state: "completed" });
    world.store.updateRun(second.id, { leadSessionId: world.leadId, state: "completed" });

    const result = tools.reopenTask({
      task: "Review comments",
      reason: "Continue the helper rename requested by the reviewer.",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("ambiguous");
    expect(result.text).toContain(first.id);
    expect(result.text).toContain(second.id);
    expect(world.store.getRun(first.id)?.state).toBe("completed");
    expect(world.store.getRun(second.id)?.state).toBe("completed");
  });

  it("searches closed tasks and retained worker context without returning unrelated tasks", () => {
    const run = plan();
    const step = start();
    settle(step, true);
    world.store.setRunState(run.id, "completed");
    plan("Save As", { objective: "Fix the unrelated Save As dialog" });

    const result = tools.listWork({ query: "1066416" });

    expect(result.ok).toBe(true);
    expect(result.text).toContain(run.id);
    expect(result.text).toContain(step.sessionId);
    expect(result.text).toContain("session state: stopped");
    expect(result.text).toContain("reopen_task");
    expect(result.text).not.toContain('task: "Save As"');
    expect(result.text).toContain(world.leadId);
  });

  it("keeps discovery and ID-based inspection inside the owning orchestrator", () => {
    const mine = plan();
    const other = world.store.createRun({
      workspaceId: mine.workspaceId,
      name: "Private unrelated task",
      objective: "Another orchestrator's review",
    });
    world.store.updateRun(other.id, {
      leadSessionId: "another-lead",
      state: "completed",
    });

    expect(tools.listWork({ query: "Private" }).text).not.toContain(other.name);
    const read = tools.getTask({ task: other.id });
    expect(read.ok).toBe(false);
    expect(read.text).not.toContain(other.name);
    const reopen = tools.reopenTask({
      task: other.id,
      reason: "Try to resume a task owned by a different orchestrator.",
    });
    expect(reopen.ok).toBe(false);
    expect(world.store.getRun(other.id)?.state).toBe("completed");
  });

  it("provides bounded discovery with explicit pagination", () => {
    plan("First");
    plan("Second");
    plan("Third");

    const first = tools.listWork({ limit: 1 });
    const second = tools.listWork({ limit: 1, offset: 1 });

    expect(first.text).toContain("1-1 of 3");
    expect(first.text).toContain("offset: 1");
    expect(second.text).toContain("2-2 of 3");
    expect(second.text).not.toBe(first.text);
  });

  it("retains the plan objective and workspace for discovery and later dispatch", () => {
    const run = plan("Review comments", { workspace: "Beta" });

    expect(run.objective).toContain("PR 1066416");
    expect(world.store.getWorkspace(run.workspaceId)?.name).toBe("Beta");
    const step = start();
    expect(world.store.getSession(step.sessionId)?.workspaceName).toBe("Beta");
    expect(tools.listWork({ query: "1066416" }).text).toContain(run.id);
  });

  it("updates metadata when planning an existing unphased task", () => {
    const created = world.store.createRun({
      workspaceId: world.store.listWorkspaces()[0]!.id,
      name: "Review comments",
      objective: "Initial request",
    });
    world.store.updateRun(created.id, { leadSessionId: world.leadId, state: "running" });

    const planned = plan("Review comments", { workspace: "Beta" });

    expect(planned.id).toBe(created.id);
    expect(planned.objective).toContain("PR 1066416");
    expect(world.store.getWorkspace(planned.workspaceId)?.name).toBe("Beta");
  });

  it("does not rewrite an unphased task while a human is reviewing it", () => {
    const run = plan();
    world.store.updateRun(run.id, { phases: [], state: "awaiting_human" });

    const result = tools.planTask({
      task: run.id,
      objective: "Replace the objective without reopening",
      phases: ["Different phase"],
      successCriteria: run.successCriteria,
      stopWhen: "The replacement objective is satisfied",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("fleet_reopen_task");
    expect(world.store.getRun(run.id)).toMatchObject({
      objective: run.objective,
      phases: [],
      state: "awaiting_human",
    });
  });

  it("does not create a task when its requested workspace is unknown", () => {
    const result = tools.planTask({
      task: "Unknown workspace",
      objective: "Review a change in an unregistered workspace",
      phases: ["Inspect"],
      successCriteria: [
        RunCriterionSchema.parse({
          id: "inspection",
          scenario: "The inspection identifies every caller",
          expectedEvidence: "A list of matching source locations",
        }),
      ],
      stopWhen: "The requested inspection is complete",
      workspace: "Not configured",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("fleet_list_nodes");
    expect(world.store.listRuns()).toHaveLength(0);
  });

  it("exposes task criteria, notes, worker output and original checkout before a reuse decision", () => {
    const run = plan();
    const step = start();
    settle(step);
    world.store.appendRunNote(run.id, 0, "Keep the Save As work independent.");

    const result = tools.getTask({ task: run.id });

    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("getWizardIsMyWorkspace");
    expect(result.text).toContain("Keep the Save As work independent.");
    expect(result.text).toContain("wizard tests passed");
    expect(result.text).toContain(step.sessionId);
    expect(result.text).toContain("/src/alpha");
    expect(result.text).toContain("follow_up");
    expect(result.text).toContain("session state: idle");
  });

  it("refuses a follow-up while the task is held for review, even if the session is idle", () => {
    const run = plan();
    const step = start();
    settle(step);
    world.store.updateRunStep(step.id, { state: "running" });
    world.store.setRunState(run.id, "awaiting_human");
    const dispatch = vi.spyOn(world.service, "dispatch");

    const result = tools.followUp({ sessionId: step.sessionId, prompt: "Rename it." });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("fleet_reopen_task");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not resend an accepted follow-up outside the scheduler while parallel capacity is full", () => {
    const run = planSerial();
    const worker = start();
    settle(worker);
    start();
    const input = { sessionId: worker.sessionId, prompt: "Rename the helper." };
    const publish = vi.spyOn(world.service, "publishRunSteps");
    expect(tools.followUp(input).ok).toBe(true);
    expect(world.store.getRunStep(worker.id)?.state).toBe("pending");
    expect(publish).toHaveBeenCalledWith(
      run.id,
      expect.arrayContaining([
        expect.objectContaining({ id: worker.id, state: "pending", attempts: 2 }),
      ]),
    );
    expect(tools.getTask({ task: run.id }).text).toContain(input.prompt);
    const dispatch = vi.spyOn(world.service, "dispatch");

    const repeated = tools.followUp(input);

    expect(repeated.ok, repeated.text).toBe(true);
    expect(repeated.text).toContain("already queued");
    expect(dispatch).not.toHaveBeenCalled();
    expect(world.store.getRunStep(worker.id)).toMatchObject({
      state: "pending",
      attempts: 2,
      prompt: input.prompt,
    });
  });

  it("does not overwrite or send a different prompt while a follow-up is already queued", () => {
    planSerial();
    const worker = start();
    settle(worker);
    start();
    expect(
      tools.followUp({ sessionId: worker.sessionId, prompt: "Rename the helper." }).ok,
    ).toBe(true);
    const dispatch = vi.spyOn(world.service, "dispatch");

    const result = tools.followUp({
      sessionId: worker.sessionId,
      prompt: "Change unrelated Save As behavior.",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("already queued");
    expect(dispatch).not.toHaveBeenCalled();
    expect(world.store.getRunStep(worker.id)?.prompt).toBe("Rename the helper.");
  });

  it("reports a persisted new-worker queue as accepted rather than a failed dispatch", () => {
    const run = plan();
    vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
    const publish = vi.spyOn(world.service, "publishRunSteps");

    const result = tools.startWork({
      task: run.id,
      category: "explore",
      title: "Inspect the helper",
      deliverable: "List the helper and all of its callers",
      scope: "The wizard source tree, without edits",
      verify: "Search for the symbol and quote the matching locations",
    });

    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("Queued");
    expect(result.text).toContain("Do not dispatch it again");
    expect(world.store.listRunSteps(run.id)).toHaveLength(1);
    expect(publish).toHaveBeenCalledWith(
      run.id,
      expect.arrayContaining([expect.objectContaining({ state: "pending" })]),
    );
  });

  it("does not prompt a worker whose Stop is still being acknowledged", () => {
    plan();
    const worker = start();
    settle(worker);
    world.store.setSessionControls(worker.sessionId, { stopRequested: true });
    const dispatch = vi.spyOn(world.service, "dispatch");

    const result = tools.followUp({
      sessionId: worker.sessionId,
      prompt: "Continue once stopping has finished.",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("stopping");
    expect(result.text).not.toContain("Start replacement");
    expect(dispatch).not.toHaveBeenCalled();
    expect(world.store.getRunStep(worker.id)?.attempts).toBe(1);
  });

  it("treats an offline worker without an agent ID as unknown, not irrecoverable", () => {
    plan();
    const worker = start();
    settle(worker);
    world.store.transitionSession(worker.sessionId, "offline");

    const result = tools.followUp({ sessionId: worker.sessionId, prompt: "Continue." });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("reconnect");
    expect(result.text).not.toContain("Start replacement");
    expect(world.store.getRunStep(worker.id)?.attempts).toBe(1);
  });

  it("distinguishes a non-resumable terminal worker from a temporary wait", () => {
    plan();
    const worker = start();
    settle(worker);
    world.store.transitionSession(worker.sessionId, "stopped");

    const result = tools.followUp({ sessionId: worker.sessionId, prompt: "Continue." });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("no resumable");
    expect(result.text).toContain("fleet_start_work");
    expect(tools.listWork().text).toContain("replace_worker");
    expect(world.store.getRunStep(worker.id)?.attempts).toBe(1);
  });
});
