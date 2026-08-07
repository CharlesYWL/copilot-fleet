import { describe, expect, it } from "vitest";
import { toPreviewLines } from "./session-preview";
import type { TerminalBlock } from "./terminal-blocks";

function block(partial: Partial<TerminalBlock> & { key: string }): TerminalBlock {
  return {
    kind: "agent",
    text: "",
    createdAt: "2026-08-07T10:00:00.000Z",
    ...partial,
  };
}

describe("toPreviewLines", () => {
  it("keeps the newest lines in stream order", () => {
    const lines = toPreviewLines(
      [
        block({ key: "a", text: "first\nsecond" }),
        block({ key: "b", kind: "user", text: "third" }),
      ],
      "",
      2,
    );

    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["agent", "second"],
      ["user", "third"],
    ]);
  });

  it("drops blank lines and annotates tool status", () => {
    const lines = toPreviewLines(
      [block({ key: "t", kind: "tool", text: "read auth.ts", status: "completed" })],
      "",
    );

    expect(lines.map((line) => line.text)).toEqual(["read auth.ts · completed"]);
  });

  it("falls back to the session tail when no events have streamed yet", () => {
    const lines = toPreviewLines([], "older\n\nnewest", 5);

    expect(lines.map((line) => line.text)).toEqual(["older", "newest"]);
  });

  it("truncates a line that would overflow the tile", () => {
    const lines = toPreviewLines([block({ key: "long", text: "x".repeat(400) })], "");

    expect(lines.map((line) => line.text)).toEqual([`${"x".repeat(180)}…`]);
  });
});
