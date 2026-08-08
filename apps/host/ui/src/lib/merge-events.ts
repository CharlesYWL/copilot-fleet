import type { SessionEvent } from "@fleet/protocol";

/**
 * One session's transcript, combining what a fetch returned with what is
 * already on screen.
 *
 * The socket appends events as they happen while `GET /events` answers with the
 * transcript as it stood when the request left. Replacing the list with that
 * answer drops anything the socket delivered in between, and since a replayed
 * event never arrives twice those lines stay missing until something unrelated
 * repaints. Keeping the extras and sorting by sequence lets the two sources
 * disagree about recency without either losing lines.
 */
export function mergeEvents(
  fetched: readonly SessionEvent[],
  known: readonly SessionEvent[],
): SessionEvent[] {
  const fetchedIds = new Set(fetched.map((event) => event.eventId));
  const arrivedMeanwhile = known.filter((event) => !fetchedIds.has(event.eventId));
  return [...fetched, ...arrivedMeanwhile].sort((a, b) => a.sequence - b.sequence);
}
