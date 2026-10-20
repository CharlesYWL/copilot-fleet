import { describe, expect, it } from "vitest";
import { exactUsageAmount, formatUsageAmount } from "./usage-format";

describe("formatUsageAmount", () => {
  it("retains integer token counts and fractional credit precision in exact readings", () => {
    expect(exactUsageAmount(100_572_259)).toBe("100,572,259");
    expect(exactUsageAmount(1.123456789)).toBe("1.123456789");
  });
  it.each([
    [null, "—"],
    [0, "0"],
    [2.125, "2.125"],
    [999, "999"],
    [1_000, "1.00K"],
    [382_154, "382.15K"],
    [100_572_259, "100.57M"],
    [2_100_000_000, "2.10B"],
    [999_999, "1.00M"],
    [999_999_999, "1.00B"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatUsageAmount(value)).toBe(expected);
  });
});
