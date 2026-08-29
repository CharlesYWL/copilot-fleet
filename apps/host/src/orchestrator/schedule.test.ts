import { describe, expect, it } from "vitest";
import type { FleetNode, FleetSession, Placement, Run, RunStep } from "@fleet/protocol";
import { RunPolicySchema } from "@fleet/protocol";
import {
  decidePlacement,
  planNextActions,
  remainingCapacity,
  type PlacementRequest,
  type ScheduleInput,
} from "./schedule.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

function node(id: string, overrides: Partial<FleetNode> = {}): FleetNode {
  return {
    id,
    name: id,
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    revision: "",
    capabilities: ["copilot-acp", "host-yolo"],
    agents: [],
    maxSessions: 4,
    activeSessions: 0,
    lastHeartbeat: iso(),
    online: true,
    homeDir: "",
    authProtocol: "legacy-secret",
    ...overrides,
  };
}

function placement(id: string, nodeId: string): Placement {
  return {
    id,
    workspaceId: "w1",
    workspaceName: "repo",
    nodeId,
    nodeName: nodeId,
    localPath: `/src/${nodeId}`,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1",
    workspaceId: "w1",
    name: "run",
    objective: "do the thing",
    state: "running",
    leadSessionId: "",
    placementId: "",
    policy: RunPolicySchema.parse({}),
    phases: [],
    phaseIndex: 0,
    successCriteria: [],
    stopWhen: "",
    failureReason: "",
    pendingPrompt: "",
    settleSeq: 0,
    wakeSeq: 0,
    emptyWakeCount: 0,
    createdAt: iso(),
    updatedAt: iso(),
    ...overrides,
  };
}

function step(id: string, overrides: Partial<RunStep> = {}): RunStep {
  return {
    id,
    runId: "r1",
    stepKey: id,
    title: id,
    prompt: `do ${id}`,
    category: "implement",
    phaseIndex: 0,
    dependsOn: [],
    state: "pending",
    sessionId: "",
    placementId: "",
    output: "",
    eventSeqFrom: 0,
    attempts: 1,
    dispatchedAt: "",
    position: 0,
    createdAt: iso(),
    updatedAt: iso(),
    ...overrides,
  };
}

function session(id: string, overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    id,
    workspaceId: "w1",
    workspaceName: "repo",
    placementId: "p1",
    nodeId: "n1",
    nodeName: "n1",
    state: "running",
    name: "",
    initialPrompt: "go",
    currentActivity: "",
    lastText: "",
    createdAt: iso(),
    updatedAt: iso(),
    agentSessionId: "",
    yolo: true,
    commands: [],
    configOptions: [],
    runId: "r1",
    runRole: "worker",
    readOnly: false,
    ...overrides,
  };
}

function world(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    run: run(),
    steps: [],
    sessions: [],
    nodes: [node("n1"), node("n2")],
    placements: [placement("p1", "n1"), placement("p2", "n2")],
    turnCompleteSessionIds: new Set<string>(),
    stepOutputs: new Map<string, string>(),
    nowMs: NOW,
    ...overrides,
  };
}

const types = (input: ScheduleInput) => planNextActions(input).map((a) => a.type);

