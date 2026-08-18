/**
 * A bounded, in-memory record of what a process has been saying.
 *
 * Both halves of the fleet already log, and both log to a place nobody is
 * looking: the Host to the terminal it was started from, the Node to a console
 * on a machine in another room. When something goes wrong the operator is in a
 * browser, and the question they need answered — "what did this thing say just
 * before it stopped working?" — is the one question the UI could not answer.
 *
 * Kept in memory rather than on disk on purpose. A log file needs rotation, a
 * size budget, a cleanup story, and a way to be read remotely; this needs to
 * survive exactly as long as the process whose behaviour is in question. A
 * restart is allowed to clear it, because a restart is also what clears the
 * problem being diagnosed.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  /** ISO timestamp, so a reader can line this up against another machine's log. */
  at: string;
  level: LogLevel;
  message: string;
};

/** Enough to cover a reconnect storm without letting one process pin memory. */
export const DEFAULT_LOG_CAPACITY = 300;

/** Truncation guard: one runaway line must not evict the whole buffer's worth. */
const MAX_MESSAGE_LENGTH = 2000;

export type LogBuffer = {
  record: (level: LogLevel, message: string) => void;
  /** Newest last, so a reader appending to a view does not have to reverse it. */
  entries: () => LogEntry[];
  clear: () => void;
};

export function createLogBuffer(capacity = DEFAULT_LOG_CAPACITY): LogBuffer {
  const limit = Math.max(1, Math.floor(capacity));
  let entries: LogEntry[] = [];

  return {
    record: (level, message) => {
      const text = String(message ?? "");
      entries.push({
        at: new Date().toISOString(),
        level,
        message:
          text.length > MAX_MESSAGE_LENGTH
            ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
            : text,
      });
      // Dropping from the front keeps the newest, which is what a person
      // debugging a live problem is looking at.
      if (entries.length > limit) entries = entries.slice(-limit);
    },
    entries: () => [...entries],
    clear: () => {
      entries = [];
    },
  };
}

/**
 * The entries worth showing when the reader asked for problems only.
 *
 * A failing node repeats one line every two seconds, so an unfiltered view is
 * mostly the same sentence — and the interesting line, the one that only
 * appeared once, is the one scrolled off the top.
 */
export function problemsOnly(entries: readonly LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.level !== "info");
}
