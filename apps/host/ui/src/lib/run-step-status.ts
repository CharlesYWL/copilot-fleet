import {
  terminalRunStepStates,
  type FleetSession,
  type RunStepState,
  type StepAdmission,
} from "@fleet/protocol";
import { sessionStatusDescriptor } from "./session-status";
import {
  statusDescriptor,
  type StatusDescriptor,
  type StatusState,
} from "./status-visuals";

const stepStates: Record<RunStepState, StatusState> = {
  pending: "queued",
  starting: "running",
  running: "running",
  succeeded: "done",
  failed: "failed",
  skipped: "skipped",
  cancelled: "stopped",
};

export function stepStatusDescriptor(
  state: RunStepState,
  session?: FleetSession,
  awaitingPermission = false,
  admission?: StepAdmission,
): StatusDescriptor {
  // A step's outcome belongs to the orchestrator, not its worker's last turn.
  if (
    !terminalRunStepStates.has(state) &&
    state !== "pending" &&
    session &&
    (session.state === "offline" || session.stopRequested || awaitingPermission)
  ) {
    return sessionStatusDescriptor(session, awaitingPermission);
  }
  // A queued step says what it is waiting on, so blocked never reads as queued.
  if (state === "pending" && admission) {
    if (admission.state === "blocked")
      return {
        ...statusDescriptor("waiting-for-permission"),
        label: "Blocked",
        shortLabel: "blocked",
        motion: undefined,
      };
    if (admission.state === "awaiting_approval")
      return {
        ...statusDescriptor("waiting-for-permission"),
        label: "Awaiting approval",
        shortLabel: "needs approval",
      };
    if (admission.state === "starting")
      return {
        ...statusDescriptor("running"),
        label: "Starting",
        shortLabel: "starting",
      };
  }
  if (state === "starting")
    return { ...statusDescriptor("running"), label: "Starting", shortLabel: "starting" };
  const descriptor = statusDescriptor(stepStates[state]);
  if (state === "cancelled") {
    return { ...descriptor, label: "Cancelled", shortLabel: "cancelled" };
  }
  return descriptor;
}
