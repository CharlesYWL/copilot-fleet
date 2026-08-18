import { describe, expect, it } from "vitest";
import type { TerminalBlock } from "./terminal-blocks";
import { promptTimeLabel, toPromptMarks } from "./prompt-marks";

const block = (values: Partial<TerminalBlock>): TerminalBlock => ({
  key: "k",
  kind: "agent",
  text: "",
  createdAt: "2026-08-18T20:39:00.000Z",
  ...values,
});

describe("toPromptMarks", () => {
  it("marks the operator's prompts and nothing else", () => {
    const marks = toPromptMarks([
      block({ key: "u1", kind: "user", text: "fix the retry helper" }),
      block({ key: "a1", kind: "agent", text: "done" }),
      block({ key: "t1", kind: "tool", text: "Run tests" }),
      block({ key: "u2", kind: "user", text: "now ship it" }),
    ]);

    expect(marks.map((mark) => [mark.key, mark.label])).toEqual([
      ["u1", "fix the retry helper"],
      ["u2", "now ship it"],
    ]);
  });

  it("flattens and cuts a prompt down to a label a tooltip can hold", () => {
    const [mark] = toPromptMarks([
      block({
        key: "u1",
        kind: "user",
        text: `line one\n\nline two ${"and more ".repeat(20)}`,
      }),
    ]);

    expect(mark?.label.length).toBe(61);
    expect(mark?.label.startsWith("line one line two")).toBe(true);
    expect(mark?.label.endsWith("…")).toBe(true);
  });

  it("still gives an empty prompt something to be called", () => {
    // Attachments can be sent with no text at all, and a mark with no label is
    // an invisible tooltip over a bar that looks broken.
    const [mark] = toPromptMarks([block({ key: "u1", kind: "user", text: "  " })]);
    expect(mark?.label).toBe("Prompt");
  });
});

describe("promptTimeLabel", () => {
  const sent = "2026-08-18T20:39:00.000Z";

  it("says Today for a prompt from the session in front of you", () => {
    expect(promptTimeLabel(sent, new Date(Date.parse(sent) + 3_600_000))).toMatch(
      /^Today, /,
    );
  });

  it("names the day once the session has outlived it", () => {
    const label = promptTimeLabel(sent, new Date(Date.parse(sent) + 86_400_000 * 3));
    expect(label.startsWith("Today")).toBe(false);
    expect(label.length).toBeGreaterThan(0);
  });

  it("says nothing rather than NaN for a timestamp it cannot read", () => {
    expect(promptTimeLabel("not a date")).toBe("");
  });
});
