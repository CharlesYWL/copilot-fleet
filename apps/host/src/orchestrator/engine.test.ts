import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { canTransition } from "@fleet/protocol";
import { FleetService } from "../fleet-service.js";
import { FleetStore } from "../store.js";
import { OrchestratorEngine, truncateMiddle } from "./engine.js";
import { ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS, runSweepInterval } from "./deadlines.js";

type SentFrame = {
  type: string;
  command?: { type: string; sessionId: string; prompt?: string };
};

function fakeSocket() {
  const sent: SentFrame[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as SentFrame),
  };
  return { sent, socket: socket as unknown as WebSocket };
}

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
} as unknown as FastifyBaseLogger;

function setup({ attach = true, maxSessions = 4 } = {}) {
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, silentLog, "");
  const { node } = store.registerNode({
    name: "devbox",
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    capabilities: ["copilot-acp", "host-yolo"],
    maxSessions,
  });
  const wire = fakeSocket();
  if (attach) {
    service.attachNode(node.id, wire.socket);
    // The gateway does this on `hello`; attaching a socket alone leaves the row
    // reading offline, and the engine will not dispatch to a node it cannot see.
    store.setNodeOnline(node.id, true, 0);
  }
  const workspace = store.createWorkspace("repo", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
  const engine = new OrchestratorEngine(service);

  const commands = (type: string) =>
    wire.sent.filter((frame) => frame.command?.type === type).map((f) => f.command!);

  /** An approved run with the given plan, as the fixture path produces it. */
  const planned = (
    steps: { stepKey: string; title: string; prompt: string; category?: string }[],
  ) => {
    const run = store.createRun({
      workspaceId: workspace.id,
      name: "run",
      objective: "do it",
    });
    store.replaceRunSteps(run.id, steps);
    store.setRunState(run.id, "running");
    return store.getRun(run.id)!;
  };

  /** Drives a session through the events a finished turn actually produces. */
  const finishTurn = (sessionId: string, text: string) => {
    // The caller may already have walked the session forward; only move it if
    // the transition table allows it.
    const advance = (state: "starting" | "running" | "idle") => {
      const current = store.getSession(sessionId)!;
      if (current.state !== state && canTransition(current.state, state)) {
        store.transitionSession(sessionId, state);
      }
    };
    advance("starting");
    advance("running");
    let sequence = store.maxEventSequence(sessionId);
    const now = new Date().toISOString();
    store.appendEvent({
      eventId: `${sessionId}-text-${++sequence}`,
      sessionId,
      sequence,
      type: "agent_text",
      payload: { text },
      createdAt: now,
    });
    store.appendEvent({
      eventId: `${sessionId}-done-${++sequence}`,
      sessionId,
      sequence,
      type: "turn_complete",
      payload: {},
      createdAt: now,
    });
    engine.handleSessionEvent({
      eventId: `${sessionId}-done-${sequence}`,
      sessionId,
      sequence,
      type: "turn_complete",
      payload: {},
      createdAt: now,
    });
    store.transitionSession(sessionId, "idle");
  };

  return {
    store,
    service,
    engine,
    node,
    placement,
    workspace,
    commands,
    planned,
    finishTurn,
  };
}

