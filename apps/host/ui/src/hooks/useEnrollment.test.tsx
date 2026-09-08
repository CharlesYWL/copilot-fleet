import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationContext } from "./useAppNotifications";
import { api } from "./useFleet";
import { useEnrollment, type Enrollment } from "./useEnrollment";

vi.mock("./useFleet", () => ({ api: vi.fn() }));

const enrollment: Enrollment = {
  hostUrl: "https://fleet.example.com",
  hostId: "host-1",
  hostFingerprint: "fingerprint",
  hostPublicKey: "public-key",
  nodeAuthentication: { total: 1, mutualAuth: 1, legacy: 0 },
  mutualAuthenticationRequired: true,
};

const wrapper = (notify: ReturnType<typeof vi.fn>) =>
  function Notifications({ children }: { children: ReactNode }) {
    return (
      <NotificationContext.Provider value={notify}>
        {children}
      </NotificationContext.Provider>
    );
  };

describe("useEnrollment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports initial polling failures once until recovery and retains the last good answer", async () => {
    const notify = vi.fn();
    vi.mocked(api).mockRejectedValue(new Error("Host unreachable"));
    const { result, rerender } = renderHook(() => useEnrollment(), {
      wrapper: wrapper(notify),
    });
    await act(async () => {});
    expect(result.current).toBeUndefined();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Could not refresh enrollment settings: Host unreachable",
      "error",
    );
    rerender();
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(api).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledTimes(1);

    vi.mocked(api).mockResolvedValue(enrollment);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current).toEqual(enrollment);
    vi.mocked(api).mockRejectedValue(new Error("Host unreachable"));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(result.current).toEqual(enrollment);
    expect(notify).toHaveBeenCalledTimes(2);

    vi.mocked(api).mockRejectedValue(new Error("Enrollment access refused"));
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(notify).toHaveBeenLastCalledWith(
      "Could not refresh enrollment settings: Enrollment access refused",
      "error",
    );
    expect(notify).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual(enrollment);
  });

  it("ignores failures from a cancelled polling effect", async () => {
    let rejectPrevious!: (reason: Error) => void;
    vi.mocked(api)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectPrevious = reject;
          }),
      )
      .mockResolvedValue(enrollment);
    const notify = vi.fn();
    const { result, rerender } = renderHook(
      ({ intervalMs }) => useEnrollment(intervalMs),
      { initialProps: { intervalMs: 3_000 }, wrapper: wrapper(notify) },
    );
    rerender({ intervalMs: 5_000 });
    await act(async () => {});
    expect(result.current).toEqual(enrollment);
    await act(async () => rejectPrevious(new Error("Obsolete failure")));
    expect(result.current).toEqual(enrollment);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify or keep polling after unmount", async () => {
    let rejectPending!: (reason: Error) => void;
    vi.mocked(api).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectPending = reject;
        }),
    );
    const notify = vi.fn();
    const { unmount } = renderHook(() => useEnrollment(), {
      wrapper: wrapper(notify),
    });
    unmount();
    await act(async () => {
      rejectPending(new Error("Late failure"));
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
});
