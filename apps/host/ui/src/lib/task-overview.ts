import {
  currentPrMaintenance,
  prMaintenanceStatus,
  type PrMaintenanceRegistration,
  type PrMaintenanceStatus,
  type RunNote,
} from "@fleet/protocol";
import { awaitingPlan, currentPhase, type RunViewModel } from "./orchestration-view";
import type { TaskMaintenanceView } from "./pr-maintenance";

/** The Host's status when it sent one; otherwise derived from the record. */
export function maintenanceStatusOf(
  record: PrMaintenanceRegistration,
  view: Pick<TaskMaintenanceView, "statuses"> | undefined,
): PrMaintenanceStatus {
  return view?.statuses?.[record.id] ?? prMaintenanceStatus(record);
}

/** A person is needed: a design decision, or a hold only they clear. */
export function maintenanceNeedsPerson(status: PrMaintenanceStatus): boolean {
  return (
    status.phase === "waiting_for_decision" ||
    Boolean(status.hold && status.hold !== "manual_control")
  );
}

export const currentMaintenance = currentPrMaintenance<PrMaintenanceRegistration>;

export function hasOutstandingWork(record: PrMaintenanceRegistration) {
  return (
    Boolean(
      record.manualControl?.commands.some((command) =>
        ["unknown", "accepted"].includes(command.state),
      ),
    ) ||
    record.incidents.some(
      (incident) => incident.kind === "effects" && !incident.resolvedAt,
    ) ||
    record.batches.some(
      (batch) =>
        ["prepared", "accepted", "reconciling", "uncertain"].includes(batch.state) ||
        (Boolean(batch.stepId) && !batch.executionSettled) ||
        batch.effects.some((effect) => ["reserved", "uncertain"].includes(effect.state)),
    ) ||
    record.actions.some((action) => ["reserved", "uncertain"].includes(action.state))
  );
}

/** Worker settlements must not replace the report a person was asked to review. */
export function latestReviewNote(notes: readonly RunNote[]) {
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index]!;
    if (!note.kind || note.kind === "review" || note.kind === "blocked") return note;
  }
  return undefined;
}

export function blockedReview(note: RunNote | undefined) {
  return (
    note?.kind === "blocked" ||
    (!note?.kind &&
      Boolean(note?.body.startsWith("**Escalated — this task is not finished.**")))
  );
}

export type TaskOverview = {
  title: string;
  summary: string;
  attention: boolean;
};

export function taskOverview(
  model: RunViewModel,
  notes: readonly RunNote[],
  maintenance: TaskMaintenanceView | undefined,
  _nowMs = Date.now(),
): TaskOverview {
  const { run } = model;
  const report = latestReviewNote(notes);
  const record = currentMaintenance(
    maintenance?.records.filter((entry) => entry.taskId === run.id) ?? [],
  );
  if (maintenance?.statusError) {
    return {
      title: "PR maintenance status unavailable",
      summary:
        "Refresh maintenance status before making a decision; prior evidence may be stale.",
      attention: true,
    };
  }
  // Maintenance describes the PR; the task's own review is described separately below.
  if (record && !record.ownershipReleasedAt) {
    const status = maintenanceStatusOf(record, maintenance);
    if (maintenanceNeedsPerson(status) || run.state !== "awaiting_human")
      return {
        title: `PR: ${status.label}`,
        summary: `${status.reason} ${status.action}`,
        attention: maintenanceNeedsPerson(status),
      };
  }
  if (run.state === "awaiting_human") {
    return {
      title: blockedReview(report) ? "Your decision is needed" : "Ready for your review",
      summary:
        report?.summary ??
        (blockedReview(report)
          ? "The task is blocked; review the original report and provide guidance to continue."
          : "The Orchestrator has handed this task over; review the result before accepting it."),
      attention: true,
    };
  }
  if ((model.stoppingSteps ?? 0) > 0) {
    return {
      title: "Stopping dispatched work",
      summary: model.stoppingUnavailable
        ? "A worker's node is offline; stopping has not been confirmed."
        : "Waiting for the existing workers to stop and settle their results.",
      attention: Boolean(model.stoppingUnavailable),
    };
  }
  if (model.attention) {
    const attention: Record<NonNullable<RunViewModel["attention"]>, TaskOverview> = {
      permission: {
        title: "A worker needs permission",
        summary: "Open the waiting session to review its actual permission request.",
        attention: true,
      },
      "workspace-setup": {
        title: "Workspace setup needs attention",
        summary: "Review task details to resolve setup before dispatching more work.",
        attention: true,
      },
      integration: {
        title: "Integration needs attention",
        summary:
          "Review the managed result and its conflict or publication gate in task details.",
        attention: true,
      },
      "failed-step": {
        title: "Dispatched work needs attention",
        summary:
          "A work attempt failed or was cancelled; inspect its recorded result before retrying.",
        attention: true,
      },
      "offline-node": {
        title: "A worker's node is offline",
        summary:
          "Work has not been confirmed complete; the existing session and its progress are preserved.",
        attention: true,
      },
    };
    return attention[model.attention];
  }
  if (run.state === "blocked") {
    return {
      title: "Task blocked",
      summary:
        "The task cannot continue; review its workspace details and recorded blocker before retrying.",
      attention: true,
    };
  }
  if (run.state === "aggregating") {
    return {
      title: "Integrating the work",
      summary:
        "Managed results are being prepared for final verification and publication review.",
      attention: false,
    };
  }
  if (run.state === "awaiting_approval") {
    return {
      title: "Task not started",
      summary: "The task is recorded but has not started dispatching work.",
      attention: false,
    };
  }
  if (run.state === "completed") {
    return {
      title: "Task completed",
      summary:
        "The task result was accepted; its reports and worker responses remain in history.",
      attention: false,
    };
  }
  if (run.state === "cancelled" || run.state === "failed") {
    return {
      title: run.state === "failed" ? "Task failed" : "Task stopped",
      summary:
        "Work is no longer progressing; review the recorded outcome before reopening.",
      attention: run.state === "failed",
    };
  }
  if (awaitingPlan(model)) {
    return {
      title: "Waiting for the Orchestrator to plan this",
      summary:
        "The task is recorded; its owner will plan and dispatch work on its next available turn.",
      attention: false,
    };
  }
  const checkpoint = [...notes]
    .reverse()
    .find(
      (note) =>
        note.phaseIndex === run.phaseIndex &&
        note.kind === "progress" &&
        note.summary &&
        !model.steps.some((step) => step.updatedAt > note.createdAt),
    );
  return {
    title:
      model.liveSteps > 0
        ? `Working on ${currentPhase(run) || "the task"}`
        : "The Orchestrator is deciding the next step",
    summary:
      checkpoint?.summary ??
      (model.liveSteps > 0
        ? "Dispatched work is in progress; no decision is currently waiting on you."
        : "The task remains open while the Orchestrator evaluates the latest results."),
    attention: false,
  };
}
