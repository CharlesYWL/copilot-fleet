import { beforeEach, describe, expect, it } from "vitest";
import {
  RunCriterionSchema,
  type CriterionOutcome,
  type RunCriterion,
} from "@fleet/protocol";
import type { FleetStore } from "../store.js";
import type { FleetService } from "../fleet-service.js";
import { fleet } from "./fleet-harness.js";
import { FleetTools } from "./tools.js";

describe("FleetTools", () => {
  let store: FleetStore;
  let service: FleetService;
  let leadId: string;

  beforeEach(() => {
    const world = fleet();
    store = world.store;
    service = world.service;
    leadId = world.leadId;
  });

  const tools = () => new FleetTools(service, leadId);

  const start = (input: Record<string, unknown>) =>
    tools().startWork({
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      verify: "list the directory and say what you saw",
      ...input,
    } as Parameters<FleetTools["startWork"]>[0]);

  /** This orchestrator's tasks, oldest first, as the tools order them. */
  const tasks = () =>
    store
      .listRuns()
      .filter((run) => run.leadSessionId === leadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  it("writes the worker's brief from what the dispatch promised", () => {
    /*
     * The Host composes it, not the orchestrator, so every worker is told the
     * same things in the same order — and so the closing instruction to verify
     * before answering cannot be dropped by a model in a hurry.
     *
     * Asserting on the text is also what catches this schema changing under the
     * tests: they call the tool directly, and service tests are not typechecked,
     * so a renamed field would otherwise compose "undefined" in silence.
     */
    start({
      task: "Explore Beta",
      title: "Find the config",
      deliverable: "the path of the config file, and what it sets",
      scope: "src/ only; do not change anything",
      verify: "print the file and quote the lines you mean",
      context: "the person already looked in the repo root and found nothing",
    });
    const step = store.listRunSteps(tasks()[1]!.id)[0]!;

    expect(step.prompt).toContain("TASK: Find the config");
    expect(step.prompt).toContain("DELIVERABLE\nthe path of the config file");
    expect(step.prompt).toContain("SCOPE\nsrc/ only");
    expect(step.prompt).toContain("VERIFY\nprint the file");
    expect(step.prompt).toContain("CONTEXT\nthe person already looked");
    expect(step.prompt).toMatch(/verification before you answer/);
    expect(step.prompt).not.toContain("undefined");
  });

  it("leaves out the context heading when there is nothing to say under it", () => {
    start({ task: "Explore Beta" });
    const step = store.listRunSteps(tasks()[1]!.id)[0]!;

    expect(step.prompt).not.toContain("CONTEXT");
    expect(step.prompt).toContain("VERIFY");
  });

  it("puts a named task in its own run, with its own budget", () => {
    const result = start({ task: "Explore Beta" });
    expect(result.text).toContain("Explore Beta");
    expect(result.ok).toBe(true);
    expect(tasks().map((run) => run.name)).toEqual(["General", "Explore Beta"]);
    // One step each, rather than both spending the same task's allowance.
    expect(store.listRunSteps(tasks()[1]!.id)).toHaveLength(1);
    expect(store.listRunSteps(tasks()[0]!.id)).toHaveLength(0);
  });

  it("adds to a task that already exists instead of opening a second one", () => {
    start({ task: "Explore Beta" });
    start({ task: "explore beta", title: "look again" });

    expect(tasks()).toHaveLength(2);
    expect(store.listRunSteps(tasks()[1]!.id)).toHaveLength(2);
  });

  it("continues the most recent task when none is named", () => {
    start({ task: "Explore Beta" });
    start({ title: "and again" });

    expect(tasks()).toHaveLength(2);
    expect(store.listRunSteps(tasks()[1]!.id)).toHaveLength(2);
  });

  it("sends work to the workspace it was told to, not the run's own", () => {
    // The reported problem: a workspace added later could not be reached at all.
    const result = start({ task: "Explore Beta", workspace: "Beta" });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("/src/beta");
  });

  it("says which workspaces exist when the named one does not", () => {
    const result = start({ workspace: "Gamma" });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("fleet_list_nodes");
  });

  it("lists every task, not only the first", () => {
    start({ task: "Explore Beta" });
    start({ task: "Audit Alpha", workspace: "Alpha" });

    const listed = tools().listWork().text;

    expect(listed).toContain("Explore Beta");
    expect(listed).toContain("Audit Alpha");
  });

  it("refuses a follow-up to a worker whose step has settled", () => {
    /*
     * It used to accept one and answer "you will be woken when it finishes".
     * Nothing was tracking that turn, so no wake could ever come.
     */
    start({ task: "Explore Beta" });
    const run = store.listRuns().find((entry) => entry.name === "Explore Beta")!;
    const step = store.listRunSteps(run.id)[0]!;
    store.updateRunStep(step.id, { state: "succeeded" });

    const result = tools().followUp({ sessionId: step.sessionId, prompt: "one more" });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("fleet_start_work");
  });

  it("will not touch a session belonging to somebody else", () => {
    const mine = store.createSession(store.listPlacements()[0]!, "hand-made");

    expect(tools().transcript({ sessionId: mine.id }).ok).toBe(false);
    expect(tools().stopWork({ sessionId: mine.id }).ok).toBe(false);
  });
});

describe("FleetTools phases", () => {
  let store: FleetStore;
  let service: FleetService;
  let leadId: string;

  beforeEach(() => {
    const world = fleet();
    store = world.store;
    service = world.service;
    leadId = world.leadId;
  });

  const tools = () => new FleetTools(service, leadId);

  const criterion = (overrides: Partial<RunCriterion> = {}): RunCriterion =>
    RunCriterionSchema.parse({
      id: "it-works",
      scenario: "running the build prints no errors",
      expectedEvidence: "npm run build exits 0",
      ...overrides,
    });

  const plan = (phases: string[], successCriteria: RunCriterion[] = [criterion()]) =>
    tools().planTask({
      task: "Ship it",
      objective: "make the change",
      phases,
      successCriteria,
      stopWhen: "the build is green on main",
    });

  const submit = (
    criteria: { id: string; outcome: CriterionOutcome; evidence: string }[] = [
      { id: "it-works", outcome: "met", evidence: "npm run build exited 0" },
    ],
  ) => tools().submitTask({ task: "Ship it", summary: "Here it is.", criteria });

  const dispatch = () =>
    tools().startWork({
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      verify: "list the directory and say what you saw",
      task: "Ship it",
    });

  const task = () => store.listRuns().find((run) => run.name === "Ship it")!;

  /** Ends every step of the task, as a settled worker does. */
  const settleAll = () => {
    for (const step of store.listRunSteps(task().id)) {
      store.updateRunStep(step.id, { state: "succeeded" });
    }
  };

  it("opens a task with the phases the orchestrator chose", () => {
    const result = plan(["Plan", "Implement", "Review"]);

    expect(result.ok).toBe(true);
    expect(task().phases).toEqual(["Plan", "Implement", "Review"]);
    expect(task().phaseIndex).toBe(0);
  });

  it("takes as few phases as the work needs", () => {
    // A question is one phase and a sign-off; inventing stages with no work in
    // them would be the fixed pipeline this replaced.
    expect(plan(["Answer"]).ok).toBe(true);
    expect(task().phases).toEqual(["Answer"]);
  });

  it("records which phase a step was dispatched in", () => {
    plan(["Plan", "Implement"]);
    dispatch();
    settleAll();
    tools().advanceTask({ task: "Ship it", note: "planned" });
    dispatch();

    const steps = store.listRunSteps(task().id);
    expect(steps.map((step) => step.phaseIndex)).toEqual([0, 1]);
  });

  it("advances only once nothing is still running", () => {
    // Judging a phase whose worker has not finished is guessing.
    plan(["Plan", "Implement"]);
    dispatch();

    const refused = tools().advanceTask({ task: "Ship it", note: "done" });

    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/still running/);
    expect(task().phaseIndex).toBe(0);
  });

  it("keeps what each phase established, for the person to read later", () => {
    plan(["Plan", "Implement"]);
    dispatch();
    settleAll();

    tools().advanceTask({ task: "Ship it", note: "Settled on the smaller change." });

    expect(store.listRunNotes(task().id).map((note) => note.body)).toEqual([
      "Settled on the smaller change.",
    ]);
    expect(task().phaseIndex).toBe(1);
  });

  it("sends the orchestrator to submit rather than past the last phase", () => {
    plan(["Only"]);
    dispatch();
    settleAll();

    const refused = tools().advanceTask({ task: "Ship it", note: "done" });

    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/fleet_submit_task/);
  });

  it("hands a finished task to the person", () => {
    plan(["Only"]);
    dispatch();
    settleAll();

    const result = submit();

    expect(result.ok).toBe(true);
    expect(task().state).toBe("awaiting_human");
    expect(store.listRunNotes(task().id).at(-1)?.body).toContain("Here it is.");
  });

  it("will not hand over work that is still out", () => {
    plan(["Only"]);
    dispatch();

    expect(submit().ok).toBe(false);
    expect(task().state).not.toBe("awaiting_human");
  });

  it("dispatches nothing more while the person holds the task", () => {
    plan(["Only"]);
    dispatch();
    settleAll();
    submit();

    const result = dispatch();

    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/review/);
  });

  it("refuses a second task of the same name", () => {
    plan(["Only"]);

    const again = plan(["Only"]);

    expect(again.ok).toBe(false);
    expect(store.listRuns().filter((run) => run.name === "Ship it")).toHaveLength(1);
  });
});

