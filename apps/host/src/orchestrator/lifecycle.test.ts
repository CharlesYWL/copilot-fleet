import { describe, expect, it, vi } from "vitest";
import { isResumableSession, ORCHESTRATOR_STOP_REASON } from "@fleet/protocol";
import { fleet } from "./fleet-harness.js";
import { OrchestratorEngine } from "./engine.js";
import { archiveRun, purgeRun, reopenOrchestratorStoppedRun } from "./lifecycle.js";

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
    store.updateNotificationPreference(session.id, session.id, true);
    const dispatch = vi.spyOn(service, "dispatch");

    archiveRun(service, run.id, "Archived after approval");

    expect(dispatch).toHaveBeenCalledWith(
      session.nodeId,
      expect.objectContaining({ type: "stop", sessionId: session.id }),
    );
    expect(store.getSession(session.id)).toMatchObject({
      state: "idle",
      stopRequested: true,
    });
    service.handleEvent({
      eventId: "stopped",
      sessionId: session.id,
      sequence: 2,
      type: "state",
      payload: { state: "stopped", activity: "Stopped" },
      createdAt: new Date().toISOString(),
    });
    const parked = store.getSession(session.id);
    expect(parked?.state).toBe("stopped");
    expect(parked?.stopRequested).toBe(false);
    expect(parked && isResumableSession(parked)).toBe(true);
    expect(store.listEvents(session.id).map((event) => event.type)).toEqual([
      "agent_session",
      "state",
    ]);
    expect(store.getRun(run.id)?.state).toBe("completed");
    expect(store.listNotifications().notifications).toEqual([]);
  });

  it("cancels only unfinished steps and resumes only those cancelled by Stop", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const run = store.createRun({
      workspaceId: placement.workspaceId,
      name: "Partially complete",
      objective: "continue safely",
    });
    const [done, active, blocked, independentlyCancelled] = store.replaceRunSteps(
      run.id,
      [
        { stepKey: "done", title: "Done", prompt: "done" },
        { stepKey: "active", title: "Active", prompt: "active", dependsOn: ["done"] },
        {
          stepKey: "blocked",
          title: "Blocked",
          prompt: "blocked",
          dependsOn: ["active"],
        },
        { stepKey: "cancelled", title: "Cancelled", prompt: "cancelled" },
      ],
    );
    store.setRunState(run.id, "running");
    store.updateRunStep(done!.id, { state: "succeeded", output: "kept" });
    store.updateRunStep(active!.id, { state: "running" });
    store.updateRunStep(independentlyCancelled!.id, { state: "cancelled" });

    archiveRun(service, run.id, ORCHESTRATOR_STOP_REASON, {
      stoppedByOrchestrator: true,
    });

    expect(store.getRun(run.id)).toMatchObject({
      state: "cancelled",
      failureReason: ORCHESTRATOR_STOP_REASON,
    });
    expect(store.getRunStep(done!.id)).toMatchObject({
      state: "succeeded",
      output: "kept",
      stoppedByOrchestrator: false,
    });
    expect(store.getRunStep(active!.id)).toMatchObject({
      state: "cancelled",
      stoppedByOrchestrator: true,
    });
    expect(store.getRunStep(blocked!.id)).toMatchObject({
      state: "cancelled",
      stoppedByOrchestrator: true,
    });
    expect(store.getRunStep(independentlyCancelled!.id)).toMatchObject({
      state: "cancelled",
      stoppedByOrchestrator: false,
    });

    expect(reopenOrchestratorStoppedRun(service, run.id)).toBe(true);
    expect(store.getRun(run.id)?.state).toBe("running");
    expect(store.getRunStep(done!.id)?.state).toBe("succeeded");
    expect(store.getRunStep(active!.id)).toMatchObject({
      state: "pending",
      stoppedByOrchestrator: false,
    });
    expect(store.getRunStep(blocked!.id)?.state).toBe("pending");
    expect(store.getRunStep(independentlyCancelled!.id)?.state).toBe("cancelled");
    expect(reopenOrchestratorStoppedRun(service, run.id)).toBe(false);
  });

  it("does not dispatch duplicate stops for a repeated archive", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const run = store.createRun({
      workspaceId: placement.workspaceId,
      name: "Stop once",
      objective: "stop once",
    });
    store.setRunState(run.id, "running");
    const session = store.createSession(placement, "work", false, "Worker", {
      runId: run.id,
      runRole: "worker",
    });
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "running");
    const dispatch = vi.spyOn(service, "dispatch");

    archiveRun(service, run.id, ORCHESTRATOR_STOP_REASON, {
      stoppedByOrchestrator: true,
    });
    archiveRun(service, run.id, ORCHESTRATOR_STOP_REASON, {
      stoppedByOrchestrator: true,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("lets a completed turn win a race with Stop without reopening the run", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const run = store.createRun({
      workspaceId: placement.workspaceId,
      name: "Racing completion",
      objective: "finish while stopping",
    });
    const [step] = store.replaceRunSteps(run.id, [
      { stepKey: "work", title: "Work", prompt: "work" },
    ]);
    store.setRunState(run.id, "running");
    const session = store.createSession(placement, "work", false, "Worker", {
      runId: run.id,
      runRole: "worker",
    });
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "running");
    store.updateRunStep(step!.id, {
      state: "running",
      sessionId: session.id,
      eventSeqFrom: 0,
    });
    const engine = new OrchestratorEngine(service);
    service.onSessionEvent((event) => engine.handleSessionEvent(event));

    archiveRun(service, run.id, ORCHESTRATOR_STOP_REASON, {
      stoppedByOrchestrator: true,
    });
    service.handleEvent({
      eventId: "text",
      sessionId: session.id,
      sequence: 1,
      type: "agent_text",
      payload: { text: "finished output" },
      createdAt: new Date().toISOString(),
    });
    service.handleEvent({
      eventId: "complete",
      sessionId: session.id,
      sequence: 2,
      type: "turn_complete",
      payload: {},
      createdAt: new Date().toISOString(),
    });
    service.handleEvent({
      eventId: "stopped",
      sessionId: session.id,
      sequence: 3,
      type: "state",
      payload: { state: "stopped", activity: "Stopped after completion" },
      createdAt: new Date().toISOString(),
    });

    expect(store.getRun(run.id)?.state).toBe("cancelled");
    expect(store.getRunStep(step!.id)).toMatchObject({
      state: "succeeded",
      output: "finished output",
      stoppedByOrchestrator: false,
    });
    expect(store.listNotifications().notifications).toEqual([]);
  });

  it("notifies when a stopped step reports a late authoritative failure", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const run = store.createRun({
      workspaceId: placement.workspaceId,
      name: "Racing failure",
      objective: "fail while stopping",
    });
    const [step] = store.replaceRunSteps(run.id, [
      { stepKey: "work", title: "Risky work", prompt: "work" },
    ]);
    store.setRunState(run.id, "running");
    const session = store.createSession(placement, "work", false, "Worker", {
      runId: run.id,
      runRole: "worker",
    });
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "running");
    store.updateRunStep(step!.id, {
      state: "running",
      sessionId: session.id,
      eventSeqFrom: 0,
    });
    const engine = new OrchestratorEngine(service);
    service.onSessionEvent((event) => engine.handleSessionEvent(event));

    archiveRun(service, run.id, ORCHESTRATOR_STOP_REASON, {
      stoppedByOrchestrator: true,
    });
    service.handleEvent({
      eventId: "failed",
      sessionId: session.id,
      sequence: 1,
      type: "state",
      payload: { state: "failed", activity: "Worker failed during Stop" },
      createdAt: new Date().toISOString(),
    });

    expect(store.getRun(run.id)?.state).toBe("cancelled");
    expect(store.getRunStep(step!.id)).toMatchObject({
      state: "failed",
      stoppedByOrchestrator: false,
    });
    expect(store.listNotifications().notifications).toMatchObject([
      {
        kind: "orchestration_step_failure",
        data: { runId: run.id, stepId: step!.id, attempts: 1 },
      },
    ]);
  });

  it("reissues persisted stop intent on reconnect and settles missing sessions", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const session = store.createSession(placement, "work");
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "running");
    store.setSessionControls(session.id, { stopRequested: true });
    store.markNodeSessionsOffline(session.nodeId, "Disconnected");
    const dispatch = vi.spyOn(service, "dispatch");

    service.reconcile(session.nodeId, [session.id], [session.id]);

    expect(store.getSession(session.id)).toMatchObject({
      state: "running",
      stopRequested: true,
    });
    expect(dispatch).toHaveBeenCalledWith(session.nodeId, {
      type: "stop",
      sessionId: session.id,
    });
    service.reconcile(session.nodeId, [session.id], [session.id]);
    expect(
      dispatch.mock.calls.filter(([, command]) => command.type === "stop"),
    ).toHaveLength(1);

    store.markNodeSessionsOffline(session.nodeId, "Disconnected again");
    service.reconcile(session.nodeId, []);
    expect(store.getSession(session.id)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
  });

  it("clears stale Stop intent from a terminal session without redispatching", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const session = store.createSession(placement, "work");
    store.transitionSession(session.id, "stopped");
    store.setSessionControls(session.id, { stopRequested: true });
    const dispatch = vi.spyOn(service, "dispatch");

    service.reconcile(session.nodeId, [session.id]);

    expect(store.getSession(session.id)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("settles a persisted Stop when a non-offline session disappears", () => {
    const { store, service } = fleet();
    const placement = store.listPlacements()[0]!;
    const session = store.createSession(placement, "work");
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "running");
    store.setSessionControls(session.id, { stopRequested: true });
    const dispatch = vi.spyOn(service, "dispatch");

    service.reconcile(session.nodeId, [session.id], [session.id]);
    expect(store.getSession(session.id)).toMatchObject({
      state: "running",
      stopRequested: true,
    });
    expect(dispatch).not.toHaveBeenCalled();

    service.reconcile(session.nodeId, []);
    expect(store.getSession(session.id)).toMatchObject({
      state: "stopped",
      stopRequested: false,
    });
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
    service.handleEvent({
      eventId: "permission",
      sessionId: session.id,
      sequence: 1,
      type: "permission",
      payload: { requestId: "request-1" },
      createdAt: new Date().toISOString(),
    });
    const permission = store.listNotifications().notifications[0]!;
    expect(permission.status).toBe("active");

    expect(purgeRun(service, run.id)).toBe(true);

    expect(store.getSession(session.id)).toBeUndefined();
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.getNotification(permission.id)?.status).toBe("resolved");
  });

  it("resolves an active review when a task is archived or purged", () => {
    const archived = fleet();
    const archivedRun = archived.store.createRun({
      workspaceId: archived.store.listWorkspaces()[0]!.id,
      name: "Archive review",
      objective: "archive it",
    });
    archived.store.setRunState(archivedRun.id, "running");
    archived.service.requestRunReview({
      runId: archivedRun.id,
      note: "ready",
      reason: "completed",
    });

    archiveRun(archived.service, archivedRun.id, "Archived by a person");
    expect(
      archived.store.getNotificationBySourceKey(`review:${archivedRun.id}:1`),
    ).toMatchObject({ status: "resolved" });

    const purged = fleet();
    const purgedRun = purged.store.createRun({
      workspaceId: purged.store.listWorkspaces()[0]!.id,
      name: "Purge review",
      objective: "purge it",
    });
    purged.store.setRunState(purgedRun.id, "running");
    purged.service.requestRunReview({
      runId: purgedRun.id,
      note: "ready",
      reason: "completed",
    });

    expect(purgeRun(purged.service, purgedRun.id)).toBe(true);
    expect(
      purged.store.getNotificationBySourceKey(`review:${purgedRun.id}:1`),
    ).toMatchObject({ status: "resolved" });
  });
});