describe("planNextActions", () => {
  it("does nothing while every node is offline, because offline means unknown", () => {
    const actions = planNextActions(
      world({
        steps: [step("s1", { state: "running", sessionId: "sess1", placementId: "p1" })],
        sessions: [session("sess1", { state: "offline" })],
        nodes: [node("n1", { online: false }), node("n2", { online: false })],
        turnCompleteSessionIds: new Set(["sess1"]),
      }),
    );
    expect(actions).toEqual([]);
  });

  it("will not call a step done before the turn completed", () => {
    const actions = planNextActions(
      world({
        steps: [step("s1", { state: "running", sessionId: "sess1", placementId: "p1" })],
        sessions: [session("sess1", { state: "running" })],
      }),
    );
    expect(actions.some((a) => a.type === "settle_step")).toBe(false);
  });

  it("ignores a late turn_complete for a step that already settled", () => {
    const actions = planNextActions(
      world({
        run: run({ policy: RunPolicySchema.parse({ wakePolicy: "none" }) }),
        steps: [step("s1", { state: "succeeded", sessionId: "sess1" })],
        sessions: [session("sess1", { state: "idle" })],
        turnCompleteSessionIds: new Set(["sess1"]),
      }),
    );
    expect(actions.some((a) => a.type === "settle_step")).toBe(false);
  });

  it("does not treat a resumed idle session as proof its retry prompt ran", () => {
    const retry = step("s1", {
      state: "starting",
      sessionId: "sess1",
      placementId: "p1",
      attempts: 2,
    });
    const idle = world({
      steps: [retry],
      sessions: [session("sess1", { state: "idle" })],
      turnCompleteSessionIds: new Set(["sess1"]),
    });
    expect(types(idle)).not.toContain("advance_step");
    expect(types(idle)).not.toContain("settle_step");

    const running = world({
      steps: [retry],
      sessions: [session("sess1", { state: "running" })],
    });
    expect(types(running)).toContain("advance_step");
  });

  it("queues an idle follow-up until the task has parallel capacity", () => {
    const actions = planNextActions(
      world({
        run: run({ policy: RunPolicySchema.parse({ maxParallel: 1 }) }),
        steps: [
          step("busy", {
            state: "running",
            sessionId: "busy-session",
            placementId: "p2",
          }),
          step("retry", {
            state: "pending",
            sessionId: "idle-session",
            placementId: "p1",
            attempts: 2,
          }),
        ],
        sessions: [
          session("busy-session", { state: "running", placementId: "p2" }),
          session("idle-session", { state: "idle", placementId: "p1" }),
        ],
      }),
    );

    expect(actions.map((action) => action.type)).not.toContain("prompt_step");
  });

  it("settles a retry whose resume attempt ended instead of resuming forever", () => {
    const actions = planNextActions(
      world({
        steps: [
          step("retry", {
            state: "pending",
            sessionId: "sess1",
            placementId: "p1",
            attempts: 2,
            dispatchedAt: "2026-08-25T10:00:00.000Z",
          }),
        ],
        sessions: [
          session("sess1", {
            state: "failed",
            currentActivity: "session/load failed",
          }),
        ],
      }),
    );

    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "settle_step",
        stepId: expect.any(String),
        state: "failed",
        output: "session/load failed",
      }),
    );
    expect(actions.map((action) => action.type)).not.toContain("resume_step");
  });

  it("does not resume a retry beside a writer started earlier in the same pass", () => {
    const actions = planNextActions(
      world({
        run: run({ placementId: "p1" }),
        steps: [
          step("fresh", { category: "implement" }),
          step("retry", {
            category: "implement",
            sessionId: "sess1",
            placementId: "p1",
            attempts: 2,
          }),
        ],
        sessions: [session("sess1", { state: "stopped" })],
      }),
    );

    expect(actions.map((action) => action.type)).toContain("start_step");
    expect(actions.map((action) => action.type)).not.toContain("resume_step");
  });

  it("keeps a slot of headroom so a node is never filled to its limit", () => {
    const full = world({
      steps: [step("s1")],
      sessions: [
        session("a", { nodeId: "n1" }),
        session("b", { nodeId: "n1" }),
        session("c", { nodeId: "n1" }),
        session("d", { nodeId: "n2" }),
        session("e", { nodeId: "n2" }),
        session("f", { nodeId: "n2" }),
      ],
    });
    // 4 max, 3 reserved: the last slot is held back as headroom.
    expect(types(full)).not.toContain("start_step");
    expect(remainingCapacity(node("n1"), 3)).toBe(0);
    expect(remainingCapacity(node("n1"), 2)).toBe(1);
    // A single-slot node must still be usable, or a test fleet can run nothing.
    expect(remainingCapacity(node("n1", { maxSessions: 1 }), 0)).toBe(1);
  });

  it("runs one writing step per placement but lets a reviewer share the checkout", () => {
    const busy = world({
      run: run({ placementId: "p1" }),
      steps: [
        step("impl", {
          state: "running",
          category: "implement",
          sessionId: "sess1",
          placementId: "p1",
        }),
        step("test", { category: "test" }),
      ],
      sessions: [session("sess1")],
    });
    expect(types(busy)).not.toContain("start_step");

    const review = world({
      run: run({ placementId: "p1" }),
      steps: [
        step("impl", {
          state: "running",
          category: "implement",
          sessionId: "sess1",
          placementId: "p1",
        }),
        step("review", { category: "review-quick" }),
      ],
      sessions: [session("sess1")],
    });
    const started = planNextActions(review).filter((a) => a.type === "start_step");
    expect(started).toHaveLength(1);
    // A reviewer that cannot see the implementation's checkout cannot review it.
    expect(started[0]).toMatchObject({ placementId: "p1" });
  });

  it("does not start a writer beside another task's writer on the checkout", () => {
    const actions = planNextActions(
      world({
        run: run({ placementId: "p1" }),
        steps: [step("next", { category: "implement" })],
        sessions: [
          session("other-writer", {
            placementId: "p1",
            state: "running",
            readOnly: false,
            runId: "another-run",
          }),
        ],
      }),
    );

    expect(actions.map((action) => action.type)).not.toContain("start_step");
  });

  it("keeps a worker open when its step settles", () => {
    const actions = planNextActions(
      world({
        steps: [step("s1", { state: "running", sessionId: "sess1", placementId: "p1" })],
        sessions: [session("sess1", { state: "idle" })],
        turnCompleteSessionIds: new Set(["sess1"]),
      }),
    );

    expect(actions).toContainEqual(
      expect.objectContaining({ type: "settle_step", state: "succeeded" }),
    );
    expect(actions.map((action) => action.type)).not.toContain("stop_session");
  });

  it("keeps an already-settled worker open for a later revisit", () => {
    const actions = planNextActions(
      world({
        // A long-lived orchestrator: its run never finishes, so the cleanup
        // that runs when one does would never reach this worker.
        run: run({ policy: RunPolicySchema.parse({ wakePolicy: "on_any_settle" }) }),
        steps: [
          step("s1", { state: "succeeded", sessionId: "sess1", placementId: "p1" }),
        ],
        sessions: [session("sess1", { state: "idle" })],
      }),
    );

    expect(actions.map((action) => action.type)).not.toContain("stop_session");
  });

  it("leaves an offline worker alone, because offline is unknown", () => {
    const actions = planNextActions(
      world({
        run: run({ policy: RunPolicySchema.parse({ wakePolicy: "on_any_settle" }) }),
        steps: [
          step("s1", { state: "succeeded", sessionId: "sess1", placementId: "p1" }),
        ],
        sessions: [session("sess1", { state: "offline" })],
      }),
    );

    expect(actions.map((action) => action.type)).not.toContain("stop_session");
  });

  it("does not re-stop a worker that already ended by itself", () => {
    const actions = planNextActions(
      world({
        steps: [step("s1", { state: "running", sessionId: "sess1", placementId: "p1" })],
        sessions: [session("sess1", { state: "failed" })],
      }),
    );

    expect(actions).toContainEqual(
      expect.objectContaining({ type: "settle_step", state: "failed" }),
    );
    expect(actions.map((action) => action.type)).not.toContain("stop_session");
  });

  it("sends unrelated work to a workspace the orchestrator named, pin or not", () => {
    /*
     * A pin says where this run's *changes* are. Read as a constraint on
     * everything it froze the orchestrator onto the first checkout it touched,
     * so a workspace added later could never be dispatched to at all. The tool
     * resolves the named workspace and records it on the step.
     */
    const actions = planNextActions(
      world({
        run: run({ placementId: "p1" }),
        steps: [step("look", { category: "explore", placementId: "p2" })],
        placements: [
          placement("p1", "n1"),
          { ...placement("p2", "n2"), workspaceId: "w2", workspaceName: "other-repo" },
        ],
      }),
    );

    expect(actions).toContainEqual(
      expect.objectContaining({ type: "start_step", placementId: "p2" }),
    );
  });

  it("keeps unnamed follow-on work on the checkout holding the changes", () => {
    const actions = planNextActions(
      world({
        run: run({ placementId: "p1" }),
        steps: [step("more", { category: "implement" })],
      }),
    );

    // p2 is free and in the same workspace, but it does not have the changes.
    expect(actions).toContainEqual(
      expect.objectContaining({ type: "start_step", placementId: "p1" }),
    );
  });

  it("ignores a pin that no writing step ever earned", () => {
    /*
     * A read-only step used to set the pin, and that stale value then
     * constrained every later step — an orchestrator frozen onto the first
     * checkout it happened to look at, refused even when another machine held
     * the same workspace and was free. The pin is a claim about where this
     * run's changes are, so a run that has changed nothing has no such claim.
     */
    const actions = planNextActions(
      world({
        run: run({ placementId: "p1" }),
        steps: [step("look", { category: "explore" })],
        // n1, which the stale pin names, has no room *for reading* — writing
        // sessions would not stand in a reader's way, and filling it with those
        // would prove nothing about the pin. n2 holds the same workspace.
        sessions: [
          session("a", { nodeId: "n1", readOnly: true }),
          session("b", { nodeId: "n1", readOnly: true }),
          session("c", { nodeId: "n1", readOnly: true }),
        ],
      }),
    );

    expect(actions).toContainEqual(
      expect.objectContaining({ type: "start_step", placementId: "p2" }),
    );
  });

  it("keeps honouring a pin once something has written to it", () => {
    const actions = planNextActions(
      world({
        run: run({ placementId: "p1" }),
        steps: [
          step("built", { category: "implement", state: "succeeded" }),
          step("check", { category: "review-quick" }),
        ],
      }),
    );

    // p2 is free and in the same workspace, but it has no diff to review.
    expect(actions).toContainEqual(
      expect.objectContaining({ type: "start_step", placementId: "p1" }),
    );
  });

  it("does nothing new while a person holds the task and keeps its workers", () => {
    /*
     * A task handed over is waiting on a person, not on the fleet: dispatching
     * or waking would be the engine talking over the review it asked for. What
     * already happened is still recorded, and the finished worker remains open
     * in case the person sends the task back.
     */
    const actions = planNextActions(
      world({
        run: run({ state: "awaiting_human", settleSeq: 1, wakeSeq: 0 }),
        steps: [
          step("done", { state: "succeeded", sessionId: "sess1", placementId: "p1" }),
          step("queued", { category: "explore" }),
        ],
        sessions: [
          session("sess1", { state: "idle" }),
          session("lead", { state: "idle", runRole: "lead" }),
        ],
      }),
    );

    const types = actions.map((action) => action.type);
    expect(types).not.toContain("stop_session");
    expect(types).not.toContain("start_step");
    expect(types).not.toContain("wake_lead");
  });

  it("wakes the Lead exactly once for two settles it has not seen", () => {
    const input = world({
      run: run({
        state: "awaiting_lead",
        leadSessionId: "lead",
        settleSeq: 2,
        wakeSeq: 0,
        policy: RunPolicySchema.parse({ wakePolicy: "on_any_settle" }),
      }),
      steps: [step("s1", { state: "succeeded" }), step("s2", { state: "succeeded" })],
      sessions: [session("lead", { state: "idle", runRole: "lead" })],
    });
    expect(types(input).filter((t) => t === "wake_lead")).toHaveLength(1);
  });

  it("does not wake a Lead that is mid-turn", () => {
    const input = world({
      run: run({
        state: "awaiting_lead",
        leadSessionId: "lead",
        settleSeq: 1,
        policy: RunPolicySchema.parse({ wakePolicy: "on_any_settle" }),
      }),
      steps: [step("s1", { state: "succeeded" })],
      sessions: [session("lead", { state: "running", runRole: "lead" })],
    });
    expect(types(input)).not.toContain("wake_lead");
  });

  it("holds a message for a Lead that is mid-turn rather than losing it", () => {
    /*
     * The Node refuses a prompt during a turn and reports it only as a
     * transcript notice, so a sender learns nothing. Holding the message means
     * a brief or a send-back written while the orchestrator was busy is still
     * delivered — the alternative was a task nobody had been told about.
     */
    const input = world({
      run: run({ leadSessionId: "lead", pendingPrompt: "a new task for you" }),
      sessions: [session("lead", { state: "running", runRole: "lead" })],
    });
    expect(types(input)).not.toContain("deliver_prompt");
  });

  it("hands a held message over as soon as the Lead is free", () => {
    const input = world({
      run: run({ leadSessionId: "lead", pendingPrompt: "a new task for you" }),
      sessions: [session("lead", { state: "idle", runRole: "lead" })],
    });
    expect(planNextActions(input)).toContainEqual({
      type: "deliver_prompt",
      runId: "r1",
      prompt: "a new task for you",
    });
  });

  it("delivers a held message before a wake, not alongside it", () => {
    // Both are prompts and Copilot takes one turn at a time. The wake stays
    // owed in settleSeq, so waiting a tick costs nothing.
    const input = world({
      run: run({
        state: "awaiting_lead",
        leadSessionId: "lead",
        pendingPrompt: "read this first",
        settleSeq: 1,
        wakeSeq: 0,
        policy: RunPolicySchema.parse({ wakePolicy: "on_any_settle" }),
      }),
      steps: [step("s1", { state: "succeeded" })],
      sessions: [session("lead", { state: "idle", runRole: "lead" })],
    });
    const result = types(input);
    expect(result).toContain("deliver_prompt");
    expect(result).not.toContain("wake_lead");
  });

  it("still delivers a held message on a run that never wakes on settles", () => {
    // A held message is owed regardless of how the run wakes, so it must be
    // decided before the wake policy short-circuits the rest of the plan.
    const input = world({
      run: run({
        leadSessionId: "lead",
        pendingPrompt: "read this",
        policy: RunPolicySchema.parse({ wakePolicy: "none" }),
      }),
      sessions: [session("lead", { state: "idle", runRole: "lead" })],
    });
    expect(types(input)).toContain("deliver_prompt");
  });

  it("finishes a handwritten plan and keeps its sessions open", () => {
    const input = world({
      run: run({ policy: RunPolicySchema.parse({ wakePolicy: "none" }) }),
      steps: [step("s1", { state: "succeeded", sessionId: "sess1" })],
      sessions: [session("sess1", { state: "idle" })],
    });
    const actions = planNextActions(input);
    expect(actions.some((a) => a.type === "wake_lead")).toBe(false);
    expect(actions.map((action) => action.type)).not.toContain("stop_session");
    expect(actions).toContainEqual(
      expect.objectContaining({ type: "finish_run", state: "completed" }),
    );
  });

  it("skips a step whose dependency failed when the run continues past failures", () => {
    const input = world({
      run: run({
        policy: RunPolicySchema.parse({ wakePolicy: "none", onStepFailure: "continue" }),
      }),
      steps: [step("audit", { state: "failed" }), step("fix", { dependsOn: ["audit"] })],
    });
    expect(types(input)).toContain("skip_step");
  });

  it("dispatches with the step's own prompt and sends nothing else", () => {
    const actions = planNextActions(world({ steps: [step("s1")] }));
    expect(actions.find((a) => a.type === "start_step")).toMatchObject({
      prompt: "do s1",
    });
    expect(actions.filter((a) => a.type === "start_step")).toHaveLength(1);
  });

  it("settles a completed turn with the collected output, not the session preview", () => {
    const input = world({
      run: run({ policy: RunPolicySchema.parse({ wakePolicy: "none" }) }),
      steps: [step("s1", { state: "running", sessionId: "sess1", placementId: "p1" })],
      sessions: [session("sess1", { state: "idle", lastText: "truncated preview" })],
      turnCompleteSessionIds: new Set(["sess1"]),
      stepOutputs: new Map([["s1", "the full collected output"]]),
    });
    expect(planNextActions(input)).toContainEqual(
      expect.objectContaining({
        type: "settle_step",
        stepId: "s1",
        state: "succeeded",
        output: "the full collected output",
      }),
    );
  });

  it("reuses a pinned placement instead of shopping for a roomier node", () => {
    const input = world({
      run: run({ placementId: "p1" }),
      steps: [step("s1")],
      // n1 is nearly full and n2 is empty, but the run is already pinned to n1.
      sessions: [
        session("a", { nodeId: "n1", placementId: "another-checkout-a" }),
        session("b", { nodeId: "n1", placementId: "another-checkout-b" }),
      ],
    });
    expect(planNextActions(input).find((a) => a.type === "start_step")).toMatchObject({
      placementId: "p1",
    });
  });

  it("fails a dispatch the node never acknowledged, but only if the node is up", () => {
    const late = step("s1", {
      state: "starting",
      placementId: "p1",
      dispatchedAt: iso(-200_000),
    });
    const online = world({
      run: run({ policy: RunPolicySchema.parse({ wakePolicy: "none" }) }),
      steps: [late],
    });
    expect(planNextActions(online)).toContainEqual(
      expect.objectContaining({ type: "settle_step", stepId: "s1", state: "failed" }),
    );

    const offline = world({
      steps: [late],
      nodes: [node("n1", { online: false }), node("n2")],
    });
    expect(planNextActions(offline).some((a) => a.type === "settle_step")).toBe(false);
  });
});

