import type { FleetSession } from "@fleet/protocol";

/** How long a running session may say nothing before that is worth mentioning. */
export const QUIET_MS = 15_000;
/** And how long before it is worth suggesting the node is the problem. */
export const STALLED_MS = 60_000;

export type TranscriptNotice =
  | { kind: "new-output"; count: number; label: string }
  | { kind: "quiet"; label: string; detail: string }
  | { kind: "stalled"; label: string; detail: string }
  | undefined;

export type NoticeInput = {
  session: Pick<FleetSession, "state">;
  /** False once the reader has scrolled away from the newest output. */
  pinned: boolean;
  /** Events that arrived since they scrolled away. */
  unseen: number;
  /** When the last event arrived, or 0 if none has. */
  lastEventAt: number;
  now: number;
};

/**
 * What, if anything, to say over the transcript.
 *
 * One notice at a time and in this order, because they answer different
 * questions and only one can be the most useful: unread output is a thing to
 * act on now, silence is a thing to understand.
 *
 * Silence is never reported as failure. A long compile and a dead node look
 * identical from here, and the session's own state machine is the only thing
 * entitled to call one of them failed — so this says how long it has been and
 * lets the operator decide.
 */
export function transcriptNotice(input: NoticeInput): TranscriptNotice {
  if (!input.pinned && input.unseen > 0) {
    return {
      kind: "new-output",
      count: input.unseen,
      label:
        input.unseen === 1
          ? "1 new line · jump to end"
          : `${input.unseen} new lines · jump to end`,
    };
  }

  const running = input.session.state === "running" || input.session.state === "starting";
  if (!running || input.lastEventAt === 0) return undefined;

  const quietFor = input.now - input.lastEventAt;
  if (quietFor >= STALLED_MS) {
    return {
      kind: "stalled",
      label: "Still running",
      detail: `nothing for ${describe(quietFor)} — worth checking the node is still connected`,
    };
  }
  if (quietFor >= QUIET_MS) {
    return {
      kind: "quiet",
      label: "Still running",
      detail: `last activity ${describe(quietFor)} ago`,
    };
  }
  return undefined;
}

function describe(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}
