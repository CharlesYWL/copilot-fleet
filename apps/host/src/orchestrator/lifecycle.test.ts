import { describe, expect, it, vi } from "vitest";
import { isResumableSession } from "@fleet/protocol";
import { fleet } from "./fleet-harness.js";
import { archiveRun, purgeRun } from "./lifecycle.js";

describe("orchestrator task lifecycle", () => {
  it("stops workers when an already-completed task is archived", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const run = store.createRun({
      workspaceId: placement.workspaceId,
      name: "Finished task",
      objective: "finish it",
    });
    store.setRunState(run.id, "running");
    store.setRunState(run.id, "completed");
    const session = store.createSession(placement, "work", false, "Worker", {
      runId: run.id,
      runRole: "worker",
    });
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "idle");
    store.appendEvent({
      eventId: "agent-session",
      sessionId: session.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "copilot-worker-1" },
      createdAt: new Date().toISOString(),
    });
    const dispatch = vi.spyOn(service, "dispatch");

    archiveRun(service, run.id, "Archived after approval");

    expect(dispatch).toHaveBeenCalledWith(
      session.nodeId,
      expect.objectContaining({ type: "stop", sessionId: session.id }),
    );
    const parked = store.getSession(session.id);
    expect(parked?.state).toBe("stopped");
    expect(parked && isResumableSession(parked)).toBe(true);
    expect(store.listEvents(session.id)).toHaveLength(1);
    expect(store.getRun(run.id)?.state).toBe("completed");
  });

  it("deletes retained workers before purging their task", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const run = store.createRun({
      workspaceId: placement.workspaceId,
      name: "Delete task",
      objective: "delete it",
    });
    store.setRunState(run.id, "running");
    store.setRunState(run.id, "completed");
    const session = store.createSession(placement, "work", false, "Worker", {
      runId: run.id,
      runRole: "worker",
    });
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "idle");

    expect(purgeRun(service, run.id)).toBe(true);

    expect(store.getSession(session.id)).toBeUndefined();
    expect(store.getRun(run.id)).toBeUndefined();
  });
});
