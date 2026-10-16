import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecisionProviderSchema,
  WorkerExecutionProfilesSchema,
  type SessionEvent,
} from "@fleet/protocol";
import type { CommandRequest } from "../fleet-service.js";
import { WorkerModelRoutingService } from "../worker-model-routing.js";
import type { DecisionPayload } from "../decision-provider.js";
import { FleetStore } from "../store.js";
import { fleet } from "./fleet-harness.js";
import { FleetTools } from "./tools.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const profiles = WorkerExecutionProfilesSchema.parse([
  {
    id: "ordinary",
    name: "Ordinary",
    description: "Bounded ordinary implementation.",
    model: "worker-ordinary",
    reasoningEffort: "medium",
  },
  {
    id: "deep",
    name: "Deep",
    description: "Cross-component recovery and lifecycle.",
    model: "worker-deep",
    reasoningEffort: "high",
  },
]);
const input = {
  category: "implement" as const,
  title: "Repair recovery",
  task: "Routing task",
  deliverable: "A patch preserving recovery behavior",
  scope: "Recovery paths; no authentication redesign",
  verify: "Run the existing recovery regression checks",
};
function evaluation(payload: DecisionPayload) {
  const choices = Object.keys(payload.questions.profile.criteria);
  return {
    profileId: choices[0]!,
    probabilities: Object.fromEntries(
      choices.map((id, index) => [id, index === 0 ? 0.9 : 0.1]),
    ),
    returnedModel: "decision-model",
    usage: null,
  };
}

