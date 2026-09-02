import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Notification as FleetNotification } from "@fleet/protocol";
import { resetNotificationClaimsForTest } from "../lib/notification-claim";
import type { LiveNotificationUpdate } from "./useFleet";

const playChime = vi.fn();
vi.mock("../lib/chime", () => ({
  playChime: (kind: string) => playChime(kind),
}));

const { useNotificationDelivery } = await import("./useNotificationDelivery");

const item = (id = "n1", overrides: Partial<FleetNotification> = {}): FleetNotification =>
  ({
    id,
    sourceKey: id,
    category: "permission",
    kind: "permission_request",
    severity: "warning",
    status: "active",
    title: "Permission needed",
    body: "A safe tool summary",
    subject: { type: "permission_request", id: "p1", label: "Tool request" },
    navigation: { type: "permission_request", sessionId: "s1" },
    data: {},
    createdAt: "2026-09-01T19:00:00.000Z",
    updatedAt: "2026-09-01T19:00:00.000Z",
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
    ...overrides,
  }) as FleetNotification;

const update = (
  sequence: number,
  notification: FleetNotification,
  deliver = true,
): LiveNotificationUpdate => ({ sequence, notification, deliver });

type TestDelivery = Parameters<typeof useNotificationDelivery>[0] & {
  onToast: ReturnType<typeof vi.fn>;
  onNavigate: ReturnType<typeof vi.fn>;
};

class MockNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();
  static instances: MockNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    MockNotification.instances.push(this);
  }
}

const delivery = (
  notificationUpdates: LiveNotificationUpdate[],
  overrides: Partial<Parameters<typeof useNotificationDelivery>[0]> = {},
): TestDelivery => {
  const onToast = vi.fn();
  const onNavigate = vi.fn();
  return {
    notificationUpdates,
    unreadCount: notificationUpdates.length,
    isTargetVisible: vi.fn(() => false),
    ...overrides,
    onToast,
    onNavigate,
  };
};

