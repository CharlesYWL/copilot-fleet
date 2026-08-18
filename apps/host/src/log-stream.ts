import type { LogBuffer, LogLevel } from "@fleet/protocol/log-buffer";

/**
 * Tees the Host's log into a buffer the browser can read.
 *
 * The Host logs to the terminal it was started from, which on a fleet that runs
 * unattended is a terminal nobody is looking at — and by the time somebody is,
 * it is usually a terminal that has been closed. The operator is in the browser,
 * so the browser has to be able to answer "what went wrong".
 *
 * A pino stream rather than a wrapped logger: fastify hands `request.log` and
 * `app.log` to every route and gateway, and each one that wrapped the logger
 * itself would be a place the wrapping could be forgotten. Everything the Host
 * logs goes through here whether or not the code doing the logging knows it.
 */

/** pino's numeric levels; anything at or above `warn` is worth keeping. */
const WARN = 40;
const ERROR = 50;

export function levelFromPino(level: unknown): LogLevel | undefined {
  const value = typeof level === "number" ? level : Number(level);
  if (!Number.isFinite(value) || value < WARN) return undefined;
  return value >= ERROR ? "error" : "warn";
}

/**
 * The readable part of a pino line.
 *
 * `msg` alone loses the reason on a thrown error, which is the half that says
 * what to do about it; the error's own message is appended when it adds
 * something the message does not already contain.
 */
export function messageFromPino(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  const msg = typeof entry.msg === "string" ? entry.msg : "";
  if (msg) parts.push(msg);
  const err = entry.err;
  if (err && typeof err === "object") {
    const detail = (err as { message?: unknown }).message;
    if (typeof detail === "string" && detail && !msg.includes(detail)) {
      parts.push(detail);
    }
  }
  // A line with neither is not worth a buffer slot, but it is worth knowing it
  // happened, so it keeps a placeholder rather than being silently dropped.
  return parts.join(" — ") || "(no message)";
}

export type WritableLike = { write: (chunk: string) => void };

export function recordingLogStream(
  logs: LogBuffer,
  out: WritableLike = process.stdout,
): WritableLike {
  return {
    write: (chunk: string) => {
      // The console keeps exactly what it had, in the same format: this is a
      // second reader of the log, not a replacement for the first.
      out.write(chunk);
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Not every line is pino's — a library writing directly to the stream
          // must not be able to take the Host's logging down with a parse error.
          continue;
        }
        const level = levelFromPino(entry.level);
        if (!level) continue;
        logs.record(level, messageFromPino(entry));
      }
    },
  };
}
