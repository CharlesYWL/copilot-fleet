import {
  isResumableSession,
  terminalSessionStates,
  type FleetSession,
} from "@fleet/protocol";
import { semanticColors } from "../theme";
import {
  statusDescriptor,
  type StatusDescriptor,
  type StatusState,
} from "./status-visuals";

/**
 * Amber for a session that ended but can be picked back up.
 *
 * The state underneath is usually `failed`, which is drawn in the same red as a
 * session that is genuinely gone. After a reboot that colours every recoverable
 * transcript as a casualty, which is exactly the reading that makes an operator
 * reach for "Clear ended".
 */
export const RESUMABLE_ACCENT = semanticColors.permission;

/**
 * How one session should be shown.
 *
 * `awaitingPermission` is passed in rather than read from the session because
 * it lives in the event log: a session blocked on a decision is still `running`
 * as far as its own state machine is concerned.
 */
export function sessionStatusDescriptor(
  session: FleetSession,
  awaitingPermission = false,
): StatusDescriptor {
  const descriptor = statusDescriptor(visualState(session, awaitingPermission));
  if (session.stopRequested && session.state === "offline") {
    return {
      ...descriptor,
      label: "Stopping - node offline",
      icon: statusDescriptor("offline").icon,
      motion: undefined,
    };
  }
  return descriptor;
}

function visualState(session: FleetSession, awaitingPermission: boolean): StatusState {
  if (session.stopRequested) return "stopping";
  if (session.state === "offline") return "offline";
  if (isDormantSession(session)) return "resumable";
  if (session.state === "failed") return "failed";
  if (session.state === "completed") return "done";
  if (session.state === "stopped") return "stopped";
  if (awaitingPermission) return "waiting-for-permission";
  if (session.state === "running" || session.state === "starting") return "running";
  if (session.state === "queued") return "queued";
  if (session.state === "cancelling") return "stopping";
  return "idle";
}

/** Orders a list so whatever needs a person is at the top of it. */
export function byAttention(descriptorOf: (session: FleetSession) => StatusDescriptor) {
  return (a: FleetSession, b: FleetSession) =>
    descriptorOf(b).priority - descriptorOf(a).priority;
}

/**
 * Ended, but Resume re-attaches it.
 *
 * Narrower than the protocol's predicate, which also covers `offline`: an
 * offline session is usually a Node that will be back in seconds and reclaim it
 * on its own, so it keeps its own status rather than being relabelled as
 * something the operator has to act on.
 */
export function isDormantSession(session: FleetSession): boolean {
  return isResumableSession(session) && terminalSessionStates.has(session.state);
}

/** The word shown where the session state goes. */
export function sessionStatusLabel(session: FleetSession): string {
  if (session.stopRequested) return "stopping";
  return isDormantSession(session) ? "resumable" : session.state;
}

export function sessionAccent(session: FleetSession): string {
  return sessionStatusDescriptor(session).color;
}

/**
 * Sessions the sidebar, the monitor wall, and the automatic selection show.
 *
 * Anything live, anything still resumable, and whatever is selected — so a
 * session that ends while being watched does not yank its own transcript away.
 * Workers parked with an ended task are the exception: they stay out of the
 * fleet list unless the operator deliberately opened one from the task view.
 *
 * The orchestrator is excluded unless it was opened deliberately: it is the
 * fleet's own surface, and it has a view of its own. Its workers are shown,
 * because they are ordinary sessions on a real node doing visible work, and
 * this list has to agree with the tree — when the two disagreed, an operator
 * saw "No sessions" beside a worker's transcript offering **Resume**, which
 * would have restarted it outside the run's accounting.
 */
export function filterVisibleSessions(
  sessions: FleetSession[],
  selectedSessionId: string | undefined,
  terminalRunIds: ReadonlySet<string> = new Set(),
  showSelectedParkedSession = false,
): FleetSession[] {
  return sessions.filter((session) => {
    const selected = session.id === selectedSessionId;
    const parkedWithTask =
      Boolean(session.runId) &&
      terminalRunIds.has(session.runId) &&
      terminalSessionStates.has(session.state);
    if (parkedWithTask && !(selected && showSelectedParkedSession)) return false;
    return (
      (session.runRole !== "lead" || selected) &&
      (selected ||
        !terminalSessionStates.has(session.state) ||
        isResumableSession(session))
    );
  });
}

/**
 * Every orchestrator conversation that has not been explicitly dismissed.
 *
 * A stopped lead is still a resumable conversation, and even one that cannot be
 * resumed must remain reachable long enough for the operator to dismiss it.
 * Filtering this list to live sessions made Stop behave like Delete.
 */
export function filterOrchestratorConversations(
  sessions: readonly FleetSession[],
): FleetSession[] {
  return sessions.filter((session) => session.runRole === "lead");
}

/** Ended with nothing left to recover: what "Clear ended" actually removes. */
export function isDisposableSession(session: FleetSession): boolean {
  return (
    session.runRole !== "lead" &&
    terminalSessionStates.has(session.state) &&
    !isResumableSession(session)
  );
}
