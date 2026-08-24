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
 * Ends a task and clears away the sessions it started.
 *
 * Distinct from cancelling, which stops the work and leaves everything where it
 * is. Archiving is what is done when nobody is going to look again: the record
 * — the task, its phases, its steps and the notes and output it collected —
 * stays, and the worker sessions stop cluttering the tree.
 *
 * Deliberately not a delete. What a task learned is often the only thing worth
 * keeping from work that did not pan out, and it lives on the run rather than
 * in the sessions.
 */
export function archiveRun(service: FleetService, runId: string, reason: string): void {
  const { store } = service;
  const run = store.getRun(runId);
  if (!run) return;

  if (!terminalRunStates.has(run.state)) {
    stopRunSessions(service, runId);
    for (const step of store.listRunSteps(runId)) {
      if (["succeeded", "failed", "skipped", "cancelled"].includes(step.state)) continue;
      store.updateRunStep(step.id, { state: "cancelled" });
    }
    const cancelled = store.setRunState(runId, "cancelled", reason)!;
    service.publishRun(cancelled);
    service.publishRunSteps(runId, store.listRunSteps(runId));
  }

  /*
   * Settled here rather than waited for. `stop` has gone to the Node and its
   * own terminal event will follow, but whoever archived a task should not
   * watch its sessions linger while that arrives — and a Node that is offline
   * would never send it at all.
   */
  for (const session of store.listSessions()) {
    if (session.runId !== runId) continue;
    if (!terminalSessionStates.has(session.state)) {
      service.publishSession(store.transitionSession(session.id, "stopped", reason));
    }
    try {
      store.deleteSession(session.id);
    } catch {
      // One session that will not go is not a reason to leave the rest, and
      // the task is archived either way.
      continue;
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
    try {
      store.deleteSession(session.id);
    } catch {
      // One session that will not go is not a reason to keep the task.
      continue;
    }
  }
  store.deleteRun(runId);
  service.broadcast({ type: "snapshot", data: service.snapshot() });
  return true;
}
