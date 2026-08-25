import { describe, expect, it, vi } from "vitest";
import { fleet } from "./fleet-harness.js";
import { archiveRun } from "./lifecycle.js";

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
    const dispatch = vi.spyOn(service, "dispatch");

    archiveRun(service, run.id, "Archived after approval");

    expect(dispatch).toHaveBeenCalledWith(
      session.nodeId,
      expect.objectContaining({ type: "stop", sessionId: session.id }),
    );
    expect(store.getSession(session.id)).toBeUndefined();
    expect(store.getRun(run.id)?.state).toBe("completed");
  });
});