describe("OrchestratorEngine", () => {
  it("writes the receipt before the command, and owns the session it starts", () => {
    const { store, engine, commands, planned } = setup();
    const run = planned([
      { stepKey: "audit", title: "Audit", prompt: "audit it", category: "explore" },
    ]);

    engine.tickRun(run.id);

    const step = store.listRunSteps(run.id)[0]!;
    expect(step.state).toBe("starting");
    expect(step.dispatchedAt).not.toBe("");
    expect(step.placementId).not.toBe("");

    const started = commands("start_session");
    expect(started).toHaveLength(1);
    // The command carries the first prompt itself; a second would race it.
    expect(started[0]?.prompt).toBe("audit it");
    expect(commands("prompt")).toHaveLength(0);

    const session = store.getSession(step.sessionId)!;
    expect(session.runId).toBe(run.id);
    expect(session.runRole).toBe("worker");
    // Read-only work does not decide where the run lives: an explore changes
    // nothing, so pinning to it would strand the run on an unrelated checkout.
    expect(store.getRun(run.id)?.placementId).toBe("");
  });

  it("pins the run to the checkout the first writing step landed on", () => {
    const { store, engine, planned } = setup();
    const run = planned([
      { stepKey: "impl", title: "Implement", prompt: "write it", category: "implement" },
    ]);

    engine.tickRun(run.id);

    const step = store.listRunSteps(run.id)[0]!;
    expect(step.placementId).not.toBe("");
    // This is what a later reviewer has to be sent to in order to see a diff.
    expect(store.getRun(run.id)?.placementId).toBe(step.placementId);
  });

  it("puts a step back in the queue when the command could not be sent", () => {
    const { store, engine, planned } = setup({ attach: false });
    const run = planned([{ stepKey: "audit", title: "Audit", prompt: "audit it" }]);

    engine.tickRun(run.id);

    // Nothing is running, so the step is not blamed for a failure that happened
    // before it started.
    expect(store.listRunSteps(run.id)[0]?.state).toBe("pending");
  });

  it("only calls a step done once the turn completed and the agent went idle", () => {
    const { store, engine, planned, finishTurn } = setup();
    const run = planned([{ stepKey: "audit", title: "Audit", prompt: "audit it" }]);
    engine.tickRun(run.id);
    const sessionId = store.listRunSteps(run.id)[0]!.sessionId;

    store.transitionSession(sessionId, "starting");
    store.transitionSession(sessionId, "running");
    engine.tickRun(run.id);
    expect(store.listRunSteps(run.id)[0]?.state).toBe("running");

    finishTurn(sessionId, "the audit found three problems");
    engine.tickRun(run.id);

    const settled = store.listRunSteps(run.id)[0]!;
    expect(settled.state).toBe("succeeded");
    expect(settled.output).toContain("three problems");
    expect(store.getRun(run.id)?.settleSeq).toBe(1);
  });

  it("runs a dependent step only after its dependency succeeds, then finishes", () => {
    const { store, engine, planned, finishTurn, commands } = setup();
    const run = planned([
      { stepKey: "audit", title: "Audit", prompt: "audit it", category: "explore" },
      { stepKey: "fix", title: "Fix", prompt: "fix it", category: "implement" },
    ]);
    store.replaceRunSteps(run.id, [
      { stepKey: "audit", title: "Audit", prompt: "audit it", category: "explore" },
      {
        stepKey: "fix",
        title: "Fix",
        prompt: "fix it",
        category: "implement",
        dependsOn: ["audit"],
      },
    ]);

    engine.tickRun(run.id);
    const audit = store.listRunSteps(run.id).find((s) => s.stepKey === "audit")!;
    expect(store.listRunSteps(run.id).find((s) => s.stepKey === "fix")?.state).toBe(
      "pending",
    );

    finishTurn(audit.sessionId, "found it");
    engine.tickRun(run.id);

    const fix = store.listRunSteps(run.id).find((s) => s.stepKey === "fix")!;
    expect(fix.state).toBe("starting");
    // Reviewers and later steps share the checkout the run was pinned to.
    expect(fix.placementId).toBe(store.getRun(run.id)?.placementId);

    finishTurn(fix.sessionId, "fixed it");
    engine.tickRun(run.id);

    expect(store.getRun(run.id)?.state).toBe("completed");
    // Completed tasks keep their workers attached until archive or delete.
    expect(commands("stop")).toHaveLength(0);
  });

  it("does not settle anything while the fleet is offline", () => {
    const { store, service, engine, node, planned, finishTurn } = setup();
    const run = planned([{ stepKey: "audit", title: "Audit", prompt: "audit it" }]);
    engine.tickRun(run.id);
    const sessionId = store.listRunSteps(run.id)[0]!.sessionId;
    finishTurn(sessionId, "done");

    // A Host that just restarted has heard from nobody: offline is unknown, and
    // concluding from it would fail live work.
    service.disconnectNode(node.id, "Host restarted");
    engine.tickRun(run.id);

    expect(store.listRunSteps(run.id)[0]?.state).not.toBe("succeeded");
    expect(store.getRun(run.id)?.state).toBe("running");
  });

  it("fails a dispatch the node never acknowledged", () => {
    const { store, engine, planned } = setup();
    const run = planned([{ stepKey: "audit", title: "Audit", prompt: "audit it" }]);
    engine.tickRun(run.id);
    const step = store.listRunSteps(run.id)[0]!;
    expect(step.state).toBe("starting");

    // Long past the dispatch deadline, on a node that is plainly reachable.
    engine.tickRun(run.id, Date.now() + 10 * 60 * 1000);
    expect(store.listRunSteps(run.id)[0]?.state).toBe("failed");
  });
});

