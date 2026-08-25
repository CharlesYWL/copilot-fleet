import type { TerminalBlock, TerminalBlockKind } from "./terminal-blocks";

export type PreviewLine = {
  key: string;
  kind: TerminalBlockKind;
  text: string;
};

const MAX_LINE_LENGTH = 180;

/**
 * Tail of a session's stream flattened to single lines, so a monitor tile can
 * show what the agent is doing without rendering a whole transcript.
 */
export function toPreviewLines(
  blocks: TerminalBlock[],
  fallbackText: string,
  limit = 12,
): PreviewLine[] {
  const lines: PreviewLine[] = [];

  for (const block of blocks) {
    for (const [offset, text] of splitLines(blockText(block)).entries()) {
      lines.push({ key: `${block.key}:${offset}`, kind: block.kind, text });
    }
  }

  if (lines.length > 0) return lines.slice(-limit);

  // Sessions that streamed before this browser connected have no events yet,
  // but the host keeps the tail of their text on the session record.
  return splitLines(fallbackText)
    .slice(-limit)
    .map((text, index) => ({ key: `tail:${index}`, kind: "agent" as const, text }));
}

function blockText(block: TerminalBlock): string {
  if (block.kind === "turn") return `turn complete (${block.text})`;
  if (block.kind === "tool" && block.status) return `${block.text} · ${block.status}`;
  // The tile shows the summary, never the envelope: a wake carries every step's
  // full output, which alone would fill a tile built to show twelve lines.
  if (block.kind === "wake" && block.detail) return `${block.text} · ${block.detail}`;
  return block.text;
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line,
    );
}
