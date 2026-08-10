import {
  isResumableSession,
  terminalSessionStates,
  type FleetSession,
} from "@fleet/protocol";
import { stateAccent, terminal } from "../theme";

/**
 * Amber for a session that ended but can be picked back up.
 *
 * The state underneath is usually `failed`, which is drawn in the same red as a
 * session that is genuinely gone. After a reboot that colours every recoverable
 * transcript as a casualty, which is exactly the reading that makes an operator
 * reach for "Clear ended".
 */
export const RESUMABLE_ACCENT = "#f7bf61";

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
  return isDormantSession(session) ? "resumable" : session.state;
}

export function sessionAccent(session: FleetSession): string {
  if (isDormantSession(session)) return RESUMABLE_ACCENT;
  return stateAccent[session.state] ?? terminal.dim;
}

/**
 * Sessions the sidebar and monitor wall show.
 *
 * Anything live, anything still resumable, and whatever is selected — so a
 * session that ends while being watched does not yank its own transcript away.
 *
 * Resumable sessions used to be filtered out with the rest of the terminal ones,
 * which hid every recoverable session behind a "Clear ended" button and left no
 * way to reach the Resume this project already supported.
 */
export function filterVisibleSessions(
  sessions: FleetSession[],
  selectedSessionId: string | undefined,
): FleetSession[] {
  return sessions.filter(
    (session) =>
      !terminalSessionStates.has(session.state) ||
      isResumableSession(session) ||
      session.id === selectedSessionId,
  );
}

/** Ended with nothing left to recover: what "Clear ended" actually removes. */
export function isDisposableSession(session: FleetSession): boolean {
  return terminalSessionStates.has(session.state) && !isResumableSession(session);
}
