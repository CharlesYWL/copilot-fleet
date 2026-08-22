import { describe, expect, it } from "vitest";
import {
  RunPolicySchema,
  type FleetSession,
  type Run,
  type RunStep,
} from "@fleet/protocol";
import {
  awaitingPlan,
  buildRunViewModels,
  currentPhase,
  runStateLabel,
  stageOf,
  summarise,
} from "./orchestration-view";

const ISO = "2026-01-01T12:00:00.000Z";
const later = (minutes: number) =>
  new Date(Date.parse(ISO) + minutes * 60_000).toISOString();

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1",
    workspaceId: "w1",
    name: "Ship it",
    objective: "make the change",
    state: "running",
    leadSessionId: "lead",
    placementId: "",
    policy: RunPolicySchema.parse({}),
    phases: [],
    phaseIndex: 0,
    failureReason: "",
    pendingPrompt: "",
    settleSeq: 0,
    wakeSeq: 0,
    emptyWakeCount: 0,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function step(id: string, overrides: Partial<RunStep> = {}): RunStep {
  return {
    id,
    runId: "r1",
    stepKey: id,
    title: id,
    prompt: "do it",
    category: "implement",
    dependsOn: [],
    state: "pending",
    sessionId: "",
    placementId: "",
    output: "",
    eventSeqFrom: 0,
    attempts: 1,
    phaseIndex: 0,
    dispatchedAt: "",
    position: 0,
    createdAt: ISO,
    updatedAt: ISO,
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
    nodeName: "box",
    state: "running",
    name: "",
    initialPrompt: "go",
    currentActivity: "",
    lastText: "",
    createdAt: ISO,
    updatedAt: ISO,
    agentSessionId: "",
    yolo: false,
    commands: [],
    configOptions: [],
    runId: "r1",
    runRole: "worker",
    readOnly: false,
    ...overrides,
  };
}

const permission = (sessionId: string) =>
  ({
    eventId: `${sessionId}-perm`,
    sessionId,
    sequence: 1,
    type: "permission_request",
    payload: {},
    createdAt: ISO,
  }) as unknown as Parameters<
    typeof buildRunViewModels
  >[0]["waitingPermissions"] extends readonly (infer T)[]
    ? T
    : never;

const build = (input: Parameters<typeof buildRunViewModels>[0]) =>
  buildRunViewModels(input);