describe("OrchestratorEngine held messages", () => {
  /** A lead session on the fixture's node, with a message owed to it. */
  const withLead = (pendingPrompt: string) => {
    const kit = setup();
    const lead = kit.store.createSession(kit.placement, "orchestrate", false, "", {
      runRole: "lead",
    });
    kit.store.transitionSession(lead.id, "starting");
    kit.store.transitionSession(lead.id, "running");
    kit.store.transitionSession(lead.id, "idle");
    const run = kit.store.createRun({
      workspaceId: kit.workspace.id,
      name: "task",
      objective: "do it",
    });
    kit.store.updateRun(run.id, {
      state: "running",
      leadSessionId: lead.id,
      pendingPrompt,
    });
    return { ...kit, lead, runId: run.id };
  };

  it("hands the message over and forgets it, so it is never sent twice", () => {
    const { store, engine, commands, runId } = withLead("here is a new task");

    engine.tick();

    expect(commands("prompt").map((command) => command.prompt)).toEqual([
      "here is a new task",
    ]);
    expect(store.getRun(runId)?.pendingPrompt).toBe("");

    // A second tick has nothing owed and must stay silent, or every tick would
    // re-send the brief for as long as the task lived.
    engine.tick();
    expect(commands("prompt")).toHaveLength(1);
  });

  it("keeps the message until the orchestrator is free", () => {
    const { store, engine, commands, lead, runId } = withLead("read this");
    store.transitionSession(lead.id, "running");

    engine.tick();

    expect(commands("prompt")).toHaveLength(0);
    // Still owed — this is the whole difference from dispatching and hoping.
    expect(store.getRun(runId)?.pendingPrompt).toBe("read this");

    store.transitionSession(lead.id, "idle");
    engine.tick();
    expect(commands("prompt").map((command) => command.prompt)).toEqual(["read this"]);
  });

  it("sends one prompt per tick when two tasks share an orchestrator", () => {
    /*
     * A tick walks every run and re-reads sessions, but a lead just prompted is
     * still recorded idle — `running` only comes back from the Node afterwards.
     * Both runs would otherwise send, and Copilot refuses the second.
     */
    const { store, engine, commands, lead, workspace } = withLead("first task");
    const second = store.createRun({
      workspaceId: workspace.id,
      name: "other",
      objective: "also do it",
    });
    store.updateRun(second.id, {
      state: "running",
      leadSessionId: lead.id,
      pendingPrompt: "second task",
    });

    engine.tick();

    expect(commands("prompt")).toHaveLength(1);
    // The one that lost keeps its message rather than losing it.
    const held = store
      .listRuns()
      .map((run) => run.pendingPrompt)
      .filter(Boolean);
    expect(held).toHaveLength(1);

    store.transitionSession(lead.id, "idle");
    engine.tick();
    expect(
      commands("prompt")
        .map((command) => command.prompt)
        .sort(),
    ).toEqual(["first task", "second task"]);
  });
});

