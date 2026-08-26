import { terminalRunStates, terminalSessionStates } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";

/**
 * What ending a task actually does, in one place.
 *
 * Two callers reach these: a person, through `/api/runs/:id`, and the
 * orchestrator, through its MCP tools. They were written once for the person
 * and would have been written a second time for the orchestrator — at which
 * point "archive" would mean two subtly different things depending on who
 * asked, and the difference would only show up as a stranded session.
 *
 * What varies between the two is the *reason* and who is allowed to ask, and
 * both of those stay with the caller. What is here is the mechanics.
 */

/** Stops every session a run still holds. Idempotent, so cancel-then-delete is safe. */
export function stopRunSessions(service: FleetService, runId: string): void {
  for (const session of service.store.listSessions()) {
    if (session.runId !== runId) continue;
    if (terminalSessionStates.has(session.state)) continue;
    service.dispatch(session.nodeId, { type: "stop", sessionId: session.id });
  }
}

/**
 * Ends a task and parks the sessions it started.
 *
 * Distinct from cancelling, which stops the work and leaves the task active.
 * Archiving stops every worker and hides it with the ended task, but preserves
 * its Copilot session id and event log so reopening can continue the same
 * conversation instead of reconstructing its context in a replacement.
 *
 * Deliberately not a delete. What a task learned can live in both the run record
 * and a worker conversation; purging the task is the operation that removes both.
 */
export function archiveRun(service: FleetService, runId: string, reason: string): void {
  const { store } = service;
  const run = store.getRun(runId);
  if (!run) return;

  // Completed tasks keep their workers open for cheap revisits, so archive must
  // stop sessions even when the run itself is already terminal.
  stopRunSessions(service, runId);
  if (!terminalRunStates.has(run.state)) {
    for (const step of store.listRunSteps(runId)) {
      if (["succeeded", "failed", "skipped", "cancelled"].includes(step.state)) continue;
      store.updateRunStep(step.id, { state: "cancelled" });
    }
    const cancelled = store.setRunState(runId, "cancelled", reason)!;
    service.publishRun(cancelled);
    service.publishRunSteps(runId, store.listRunSteps(runId));
  }

  /*
   * Settled here rather than waited for. `stop` has gone to the Node and its own
   * terminal event will follow, but the stopped row is intentionally retained:
   * it releases capacity while keeping the agent id and transcript available to
   * `fleet_follow_up` after the task is reopened.
   */
  for (const session of store.listSessions()) {
    if (session.runId !== runId) continue;
    if (!terminalSessionStates.has(session.state)) {
      service.publishSession(store.transitionSession(session.id, "stopped", reason));
    }
  }
  service.broadcast({ type: "snapshot", data: service.snapshot() });
}

/**
 * Removes a task and everything it started.
 *
 * The honest opposite of archiving: archiving keeps what the work learned, this
 * keeps nothing. Its sessions go too — a run's workers cannot be found once the
 * run is gone, so leaving them would strand them in the tree with no way back
 * to why they exist.
 */
export function purgeRun(service: FleetService, runId: string): boolean {
  const { store } = service;
  if (!store.getRun(runId)) return false;
  // Sessions are stopped before the rows go, because a deleted run cannot stop
  // anything afterwards — there is nothing left to find them by.
  stopRunSessions(service, runId);
  for (const session of store.listSessions()) {
    if (session.runId !== runId) continue;
    if (!terminalSessionStates.has(session.state)) {
      store.transitionSession(session.id, "stopped", "Task deleted");
    }
    store.deleteSession(session.id);
  }
  store.deleteRun(runId);
  service.broadcast({ type: "snapshot", data: service.snapshot() });
  return true;
}