async function setup(mode: "off" | "shadow" | "route" = "route") {
  const f = fleet();
  const app = Fastify({ logger: false });
  f.store.setDefaultModel("default-worker");
  f.store.setDefaultReasoningEffort("low");
  const evaluate = vi.fn(async (_provider, _key, payload: DecisionPayload) =>
    evaluation(payload),
  );
  const routing = new WorkerModelRoutingService(f.store, app.log, undefined, {
    evaluate,
    rateIntervalMs: 0,
  });
  f.service.workerModelRouting = routing;
  const provider = DecisionProviderSchema.parse({
    id: "decision",
    name: "Decision",
    kind: "foundry",
    endpoint: "https://demo.services.ai.azure.com",
    model: "Exact-Deployment",
  });
  const result = await routing.test(
    { provider, keyAction: "replace", key: "private-integration-fixture-key" },
    "operator:",
  );
  await routing.update(
    {
      expectedRevision: 0,
      mode,
      minProbability: 0.5,
      timeoutMs: 5000,
      profiles,
      providers: [{ provider, keyAction: "replace", testToken: result.testToken }],
    },
    "operator:",
  );
  evaluate.mockClear();
  const commands: CommandRequest[] = [];
  const dispatch = f.service.dispatch.bind(f.service);
  vi.spyOn(f.service, "dispatch").mockImplementation((...args) => {
    commands.push(args[1]);
    if (
      args[1].type === "start_session" &&
      f.store.getSession(args[1].sessionId)?.runRole !== "lead"
    ) {
      const step = f.store.getRunStepBySession(args[1].sessionId);
      expect(step).toBeDefined();
      expect(step?.state).toBe("starting");
      expect(step?.eventSeqFrom).toBe(0);
    }
    return dispatch(...args);
  });
  cleanups.push(async () => {
    routing.reset();
    await app.close();
    f.store.close();
  });
  const tools = new FleetTools(f.service, f.leadId);
  const worker = () =>
    f.store
      .listSessions()
      .find((session) => session.runRole === "worker" || session.runRole === "reviewer")!;
  const event = (type: SessionEvent["type"], payload: SessionEvent["payload"]) => {
    const session = worker();
    const record: SessionEvent = {
      eventId: randomUUID(),
      sessionId: session.id,
      sequence: f.store.maxEventSequence(session.id) + 1,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    expect(f.service.handleEvent(record)).toBe(true);
    f.engine.handleSessionEvent(record);
  };
  return { ...f, app, routing, evaluate, tools, commands, worker, event };
}

describe("new-worker routing through admission and dispatch", () => {
  it("persists the requested pair and step association before sending the first command", async () => {
    const h = await setup();
    const result = await h.tools.startRoutedWork({
      ...input,
      context: "z".repeat(40_000),
    });
    expect(result.ok).toBe(true);
    const worker = h.worker();
    const step = h.store.getRunStepBySession(worker.id)!;
    expect(step.routing).toMatchObject({
      source: "decision",
      profileId: "ordinary",
      model: "worker-ordinary",
    });
    expect(worker.workerSelection).toMatchObject({
      model: "worker-ordinary",
      reasoningEffort: "medium",
      fallbackModel: "default-worker",
    });
    const start = h.commands.find(
      (command) => command.type === "start_session" && command.sessionId === worker.id,
    );
    expect(start).toMatchObject({
      type: "start_session",
      contextTier: "long_context",
      readOnly: false,
      config: [
        { id: "mode", value: "agent" },
        { id: "model", value: "worker-ordinary", fallback: "default-worker" },
        { id: "reasoning_effort", value: "medium", fallback: "low" },
      ],
    });
    if (start?.type !== "start_session") throw new Error("Worker was not started");
    expect(start.prompt).toContain("z".repeat(40_000));
    expect(JSON.stringify(h.evaluate.mock.calls[0]?.[2])).not.toContain("z".repeat(100));
    expect(JSON.stringify(h.commands)).not.toContain("private-integration-fixture-key");
  });

  it("gives the decision model the task's objective and phase from the database, and records the call against the run", async () => {
    const h = await setup();
    const run = h.store.createRun({
      workspaceId: h.store.getSession(h.leadId)!.workspaceId,
      name: "S07 authoring",
      objective: "Deliver one independently reviewed draft PR for S07",
      phases: ["Inspect", "Implement and verify", "Review and publish"],
    });
    h.store.updateRun(run.id, {
      leadSessionId: h.leadId,
      state: "running",
      phaseIndex: 1,
    });
    const result = await h.tools.startRoutedWork({
      ...input,
      task: run.id,
      deliverable: "A patch for 8536a1fcd0de149d659af95cd6a94abf8d348441",
      scope: "Only C:\\repo\\src\\recovery",
    });
    expect(result.ok, result.text).toBe(true);
    const payload = h.evaluate.mock.calls[0]?.[2];
    expect(payload?.state.task).toEqual({
      name: "S07 authoring",
      objective: "Deliver one independently reviewed draft PR for S07",
      phase: "2 of 3: Implement and verify",
      plan: "Inspect → Implement and verify → Review and publish",
    });
    expect(payload?.state.deliverable).toBe("A patch for <hash>");
    expect(payload?.state.scope).toBe("Only <path>");
    // The worker still receives the original brief, untouched.
    const start = h.commands.find((command) => command.type === "start_session");
    if (start?.type !== "start_session") throw new Error("Worker was not started");
    expect(start.prompt).toContain("8536a1fcd0de149d659af95cd6a94abf8d348441");
    expect(start.prompt).toContain("C:\\repo\\src\\recovery");

    const [call] = h.store.listWorkerRoutingCalls({ runId: run.id });
    expect(call).toMatchObject({
      runId: run.id,
      category: "implement",
      source: "decision",
      profileId: "ordinary",
    });
    expect(call?.request).toMatchObject({
      state: { task: { name: "S07 authoring" } },
    });
  });

  it("keeps Off behavior and ignores profile hints without creating snapshots", async () => {
    const h = await setup("off");
    const result = await h.tools.startRoutedWork({
      ...input,
      profile: "unknown-profile",
    });
    expect(result.ok).toBe(true);
    expect(h.worker().workerSelection).toBeUndefined();
    expect(h.store.getRunStepBySession(h.worker().id)?.routing).toBeUndefined();
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(result.text).not.toContain("Routing:");
  });

  it("uses ordinary defaults in Shadow and does not widen a read-only category", async () => {
    const h = await setup("shadow");
    expect((await h.tools.startRoutedWork(input)).ok).toBe(true);
    expect(h.worker().workerSelection).toMatchObject({
      source: "shadow",
      model: "default-worker",
    });
    const readOnly = await setup("route");
    expect(
      (
        await readOnly.tools.startRoutedWork({
          ...input,
          category: "explore",
          profile: "deep",
        })
      ).ok,
    ).toBe(true);
    expect(readOnly.worker()).toMatchObject({
      readOnly: true,
      workerSelection: { source: "explicit", model: "worker-deep" },
    });
    expect(readOnly.evaluate).not.toHaveBeenCalled();
  });

  it("uses description-based routing for read-only work without widening its permissions", async () => {
    const h = await setup();
    expect((await h.tools.startRoutedWork({ ...input, category: "explore" })).ok).toBe(
      true,
    );
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    expect(h.worker()).toMatchObject({
      readOnly: true,
      workerSelection: { source: "decision", model: "worker-ordinary" },
    });
  });

  it("rechecks task parallel limits after simultaneous decisions instead of starting duplicates", async () => {
    const h = await setup();
    const run = h.store.createRun({
      workspaceId: h.store.getSession(h.leadId)!.workspaceId,
      name: "One-slot task",
      objective: "One bounded implementation",
      policy: { maxParallel: 1 },
    });
    h.store.updateRun(run.id, { leadSessionId: h.leadId, state: "running" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.evaluate.mockImplementation(async (_provider, _key, payload) => {
      await gate;
      return evaluation(payload);
    });
    const first = h.tools.startRoutedWork({ ...input, task: run.id });
    const second = h.tools.startRoutedWork({
      ...input,
      task: run.id,
      title: "Another independent worker",
    });
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(2));
    release();
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.text).toContain("parallel limit");
    expect(h.store.listRunSteps(run.id)).toHaveLength(1);
    expect(h.commands.filter((command) => command.type === "start_session")).toHaveLength(
      1,
    );
  });

  it("does not start a worker after the task is cancelled during the decision wait", async () => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.evaluate.mockImplementation(async (_provider, _key, payload) => {
      await gate;
      return evaluation(payload);
    });
    const pending = h.tools.startRoutedWork(input);
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalled());
    const run = h.store.listRuns()[0]!;
    h.store.setRunState(run.id, "cancelled");
    release();
    expect((await pending).ok).toBe(false);
    expect(h.store.listRunSteps(run.id)).toHaveLength(0);
    expect(h.commands.filter((command) => command.type === "start_session")).toHaveLength(
      0,
    );
  });

  it("rejects inadmissible work without calling the provider", async () => {
    const h = await setup();
    const run = h.store.createRun({
      workspaceId: h.store.getSession(h.leadId)!.workspaceId,
      name: "Closed task",
      objective: "No dispatch allowed",
    });
    h.store.updateRun(run.id, { leadSessionId: h.leadId, state: "cancelled" });
    expect((await h.tools.startRoutedWork({ ...input, task: run.id })).ok).toBe(false);
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("fences an old decision request across restore even when the task and lead IDs survive", async () => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.evaluate.mockImplementation(async (_provider, _key, payload) => {
      await gate;
      return evaluation(payload);
    });
    const pending = h.tools.startRoutedWork(input);
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalled());
    const run = h.store.listRuns()[0]!;
    h.store.replaceHostBackup(h.store.exportHostBackup({ enrollmentToken: "" }));
    h.store.setNodeOnline(h.leadSubject.nodeId, true, 0);
    release();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.text).toContain("restored");
    expect(h.store.listRunSteps(run.id)).toHaveLength(0);
  });
});

