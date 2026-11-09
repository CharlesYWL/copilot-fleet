import type { Run } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { owedPrompt } from "./briefing.js";
import { reviewOutcome, type ReviewInput } from "./review.js";

/** Who answered: the person in the browser, or the operator's local agent. */
export type TaskReviewer =
  { kind: "operator" } | { kind: "local_agent"; clientLabel?: string | undefined };

export type TaskReviewResult =
  | { kind: "not_found" }
  | { kind: "not_waiting" }
  | { kind: "needs_reason" }
  | { kind: "approved"; run: Run }
  | { kind: "sent_back"; run: Run };

function byline(reviewer: TaskReviewer): string {
  if (reviewer.kind === "operator") return "a person";
  return reviewer.clientLabel
    ? `the operator's local agent ("${reviewer.clientLabel}")`
    : "the operator's local agent";
}

/**
 * Answers a task the orchestrator handed over for review.
 *
 * The browser's approve/send-back and a local agent the operator allowed to
 * review both come through here, so the two can never drift: approving closes
 * the task (or starts a managed task's aggregation — publishing stays a
 * separate approval); sending back reopens it with the note owed to the
 * orchestrator as its next turn.
 */
export function applyTaskReview(
  service: FleetService,
  engine: { tick(): void },
  runId: string,
  input: ReviewInput,
  reviewer: TaskReviewer = { kind: "operator" },
): TaskReviewResult {
  const store = service.store;
  const run = store.getRun(runId);
  // The task's review is about the task. A PR maintenance decision is
  // answered in the PRM panel or the orchestrator conversation, never here,
  // so settling this review can never cancel or settle maintenance intent.
  const outcome = reviewOutcome(run, input);
  if (
    outcome.kind === "not_found" ||
    outcome.kind === "not_waiting" ||
    outcome.kind === "needs_reason"
  )
    return outcome;
  store.prMaintenance.assertAdmission({
    taskId: runId,
    action: outcome.kind === "approve" ? "approve" : "reopen",
  });
  const who = byline(reviewer);
  if (outcome.kind === "approve") {
    store.appendRunNote(
      run!.id,
      run!.phaseIndex,
      outcome.note ||
        (reviewer.kind === "operator"
          ? "The task result was accepted by a person."
          : `The task result was accepted by ${who}.`),
      {
        summary:
          reviewer.kind === "operator"
            ? "Task result accepted"
            : "Task result accepted by local agent",
        kind: "decision",
        source: "operator",
      },
    );
    service.resolveRunReview(run!.id);
    const done =
      run!.workspaceBinding?.effectiveMode === "managed"
        ? service.worktrees.beginAggregation(run!.id)
        : store.setRunState(run!.id, "completed")!;
    service.publishRun(done);
    engine.tick();
    return { kind: "approved", run: done };
  }

  store.appendRunNote(
    run!.id,
    run!.phaseIndex,
    reviewer.kind === "operator"
      ? `Sent back: ${outcome.note}`
      : `Sent back by ${who}: ${outcome.note}`,
    {
      summary:
        reviewer.kind === "operator"
          ? "Guidance sent to the Orchestrator"
          : "Local agent sent the task back",
      kind: "decision",
      source: "operator",
    },
  );
  service.resolveRunReview(run!.id);
  /*
   * The note is owed rather than sent. Leaving `awaiting_human` is what takes
   * the approve/send-back controls away, so a prompt dropped because the lead
   * was mid-turn would strand the task: no steps left to settle, so no wake
   * could ever be owed, and no control left to try again with.
   */
  const reopened = store.updateRun(run!.id, {
    state: "running",
    pendingPrompt: owedPrompt(run!.pendingPrompt, outcome.prompt),
  })!;
  service.publishRun(reopened);
  engine.tick();
  return { kind: "sent_back", run: reopened };
}
