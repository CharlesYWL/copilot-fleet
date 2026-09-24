import {
  currentPrMaintenance,
  prMaintenanceProgress,
  type PrMaintenanceRegistration,
  type PrMaintenanceStage,
  type RunNote,
} from "@fleet/protocol";
import { awaitingPlan, currentPhase, type RunViewModel } from "./orchestration-view";
import type { TaskMaintenanceView } from "./pr-maintenance";

export const maintenanceStageLabels: Record<PrMaintenanceStage, string> = {
  checking: "Checking PR",
  triage: "Reviewing feedback",
  addressing_review: "Fixing feedback",
  waiting_checks: "Waiting for checks",
  waiting_review: "Waiting for review",
  ready: "Ready to merge",
  human_hold: "Decision needed",
  reconciling: "Reconciling effects",
  authorization_required: "Repair authorization required",
  paused: "Paused",
  recovering: "Recovering access",
  blocked: "Blocked",
  merged: "Merged",
  closed: "Closed",
  released: "Released",
};

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
  nowMs = Date.now(),
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
  if (record?.decision?.state === "pending" && !record.ownershipReleasedAt) {
    return {
      title: "Your design decision is needed",
      summary:
        report?.kind === "blocked" && report.summary
          ? report.summary
          : "PR maintenance is paused for bounded direction; no design change is authorized yet.",
      attention: true,
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
  if (record && !record.ownershipReleasedAt) {
    if (["merged", "closed"].includes(record.lifecycle) && hasOutstandingWork(record)) {
      return {
        title: `PR ${record.lifecycle}; reconciliation pending`,
        summary:
          "Previously accepted work or unknown effects still need reconciliation before ownership can be released.",
        attention: true,
      };
    }
    if (record.manualControl && !record.manualControl.endedAt) {
      const unknown = record.manualControl.commands.some(
        (command) => command.state === "unknown",
      );
      const accepted = record.manualControl.commands.some(
        (command) => command.state === "accepted",
      );
      return {
        title: "Manual supervisor control",
        summary: unknown
          ? "Manual delivery has no correlated receipt yet; do not replay it while unattended maintenance is paused."
          : accepted
            ? "The manual command is accepted; wait for its completion receipt while unattended maintenance stays paused."
            : "Unattended maintenance stays paused; use the retained worker for manual work and explicitly resume maintenance when ready.",
        attention: unknown,
      };
    }
    const stage = prMaintenanceProgress(record, nowMs).stage;
    const copy: Record<PrMaintenanceStage, string> = {
      checking:
        "Fleet is checking current PR evidence and remaining feedback obligations before claiming readiness.",
      triage:
        "Current feedback without a matching current-HEAD disposition is being assessed against the approved scope.",
      addressing_review:
        "An accepted feedback batch is queued or running on the retained worker within its authorization.",
      waiting_checks: "Required checks have not all passed for the current PR head.",
      waiting_review:
        "Required review approval is still outstanding for the current PR head.",
      ready: "Current evidence permits readiness; merging remains a human action.",
      human_hold:
        "Maintenance is waiting for your bounded direction before any further repairs.",
      reconciling:
        "Some work or remote effects are unsettled; do not blindly repeat the action.",
      authorization_required:
        "Legacy observation-only maintenance is retired. Prepare and authenticate repair authorization for the retained PR and worker; no writes or automatic resume.",
      paused: "Maintenance is paused; review its controls and reason before resuming.",
      recovering:
        "Fleet is trying a bounded observation fallback, not bypassing permissions.",
      blocked:
        "Resolve the recorded blocker before further PR work or a readiness claim.",
      merged:
        "The PR merge was observed; this alone does not prove deployment or completion of the whole task.",
      closed: "The PR is closed, not merged; no new maintenance repairs will be started.",
      released:
        "Maintenance ownership has been released; a new grant is needed to restart it.",
    };
    return {
      title:
        stage === "ready"
          ? "PR ready to merge"
          : stage === "checking"
            ? "Checking PR status"
            : `PR: ${maintenanceStageLabels[stage].toLowerCase()}`,
      summary: copy[stage],
      attention: [
        "human_hold",
        "blocked",
        "reconciling",
        "paused",
        "authorization_required",
      ].includes(stage),
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