describe("effective selection continuity and backup", () => {
  it("resumes a manually changed session with its own pair, not newer defaults", async () => {
    const h = await setup();
    await h.tools.startRoutedWork(input);
    h.event("state", { state: "starting", activity: "Starting ACP" });
    h.event("agent_session", { agentSessionId: "native-worker-id" });
    h.event("config", {
      options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          description: "",
          currentValue: "manual-model",
          choices: [{ value: "manual-model", name: "Manual", description: "" }],
        },
        {
          id: "reasoning_effort",
          name: "Effort",
          category: "thought_level",
          description: "",
          currentValue: "manual-effort",
          choices: [{ value: "manual-effort", name: "Manual effort", description: "" }],
        },
      ],
    });
    h.store.transitionSession(h.worker().id, "stopped", "Stopped for reconnect");
    h.store.setDefaultModel("later-default");
    h.store.setDefaultReasoningEffort("later-effort");
    h.evaluate.mockClear();
    const resumed = h.service.resumeSession(h.worker().id);
    expect(resumed.ok).toBe(true);
    expect(h.commands.find((command) => command.type === "resume_session")).toMatchObject(
      {
        config: [
          { id: "mode", value: "agent" },
          { id: "model", value: "manual-model" },
          { id: "reasoning_effort", value: "manual-effort" },
        ],
      },
    );
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("preserves the receipt on follow-up and records a Node fallback before prompting", async () => {
    const h = await setup();
    await h.tools.startRoutedWork(input);
    h.event("state", { state: "starting", activity: "Starting ACP" });
    h.event("agent_session", { agentSessionId: "native-worker-id" });
    h.event("system", { message: "Used defaults", workerModelRoutingFallback: true });
    const step = h.store.getRunStepBySession(h.worker().id)!;
    expect(step.routing?.workerFallbackReason).toBe("model_unavailable");
    expect(h.worker().workerSelection?.fallbackApplied).toBe(true);
    h.event("state", { state: "running", activity: "Working" });
    h.event("turn_complete", { stopReason: "end_turn" });
    h.event("state", { state: "idle", activity: "Done" });
    h.evaluate.mockClear();
    const follow = h.tools.followUp({
      sessionId: h.worker().id,
      prompt: "Revise the same patch and rerun its checks.",
    });
    expect(follow.ok, follow.text).toBe(true);
    expect(h.store.getRunStep(step.id)?.routing).toEqual(step.routing);
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("carries selections through backup while suspending external routing and dropping key authority", async () => {
    const h = await setup();
    await h.tools.startRoutedWork(input);
    const worker = h.worker();
    const step = h.store.getRunStepBySession(worker.id)!;
    const backup = h.store.exportHostBackup({ enrollmentToken: "" });
    const restored = new FleetStore(":memory:");
    cleanups.push(() => restored.close());
    restored.replaceHostBackup(backup);
    expect(restored.getSession(worker.id)?.workerSelection).toEqual(
      worker.workerSelection,
    );
    expect(restored.getRunStep(step.id)?.routing).toEqual(step.routing);
    expect(restored.getWorkerModelRouting().mode).toBe("off");
    expect(restored.getSetting("workerModelRouting.providerState")).toBe("{}");
    expect(JSON.stringify(backup)).not.toContain("private-integration-fixture-key");
  });

  it("keeps the debug record out of backups and clears it on restore and when its task is deleted", async () => {
    const h = await setup();
    await h.tools.startRoutedWork(input);
    const runId = h.store.listRuns()[0]!.id;
    expect(h.store.listWorkerRoutingCalls({ runId })).toHaveLength(1);
    expect(
      JSON.stringify(h.store.exportHostBackup({ enrollmentToken: "" })),
    ).not.toContain("worker_routing_calls");
    const restored = new FleetStore(":memory:");
    cleanups.push(() => restored.close());
    restored.recordWorkerRoutingCall({
      id: "stale",
      runId: "old",
      category: "implement",
      receipt: h.store.listWorkerRoutingCalls()[0]!.receipt,
    });
    restored.replaceHostBackup(h.store.exportHostBackup({ enrollmentToken: "" }));
    expect(restored.countWorkerRoutingCalls()).toBe(0);

    h.store.recordWorkerRoutingCall({
      id: "other",
      runId: "another-task",
      category: "implement",
      receipt: h.store.listWorkerRoutingCalls()[0]!.receipt,
    });
    h.store.deleteRun(runId);
    expect(h.store.listWorkerRoutingCalls({ runId })).toEqual([]);
    expect(h.store.listWorkerRoutingCalls({ runId: "another-task" })).toHaveLength(1);
  });
});