describe("capacity by kind", () => {
  it("does not queue research behind implementation", () => {
    /*
     * The complaint this fixes: an orchestrator asked to look something up was
     * told there were no free slots, because a machine busy changing code had
     * spent the only budget there was. Reading and writing are limited by
     * different things, so they are counted separately.
     */
    const actions = planNextActions(
      world({
        steps: [step("look", { category: "explore" })],
        sessions: [
          session("a", { nodeId: "n1" }),
          session("b", { nodeId: "n1" }),
          session("c", { nodeId: "n1" }),
          session("d", { nodeId: "n2" }),
          session("e", { nodeId: "n2" }),
          session("f", { nodeId: "n2" }),
        ],
      }),
    );

    expect(actions.map((action) => action.type)).toContain("start_step");
  });

  it("still refuses a change when the writing budget is spent", () => {
    const actions = planNextActions(
      world({
        steps: [step("build", { category: "implement" })],
        sessions: [
          session("a", { nodeId: "n1" }),
          session("b", { nodeId: "n1" }),
          session("c", { nodeId: "n1" }),
          session("d", { nodeId: "n2" }),
          session("e", { nodeId: "n2" }),
          session("f", { nodeId: "n2" }),
        ],
      }),
    );

    expect(actions.map((action) => action.type)).not.toContain("start_step");
  });

  it("bounds reading too, so a look is not free", () => {
    // An explore is a real process. "Reads do not queue behind writes" must not
    // become "a machine will take any number of reads".
    const actions = planNextActions(
      world({
        steps: [step("look", { category: "explore" })],
        sessions: [
          session("a", { nodeId: "n1", readOnly: true }),
          session("b", { nodeId: "n1", readOnly: true }),
          session("c", { nodeId: "n1", readOnly: true }),
          session("d", { nodeId: "n2", readOnly: true }),
          session("e", { nodeId: "n2", readOnly: true }),
          session("f", { nodeId: "n2", readOnly: true }),
        ],
      }),
    );

    expect(actions.map((action) => action.type)).not.toContain("start_step");
  });
});

