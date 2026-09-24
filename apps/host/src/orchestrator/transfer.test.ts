import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecution, FleetSession, Run } from "@fleet/protocol";
import type { FleetStore } from "../store.js";
import type { FleetService } from "../fleet-service.js";
import { fleet } from "./fleet-harness.js";
import { OrchestratorEngine } from "./engine.js";
import { TaskTransferError, transferRun } from "./lifecycle.js";
import { FleetTools } from "./tools.js";

describe("transferring a task between orchestrators", () => {
  let store: FleetStore;
  let service: FleetService;
  let leadId: string;

  const idle = (id: string) => {
    store.transitionSession(id, "starting");
    store.transitionSession(id, "idle");
  };

  beforeEach(() => {
    const world = fleet();
    store = world.store;
    service = world.service;
    leadId = world.leadId;
    idle(leadId);
  });

  /** A second conversation, which is what a full one hands its work to. */
  const addLead = (name = "Fresh"): FleetSession => {
    const lead = store.createSession(
      store.listPlacements()[0]!,
      "orchestrate",
      true,
      name,
      {
        runRole: "lead",
      },
    );
    idle(lead.id);
    return store.getSession(lead.id)!;
  };

  const task = (name = "Ship it", owner = leadId, state: Run["state"] = "running") => {
    const run = store.createRun({
      workspaceId: store.getSession(leadId)!.workspaceId,
      name,
      objective: `${name}, carefully`,
      phases: ["Implement", "Review"],
    });
    return store.updateRun(run.id, { leadSessionId: owner, state })!;
  };

  const refusal = (act: () => unknown) => {
    try {
      act();
    } catch (error) {
      if (error instanceof TaskTransferError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  it("moves the task and briefs the receiving orchestrator with the handoff note", () => {
    const next = addLead();
    const run = task();

    const result = transferRun(service, run.id, next.id, {
      source: "operator",
      note: "Review is next; the worker already pushed.",
    });

    expect(result).toMatchObject({ changed: true, from: leadId });
    const moved = store.getRun(run.id)!;
    expect(moved.leadSessionId).toBe(next.id);
    expect(moved.pendingPrompt).toContain("<fleet-task-transfer");
    expect(moved.pendingPrompt).toContain(`taskId=${JSON.stringify(run.id)}`);
    expect(moved.pendingPrompt).toContain(`from="Orchestrator (${leadId})"`);
    expect(moved.pendingPrompt).toContain("Review is next; the worker already pushed.");
    expect(moved.pendingPrompt).toContain(`fleet_get_task with task "${run.id}"`);
    const note = store.listRunNotes(run.id).at(-1)!;
    expect(note).toMatchObject({
      kind: "lifecycle",
      source: "operator",
      summary: `Task transferred to Fresh (${next.id})`,
    });
    expect(note.body).toContain(
      `Transferred from Orchestrator (${leadId}) to Fresh (${next.id})`,
    );
    expect(note.body).toContain("Review is next; the worker already pushed.");
  });

  it("changes which orchestrator can see the task, and says where it went", () => {
    const next = addLead();
    const run = task();
    transferRun(service, run.id, next.id, { source: "operator" });

    const previous = new FleetTools(service, leadId);
    const refused = previous.getTask({ task: run.id });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain(`assigned to Fresh (${next.id})`);
    expect(refused.text).toContain("Do not recreate its work here");
    expect(previous.listWork({}).text).not.toContain(run.id);
    // A dispatch naming the task by ID must not open a replacement under the old owner.
    const dispatched = previous.startWork({
      category: "explore",
      title: "look",
      deliverable: "a list of what is in there",
      scope: "the whole checkout, read-only",
      verify: "list the directory and say what you saw",
      task: run.id,
    });
    expect(dispatched.ok).toBe(false);
    expect(store.listRuns()).toHaveLength(1);

    const receiving = new FleetTools(service, next.id);
    expect(receiving.getTask({ task: run.id }).ok).toBe(true);
    expect(receiving.listWork({}).text).toContain(run.id);
  });

  it("delivers the brief to the receiving orchestrator only", () => {
    const next = addLead();
    const run = task();
    transferRun(service, run.id, next.id, { source: "operator" });
    const dispatch = vi.spyOn(service, "dispatch");

    new OrchestratorEngine(service).tick();

    const prompts = dispatch.mock.calls
      .map((call) => call[1] as { type: string; sessionId?: string; prompt?: string })
      .filter((message) => message.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionId: next.id });
    expect(prompts[0]!.prompt).toContain("<fleet-task-transfer");
    expect(store.getRun(run.id)!.pendingPrompt).toBe("");
  });

  it("keeps what was owed and carries over what the previous orchestrator was never sent", () => {
    const next = addLead();
    const run = task();
    store.updateRun(run.id, { pendingPrompt: "Held send-back note" });
    const nodeId = store.getSession(leadId)!.nodeId;
    const wake = store.commands.enqueuePrompt({
      nodeId,
      key: `run-wake:${run.id}:1`,
      executions: [],
      delivery: { sessionId: leadId, prompt: "<fleet-wake>earlier result</fleet-wake>" },
    });
    store.commands.enqueuePrompt({
      nodeId,
      key: "status:unrelated",
      executions: [],
      delivery: { sessionId: leadId, prompt: "status check" },
    });

    transferRun(service, run.id, next.id, { source: "operator" });

    const owed = store.getRun(run.id)!.pendingPrompt;
    expect(owed.indexOf("<fleet-task-transfer")).toBe(0);
    expect(owed.indexOf("earlier result")).toBeGreaterThan(0);
    expect(owed.indexOf("Held send-back note")).toBeGreaterThan(
      owed.indexOf("earlier result"),
    );
    expect(store.commands.prompt(wake.delivery.deliveryId)?.state).toBe("orphaned");
    expect(store.commands.prompts(leadId).map((record) => record.key)).toEqual([
      "status:unrelated",
    ]);
  });

  it("moves a closed task without a brief nothing would ever deliver", () => {
    const next = addLead();
    const run = task("Done", leadId, "completed");

    transferRun(service, run.id, next.id, { source: "operator" });

    expect(store.getRun(run.id)).toMatchObject({
      leadSessionId: next.id,
      pendingPrompt: "",
      state: "completed",
    });
  });

  it("adopts a task nothing owns", () => {
    const next = addLead();
    const run = task("Orphan", "");

    const result = transferRun(service, run.id, next.id, { source: "operator" });

    expect(result).toMatchObject({ changed: true, from: "" });
    expect(store.getRun(run.id)!.leadSessionId).toBe(next.id);
    expect(store.listRunNotes(run.id).at(-1)!.body).toContain("it had no orchestrator");
  });

  it("treats a transfer to the current owner as done", () => {
    const run = task();

    const result = transferRun(service, run.id, leadId, { source: "operator" });

    expect(result.changed).toBe(false);
    expect(store.listRunNotes(run.id)).toEqual([]);
    expect(store.getRun(run.id)!.pendingPrompt).toBe("");
  });

  it("only hands work to a running orchestrator", () => {
    const run = task();
    const stopping = addLead("Stopping");
    store.setSessionControls(stopping.id, { stopRequested: true });
    const dismissed = addLead("Dismissed");
    store.setSessionControls(dismissed.id, { dismissed: true });
    const worker = store.createSession(store.listPlacements()[0]!, "work", false, "W", {
      runId: run.id,
      runRole: "worker",
    });

    for (const id of [stopping.id, dismissed.id])
      expect(
        refusal(() => transferRun(service, run.id, id, { source: "operator" })),
      ).toMatchObject({ statusCode: 409, code: "orchestrator_not_live" });
    expect(
      refusal(() => transferRun(service, run.id, worker.id, { source: "operator" })),
    ).toMatchObject({ statusCode: 404, code: "orchestrator_not_found" });
    expect(
      refusal(() => transferRun(service, "missing", leadId, { source: "operator" })),
    ).toMatchObject({ statusCode: 404, code: "task_not_found" });
    expect(store.getRun(run.id)!.leadSessionId).toBe(leadId);
    expect(store.listRunNotes(run.id)).toEqual([]);
  });

  it("waits for a command that may be changing the task's checkout", () => {
    const next = addLead();
    const run = task();
    store.commands.putFence({
      taskId: run.id,
      executionId: randomUUID(),
      revision: 1,
      state: "executing",
      changedAt: new Date().toISOString(),
    });

    expect(
      refusal(() => transferRun(service, run.id, next.id, { source: "operator" })),
    ).toMatchObject({ code: "command_task_fenced" });
    expect(store.getRun(run.id)!.leadSessionId).toBe(leadId);
  });

  it("refuses while a command the previous owner requested has not settled", () => {
    const next = addLead();
    const run = task();
    vi.spyOn(store.commands, "unsettled").mockReturnValue([
      { id: "execution-1", taskId: run.id, leadSessionId: leadId } as CommandExecution,
    ]);

    const error = refusal(() =>
      transferRun(service, run.id, next.id, { source: "operator" }),
    );

    expect(error).toMatchObject({ code: "command_unsettled" });
    expect(error.message).toContain("execution-1");
    expect(store.getRun(run.id)!.leadSessionId).toBe(leadId);
  });

  describe("through the fleet tools", () => {
    it("lets a fresh orchestrator take a task over by ID, without briefing itself", () => {
      const next = addLead();
      const run = task();

      const result = new FleetTools(service, next.id).transferTask({ task: run.id });

      expect(result.ok, result.text).toBe(true);
      expect(result.text).toContain(`You now own "Ship it" (task id: ${run.id})`);
      expect(result.text).toContain(`fleet_get_task with task "${run.id}"`);
      const moved = store.getRun(run.id)!;
      expect(moved.leadSessionId).toBe(next.id);
      expect(moved.pendingPrompt).not.toContain("<fleet-task-transfer");
      expect(store.listRunNotes(run.id).at(-1)).toMatchObject({
        source: "orchestrator",
        sessionId: next.id,
      });
      expect(store.listRunNotes(run.id).at(-1)!.body).toContain(
        "by the receiving orchestrator",
      );
    });

    it("lets a full orchestrator hand its own task on by name, with a note", () => {
      const next = addLead();
      const run = task();
      const dispatch = vi.spyOn(service, "dispatch");

      const result = new FleetTools(service, leadId).transferTask({
        task: "Ship it",
        to: next.id,
        note: "The reviewer asked for one more test.",
      });

      expect(result.ok, result.text).toBe(true);
      expect(result.text).toContain("The task is no longer yours");
      expect(store.getRun(run.id)!.leadSessionId).toBe(next.id);
      // The receiver is idle, so the brief goes out on the tick the tool runs.
      const briefed = dispatch.mock.calls
        .map((call) => call[1] as { type: string; sessionId?: string; prompt?: string })
        .find((message) => message.type === "prompt");
      expect(briefed).toMatchObject({ sessionId: next.id });
      expect(briefed!.prompt).toContain("The reviewer asked for one more test.");
      expect(briefed!.prompt).toContain(`from="Orchestrator (${leadId})"`);
    });

    it("names an orchestrator by a unique name, and refuses an ambiguous one", () => {
      const run = task();
      const named = addLead("Night shift");
      addLead("Orchestrator");

      const ambiguous = new FleetTools(service, leadId).transferTask({
        task: run.id,
        to: "orchestrator",
      });
      expect(ambiguous.ok).toBe(false);
      expect(ambiguous.text).toContain("ambiguous");
      expect(store.getRun(run.id)!.leadSessionId).toBe(leadId);

      const unknown = new FleetTools(service, leadId).transferTask({
        task: run.id,
        to: "Day shift",
      });
      expect(unknown.ok).toBe(false);
      expect(unknown.text).toContain("fleet_list_orchestrators");

      const moved = new FleetTools(service, leadId).transferTask({
        task: run.id,
        to: "night SHIFT",
      });
      expect(moved.ok, moved.text).toBe(true);
      expect(store.getRun(run.id)!.leadSessionId).toBe(named.id);
    });

    it("relays a refusal instead of throwing", () => {
      const run = task();
      const stopping = addLead();
      store.setSessionControls(stopping.id, { stopRequested: true });

      const result = new FleetTools(service, leadId).transferTask({
        task: run.id,
        to: stopping.id,
      });

      expect(result.ok).toBe(false);
      expect(result.text).toContain("orchestrator_not_live");
      expect(result.text).toContain('Nothing was changed for "Ship it"');
    });

    it("refuses a task it cannot find", () => {
      const result = new FleetTools(service, leadId).transferTask({ task: "Nope" });

      expect(result.ok).toBe(false);
      expect(result.text).toContain('No task matching "Nope"');
    });

    it("lists every conversation with the work it is responsible for", () => {
      const next = addLead();
      const open = task("Open work");
      task("Closed work", leadId, "completed");
      store.appendEvent({
        eventId: "usage-1",
        sessionId: next.id,
        sequence: store.maxEventSequence(next.id) + 1,
        type: "usage",
        payload: { contextTokens: 50_000, contextWindow: 200_000 },
        createdAt: new Date().toISOString(),
      });

      const listed = new FleetTools(service, next.id).listOrchestrators();

      expect(listed.ok).toBe(true);
      expect(listed.text).toContain(`"Orchestrator" (${leadId})`);
      expect(listed.text).toContain(`"Fresh" (${next.id}) — this conversation`);
      expect(listed.text).toContain(`${open.id}: "Open work" - running`);
      expect(listed.text).not.toContain("Closed work");
      expect(listed.text).toContain("closed tasks: 1");
      expect(listed.text).toContain("context 25% used");
    });
  });
});
