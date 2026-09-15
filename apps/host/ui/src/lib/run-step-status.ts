import {
  terminalRunStepStates,
  type FleetSession,
  type RunStepState,
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
  const descriptor = statusDescriptor(stepStates[state]);
  if (state === "cancelled") {
    return { ...descriptor, label: "Cancelled", shortLabel: "cancelled" };
  }
  return descriptor;
}
