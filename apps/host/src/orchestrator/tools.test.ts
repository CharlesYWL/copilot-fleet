import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { OrchestratorEngine } from "./engine.js";
import { FleetTools } from "./tools.js";

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as FastifyBaseLogger;

function fakeSocket() {
  return {
    readyState: 1,
    // `dispatch` compares against the socket's own OPEN, so a stub without it
    // silently reads as closed and every command is "sent to a dead node".
    OPEN: 1,
    send: () => {},
  } as unknown as Parameters<FleetService["attachNode"]>[1];
}

/** A fleet with one online node holding two different checkouts. */
function fleet() {
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, silent, "test");

  const { node } = store.registerNode({
    name: "box",
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    capabilities: ["copilot-acp", "host-yolo"],
    maxSessions: 8,
  });
  service.attachNode(node.id, fakeSocket());
  store.setNodeOnline(node.id, true, 0);

  const first = store.createWorkspace("Alpha", "");
  const second = store.createWorkspace("Beta", "");
  store.createPlacement(first.id, node.id, "/src/alpha");
  store.createPlacement(second.id, node.id, "/src/beta");

  const engine = new OrchestratorEngine(service);
  service.attachOrchestration({
    leadTokens: { mint: () => "flt_test" },
    mcpUrl: () => "http://127.0.0.1/mcp",
    tickRun: (runId) => engine.tickRun(runId),
  });

  const lead = store.createSession(
    store.listPlacements()[0]!,
    "orchestrate",
    true,
    "Orchestrator",
    { runRole: "lead" },
  );
  const run = store.createRun({
    workspaceId: first.id,
    name: "General",
    objective: "general",
    policy: { wakePolicy: "on_any_settle" },
  });
  store.updateRun(run.id, { leadSessionId: lead.id, state: "running" });
  return { store, service, leadId: lead.id };
}

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
      prompt: "go and look",
      ...input,
    } as Parameters<FleetTools["startWork"]>[0]);

  /** This orchestrator's tasks, oldest first, as the tools order them. */
  const tasks = () =>
    store
      .listRuns()
      .filter((run) => run.leadSessionId === leadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

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

  const plan = (phases: string[]) =>
    tools().planTask({
      task: "Ship it",
      objective: "make the change",
      phases,
    });

  const dispatch = () =>
    tools().startWork({
      category: "explore",
      title: "look",
      prompt: "go and look",
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

    const result = tools().submitTask({ task: "Ship it", summary: "Here it is." });

    expect(result.ok).toBe(true);
    expect(task().state).toBe("awaiting_human");
    expect(store.listRunNotes(task().id).at(-1)?.body).toBe("Here it is.");
  });

  it("will not hand over work that is still out", () => {
    plan(["Only"]);
    dispatch();

    expect(tools().submitTask({ task: "Ship it", summary: "done" }).ok).toBe(false);
    expect(task().state).not.toBe("awaiting_human");
  });

  it("dispatches nothing more while the person holds the task", () => {
    plan(["Only"]);
    dispatch();
    settleAll();
    tools().submitTask({ task: "Ship it", summary: "Here it is." });

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