beforeEach(() => {
  localStorage.clear();
  resetNotificationClaimsForTest();
  playChime.mockClear();
  MockNotification.permission = "default";
  MockNotification.requestPermission.mockReset();
  MockNotification.instances = [];
  vi.stubGlobal("Notification", MockNotification);
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

describe("useNotificationDelivery", () => {
  it("delivers a new record once without redelivering a later upsert", async () => {
    const notification = item();
    const input = delivery([update(1, notification)]);
    const { rerender } = renderHook(({ value }) => useNotificationDelivery(value), {
      initialProps: { value: input },
    });
    await waitFor(() => expect(input.onToast).toHaveBeenCalledTimes(1));
    expect(playChime).toHaveBeenCalledExactlyOnceWith("permission");

    rerender({
      value: {
        ...input,
        notificationUpdates: [
          update(1, notification),
          update(2, item("n1", { updatedAt: "2026-09-01T19:01:00.000Z" }), false),
        ],
      },
    });
    await act(async () => Promise.resolve());
    expect(input.onToast).toHaveBeenCalledTimes(1);
    expect(playChime).toHaveBeenCalledTimes(1);
  });

  it("keeps in-app delivery working when browser permission is denied", async () => {
    MockNotification.requestPermission.mockResolvedValue("denied");
    const input = delivery([]);
    const { result, rerender } = renderHook(
      ({ value }) => useNotificationDelivery(value),
      { initialProps: { value: input } },
    );

    act(() => result.current.toggleBrowser());
    await waitFor(() => expect(MockNotification.requestPermission).toHaveBeenCalled());
    expect(result.current.browserEnabled).toBe(false);

    rerender({
      value: {
        ...input,
        notificationUpdates: [update(1, item())],
      },
    });
    await waitFor(() =>
      expect(input.onToast).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" })),
    );
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("uses the fallback claim to avoid duplicate transient delivery", async () => {
    const first = delivery([update(1, item("shared"))]);
    const second = delivery([update(1, item("shared"))]);
    renderHook(() => useNotificationDelivery(first));
    renderHook(() => useNotificationDelivery(second));

    await waitFor(() =>
      expect(first.onToast.mock.calls.length + second.onToast.mock.calls.length).toBe(1),
    );
    expect(playChime).toHaveBeenCalledTimes(1);
  });

  it("serializes supported-browser claims with Web Locks", async () => {
    let tail = Promise.resolve();
    const request = vi.fn(
      <T,>(
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => T | PromiseLike<T>,
      ): Promise<T> => {
        const result = tail.then(() => callback({ name: "notification" } as Lock));
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    const first = delivery([update(1, item("locked"))]);
    const second = delivery([update(1, item("locked"))]);
    renderHook(() => useNotificationDelivery(first));
    renderHook(() => useNotificationDelivery(second));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(first.onToast.mock.calls.length + second.onToast.mock.calls.length).toBe(1);
  });

  it("uses a browser notification instead of a toast while the page is hidden", async () => {
    localStorage.setItem("fleet.browser-notifications", "on");
    MockNotification.permission = "granted";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const input = delivery([update(1, item())]);
    renderHook(() => useNotificationDelivery(input));

    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));
    expect(input.onToast).not.toHaveBeenCalled();
    expect(MockNotification.instances[0]?.options?.body).toBe("A safe tool summary");

    MockNotification.instances[0]?.onclick?.();
    expect(input.onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
  });

  it("closes a durable desktop notification when a live update resolves it", async () => {
    localStorage.setItem("fleet.browser-notifications", "on");
    MockNotification.permission = "granted";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const active = item();
    const input = delivery([update(1, active)]);
    const { rerender } = renderHook(({ value }) => useNotificationDelivery(value), {
      initialProps: { value: input },
    });
    await waitFor(() => expect(MockNotification.instances).toHaveLength(1));

    const resolved = item("n1", {
      status: "resolved",
      resolvedAt: "2026-09-01T19:01:00.000Z",
      updatedAt: "2026-09-01T19:01:00.000Z",
    });
    rerender({
      value: {
        ...input,
        notificationUpdates: [update(1, active), update(2, resolved, false)],
      },
    });

    expect(MockNotification.instances[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("plays sound only while hidden when browser notifications are disabled", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const hidden = delivery([update(1, item("sound-only"))]);
    renderHook(() => useNotificationDelivery(hidden));
    await waitFor(() => expect(playChime).toHaveBeenCalledExactlyOnceWith("permission"));
    expect(hidden.onToast).not.toHaveBeenCalled();
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("falls back to sound only while hidden when browser permission is denied", async () => {
    localStorage.setItem("fleet.browser-notifications", "on");
    MockNotification.permission = "denied";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const hidden = delivery([update(1, item("denied-sound"))]);
    renderHook(() => useNotificationDelivery(hidden));

    await waitFor(() => expect(playChime).toHaveBeenCalledExactlyOnceWith("permission"));
    expect(hidden.onToast).not.toHaveBeenCalled();
    expect(MockNotification.instances).toHaveLength(0);
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("uses the cross-tab claim so only one hidden tab chimes", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const first = delivery([update(1, item("hidden-shared"))]);
    const second = delivery([update(1, item("hidden-shared"))]);
    renderHook(() => useNotificationDelivery(first));
    renderHook(() => useNotificationDelivery(second));

    await waitFor(() => expect(playChime).toHaveBeenCalledTimes(1));
    expect(first.onToast).not.toHaveBeenCalled();
    expect(second.onToast).not.toHaveBeenCalled();
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("prefers a visible toast over a hidden browser claimant", async () => {
    localStorage.setItem("fleet.browser-notifications", "on");
    MockNotification.permission = "granted";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const hidden = delivery([update(1, item("preferred"))]);
    renderHook(() => useNotificationDelivery(hidden));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    const visible = delivery([update(1, item("preferred"))]);
    renderHook(() => useNotificationDelivery(visible));

    await waitFor(() => expect(visible.onToast).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(MockNotification.instances).toHaveLength(0);
    expect(hidden.onToast).not.toHaveBeenCalled();
  });

  it("lets a target-visible tab suppress another visible tab", async () => {
    const candidate = delivery([update(1, item("visible-suppressed"))]);
    renderHook(() => useNotificationDelivery(candidate));

    const target = delivery([update(1, item("visible-suppressed"))], {
      isTargetVisible: vi.fn(() => true),
    });
    renderHook(() => useNotificationDelivery(target));

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(candidate.onToast).not.toHaveBeenCalled();
    expect(target.onToast).not.toHaveBeenCalled();
    expect(MockNotification.instances).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("lets a target-visible tab suppress a hidden browser tab", async () => {
    localStorage.setItem("fleet.browser-notifications", "on");
    MockNotification.permission = "granted";
    const request = vi.fn(
      <T,>(
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => T | PromiseLike<T>,
      ): Promise<T> => Promise.resolve(callback({ name: "notification" } as Lock)),
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const browserCandidate = delivery([update(1, item("browser-suppressed"))]);
    renderHook(() => useNotificationDelivery(browserCandidate));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    const target = delivery([update(1, item("browser-suppressed"))], {
      isTargetVisible: vi.fn(() => true),
    });
    renderHook(() => useNotificationDelivery(target));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(request).toHaveBeenCalledTimes(2);
    expect(target.onToast).not.toHaveBeenCalled();
    expect(MockNotification.instances).toHaveLength(0);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("elects one visible delivery when no tab has the target visible", async () => {
    const first = delivery([update(1, item("no-target"))]);
    const second = delivery([update(1, item("no-target"))]);
    renderHook(() => useNotificationDelivery(first));
    renderHook(() => useNotificationDelivery(second));

    await waitFor(() =>
      expect(first.onToast.mock.calls.length + second.onToast.mock.calls.length).toBe(1),
    );
    expect(playChime).toHaveBeenCalledTimes(1);
  });
});