/*
 * Criteria only mean something if they can stop a handover. Everything here is
 * about that: a task promises what done looks like at plan time, and cannot be
 * given to a person until the orchestrator says how each promise turned out.
 */
describe("FleetTools success criteria", () => {
  let store: FleetStore;
  let service: FleetService;
  let leadId: string;
  let runId: string;

  const tools = () => new FleetTools(service, leadId);

  const criteria = [
    RunCriterionSchema.parse({
      id: "logout-invalidates",
      scenario: "reusing a token after logout returns 401",
      expectedEvidence: "the auth suite's logout test passes",
    }),
    RunCriterionSchema.parse({
      id: "nice-to-have",
      scenario: "the error message names the expired token",
      expectedEvidence: "the 401 body contains the token id",
      essential: false,
    }),
  ];

  const met = (id: string) => ({
    id,
    outcome: "met" as CriterionOutcome,
    evidence: "ran the auth suite; the logout test passed",
  });

  beforeEach(() => {
    const world = fleet();
    store = world.store;
    service = world.service;
    leadId = world.leadId;
    tools().planTask({
      task: "Ship it",
      objective: "make the change",
      phases: ["Only"],
      successCriteria: criteria,
      stopWhen: "the auth suite is green",
    });
    runId = store.listRuns().find((run) => run.name === "Ship it")!.id;
    tools().startWork({
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      verify: "list the directory and say what you saw",
      task: "Ship it",
    });
    for (const step of store.listRunSteps(runId)) {
      store.updateRunStep(step.id, { state: "succeeded" });
    }
  });

  const submit = (
    reported: { id: string; outcome: CriterionOutcome; evidence: string }[],
  ) =>
    tools().submitTask({ task: "Ship it", summary: "Here it is.", criteria: reported });

  const state = () => store.getRun(runId)!.state;

  it("keeps what the task promised, so the gate has something to check", () => {
    expect(store.getRun(runId)!.successCriteria.map((c) => c.id)).toEqual([
      "logout-invalidates",
      "nice-to-have",
    ]);
    expect(store.getRun(runId)!.stopWhen).toBe("the auth suite is green");
  });

  it("will not hand over a task whose essential criterion is unmet", () => {
    const result = submit([
      { id: "logout-invalidates", outcome: "unmet", evidence: "the test still fails" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.text).toContain("logout-invalidates");
    expect(state()).not.toBe("awaiting_human");
  });

  it("treats a criterion that could not be checked as not met", () => {
    // "blocked" is honest, and honesty is worth encouraging — but it is still
    // not evidence that the thing works, so it cannot end the task either.
    const result = submit([
      { id: "logout-invalidates", outcome: "blocked", evidence: "no test database" },
    ]);

    expect(result.ok).toBe(false);
    expect(state()).not.toBe("awaiting_human");
  });

  it("will not let an essential criterion be quietly left out", () => {
    const result = submit([met("nice-to-have")]);

    expect(result.ok).toBe(false);
    expect(result.text).toContain("logout-invalidates");
    // The refusal repeats what the criterion asked for, so the next attempt has
    // it to hand rather than having to go back and look.
    expect(result.text).toContain("the auth suite's logout test passes");
    expect(state()).not.toBe("awaiting_human");
  });

  it("does not hold up a task for an optional criterion", () => {
    const result = submit([met("logout-invalidates")]);

    expect(result.ok).toBe(true);
    expect(state()).toBe("awaiting_human");
  });

  it("refuses outcomes for criteria this task never had", () => {
    // Otherwise a made-up id would satisfy nothing while looking thorough.
    const result = submit([met("logout-invalidates"), met("invented")]);

    expect(result.ok).toBe(false);
    expect(result.text).toContain("invented");
    expect(state()).not.toBe("awaiting_human");
  });

  it("records the evidence next to the summary the person reads", () => {
    submit([met("logout-invalidates")]);

    const note = store.listRunNotes(runId).at(-1)!.body;
    expect(note).toContain("Here it is.");
    expect(note).toContain("logout-invalidates: met");
    expect(note).toContain("ran the auth suite");
    expect(note).toContain("nice-to-have (optional): not reported");
  });

  it("still hands over a task that was planned before criteria existed", () => {
    // Runs created by an older build have none, and are not stuck because of it.
    store.updateRun(runId, { successCriteria: [] });

    expect(submit([]).ok).toBe(true);
    expect(state()).toBe("awaiting_human");
  });

  it("leaves a way out when a criterion turns out to be impossible", () => {
    /*
     * Without this the gate is a trap: submitting is refused, and an
     * orchestrator with no legal move will either invent one or go quiet.
     * Neither is better than saying "I am stuck, here is why".
     *
     * The bug this replaces was worse than a missing feature — three separate
     * places told the orchestrator to call fleet_escalate while no such tool
     * was registered, so being blocked led to a tool-not-found and then to
     * improvisation.
     */
    expect(
      submit([
        { id: "logout-invalidates", outcome: "blocked", evidence: "no test database" },
      ]).ok,
    ).toBe(false);

    const out = tools().escalate({
      task: "Ship it",
      reason:
        "There is no test database on any node, so the logout test cannot run at all.",
    });

    expect(out.ok).toBe(true);
    expect(state()).toBe("awaiting_human");
    const note = store.listRunNotes(runId).at(-1)!.body;
    // Named as unfinished, so nobody reads it as a completion.
    expect(note).toContain("not finished");
    expect(note).toContain("no test database");
    // And carries what it was supposed to satisfy, so the person can decide
    // whether to drop that criterion without going to look it up.
    expect(note).toContain("logout-invalidates");
  });

  it("does not escalate a task the person already holds", () => {
    submit([met("logout-invalidates")]);

    const out = tools().escalate({
      task: "Ship it",
      reason: "changed my mind about this one, actually",
    });

    expect(out.ok).toBe(false);
  });
});
