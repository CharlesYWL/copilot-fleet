import { describe, expect, it } from "vitest";
import { reconnectDelay } from "./reconnect-delay";

describe("reconnectDelay", () => {
  it("retries almost immediately on the first attempt", () => {
    // A dev server restart is back within a second, which is the common case;
    // waiting longer would make the UI feel broken for no reason.
    expect(reconnectDelay(0)).toBe(500);
  });

  it("backs off as attempts pile up", () => {
    expect(reconnectDelay(1)).toBe(1_000);
    expect(reconnectDelay(2)).toBe(2_000);
    expect(reconnectDelay(3)).toBe(4_000);
  });

  it("stops growing at a ceiling so a long outage still recovers promptly", () => {
    // Without a cap the delay doubles into minutes, and the operator would be
    // left staring at stale data long after the host came back.
    expect(reconnectDelay(10)).toBe(10_000);
    expect(reconnectDelay(50)).toBe(10_000);
  });
});