describe("naming a machine", () => {
  const NODES = { n1: "WEILI-MS-SP", n2: "CHARLES-DESK" } as const;

  /** Placements carry the node's name; the store joins it, so a fixture must too. */
  const on = (
    id: string,
    nodeId: keyof typeof NODES,
    extra: Partial<Placement> = {},
  ) => ({
    ...placement(id, nodeId),
    nodeName: NODES[nodeId],
    ...extra,
  });

  const ask = (overrides: Partial<PlacementRequest> = {}) =>
    decidePlacement({
      run: run(),
      category: "implement",
      hasWritingStep: false,
      placements: [on("p1", "n1"), on("p2", "n2")],
      nodeById: new Map([
        ["n1", node("n1", { name: NODES.n1 })],
        ["n2", node("n2", { name: NODES.n2 })],
      ]),
      reservedFor: () => 0,
      writingInFlight: new Set<string>(),
      ...overrides,
    });

  it("sends the step to the machine that was named, not the roomiest one", () => {
    // p1 would win on capacity alone, since both are empty and it is first.
    expect(ask({ node: "CHARLES-DESK" })).toMatchObject({ id: "p2" });
  });

  it("takes a prefix, because the orchestrator retypes what it read", () => {
    expect(ask({ node: "weili" })).toMatchObject({ id: "p1" });
  });

  it("refuses a name that fits two machines rather than picking one", () => {
    const answer = ask({
      node: "node",
      nodeById: new Map([
        ["n1", node("n1", { name: "node-a" })],
        ["n2", node("n2", { name: "node-b" })],
      ]),
    });

    expect(answer).toBe(
      '"node" matches 2 nodes: node-a, node-b. Name one of them exactly.',
    );
  });

  it("says which machines exist when the name matches none", () => {
    expect(ask({ node: "laptop" })).toContain("fleet_list_nodes");
  });

  it("blames the machine that was named, not the fleet, when it is full", () => {
    /*
     * "Every node with that checkout is full" is true and useless here: the
     * orchestrator named one machine, and reading that as fleet-wide saturation
     * is how it gives up on work another machine would have taken.
     */
    const answer = ask({ node: "WEILI-MS-SP", reservedFor: () => 99 });

    expect(answer).toContain("WEILI-MS-SP has no free slot");
    expect(answer).toContain("omit `node`");
  });

  it("says the machine is offline rather than that nothing has the checkout", () => {
    const answer = ask({
      node: "WEILI-MS-SP",
      nodeById: new Map([
        ["n1", node("n1", { name: NODES.n1, online: false })],
        ["n2", node("n2", { name: NODES.n2 })],
      ]),
    });

    expect(answer).toContain("WEILI-MS-SP is offline");
  });

  it("says so when the named machine has no copy of the repository", () => {
    const answer = ask({
      node: "CHARLES-DESK",
      placements: [on("p1", "n1")],
    });

    expect(answer).toContain("CHARLES-DESK has no checkout");
  });

  it("will not move a review away from the changes it has to see", () => {
    /*
     * Where this run's changes are is a fact, not a preference. Honouring the
     * request would send the reviewer to a tree with none of the work in it,
     * and it would approve what it could not find anything wrong with.
     */
    const answer = ask({
      run: run({ placementId: "p1" }),
      hasWritingStep: true,
      category: "review-deep",
      node: "CHARLES-DESK",
    });

    expect(answer).toContain("holds the changes to review");
    expect(answer).toContain("Send it to WEILI-MS-SP");
  });

  it("still lets a named machine take work that is genuinely unrelated", () => {
    // A named workspace is how the orchestrator says "this is different work",
    // and that releases the pin the same way it does without a named machine.
    const answer = ask({
      run: run({ placementId: "p1" }),
      hasWritingStep: true,
      workspace: "other-repo",
      node: "CHARLES-DESK",
      placements: [
        on("p1", "n1"),
        on("p2", "n2", { workspaceId: "w2", workspaceName: "other-repo" }),
      ],
    });

    expect(answer).toMatchObject({ id: "p2" });
  });

  it("leaves the Host's own choice alone when no machine is named", () => {
    expect(ask()).toMatchObject({ id: "p1" });
  });
});
