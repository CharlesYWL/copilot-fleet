import { afterEach, describe, expect, it, vi } from "vitest";
import { startNotificationRetentionMonitor } from "./retention.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startNotificationRetentionMonitor", () => {
  it("reports a periodic sweep failure without throwing from the timer", async () => {
    vi.useFakeTimers();
    const pruneNotifications = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockImplementationOnce(() => {
        throw new Error("retention failed");
      });
    const error = vi.fn();
    const timer = startNotificationRetentionMonitor(
      { pruneNotifications },
      { error },
      100,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(pruneNotifications).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      { error: expect.objectContaining({ message: "retention failed" }) },
      "Failed periodic notification retention sweep",
    );
    clearInterval(timer);
  });
});
