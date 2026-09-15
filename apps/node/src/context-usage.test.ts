import { describe, expect, it } from "vitest";
import { parseContextUsage } from "./context-usage.js";

const at = "2026-09-15T07:00:00.000Z";
const report = (header: string) =>
  `Context Usage\n\n○ ◌ ◌ ● ◉ · · · · ·   ${header}\n· · · · ·   System Prompt 7.8k (2%)\n◎ ◎ ◎ ◎ ◎   Buffer 141.6k (35%)`;

describe("Copilot context snapshots", () => {
  it("reads the full 400k window instead of mistaking the 272k input budget for it", () => {
    expect(
      parseContextUsage(report("gpt-5.6-sol-fast · 27k/400k tokens (7%)"), at),
    ).toEqual({
      model: "gpt-5.6-sol-fast",
      usedTokens: 27000,
      tokenLimit: 400000,
      percentage: 7,
      updatedAt: at,
      estimated: true,
    });
  });

  it("preserves the CLI percentage when printed token quantities are rounded", () => {
    expect(parseContextUsage(report("gpt-5.5 · 70k/1.1M tokens (7%)"), at)).toMatchObject(
      {
        usedTokens: 70000,
        tokenLimit: 1100000,
        percentage: 7,
        estimated: true,
      },
    );
  });

  it.each([
    ["gpt-6-astra · 8.1k/1M tokens (1%)", 8100, 1000000, 1],
    ["model • 0/200,000 tokens (0%)", 0, 200000, 0],
    ["model · 210k/200k tokens (105%)", 210000, 200000, 105],
  ])("reads %s", (line, usedTokens, tokenLimit, percentage) => {
    expect(parseContextUsage(report(line), at)).toMatchObject({
      usedTokens,
      tokenLimit,
      percentage,
    });
  });

  it("does not invent a snapshot before the agent context is initialized", () => {
    expect(
      parseContextUsage(
        "Context information is not yet available. Send a message first.",
        at,
      ),
    ).toBeNull();
  });

  it.each([
    "",
    "The agent answered instead",
    "Context Usage\nunrecognized layout",
    report("model · 1/0 tokens (0%)"),
  ])("reports unreadable context output instead of silently guessing: %s", (text) => {
    expect(() => parseContextUsage(text, at)).toThrow();
  });
});
