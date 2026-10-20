import { describe, expect, it, vi } from "vitest";
import { CopilotUsageReporter } from "./copilot-usage.js";
import { readNativeTokenTotals } from "../usage-totals.js";
import type { UsageContext } from "./types.js";
const native = vi.hoisted(() => ({
  nativeSessionId: "native",
  counterId: "native",
  source: "copilot-checkpoint",
  observedAt: "2026-10-19T12:00:00Z",
  aiCredits: 2,
  totalTokens: 150,
}));
vi.mock("../usage-totals.js", () => ({ readNativeTokenTotals: vi.fn() }));
vi.mock("../session-credits.js", () => ({
  SessionCreditReader: class {
    accounting = native;
    loop = { idle: true, generation: 1 };
    read = async () => native.aiCredits;
  },
}));
describe("CopilotUsageReporter accounting", () => {
  it("keeps database tokens authoritative across transient unavailability while refreshing credits", async () => {
    vi.mocked(readNativeTokenTotals)
      .mockReturnValueOnce({ totalTokens: 200 })
      .mockReturnValue(undefined);
    const context: UsageContext = {
      report: vi.fn(),
      notice: vi.fn(),
      model: () => "model",
      stopping: () => false,
      aborted: () => false,
      assertActive: () => {},
      prompt: async () => {},
    };
    const reporter = new CopilotUsageReporter(context);
    try {
      await reporter.start("native", false, true);
      native.aiCredits = 3;
      await reporter.flush();
      const readings = vi
        .mocked(context.report)
        .mock.calls.flatMap(([reading]) =>
          reading.accounting ? [reading.accounting] : [],
        );
      expect(readings.filter((reading) => reading.totalTokens !== undefined)).toEqual([
        expect.objectContaining({ totalTokens: 200, baseline: true }),
      ]);
      expect(readings.at(-1)).toMatchObject({ aiCredits: 3 });
      expect(readings.at(-1)?.totalTokens).toBeUndefined();
    } finally {
      reporter.close();
      native.aiCredits = 2;
    }
  });
});
