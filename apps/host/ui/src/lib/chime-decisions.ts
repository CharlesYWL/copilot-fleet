import type { FleetSession } from "@fleet/protocol";
import type { ChimeKind } from "./chime";

/**
 * Deciding when a sound is owed, kept apart from making one.
 *
 * The hard part of an alert is not the tone, it is not crying wolf: a page that
 * chimed for everything it saw would sound off once per session the moment it
 * loaded, again on every reconnect, and again for each session an operator
 * dismissed. All of that is decided here, where it can be tested without a
 * speaker.
 */

/** Sessions that have stopped needing anything, whether well or badly. */
const FINISHED = new Set(["idle", "completed", "stopped", "failed"]);

/** The state an agent is in while it still owes an answer. */
const WORKING = new Set(["running", "cancelling"]);

export type ChimeDecision = { kind: ChimeKind; sessionId: string };

/**
 * What changed between two views of the fleet, in sounds.
 *
 * `previous` being empty means this is the first view, and nothing is announced:
 * a browser opening onto ten finished sessions has not just watched ten agents
 * finish, and saying so would be both wrong and unbearable.
 */
export function chimesFor(
  previous: ReadonlyMap<string, string>,
  sessions: readonly FleetSession[],
): ChimeDecision[] {
  if (previous.size === 0) return [];
  const chimes: ChimeDecision[] = [];
  for (const session of sessions) {
    const before = previous.get(session.id);
    // A session this view has never seen is not a transition. It is a session
    // that was created elsewhere, or one whose node just came back.
    if (before === undefined || before === session.state) continue;
    if (WORKING.has(before) && FINISHED.has(session.state)) {
      chimes.push({ kind: "done", sessionId: session.id });
    }
  }
  return chimes;
}

/** The state map to compare the next view against. */
export function sessionStates(sessions: readonly FleetSession[]): Map<string, string> {
  return new Map(sessions.map((session) => [session.id, session.state]));
}

/**
 * Permission requests that have not been announced yet.
 *
 * Keyed on the request rather than the session because a single turn can raise
 * several, and each one is a separate thing waiting on a human.
 */
export function newPermissionIds(
  announced: ReadonlySet<string>,
  pendingIds: readonly string[],
): string[] {
  return pendingIds.filter((id) => id && !announced.has(id));
}
