import { beforeEach, describe, expect, it } from "vitest";
import {
  RunCriterionSchema,
  type CriterionOutcome,
  type RunCriterion,
} from "@fleet/protocol";
import type { FleetStore } from "../store.js";
import type { FleetService } from "../fleet-service.js";
import { fleet } from "./fleet-harness.js";
import { FleetTools, StartWorkSchema, explainInvalidArgs } from "./tools.js";

describe("FleetTools", () => {
  let store: FleetStore;
  let service: FleetService;
  let leadId: string;
  let addNode: ReturnType<typeof fleet>["addNode"];

  beforeEach(() => {
    const world = fleet();
    store = world.store;
    service = world.service;
    leadId = world.leadId;
    addNode = world.addNode;
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
    const step = store.listRunSteps(tasks()[0]!.id)[0]!;

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
    const step = store.listRunSteps(tasks()[0]!.id)[0]!;

    expect(step.prompt).not.toContain("CONTEXT");
    expect(step.prompt).toContain("VERIFY");
  });

  it("puts a named task in its own run, with its own budget", () => {
    const result = start({ task: "Explore Beta" });
    expect(result.text).toContain("Explore Beta");
    expect(result.ok).toBe(true);
    expect(tasks().map((run) => run.name)).toEqual(["Explore Beta"]);
    expect(store.listRunSteps(tasks()[0]!.id)).toHaveLength(1);

    // A second name is a second task, rather than more work in the first: they
    // are unrelated, and sharing a budget and a checkout would say otherwise.
    start({ task: "Audit Alpha", workspace: "Alpha" });
    expect(tasks().map((run) => run.name)).toEqual(["Explore Beta", "Audit Alpha"]);
    expect(store.listRunSteps(tasks()[0]!.id)).toHaveLength(1);
    expect(store.listRunSteps(tasks()[1]!.id)).toHaveLength(1);
  });

  it("has no task at all until one is opened", () => {
    /*
     * A conversation used to start with one called "General" so that work could
     * go out without naming a task. Nothing can be dispatched into an unplanned
     * task any more — planning is where success criteria are written — so the
     * placeholder only added an empty card per conversation to the board.
     */
    expect(tasks()).toEqual([]);

    const result = tools().startWork({
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      verify: "list the directory and say what you saw",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("no task yet");
    expect(tasks()).toEqual([]);
  });

  it("adds to a task that already exists instead of opening a second one", () => {
    start({ task: "Explore Beta" });
    start({ task: "explore beta", title: "look again" });

    expect(tasks()).toHaveLength(1);
    expect(store.listRunSteps(tasks()[0]!.id)).toHaveLength(2);
  });

  it("continues the most recent task when none is named", () => {
    start({ task: "Explore Beta" });
    start({ title: "and again" });

    expect(tasks()).toHaveLength(1);
    expect(store.listRunSteps(tasks()[0]!.id)).toHaveLength(2);
  });

  it("sends work to the workspace it was told to, not the run's own", () => {
    // The reported problem: a workspace added later could not be reached at all.
    const result = start({ task: "Explore Beta", workspace: "Beta" });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("/src/beta");
  });

  /**
   * Choosing the machine, which is otherwise the Host's job.
   *
   * The Host ranks by free capacity and knows nothing else — not which machine
   * has the GPU, the signing key or the licensed toolchain. `node` is how the
   * orchestrator supplies the part the ranking cannot see.
   */
  describe("naming a machine", () => {
    it("dispatches to the machine that was named, not the roomiest one", () => {
      addNode("gpu-rig");
      // The lead session sits on box, so gpu-rig is in fact the roomier of the
      // two; naming box is what proves the name and not the ranking decided it.
      const result = start({ task: "Explore Beta", workspace: "Beta", node: "box" });

      expect(result.ok).toBe(true);
      expect(result.text).toContain("node: box (as asked)");
      expect(result.text).toContain("path: /src/beta");

      const step = store.listRunSteps(tasks()[0]!.id)[0]!;
      const placement = store.getPlacement(step.placementId)!;
      expect(store.getNode(placement.nodeId)?.name).toBe("box");
    });

    it("refuses an unknown machine instead of quietly using another", () => {
      /*
       * Silently falling back is the failure that matters here: the whole
       * reason to name a machine is that the others will not do, so work that
       * lands elsewhere is worse than work that does not start.
       */
      const result = start({ task: "Explore Beta", node: "laptop" });

      expect(result.ok).toBe(false);
      expect(result.text).toContain('No node is called "laptop"');
      expect(store.listRunSteps(tasks()[0]!.id)).toHaveLength(0);
    });

    it("refuses an offline machine by name, rather than sending work past it", () => {
      addNode("gpu-rig", { online: false });
      const result = start({ task: "Explore Beta", node: "gpu-rig" });

      expect(result.ok).toBe(false);
      expect(result.text).toContain("gpu-rig is offline");
    });

    it("keeps a review with the changes even when another machine is named", () => {
      addNode("gpu-rig");
      // Pinned to box by writing there, so gpu-rig is a tree with no diff in it.
      start({ task: "Ship it", category: "implement", title: "build it", node: "box" });
      const review = start({
        task: "Ship it",
        category: "review-deep",
        title: "check it",
        node: "gpu-rig",
      });

      expect(review.ok).toBe(false);
      expect(review.text).toContain("holds the changes to review");
      expect(review.text).toContain("Send it to box");
    });

    it("still lets the Host choose when no machine is named", () => {
      addNode("gpu-rig");
      const result = start({ task: "Explore Beta" });

      expect(result.ok).toBe(true);
      expect(result.text).not.toContain("(as asked)");
    });
  });

  /**
   * Chats is a destination with no repository in it.
   *
   * The node in the harness reports no home directory, so each of these opts in
   * by giving it one — which is also the only way a Chats checkout is ever
   * created.
   */
  describe("Chats", () => {
    const withChats = () => {
      const node = store.listNodes()[0]!;
      store.setNodeIdentity(node.id, { homeDir: "/home/box" });
      return store.chatPlacementFor(node.id)!;
    };

    it("takes a question, and runs it in the node's home directory", () => {
      const chat = withChats();
      const result = start({ task: "Ask something", workspace: "Chats" });

      expect(result.ok).toBe(true);
      expect(result.text).toContain(chat.localPath);
    });

    it("refuses a change, which would have nothing to change", () => {
      /*
       * And more than nothing: a writing step that reached a home directory
       * would take the run's pin with it, so every later step — the review
       * above all — would be sent to a tree that never held the work.
       */
      withChats();
      start({ task: "Ask something", workspace: "Chats" });

      const result = start({
        category: "implement",
        title: "change it",
        workspace: "Chats",
      });

      expect(result.ok).toBe(false);
      expect(result.text).toContain("no checkout");
    });

    it("refuses a review, which would have nothing to review", () => {
      withChats();
      start({ task: "Ask something", workspace: "Chats" });

      const result = start({
        category: "review-deep",
        title: "read it back",
        workspace: "Chats",
      });

      expect(result.ok).toBe(false);
      expect(result.text).toContain("no checkout");
    });

    it("still sends a change to a real workspace named alongside it", () => {
      // The refusal drops Chats from the candidates rather than refusing the
      // whole dispatch, so a search that matched both still lands on the repo.
      withChats();
      start({ task: "Work on Beta" });

      const result = start({
        category: "implement",
        title: "change it",
        workspace: "Beta",
      });

      expect(result.ok).toBe(true);
      expect(result.text).toContain("/src/beta");
    });

    it("says what Chats is when it lists the machines", () => {
      withChats();
      const result = tools().listNodes();

      expect(result.text).toContain("/home/box");
      expect(result.text).toContain("not a checkout");
    });
  });

  it("says which workspaces exist when the named one does not", () => {
    // Needs a task first: without one there is nothing to dispatch into, and
    // that refusal comes before the workspace is even looked at.
    start({ task: "Explore Beta" });

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

  it("does not start a writer beside another task's writer on the checkout", () => {
    const first = start({ task: "First change", category: "implement" });
    expect(first.ok).toBe(true);

    const second = start({ task: "Second change", category: "implement" });

    expect(second.ok).toBe(false);
    expect(second.text).toContain("Only one writer");
  });

  it("lets a distinct writing role start beside an idle retained worker", () => {
    start({ task: "Ship Beta", category: "implement" });
    const run = store.listRuns().find((entry) => entry.name === "Ship Beta")!;
    const implementation = store.listRunSteps(run.id)[0]!;
    store.updateRunStep(implementation.id, { state: "succeeded" });
    store.transitionSession(implementation.sessionId, "starting");
    store.transitionSession(implementation.sessionId, "running");
    store.transitionSession(implementation.sessionId, "idle");

    const result = start({
      task: "Ship Beta",
      category: "test",
      title: "test the change",
    });

    expect(result.ok, result.text).toBe(true);
    expect(store.listRunSteps(run.id)).toHaveLength(2);
  });

  it("resumes the same worker when revisiting a settled step", () => {
    start({ task: "Explore Beta" });
    const run = store.listRuns().find((entry) => entry.name === "Explore Beta")!;
    const step = store.listRunSteps(run.id)[0]!;
    store.updateRunStep(step.id, { state: "succeeded" });
    store.appendEvent({
      eventId: "agent-session",
      sessionId: step.sessionId,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "copilot-worker-1" },
      createdAt: new Date().toISOString(),
    });
    store.transitionSession(step.sessionId, "stopped");

    const result = tools().followUp({ sessionId: step.sessionId, prompt: "one more" });
    const retried = store.getRunStep(step.id)!;

    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("same worker session");
    expect(retried.sessionId).toBe(step.sessionId);
    expect(retried.attempts).toBe(2);
    expect(retried.state).toBe("pending");
    expect(retried.prompt).toBe("one more");
    expect(store.getSession(step.sessionId)?.state).toBe("starting");

    store.transitionSession(step.sessionId, "idle");
    service.tickRun(run.id);
    expect(store.getRunStep(step.id)?.state).toBe("starting");
  });

  it("revisits a settled step in the worker that stayed open", () => {
    start({ task: "Explore Beta" });
    const run = store.listRuns().find((entry) => entry.name === "Explore Beta")!;
    const step = store.listRunSteps(run.id)[0]!;
    store.updateRunStep(step.id, { state: "succeeded" });
    store.transitionSession(step.sessionId, "starting");
    store.transitionSession(step.sessionId, "running");
    store.transitionSession(step.sessionId, "idle");

    const result = tools().followUp({
      sessionId: step.sessionId,
      prompt: "check the same finding again",
    });
    const retried = store.getRunStep(step.id)!;

    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("same open worker session");
    expect(retried.attempts).toBe(2);
    expect(retried.sessionId).toBe(step.sessionId);
    expect(retried.state).toBe("starting");
    expect(store.getSession(step.sessionId)?.state).toBe("idle");
  });

  it("does not resume a writer beside another writer on the same checkout", () => {
    start({ task: "Fix Beta", category: "implement" });
    const run = store.listRuns().find((entry) => entry.name === "Fix Beta")!;
    const first = store.listRunSteps(run.id)[0]!;
    store.updateRunStep(first.id, { state: "succeeded" });
    store.appendEvent({
      eventId: "first-agent-session",
      sessionId: first.sessionId,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "copilot-writer-1" },
      createdAt: new Date().toISOString(),
    });
    store.transitionSession(first.sessionId, "stopped");

    expect(
      start({
        task: "Fix Beta",
        category: "implement",
        title: "different coding work",
      }).ok,
    ).toBe(true);

    const second = store.listRunSteps(run.id)[1]!;
    const result = tools().followUp({
      sessionId: first.sessionId,
      prompt: "revisit the first change",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("when scheduling allows");
    expect(store.getRunStep(first.id)?.attempts).toBe(2);
    expect(store.getSession(first.sessionId)?.state).toBe("stopped");

    store.updateRunStep(second.id, { state: "succeeded" });
    store.transitionSession(second.sessionId, "stopped");
    service.tickRun(run.id);
    expect(store.getSession(first.sessionId)?.state).toBe("starting");
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
    expect(note).toContain("**logout-invalidates** — met");
    expect(note).toContain("ran the auth suite");
    expect(note).toContain("**nice-to-have** *(optional)* — not reported");
  });

  it("creates one controlled review notification for a completed handover", () => {
    expect(submit([met("logout-invalidates")]).ok).toBe(true);
    expect(submit([met("logout-invalidates")]).ok).toBe(false);

    const notifications = store.listNotifications().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sourceKey: `review:${runId}:1`,
      kind: "orchestration_needs_review",
      navigation: { type: "run", runId },
      data: { reviewSeq: 1, reason: "completed" },
    });
    expect(JSON.stringify(notifications[0])).not.toContain("ran the auth suite");
  });

  it("refuses a handover written as a wall of prose", () => {
    /*
     * The review page is this text and two buttons, so an unscannable summary
     * is not a style complaint — it is the person having to reconstruct the
     * argument before they can make the only decision the orchestrator cannot.
     */
    const wall =
      "Implementation is done and backed by real before/after evidence: the new tests " +
      "failed on unmodified source and then passed, the dead rule was deleted, the copy " +
      "was worse than the primary so the worker added dedicated keys instead of mutating " +
      "the shared ones, gates are green, and the layout numbers are still unverified by " +
      "machine because jsdom cannot resolve them, so please look at those yourself.";

    const result = tools().submitTask({
      task: "Ship it",
      summary: wall,
      criteria: [met("logout-invalidates")],
    });

    expect(result.ok).toBe(false);
    // The refusal carries the shape, so the next attempt is a rewrite and not a guess.
    expect(result.text).toContain("### How it was proven");
    // Nothing moved: the task is still the orchestrator's to hand over.
    expect(state()).not.toBe("awaiting_human");
    expect(store.listRunNotes(runId)).toHaveLength(0);
  });

  it("takes a long handover that is written to be scanned", () => {
    const report = [
      "**The empty state now uses a native 48px glyph.**",
      "",
      "### What was done",
      "- swapped `Search20Regular` for `Search48Regular` in both variants",
      "- deleted the dead `fontSize: 48px` rule that was scaling the old glyph",
      "",
      "### How it was proven",
      "- the new tests failed on unmodified source, then passed 10/10 and 21/21",
      "",
      "### Not verified",
      "- the layout numbers, which jsdom cannot resolve",
    ].join("\n");

    const result = tools().submitTask({
      task: "Ship it",
      summary: report,
      criteria: [met("logout-invalidates")],
    });

    expect(result.ok).toBe(true);
    expect(state()).toBe("awaiting_human");
    expect(store.listRunNotes(runId).at(-1)!.body).toContain("### How it was proven");
  });

  it("does not demand headings of a one-line answer", () => {
    // A question answered in a sentence needs no structure, and asking for it
    // would make the gate ceremony rather than a service to the reader.
    expect(submit([met("logout-invalidates")]).ok).toBe(true);
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
    expect(store.listNotifications().notifications[0]).toMatchObject({
      sourceKey: `review:${runId}:1`,
      data: { reason: "blocked" },
      body: "The orchestrator is blocked and needs a human decision before work can continue.",
    });
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

/*
 * The endings that are not "it worked".
 *
 * Until these existed the orchestrator had two ways to finish a task and no way
 * to abandon one, so a withdrawn request either sat open forever or was pushed
 * at a person as an escalation — asking them to decide something they had just
 * decided themselves.
 */
describe("FleetTools task lifecycle", () => {
  let store: FleetStore;
  let service: FleetService;
  let leadId: string;

  const tools = () => new FleetTools(service, leadId);

  beforeEach(() => {
    const world = fleet();
    store = world.store;
    service = world.service;
    leadId = world.leadId;
  });

  const plan = (task = "Ship it", phases: string[] = ["Only"]) =>
    tools().planTask({
      task,
      objective: "make the change",
      phases,
      successCriteria: [
        RunCriterionSchema.parse({
          id: "it-works",
          scenario: "running the build prints no errors",
          expectedEvidence: "npm run build exits 0",
        }),
      ],
      stopWhen: "the build is green on main",
    });

  const task = (name = "Ship it") => store.listRuns().find((run) => run.name === name)!;

  const dispatch = (name = "Ship it") =>
    tools().startWork({
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      verify: "list the directory and say what you saw",
      task: name,
    });

  const settleAll = (runId: string) => {
    for (const step of store.listRunSteps(runId)) {
      store.updateRunStep(step.id, { state: "succeeded" });
    }
  };

  const handOver = () => {
    settleAll(task().id);
    tools().submitTask({
      task: "Ship it",
      summary: "Here it is.",
      criteria: [{ id: "it-works", outcome: "met", evidence: "the build exited 0" }],
    });
  };

  describe("closing", () => {
    it("ends a task nobody wants any more, and keeps what it learned", () => {
      plan("Ship it", ["Look", "Change"]);
      dispatch();
      settleAll(task().id);
      tools().advanceTask({ task: "Ship it", note: "Found the file." });

      const out = tools().closeTask({
        task: "Ship it",
        reason: "The person withdrew this — the feature is being cut instead.",
      });

      expect(out.ok).toBe(true);
      expect(task().state).toBe("cancelled");
      // The record is the whole difference between this and deleting.
      expect(store.listRunSteps(task().id)).toHaveLength(1);
      const notes = store.listRunNotes(task().id).map((note) => note.body);
      expect(notes).toContain("Found the file.");
      expect(notes.at(-1)).toContain("Closed without finishing.");
      expect(notes.at(-1)).toContain("the feature is being cut");
    });

    it("stops the workers it still had, retains them, and says how many", () => {
      plan();
      dispatch();
      const live = store.listRunSteps(task().id);
      expect(live).toHaveLength(1);
      const session = store.getSession(live[0]!.sessionId)!;
      store.appendEvent({
        eventId: "agent-session",
        sessionId: session.id,
        sequence: 1,
        type: "agent_session",
        payload: { agentSessionId: "copilot-worker-1" },
        createdAt: new Date().toISOString(),
      });

      const out = tools().closeTask({
        task: "Ship it",
        reason: "Superseded by the migration task, which covers this as well.",
      });

      expect(out.ok).toBe(true);
      expect(out.text).toContain("1 step(s) were still running");
      expect(out.text).toContain("worker conversations are kept");
      expect(store.getRunStep(live[0]!.id)!.state).toBe("cancelled");
      expect(store.getSession(session.id)).toMatchObject({
        state: "queued",
        stopRequested: true,
        agentSessionId: "copilot-worker-1",
      });
      expect(store.listEvents(session.id)).toHaveLength(1);
    });

    it("reopens a closed task and resumes its original worker conversation", () => {
      plan();
      dispatch();
      const step = store.listRunSteps(task().id)[0]!;
      store.appendEvent({
        eventId: "agent-session",
        sessionId: step.sessionId,
        sequence: 1,
        type: "agent_session",
        payload: { agentSessionId: "copilot-worker-1" },
        createdAt: new Date().toISOString(),
      });
      tools().closeTask({
        task: "Ship it",
        reason:
          "The request looked obsolete, but the reviewer confirmed it still matters.",
      });
      service.handleEvent({
        eventId: "worker-stopped",
        sessionId: step.sessionId,
        sequence: 2,
        type: "state",
        payload: { state: "stopped", activity: "Stopped" },
        createdAt: new Date().toISOString(),
      });

      expect(
        tools().reopenTask({
          task: "Ship it",
          reason: "Apply the review feedback in the same implementation context.",
        }).ok,
      ).toBe(true);
      const result = tools().followUp({
        sessionId: step.sessionId,
        prompt: "Apply the review comment and rerun the focused test.",
      });

      expect(result.ok, result.text).toBe(true);
      expect(result.text).toContain("same worker session");
      expect(store.getRunStep(step.id)).toMatchObject({
        attempts: 2,
        sessionId: step.sessionId,
        state: "pending",
      });
      expect(store.getSession(step.sessionId)).toMatchObject({
        state: "starting",
        agentSessionId: "copilot-worker-1",
      });
    });

    it("will not take a task back from the person by closing it", () => {
      /*
       * The one version of this that would surprise someone: they are looking at
       * the review page while it disappears. Taking it back is a real thing to
       * want, and it has its own tool that says so in the record.
       */
      plan();
      handOver();
      expect(task().state).toBe("awaiting_human");

      const out = tools().closeTask({
        task: "Ship it",
        reason: "Actually the person said to drop this one entirely.",
      });

      expect(out.ok).toBe(false);
      expect(out.text).toContain("fleet_reopen_task");
      expect(task().state).toBe("awaiting_human");
    });

    it("does not close a task twice", () => {
      plan();
      tools().closeTask({ task: "Ship it", reason: "Withdrawn before anything ran." });

      const again = tools().closeTask({
        task: "Ship it",
        reason: "Withdrawn before anything ran.",
      });

      expect(again.ok).toBe(false);
      expect(again.text).toContain("already closed");
    });

    it("points a re-planned name at reopening rather than a dead end", () => {
      /*
       * A closed task keeps its name. Before closing existed that was rare;
       * now it is the ordinary aftermath, and the old refusal sent the caller
       * to dispatch into a cancelled run, which refuses in turn.
       */
      plan();
      tools().closeTask({
        task: "Ship it",
        reason: "Withdrawn; the person changed tack.",
      });

      const again = plan();

      expect(again.ok).toBe(false);
      expect(again.text).toContain("fleet_reopen_task");
    });
  });

  describe("reopening", () => {
    it("takes a task back from review, so the person stops being asked", () => {
      plan();
      handOver();

      const out = tools().reopenTask({
        task: "Ship it",
        reason: "The reviewer found the same bug in the other tab; this is not done.",
      });

      expect(out.ok).toBe(true);
      expect(task().state).toBe("running");
      expect(store.listRunNotes(task().id).at(-1)!.body).toContain(
        "Taken back before review",
      );
    });

    it("resolves the withdrawn review and creates a new sequence on resubmit", () => {
      plan();
      handOver();
      const run = task();
      expect(store.getNotificationBySourceKey(`review:${run.id}:1`)).toMatchObject({
        status: "active",
      });

      tools().reopenTask({
        task: "Ship it",
        reason: "The evidence needs one more focused check.",
      });
      expect(store.getNotificationBySourceKey(`review:${run.id}:1`)).toMatchObject({
        status: "resolved",
      });

      handOver();
      expect(store.getRun(run.id)?.reviewSeq).toBe(2);
      expect(store.getNotificationBySourceKey(`review:${run.id}:2`)).toMatchObject({
        status: "active",
      });
      expect(store.listNotifications().notifications).toHaveLength(2);
    });

    it("carries a finished task on from the phase it was on", () => {
      plan();
      handOver();
      store.updateRun(task().id, { state: "completed" });

      const out = tools().reopenTask({
        task: "Ship it",
        reason: "The person wants the same change applied to the second tab.",
      });

      expect(out.ok).toBe(true);
      expect(task().state).toBe("running");
      expect(task().phaseIndex).toBe(0);
      // The point of reopening rather than opening: the contract survives.
      expect(task().successCriteria.map((c) => c.id)).toEqual(["it-works"]);
      expect(store.listRunNotes(task().id).at(-1)!.body).toContain("Reopened");
    });

    it("clears the reason a task failed, so it does not read as still broken", () => {
      plan();
      store.updateRun(task().id, { state: "failed", failureReason: "the node vanished" });

      tools().reopenTask({
        task: "Ship it",
        reason: "The node is back; pick this up where it stopped.",
      });

      expect(task().failureReason).toBe("");
    });

    it("refuses to reopen a task that is still open", () => {
      plan();

      const out = tools().reopenTask({
        task: "Ship it",
        reason: "I would like to carry on with this one.",
      });

      expect(out.ok).toBe(false);
      expect(out.text).toContain("fleet_start_work");
    });
  });

  describe("discarding", () => {
    it("removes a task that dispatched nothing", () => {
      plan("Duplicate");
      const id = task("Duplicate").id;

      const out = tools().discardTask({
        task: "Duplicate",
        reason: "Opened this twice; the other one has the same phases.",
      });

      expect(out.ok).toBe(true);
      expect(store.getRun(id)).toBeUndefined();
    });

    it("will not destroy a record a person might read", () => {
      /*
       * The same rule that stops it dropping a success criterion. Once work has
       * gone out there is something to have learned, and what to do with that is
       * a person's call — so the refusal names the tool that keeps it.
       */
      plan();
      dispatch();

      const out = tools().discardTask({
        task: "Ship it",
        reason: "On reflection this task was a misreading of the request.",
      });

      expect(out.ok).toBe(false);
      expect(out.text).toContain("fleet_close_task");
      expect(store.getRun(task().id)).toBeTruthy();
    });

    it("will not delete a task out from under the person reviewing it", () => {
      plan();
      handOver();

      const out = tools().discardTask({
        task: "Ship it",
        reason: "I would rather this had never been opened at all.",
      });

      expect(out.ok).toBe(false);
      expect(out.text).toContain("leave it there");
      expect(store.getRun(task().id)).toBeTruthy();
    });
  });

  it("touches no task belonging to another orchestrator", () => {
    // The scoping every tool here relies on: a task is found by name, and the
    // names are only unique within one conversation.
    plan();
    const mine = task().id;
    const other = store.createRun({
      workspaceId: store.listWorkspaces()[0]!.id,
      name: "Ship it",
      objective: "someone else's",
    });

    expect(
      tools().closeTask({ task: "Ship it", reason: "Withdrawn by the person." }).ok,
    ).toBe(true);
    expect(store.getRun(other.id)!.state).not.toBe("cancelled");
    expect(store.getRun(mine)!.state).toBe("cancelled");
  });
});

/*
 * The net under the schema. It only runs if the advertised schema and the
 * handler's ever come apart, but what it produces is what a model would have
 * to act on if they did, so it is held to reading as an instruction.
 */
describe("explainInvalidArgs", () => {
  const reject = (args: unknown) => {
    const parsed = StartWorkSchema.safeParse(args);
    if (parsed.success) throw new Error("expected these arguments to be refused");
    return explainInvalidArgs("fleet_start_work", parsed.error, args);
  };

  const dispatch = (over: Record<string, unknown>) => ({
    category: "explore",
    title: "look",
    deliverable: "a list of what is in there",
    scope: "the whole checkout, read-only",
    verify: "list the directory and say what you saw",
    ...over,
  });

  it("says the call had no effect, so a caller does not wait for a worker", () => {
    const out = reject(dispatch({ verify: "eh" }));

    expect(out.ok).toBe(false);
    expect(out.text).toContain("did nothing");
    expect(out.text).toContain("Nothing was started");
  });

  it("passes on what the failing field was for, not just that it failed", () => {
    const out = reject(dispatch({ verify: "eh" }));

    expect(out.text).toContain("verify");
    expect(out.text).toContain("the command to run or the observation to make");
  });

  it("says which field is missing rather than describing its type", () => {
    const args = dispatch({});
    delete (args as Record<string, unknown>).verify;

    expect(reject(args).text).toContain("verify: missing, and required.");
  });

  it("no longer has a length to complain about on the brief itself", () => {
    // The ceiling that produced the reported failures is gone, so the one
    // remaining way to be refused is having said too little.
    expect(
      StartWorkSchema.safeParse(dispatch({ context: "x".repeat(500_000) })).success,
    ).toBe(true);
  });

  it("never answers with a dump of Zod issue objects", () => {
    const out = reject(dispatch({ scope: "tiny" }));

    expect(out.text).not.toContain('"code"');
    expect(out.text).not.toContain("too_small");
  });
});
