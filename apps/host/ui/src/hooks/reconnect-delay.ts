const FIRST_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/**
 * How long to wait before the next attempt to reopen the browser socket.
 *
 * Doubles from half a second up to a ceiling: a `tsx watch` restart is back
 * almost at once, while a host that is down for longer should not be hammered.
 * The ceiling matters as much as the growth, because an uncapped backoff leaves
 * the page showing stale data long after the host returns.
 */
export function reconnectDelay(attempt: number): number {
  return Math.min(FIRST_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}
