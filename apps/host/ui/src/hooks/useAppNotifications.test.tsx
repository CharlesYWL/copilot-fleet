import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  NotificationContext,
  useAppNotifications,
  useMessageNotification,
  useNotify,
  type NotificationIntent,
} from "./useAppNotifications";

describe("useAppNotifications", () => {
  it.each([
    ["error", "error"],
    ["warning", "warning"],
    ["info", "info"],
    ["success", "info"],
  ] as const)("records %s messages with %s severity", (intent, severity) => {
    const { result } = renderHook(useAppNotifications);
    act(() => result.current.add("Operation result", intent));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]).toMatchObject({
      kind: "app_message",
      category: "application",
      body: "Operation result",
      intent,
      severity,
      status: "active",
      readAt: null,
      navigation: { type: "none" },
    });
    expect(result.current.unreadCount).toBe(1);
  });

  it("deduplicates unread message and intent, including batched arrivals", () => {
    const { result } = renderHook(useAppNotifications);
    act(() => {
      result.current.add("Offline");
      result.current.add("Offline");
      result.current.add("Offline", "warning");
      result.current.add(" ");
    });
    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.unreadCount).toBe(2);
  });

  it("preserves read history but allows new occurrences after read or dismissal", () => {
    const { result } = renderHook(useAppNotifications);
    act(() => result.current.add("Offline"));
    const firstId = result.current.notifications[0]!.id;
    act(() => result.current.markRead(firstId));
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.notifications[0]!.readAt).toBeTruthy();
    act(() => result.current.add("Offline"));
    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.notifications[0]!.id).not.toBe(firstId);
    const secondId = result.current.notifications[0]!.id;
    act(() => result.current.dismiss(secondId));
    expect(result.current.notifications.map((item) => item.id)).toEqual([firstId]);
    act(() => result.current.add("Offline"));
    expect(result.current.unreadCount).toBe(1);
  });

  it("marks all read and clears all while allowing subsequent notifications", () => {
    const { result } = renderHook(useAppNotifications);
    act(() => {
      result.current.add("One");
      result.current.add("Two", "warning");
    });
    act(() => result.current.markAllRead());
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.notifications.every((item) => item.readAt)).toBe(true);
    act(() => result.current.dismissAll());
    expect(result.current.notifications).toEqual([]);
    act(() => result.current.add("One"));
    expect(result.current.unreadCount).toBe(1);
  });

  it("bounds history and never stores messages or calls a backend", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    try {
      const { result, unmount } = renderHook(useAppNotifications);
      act(() => {
        for (let index = 0; index < 205; index++) {
          result.current.add(`Message ${index}`);
        }
      });
      expect(result.current.notifications).toHaveLength(200);
      expect(result.current.notifications[0]!.body).toBe("Message 204");
      expect(result.current.notifications.at(-1)!.body).toBe("Message 5");
      act(() => result.current.markRead(result.current.notifications[0]!.id));
      act(() => result.current.dismiss(result.current.notifications[0]!.id));
      act(() => result.current.markAllRead());
      act(() => result.current.dismissAll());
      unmount();
      const next = renderHook(useAppNotifications);
      expect(next.result.current.notifications).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      storage.mockRestore();
    }
  });
});

describe("notification context", () => {
  it("has a harmless default and exposes the provider callback", () => {
    const outside = renderHook(useNotify);
    expect(() => outside.result.current("Outside provider")).not.toThrow();
    const notify = vi.fn();
    const inside = renderHook(useNotify, {
      wrapper: ({ children }) => (
        <NotificationContext.Provider value={notify}>
          {children}
        </NotificationContext.Provider>
      ),
    });
    inside.result.current("Saved", "success");
    expect(notify).toHaveBeenCalledWith("Saved", "success");
  });

  it("forwards changed nonempty messages once, including strict effects and callback changes", () => {
    let notify = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <NotificationContext.Provider value={notify}>
          {children}
        </NotificationContext.Provider>
      </StrictMode>
    );
    const { rerender } = renderHook(
      ({ message, intent }: { message: string | null; intent: NotificationIntent }) =>
        useMessageNotification(message, intent),
      { wrapper, initialProps: { message: "Offline", intent: "error" } },
    );
    expect(notify).toHaveBeenCalledExactlyOnceWith("Offline", "error");
    rerender({ message: "Offline", intent: "error" });
    expect(notify).toHaveBeenCalledTimes(1);
    notify = vi.fn();
    rerender({ message: "Offline", intent: "error" });
    expect(notify).not.toHaveBeenCalled();
    rerender({ message: "Offline", intent: "warning" });
    expect(notify).toHaveBeenCalledExactlyOnceWith("Offline", "warning");
    rerender({ message: null, intent: "warning" });
    rerender({ message: "  ", intent: "warning" });
    expect(notify).toHaveBeenCalledTimes(1);
    rerender({ message: "Offline", intent: "warning" });
    expect(notify).toHaveBeenCalledTimes(2);
    rerender({ message: "Online", intent: "info" });
    expect(notify).toHaveBeenLastCalledWith("Online", "info");
  });
});
