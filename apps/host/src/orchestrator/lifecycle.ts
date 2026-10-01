import {
  ORCHESTRATOR_STOP_REASON,
  terminalRunStates,
  terminalSessionStates,
  type FleetSession,
  type PrMaintenanceRegistration,
  type Run,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { transferEnvelope } from "./briefing.js";

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

export type StopSessionsResult = {
  matched: number;
  requested: number;
  alreadyStopping: number;
  alreadyTerminal: number;
};

/**
 * Requests Stop for a known set of sessions.
 *
 * Shared by one-task cleanup and the two bulk controls so every entry point has
 * the same idempotency and publishes the same durable Stop intent.
 */
export function stopSessions(
  service: FleetService,
  sessions: readonly FleetSession[],
): StopSessionsResult {
  for (const session of sessions)
    service.store.prMaintenance.pauseForSession(session.id, "Session Stop requested");
  for (const session of sessions) service.store.assertSessionMutable(session.id);
  const result: StopSessionsResult = {
    matched: sessions.length,
    requested: 0,
    alreadyStopping: 0,
    alreadyTerminal: 0,
  };
  for (const session of sessions) {
    if (terminalSessionStates.has(session.state)) {
      result.alreadyTerminal += 1;
      continue;
    }
    if (session.stopRequested) {
      result.alreadyStopping += 1;
      continue;
    }
    service.publishSession(
      service.store.setSessionControls(session.id, { stopRequested: true }),
    );
    service.dispatch(session.nodeId, { type: "stop", sessionId: session.id });
    result.requested += 1;
  }
  return result;
}

/** Stops every session a run still holds. Idempotent, so cancel-then-delete is safe. */
export function stopRunSessions(service: FleetService, runId: string): void {
  service.commands.revokeTask(runId);
  stopSessions(
    service,
    service.store.listSessions().filter((session) => session.runId === runId),
  );
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
export function archiveRun(
  service: FleetService,
  runId: string,
  reason: string,
  options: { stoppedByOrchestrator?: boolean } = {},
): void {
  const { store } = service;
  const run = store.getRun(runId);
  if (!run) return;

  store.prMaintenance.pauseForTask(runId, reason);
  const held =
    store.prMaintenance.admission({ taskId: runId, action: "discover" }).reason ===
    "wait_for_human";
  if (!held) service.resolveRunReview(runId);
  if (!terminalRunStates.has(run.state)) {
    const cancelled = store.cancelRunWithUnfinishedSteps(
      runId,
      reason,
      options.stoppedByOrchestrator ?? false,
    )!;
    service.publishRun(cancelled);
    service.publishRunSteps(runId, store.listRunSteps(runId));
  }
  // Persist the terminal run before sending commands, so no event or repeated
  // scheduler tick can dispatch a dependency after Stop has been accepted.
  // Completed tasks still stop retained workers when explicitly archived.
  stopRunSessions(service, runId);
  const cancelledRun = store.getRun(runId);
  if (
    cancelledRun?.state === "cancelled" &&
    cancelledRun?.workspaceBinding?.effectiveMode === "managed" &&
    cancelledRun.workspaceBinding.aggregationState !== "completed"
  )
    service.worktrees.beginFinalization(runId, "cancelled", reason);

  service.broadcast({ type: "snapshot", data: service.snapshot() });
}

/**
 * Restores only work that the orchestration stop operation cancelled.
 *
 * Stop no longer cancels a lead's tasks; this reopens the ones an older Host
 * cancelled that way, so a conversation stopped before the upgrade resumes
 * with its work rather than without it.
 *
 * Successful, failed, skipped, and independently-cancelled steps remain
 * terminal. Pending steps retain their worker session id so the scheduler uses
 * `session/load` and continues the same Copilot context.
 */
export function reopenOrchestratorStoppedRun(
  service: FleetService,
  runId: string,
): boolean {
  const { store } = service;
  const run = store.getRun(runId);
  if (
    !run ||
    run.state !== "cancelled" ||
    run.failureReason !== ORCHESTRATOR_STOP_REASON
  ) {
    return false;
  }
  store.prMaintenance.assertAdmission({ taskId: runId, action: "reopen" });
  const reopened = store.resumeOrchestratorStoppedRun(runId, ORCHESTRATOR_STOP_REASON);
  if (!reopened) return false;
  service.publishRun(reopened);
  service.publishRunSteps(runId, store.listRunSteps(runId));
  return true;
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
  store.prMaintenance.pauseForTask(runId, "Task deletion requested");
  store.prMaintenance.assertTaskCleanupAllowed(runId);
  store.assertWorktreePurgeAllowed(runId);
  service.resolveRunReview(runId);
  // Sessions are stopped before the rows go, because a deleted run cannot stop
  // anything afterwards — there is nothing left to find them by.
  stopRunSessions(service, runId);
  for (const session of store.listSessions()) {
    if (session.runId !== runId) continue;
    if (!terminalSessionStates.has(session.state)) {
      service.settleCommandedSession(session.id, "stopped", "Task deleted", false);
    }
    service.resolveSessionPermissionRequests(session.id);
    store.deleteSession(session.id);
  }
  store.deleteRun(runId);
  service.broadcast({ type: "snapshot", data: service.snapshot() });
  return true;
}

/** Why a task could not change hands, in words a route or a tool can relay. */
export class TaskTransferError extends Error {
  constructor(
    readonly statusCode: 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type TaskTransferOptions = {
  /** Who asked, for the task's history. */
  source: "operator" | "orchestrator";
  /** The orchestrator that asked, when one did. */
  actorSessionId?: string | undefined;
  /** What the receiving orchestrator should know that the record does not say. */
  note?: string | undefined;
  /**
   * Whether the receiving orchestrator is sent a brief. One taking a task over
   * itself already knows, and reads the same instructions in its tool result.
   */
  brief?: boolean | undefined;
};

export type TaskTransferResult = {
  run: Run;
  /** The orchestrator the task came from; empty for a task nothing owned. */
  from: string;
  /** False when the task was already there, which is not an error. */
  changed: boolean;
};

/** An orchestrator as the task history and the receiving conversation read it. */
export function orchestratorLabel(session: FleetSession | undefined, id = ""): string {
  if (!session) return id ? `orchestrator ${id}` : "no orchestrator";
  const name = session.name.replace(/\s+/g, " ").trim() || "Orchestrator";
  return `${name} (${session.id})`;
}

/** A task still needs an orchestrator while it is open or keeping a PR maintained. */
export function taskNeedsOrchestrator(service: FleetService, run: Run): boolean {
  return (
    !terminalRunStates.has(run.state) ||
    service.store.prMaintenance.list({ taskId: run.id, retainedOnly: true, limit: 1 })
      .records.length > 0
  );
}

function taskMaintenance(service: FleetService, taskId: string) {
  const records: PrMaintenanceRegistration[] = [];
  let cursor: string | undefined;
  do {
    const page = service.store.prMaintenance.list({
      taskId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}

/**
 * How much of what the previous owner was owed travels with the brief.
 *
 * The brief goes out as one prompt, and a durable delivery holds at most
 * 128 KiB; wakes that piled up unread must not be what makes it undeliverable.
 * The middle goes first, as it does for worker output: the record keeps all of
 * it, and the brief says to read the record.
 */
const CARRIED_PROMPT_CHARS = 24_000;

function carriedOver(owed: readonly string[]): string {
  const text = owed.join("\n\n");
  if (text.length <= CARRIED_PROMPT_CHARS) return text;
  const half = CARRIED_PROMPT_CHARS / 2;
  return [
    text.slice(0, half),
    "[… earlier notifications for this task were shortened here; fleet_get_task has the full record …]",
    text.slice(-half),
  ].join("\n\n");
}

/**
 * Reassigns a task, and everything that follows its owner, to another
 * orchestrator.
 *
 * A task belongs to exactly one orchestrator because the owner is what the
 * engine wakes and what PR maintenance's heartbeat claims work for: two owners
 * would be two heartbeats on one PR. So the run, its maintenance registrations
 * and a pending proposal move in one transaction, and nothing else about the
 * task changes — its workers, steps, checkout and budget stay where they are.
 *
 * Who may ask is deliberately not checked here. An operator moves tasks off a
 * conversation whose context is full; an orchestrator can hand work on or take
 * it over. What is checked is that the move is safe: the receiving
 * conversation is live, and no command the previous owner requested is still
 * touching the task, since its result would be delivered to the wrong one.
 *
 * The receiving orchestrator has none of the task's history, so it is owed a
 * brief — held on the run like any owed prompt, together with anything the
 * previous owner was owed and not yet sent. A closed task gets none: nothing is
 * delivered to a closed task, and an owed prompt there would only hold its
 * sessions back from retention.
 */
export function transferRun(
  service: FleetService,
  runId: string,
  toLeadSessionId: string,
  options: TaskTransferOptions,
): TaskTransferResult {
  const { store } = service;
  // The run broadcast carries the new owner; only a re-owned proposal changes
  // anything else a browser holds, so only that is worth a whole snapshot.
  let proposalMoved = false;
  const result = store.writeAtomically((): TaskTransferResult => {
    const run = store.getRun(runId);
    if (!run) throw new TaskTransferError(404, "task_not_found", "Task not found");
    const target = store.getSession(toLeadSessionId);
    if (!target || target.runRole !== "lead")
      throw new TaskTransferError(
        404,
        "orchestrator_not_found",
        "Orchestrator not found",
      );
    if (run.leadSessionId === target.id)
      return { run, from: run.leadSessionId, changed: false };
    if (
      terminalSessionStates.has(target.state) ||
      target.stopRequested ||
      target.cleanupRequested ||
      target.dismissed
    )
      throw new TaskTransferError(
        409,
        "orchestrator_not_live",
        "Tasks can only move to a running orchestrator. Resume or restore that conversation first, or start a new one.",
      );
    const fence = store.commands.fence(run.id);
    if (fence && ["executing", "observation_required"].includes(fence.state))
      throw new TaskTransferError(
        409,
        "command_task_fenced",
        "A command may still be changing this task's checkout. Wait for it to settle and be observed, then transfer the task.",
      );
    const recordIds = new Set(
      taskMaintenance(service, run.id).map((record) => record.id),
    );
    const commands = store.commands
      .unsettled()
      .filter(
        (execution) =>
          execution.leadSessionId !== target.id &&
          (execution.taskId === run.id ||
            (execution.maintenanceObservation &&
              recordIds.has(execution.maintenanceObservation.recordId))),
      );
    if (commands.length)
      throw new TaskTransferError(
        409,
        "command_unsettled",
        `This task has ${commands.length} unsettled command execution(s) (${commands
          .map((execution) => execution.id)
          .join(
            ", ",
          )}). Their results go to the orchestrator that requested them, so let them settle or cancel them, then transfer the task.`,
      );

    const from = run.leadSessionId;
    const previous = from ? store.getSession(from) : undefined;
    const open = !terminalRunStates.has(run.state);
    /*
     * What the previous owner was owed and has not been sent: a held brief or
     * send-back already moved off the run into its delivery queue, and a wake.
     * Anything already on its way to that conversation cannot be recalled; the
     * brief tells the new owner to read the record, which has all of it.
     */
    const owed: string[] = [];
    if (from) {
      for (const record of store.commands.prompts(from)) {
        if (
          !record.key.startsWith(`run-prompt:${run.id}:`) &&
          !record.key.startsWith(`run-wake:${run.id}:`)
        )
          continue;
        if (record.state !== "pending" && record.state !== "rejected_busy") continue;
        owed.push(record.delivery.prompt);
        store.commands.updatePrompt({ ...record, state: "orphaned" });
      }
    }
    const note = options.note?.trim() ?? "";
    const phase = run.phases[run.phaseIndex];
    const brief =
      open && options.brief !== false
        ? transferEnvelope({
            taskId: run.id,
            task: run.name,
            state: run.state,
            ...(phase
              ? { phase: `${phase} (${run.phaseIndex + 1}/${run.phases.length})` }
              : {}),
            ...(from ? { from: orchestratorLabel(previous, from) } : {}),
            ...(note ? { note } : {}),
          })
        : "";
    const pendingPrompt = open
      ? [brief, carriedOver(owed), run.pendingPrompt]
          .filter((part) => part.trim())
          .join("\n\n")
      : run.pendingPrompt;
    store.updateRun(run.id, {
      leadSessionId: target.id,
      ...(pendingPrompt !== run.pendingPrompt ? { pendingPrompt } : {}),
    });
    proposalMoved = Boolean(store.prMaintenance.getProposal(run.id));
    store.prMaintenance.transferTask(run.id, target.id);
    const actor =
      options.source === "operator"
        ? "an operator"
        : options.actorSessionId === target.id
          ? "the receiving orchestrator"
          : options.actorSessionId === from
            ? "the previous orchestrator"
            : `orchestrator ${options.actorSessionId ?? "(unknown)"}`;
    store.appendRunNote(
      run.id,
      run.phaseIndex,
      [
        from
          ? `**Transferred from ${orchestratorLabel(previous, from)} to ${orchestratorLabel(target)}** by ${actor}.`
          : `**Assigned to ${orchestratorLabel(target)}** by ${actor}; it had no orchestrator.`,
        "Its workers, pending review and PR maintenance moved with it; the previous orchestrator no longer sees it.",
        ...(note ? ["", "Handoff note:", "", note] : []),
      ].join("\n"),
      {
        summary: `Task transferred to ${orchestratorLabel(target)}`.slice(0, 240),
        kind: "lifecycle",
        source: options.source,
        ...(options.actorSessionId ? { sessionId: options.actorSessionId } : {}),
      },
    );
    return { run: store.getRun(run.id)!, from, changed: true };
  });
  if (result.changed) {
    service.publishRun(result.run);
    if (proposalMoved) service.publishSnapshot();
  }
  return result;
}
