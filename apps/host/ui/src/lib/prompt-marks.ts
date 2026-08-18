import type { TerminalBlock } from "./terminal-blocks";

export type PromptMark = {
  /** The block key, which is also the transcript element's `data-prompt-key`. */
  key: string;
  /** The prompt itself, cut to something a tooltip can hold on two lines. */
  label: string;
  createdAt: string;
};

/** Long enough to recognise a prompt, short enough not to become a paragraph. */
const LABEL_MAX_LENGTH = 60;

/**
 * The operator's own prompts, in order, as the rail beside the stream draws them.
 *
 * A long session is a sequence of things the operator asked for, and the agent's
 * work between two prompts is one chapter of it. The scrollbar could only ever
 * say "you are 40% down"; these marks say "this is the turn where you asked for
 * the retry fix", which is the question someone scrolling back is actually
 * asking.
 */
export function toPromptMarks(blocks: TerminalBlock[]): PromptMark[] {
  return blocks
    .filter((block) => block.kind === "user")
    .map((block) => ({
      key: block.key,
      label: promptLabel(block.text),
      createdAt: block.createdAt,
    }));
}

function promptLabel(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (!flattened) return "Prompt";
  return flattened.length > LABEL_MAX_LENGTH
    ? `${flattened.slice(0, LABEL_MAX_LENGTH)}…`
    : flattened;
}

/**
 * When a prompt was sent, said the way someone reading a tooltip would say it.
 *
 * A bare clock time is ambiguous the moment a session outlives the day it
 * started, and a full date on every mark is noise for the session that did not.
 */
export function promptTimeLabel(value: string, now: Date = new Date()): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  const sent = new Date(parsed);
  const time = sent.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return isSameDay(sent, now)
    ? `Today, ${time}`
    : `${sent.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
