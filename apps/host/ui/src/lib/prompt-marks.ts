import { promptLabel, type PromptMark, type TerminalBlock } from "@fleet/protocol";

export type { PromptMark };

/**
 * The operator's own prompts, in order, as the rail beside the stream draws them.
 *
 * A long session is a sequence of things the operator asked for, and the agent's
 * work between two prompts is one chapter of it. The scrollbar could only ever
 * say "you are 40% down"; these marks say "this is the turn where you asked for
 * the retry fix", which is the question someone scrolling back is actually
 * asking. `start` is the absolute position of `blocks[0]`.
 */
export function toPromptMarks(blocks: readonly TerminalBlock[], start = 0): PromptMark[] {
  const marks: PromptMark[] = [];
  blocks.forEach((block, offset) => {
    if (block.kind !== "user") return;
    marks.push({
      key: block.key,
      index: start + offset,
      label: promptLabel(block.text),
      createdAt: block.createdAt,
    });
  });
  return marks;
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