describe("stageOf", () => {
  it("calls a task with work in flight implementation, whatever the run row says", () => {
    // The steps are what is actually happening; the run row lags behind them.
    expect(
      stageOf(run({ state: "awaiting_lead" }), [step("a", { state: "running" })]),
    ).toBe("implementation");
  });

  it("puts a task the orchestrator handed over into validation", () => {
    expect(stageOf(run({ state: "awaiting_human" }), [])).toBe("validation");
  });

  it("puts a decided task in validation and an empty one back in planning", () => {
    expect(
      stageOf(run({ state: "awaiting_lead" }), [step("a", { state: "succeeded" })]),
    ).toBe("validation");
    expect(stageOf(run({ state: "awaiting_lead" }), [])).toBe("planning");
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "puts a %s task in delivery",
    (state) => {
      expect(stageOf(run({ state }), [step("a", { state: "running" })])).toBe("delivery");
    },
  );

  it("starts an unapproved task in planning", () => {
    expect(stageOf(run({ state: "awaiting_approval" }), [])).toBe("planning");
    expect(stageOf(run({ state: "planning" }), [])).toBe("planning");
  });
});

describe("buildRunViewModels", () => {
  it("finds attention through the session a permission belongs to", () => {
    /*
     * A permission is an event on a session, and the run it belongs to is
     * `running` — which is what a healthy run looks like. Reading attention
     * from run state alone would never see it.
     */
    const [model] = build({
      runs: [run()],
      stepsByRun: { r1: [step("a", { state: "running", sessionId: "s1" })] },
      sessions: [session("s1")],
      waitingPermissions: [permission("s1")],
    });

    expect(model?.attention).toBe("permission");
    expect(model?.attentionSessionId).toBe("s1");
  });

  it("treats a task handed to a person as needing one", () => {
    const [model] = build({
      runs: [run({ state: "awaiting_human" })],
      stepsByRun: {},
      sessions: [],
    });

    expect(model?.attention).toBe("permission");
  });

  it("tells a failure apart from a permission", () => {
    // Both need a person, but only one of them is blocking an agent right now.
    const [model] = build({
      runs: [run()],
      stepsByRun: { r1: [step("a", { state: "failed" })] },
      sessions: [],
    });

    expect(model?.attention).toBe("failed-step");
  });

  it("notices a step whose node went away", () => {
    const [model] = build({
      runs: [run()],
      stepsByRun: { r1: [step("a", { state: "running", sessionId: "s1" })] },
      sessions: [session("s1", { state: "offline" })],
    });

    expect(model?.attention).toBe("offline-node");
  });

  it("ignores an offline session whose step already settled", () => {
    const [model] = build({
      runs: [run()],
      stepsByRun: { r1: [step("a", { state: "succeeded", sessionId: "s1" })] },
      sessions: [session("s1", { state: "offline" })],
    });

    expect(model?.attention).toBeUndefined();
  });

  it.each(["cancelled", "completed", "failed"] as const)(
    "asks nothing of anyone once the task is %s",
    (state) => {
      /*
       * Abandoning cancels every step still in flight, so reading attention
       * from the steps alone made every abandoned task claim a failure forever
       * — top of its column, and holding the badge that says a person is
       * needed, with no action left to take.
       */
      const [model] = build({
        runs: [run({ state })],
        stepsByRun: { r1: [step("a", { state: "cancelled" })] },
        sessions: [],
      });

      expect(model?.attention).toBeUndefined();
    },
  );

  it("sinks a finished task below a queued one", () => {
    const models = build({
      runs: [
        run({ id: "done", state: "cancelled", updatedAt: later(10) }),
        run({ id: "waiting", state: "running", updatedAt: ISO }),
      ],
      stepsByRun: { done: [step("a", { runId: "done", state: "cancelled" })] },
      sessions: [],
    });

    expect(models.map((model) => model.run.id)).toEqual(["waiting", "done"]);
  });

  it("does not count a finished task as needing a person", () => {
    const models = build({
      runs: [run({ state: "cancelled" })],
      stepsByRun: { r1: [step("a", { state: "cancelled" })] },
      sessions: [],
    });

    expect(summarise(models).needsYou).toBe(0);
  });

  it("knows a task that exists but has not been planned", () => {
    /*
     * Opening a task writes the record before it briefs the orchestrator, so
     * this is the ordinary state between the two. Without a name for it the
     * detail page renders empty and reads as broken.
     */
    const [model] = build({ runs: [run({ phases: [] })], stepsByRun: {}, sessions: [] });
    expect(awaitingPlan(model!)).toBe(true);
  });

  it("stops calling a task unplanned once the orchestrator names its phases", () => {
    const [model] = build({
      runs: [run({ phases: ["Implement", "Review"] })],
      stepsByRun: {},
      sessions: [],
    });
    expect(awaitingPlan(model!)).toBe(false);
  });

  it("stops calling a task unplanned once work is out for it", () => {
    // A handwritten plan has steps and no phases; it is dispatched, not waiting.
    const [model] = build({
      runs: [run({ phases: [] })],
      stepsByRun: { r1: [step("a", { state: "running" })] },
      sessions: [],
    });
    expect(awaitingPlan(model!)).toBe(false);
  });

  it("never calls a finished task unplanned", () => {
    // Abandoning one before it was ever planned leaves phases empty forever.
    const [model] = build({
      runs: [run({ state: "cancelled", phases: [] })],
      stepsByRun: {},
      sessions: [],
    });
    expect(awaitingPlan(model!)).toBe(false);
  });

  it("counts live, completed and total steps", () => {
    const [model] = build({
      runs: [run()],
      stepsByRun: {
        r1: [
          step("a", { state: "succeeded" }),
          step("b", { state: "running" }),
          step("c", { state: "starting" }),
          step("d", { state: "pending" }),
        ],
      },
      sessions: [],
    });

    expect(model).toMatchObject({ liveSteps: 2, completedSteps: 1, totalSteps: 4 });
  });

  it("takes the newest activity from the steps, not just the run row", () => {
    const [model] = build({
      runs: [run({ updatedAt: ISO })],
      stepsByRun: { r1: [step("a", { updatedAt: later(5) })] },
      sessions: [],
    });

    expect(model?.latestActivityAt).toBe(later(5));
  });

  it("sorts attention above work, and work above rest", () => {
    const models = build({
      runs: [
        run({ id: "quiet", updatedAt: ISO }),
        run({ id: "busy", updatedAt: ISO }),
        run({ id: "blocked", updatedAt: ISO }),
        run({ id: "over", state: "completed", updatedAt: ISO }),
      ],
      stepsByRun: {
        busy: [step("b", { runId: "busy", state: "running" })],
        blocked: [step("x", { runId: "blocked", state: "running", sessionId: "s1" })],
      },
      sessions: [session("s1")],
      waitingPermissions: [permission("s1")],
    });

    expect(models.map((model) => model.run.id)).toEqual([
      "blocked",
      "busy",
      "quiet",
      "over",
    ]);
  });

  it("resolves the checkout a pinned run is working in", () => {
    const [model] = build({
      runs: [run({ placementId: "p1" })],
      stepsByRun: {},
      sessions: [],
      placements: [
        {
          id: "p1",
          workspaceId: "w1",
          workspaceName: "repo",
          nodeId: "n1",
          nodeName: "box",
          localPath: "/src/repo",
        },
      ],
    });

    expect(model?.placement?.localPath).toBe("/src/repo");
  });
});

describe("summarise", () => {
  it("counts what the header shows", () => {
    const models = build({
      runs: [run({ id: "a" }), run({ id: "b", state: "awaiting_human" })],
      stepsByRun: { a: [step("s", { runId: "a", state: "running" })] },
      sessions: [],
    });

    expect(summarise(models)).toMatchObject({ total: 2, running: 1, needsYou: 1 });
  });

  it("does not let finished tasks decide where the work is", () => {
    const models = build({
      runs: [
        run({ id: "a", state: "completed" }),
        run({ id: "b", state: "completed" }),
        run({ id: "c" }),
      ],
      stepsByRun: { c: [step("s", { runId: "c", state: "running" })] },
      sessions: [],
    });

    expect(summarise(models).dominantStage).toBe("implementation");
  });
});

describe("labels", () => {
  it("calls a cancelled run abandoned, because its output is still there", () => {
    // `cancel` keeps the run and its steps; only the dispatching stops.
    expect(runStateLabel(run({ state: "cancelled" }))).toBe("Abandoned");
  });

  it("names the phase the orchestrator chose, and nothing when it chose none", () => {
    expect(currentPhase(run({ phases: ["Plan", "Ship"], phaseIndex: 1 }))).toBe("Ship");
    expect(currentPhase(run())).toBe("");
  });

  it("clamps a phase index that has run past the end", () => {
    expect(currentPhase(run({ phases: ["Only"], phaseIndex: 4 }))).toBe("Only");
  });
});
