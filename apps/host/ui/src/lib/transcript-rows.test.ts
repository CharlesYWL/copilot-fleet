import { describe, expect, it } from "vitest";
import type { TerminalBlock } from "./terminal-blocks";
import { isCompactTool, transcriptRows } from "./transcript-rows";

const block = (
  key: string,
  kind: TerminalBlock["kind"] = "tool",
  status = "completed",
): TerminalBlock => ({
  key,
  kind,
  status,
  text: key,
  createdAt: "2026-10-08T00:00:00.000Z",
});

describe("transcript rows", () => {
  it("keeps tool runs stable while their statuses change and records block positions", () => {
    const blocks = [
      block("prompt", "user"),
      block("first"),
      block("second", "tool", "pending"),
      block("third", "tool", "in_progress"),
      block("answer", "agent"),
    ];
    const before = transcriptRows(blocks, 40);
    const after = transcriptRows(
      blocks.map((item) =>
        item.kind === "tool" ? { ...item, status: "completed" } : item,
      ),
      40,
      before,
    );
    expect(before.rows.map((row) => [row.key, row.index, row.blocks.length])).toEqual([
      ["prompt", 40, 1],
      ["first", 41, 3],
      ["answer", 44, 1],
    ]);
    expect(after.rows.map((row) => [row.key, row.index, row.blocks.length])).toEqual(
      before.rows.map((row) => [row.key, row.index, row.blocks.length]),
    );
    expect(after.firstItemIndex).toBe(40);
  });

  it("does not cross any non-tool block", () => {
    const boundaries: TerminalBlock["kind"][] = [
      "agent",
      "user",
      "thought",
      "permission",
      "permission_result",
      "error",
      "system",
      "turn",
      "state",
      "wake",
    ];
    for (const kind of boundaries) {
      expect(
        transcriptRows([block("before"), block("boundary", kind), block("after")], 0)
          .rows,
      ).toHaveLength(3);
    }
  });

  it("anchors prepended pages by row count, including a run crossing the page boundary", () => {
    const blocks = [
      block("prompt", "user"),
      block("first"),
      block("second"),
      block("third"),
      block("answer", "agent"),
    ];
    const tail = transcriptRows(blocks.slice(3), 3);
    const middle = transcriptRows(blocks.slice(1), 1, tail);
    const whole = transcriptRows(blocks, 0, middle);
    expect(tail.firstItemIndex).toBe(3);
    expect(middle.firstItemIndex).toBe(3);
    expect(middle.rows[0]).toMatchObject({ key: "third", index: 1 });
    expect(whole.firstItemIndex).toBe(2);
    expect(whole.rows[1]).toMatchObject({ key: "third", index: 1 });
    expect(whole.rows.at(-1)?.index).toBe(4);
    expect(whole.firstItemIndex + whole.rows.length - 1).toBe(
      tail.firstItemIndex + tail.rows.length - 1,
    );
  });

  it("does not shift indices when live tools are appended or a fresh page replaces the view", () => {
    const first = block("first");
    const before = transcriptRows([first], 100);
    const after = transcriptRows([first, block("second")], 100, before);
    expect(after.firstItemIndex).toBe(100);
    expect(after.rows).toHaveLength(1);
    expect(transcriptRows([block("fresh")], 200).firstItemIndex).toBe(200);
    expect(transcriptRows([], 0).rows).toEqual([]);
  });
});

describe("compact tools", () => {
  it.each(["completed", "failed"])("folds %s calls", (status) => {
    expect(isCompactTool(block("call", "tool", status))).toBe(true);
  });

  it.each(["pending", "running", "in_progress", "", "cancelled"])(
    "leaves %s calls visible regardless of session state",
    (status) => {
      expect(isCompactTool(block("call", "tool", status))).toBe(false);
    },
  );

  it("keeps completion answers visible while allowing failed details to fold", () => {
    expect(isCompactTool({ ...block("answer"), body: "Final answer" })).toBe(false);
    expect(
      isCompactTool({ ...block("failure", "tool", "failed"), body: "Failure details" }),
    ).toBe(true);
    expect(isCompactTool(block("prose", "agent"))).toBe(false);
  });
});
