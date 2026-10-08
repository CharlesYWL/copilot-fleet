import type { TerminalBlock } from "./terminal-blocks";

export type TranscriptRow = {
  key: string;
  /** Absolute block position, independent of the virtual list's row indices. */
  index: number;
  blocks: readonly TerminalBlock[];
};

export type TranscriptRows = {
  rows: readonly TranscriptRow[];
  firstItemIndex: number;
};

/**
 * Tool runs own one virtual row so completing a call only changes that row's
 * height, not the indices of everything below it.
 */
export function transcriptRows(
  blocks: readonly TerminalBlock[],
  start: number,
  previous?: TranscriptRows,
): TranscriptRows {
  const rows: TranscriptRow[] = [];
  for (let offset = 0; offset < blocks.length;) {
    const block = blocks[offset]!;
    const first = offset++;
    if (block.kind === "tool") {
      while (blocks[offset]?.kind === "tool") offset++;
    }
    rows.push({
      key: block.key,
      index: start + first,
      blocks: blocks.slice(first, offset),
    });
  }

  let firstItemIndex = start;
  const anchor = previous?.rows[0];
  if (anchor && start <= anchor.index) {
    const offset = rows.findIndex(
      (row) => row.index <= anchor.index && anchor.index < row.index + row.blocks.length,
    );
    if (offset >= 0) {
      // An older page can extend the first tool run. Keep its key and virtual
      // index so paging preserves both the reading position and disclosures.
      rows[offset]!.key = anchor.key;
      firstItemIndex = previous.firstItemIndex - offset;
    }
  }
  return { rows, firstItemIndex };
}

/** A completion response is the agent's final answer, not routine tool output. */
export function isCompactTool(block: TerminalBlock): boolean {
  return (
    block.kind === "tool" &&
    (block.status === "failed" || (block.status === "completed" && !block.body))
  );
}
