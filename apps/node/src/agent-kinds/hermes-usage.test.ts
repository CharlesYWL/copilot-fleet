import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { HermesUsageReporter } from "./hermes-usage.js";
import type * as UsageTotalsModule from "../usage-totals.js";
import type { UsageContext } from "./types.js";
vi.mock("../usage-totals.js", async (original) => ({
  ...(await original<typeof UsageTotalsModule>()),
  readNativeTokenTotals: () => undefined,
}));
describe("HermesUsageReporter", () => {
  it("keeps context separate and publishes cumulative completion totals without AI credits", async () => {
    const context: UsageContext = {
      report: vi.fn(),
      notice: vi.fn(),
      model: () => "model",
      stopping: () => false,
      aborted: () => false,
      assertActive: () => {},
      prompt: async () => {},
    };
    const reporter = new HermesUsageReporter(context, "default");
    await reporter.start("native", false, true);
    try {
      reporter.onUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000 });
      expect(context.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ contextTokens: 100 }),
      );
      const response = {
        stopReason: "end_turn",
        usage: { totalTokens: 300, inputTokens: 200, outputTokens: 100 },
      } as unknown as acp.PromptResponse;
      await reporter.afterPrompt(response);
      await reporter.afterPrompt(response);
      const readings = vi
        .mocked(context.report)
        .mock.calls.filter(([reading]) => reading.accounting);
      expect(readings).toHaveLength(1);
      expect(readings[0]![0].accounting).toMatchObject({
        totalTokens: 300,
        baseline: true,
      });
      expect(readings[0]![0].accounting?.aiCredits).toBeUndefined();
    } finally {
      reporter.close();
    }
  });
});