describe("OrchestratorEngine status checks", () => {
  const createLead = (kit: ReturnType<typeof setup>, prompt = "orchestrate") => {
    const lead = kit.store.createSession(kit.placement, prompt, false, "", {
      runRole: "lead",
    });
    kit.store.transitionSession(lead.id, "starting");
    kit.store.transitionSession(lead.id, "running");
    return kit.store.transitionSession(lead.id, "idle");
  };

  const assignTask = (
    kit: ReturnType<typeof setup>,
    leadSessionId: string,
    name: string,
  ) => {
    const created = kit.store.createRun({
      workspaceId: kit.workspace.id,
      name,
      objective: name,
      policy: { wakePolicy: "on_any_settle" },
    });
    return kit.store.updateRun(created.id, {
      state: "running",
      leadSessionId,
    })!;
  };

  it("checks an idle Lead every 30 minutes, not on every deadline sweep", () => {
    const kit = setup();
    const lead = createLead(kit);
    assignTask(kit, lead.id, "Active task");
    const baseline = Date.parse(kit.store.getSession(lead.id)!.updatedAt);

    kit.engine.tick(baseline + ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS - 1);
    expect(kit.commands("prompt")).toHaveLength(0);

    kit.engine.tick(baseline + ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS);
    expect(kit.commands("prompt")).toHaveLength(1);

    kit.engine.tick(baseline + 2 * ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS - 1);
    expect(kit.commands("prompt")).toHaveLength(1);

    kit.engine.tick(baseline + 2 * ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS);
    expect(kit.commands("prompt")).toHaveLength(2);
  });

  it("does nothing when every assigned task is done or waiting for review", () => {
    const kit = setup();
    const lead = createLead(kit);
    const review = assignTask(kit, lead.id, "Waiting for review");
    const done = assignTask(kit, lead.id, "Done");
    kit.store.updateRun(review.id, { state: "awaiting_human" });
    kit.store.updateRun(done.id, { state: "completed" });

    kit.engine.tick(
      Date.parse(kit.store.getSession(lead.id)!.updatedAt) +
        ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS,
    );

    expect(kit.commands("prompt")).toHaveLength(0);
  });

  it("does not interrupt a Lead that is already in a turn", () => {
    const kit = setup();
    const lead = createLead(kit);
    assignTask(kit, lead.id, "Active task");
    kit.store.transitionSession(lead.id, "running");

    kit.engine.tick(
      Date.parse(kit.store.getSession(lead.id)!.updatedAt) +
        ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS,
    );

    expect(kit.commands("prompt")).toHaveLength(0);
  });

  it("keeps each conversation's reminder scoped to its assigned tasks", () => {
    const kit = setup();
    const first = createLead(kit, "first");
    const second = createLead(kit, "second");
    assignTask(kit, first.id, "First lead task");
    assignTask(kit, second.id, "Second lead task");
    const due =
      Math.max(
        Date.parse(kit.store.getSession(first.id)!.updatedAt),
        Date.parse(kit.store.getSession(second.id)!.updatedAt),
      ) + ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS;

    kit.engine.tick(due);

    const prompts = kit.commands("prompt");
    expect(prompts).toHaveLength(2);
    const firstPrompt = prompts.find((command) => command.sessionId === first.id)?.prompt;
    const secondPrompt = prompts.find(
      (command) => command.sessionId === second.id,
    )?.prompt;
    expect(firstPrompt).toContain("First lead task");
    expect(firstPrompt).not.toContain("Second lead task");
    expect(secondPrompt).toContain("Second lead task");
    expect(secondPrompt).not.toContain("First lead task");
  });

  it("prompts only the Lead and never interrupts a dispatched worker", () => {
    const kit = setup();
    const lead = createLead(kit);
    const run = assignTask(kit, lead.id, "Long-running task");
    kit.store.upsertRunStep(run.id, {
      stepKey: "step-1",
      title: "Keep working",
      prompt: "work",
      category: "implement",
    });
    kit.engine.tickRun(run.id);
    const worker = kit.store.getSession(kit.store.listRunSteps(run.id)[0]!.sessionId)!;
    kit.store.transitionSession(worker.id, "starting");
    kit.store.transitionSession(worker.id, "running");
    kit.engine.tickRun(run.id);

    kit.engine.tick(
      Date.parse(kit.store.getSession(lead.id)!.updatedAt) +
        ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS,
    );

    expect(kit.commands("prompt")).toHaveLength(1);
    expect(kit.commands("prompt")[0]?.sessionId).toBe(lead.id);
    expect(kit.commands("prompt")[0]?.prompt).toContain("read-only check");
    expect(kit.commands("stop")).toHaveLength(0);
  });

  it("lets an owed task brief take priority over the periodic reminder", () => {
    const kit = setup();
    const lead = createLead(kit);
    const run = assignTask(kit, lead.id, "New task");
    kit.store.updateRun(run.id, { pendingPrompt: "read the new task brief" });
    const due =
      Date.parse(kit.store.getSession(lead.id)!.updatedAt) +
      ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS;

    kit.engine.tick(due);

    expect(kit.commands("prompt").map((command) => command.prompt)).toEqual([
      "read the new task brief",
    ]);

    // The brief itself resets the 30-minute clock, even before the Node reports
    // the Lead as running.
    kit.engine.tick(due + ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS - 1);
    expect(kit.commands("prompt")).toHaveLength(1);

    kit.engine.tick(due + ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS);
    expect(kit.commands("prompt")).toHaveLength(2);
    expect(kit.commands("prompt")[1]?.prompt).toContain("<fleet-status-check");
  });
});

describe("truncateMiddle", () => {
  it("keeps the tail, because that is where a failure says why", () => {
    const text = `${"a".repeat(500)}Error: the thing exploded`;
    const clipped = truncateMiddle(text, 100);
    expect(clipped.length).toBeLessThan(text.length);
    expect(clipped).toContain("Error: the thing exploded");
    expect(clipped).toContain("elided");
  });

  it("leaves short output alone", () => {
    expect(truncateMiddle("short", 100)).toBe("short");
  });
});

describe("runSweepInterval", () => {
  it("never sweeps less often than the deadline it has to enforce", () => {
    // A sweep slower than the deadline would let a stranded step sit past it.
    expect(runSweepInterval(10_000)).toBeLessThanOrEqual(10_000);
    // And it never becomes a busy loop on a very short deadline.
    expect(runSweepInterval(100)).toBe(5_000);
    expect(runSweepInterval(600_000)).toBe(30_000);
  });
});
