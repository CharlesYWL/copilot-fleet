import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { HermesUsageReporter } from "./hermes-usage.js";
import { readNativeTokenTotals } from "../usage-totals.js";
import type { UsageContext } from "./types.js";
import type * as UsageTotalsModule from "../usage-totals.js";
vi.mock("../usage-totals.js", async (original) => ({
  ...(await original<typeof UsageTotalsModule>()),
  readNativeTokenTotals: vi.fn(),
}));
const context = (): UsageContext => ({
  report: vi.fn(),
  notice: vi.fn(),
  model: () => "model",
  stopping: () => false,
  aborted: () => false,
  assertActive: () => {},
  prompt: async () => {},
});
const cumulative = {
  totalTokens: 300,
  inputTokens: 200,
  outputTokens: 100,
  cacheReadTokens: 150,
  cacheWriteTokens: 20,
};
beforeEach(() => vi.mocked(readNativeTokenTotals).mockReset());

describe("HermesUsageReporter", () => {
  it("keeps context separate and publishes versioned lifetime native totals without credits", async () => {
    const usage = context();
    vi.mocked(readNativeTokenTotals).mockReturnValue(cumulative);
    const reporter = new HermesUsageReporter(usage, "default");
    try {
      await reporter.start("native", false, true);
      reporter.onUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000 });
      expect(usage.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ contextTokens: 100 }),
      );
      await reporter.flush();
      const readings = vi
        .mocked(usage.report)
        .mock.calls.flatMap(([reading]) =>
          reading.accounting ? [reading.accounting] : [],
        );
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({
        source: "hermes-native-totals-v2",
        counterId: "hermes-native-totals-v2:default:native",
        totalTokens: 300,
        baseline: true,
      });
      expect(readings[0]?.aiCredits).toBeUndefined();
    } finally {
      reporter.close();
    }
  });
  it("never chooses larger ACP process counters over a native cumulative reading", async () => {
    const usage = context();
    vi.mocked(readNativeTokenTotals).mockReturnValue(cumulative);
    const reporter = new HermesUsageReporter(usage, "default");
    try {
      await reporter.start("native", false, true);
      await reporter.afterPrompt({
        stopReason: "end_turn",
        usage: { totalTokens: 10000, inputTokens: 9900, outputTokens: 100 },
      } as unknown as acp.PromptResponse);
      await reporter.flush();
      const readings = vi
        .mocked(usage.report)
        .mock.calls.flatMap(([reading]) =>
          reading.accounting ? [reading.accounting] : [],
        );
      expect(readings.map((reading) => reading.totalTokens)).toEqual([300]);
    } finally {
      reporter.close();
    }
  });
  it("waits for native persistence rather than substituting incompatible response usage", async () => {
    const usage = context();
    const reporter = new HermesUsageReporter(usage, "default");
    try {
      await reporter.start("native", false, true);
      await reporter.afterPrompt({
        stopReason: "end_turn",
        usage: { totalTokens: 10000 },
      } as unknown as acp.PromptResponse);
      expect(usage.report).not.toHaveBeenCalled();
      vi.mocked(readNativeTokenTotals).mockReturnValue(cumulative);
      await reporter.flush();
      expect(usage.report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accounting: expect.objectContaining({ totalTokens: 300 }),
        }),
      );
    } finally {
      reporter.close();
    }
  });
});
