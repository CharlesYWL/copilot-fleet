import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { NotificationCenter } from "./NotificationCenter";

const notification = (
  id: string,
  createdAt: string,
  overrides: Partial<Notification> = {},
): Notification => ({
  id,
  sourceKey: id,
  category: "orchestration",
  kind: "orchestration_step_failure",
  severity: "error",
  status: "active",
  title: `Title ${id}`,
  body: `Body ${id}`,
  subject: { type: "run_step", id, label: id, parentId: "r1" },
  navigation: { type: "run_step", runId: "r1", stepId: id },
  data: {},
  createdAt,
  updatedAt: createdAt,
  readAt: null,
  dismissedAt: null,
  resolvedAt: null,
  ...overrides,
});

const show = (
  notifications: Notification[] = [],
  unreadCount = 0,
  overrides: Partial<Parameters<typeof NotificationCenter>[0]> = {},
) => {
  const props = {
    notifications,
    unreadCount,
    browserEnabled: false,
    onToggleBrowser: vi.fn(),
    onNavigate: vi.fn(),
    onMarkRead: vi.fn(),
    onMarkAllRead: vi.fn(),
    onDismissAll: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationCenter {...props} />
    </FluentProvider>,
  );
  return props;
};

const open = (unreadCount: number) =>
  fireEvent.click(
    screen.getByRole("button", {
      name: `Notifications, ${unreadCount} unread notification${
        unreadCount === 1 ? "" : "s"
      }`,
    }),
  );

describe("NotificationCenter", () => {
  it("hides the inline count at zero and shows it above zero", () => {
    const { rerender } = render(
      <FluentProvider theme={fleetDarkTheme}>
        <NotificationCenter
          notifications={[]}
          unreadCount={0}
          browserEnabled={false}
          onToggleBrowser={vi.fn()}
          onNavigate={vi.fn()}
          onMarkRead={vi.fn()}
          onMarkAllRead={vi.fn()}
          onDismissAll={vi.fn()}
          onDismiss={vi.fn()}
        />
      </FluentProvider>,
    );
    let bell = screen.getByRole("button", {
      name: "Notifications, 0 unread notifications",
    });
    expect(bell.parentElement?.textContent).toBe("");

    rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <NotificationCenter
          notifications={[]}
          unreadCount={3}
          browserEnabled={false}
          onToggleBrowser={vi.fn()}
          onNavigate={vi.fn()}
          onMarkRead={vi.fn()}
          onMarkAllRead={vi.fn()}
          onDismissAll={vi.fn()}
          onDismiss={vi.fn()}
        />
      </FluentProvider>,
    );
    bell = screen.getByRole("button", {
      name: "Notifications, 3 unread notifications",
    });
    expect(bell.parentElement?.textContent).toBe("3");
  });

  it("shows a clear empty state", () => {
    show();
    open(0);
    expect(screen.getByText("No notifications yet.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mark all read" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Clear all" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("orders newest first and exposes truthful kind, severity, and time", () => {
    show([
      notification("old", "2026-09-01T18:00:00.000Z"),
      notification("new", "2026-09-01T19:00:00.000Z", {
        kind: "permission_request",
        severity: "warning",
      }),
    ]);
    open(0);

    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByText("Title new")).toBeTruthy();
    expect(within(items[0]!).getByText("Permission required")).toBeTruthy();
    expect(within(items[0]!).getByRole("img", { name: "warning severity" })).toBeTruthy();
    expect(items[0]!.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-09-01T19:00:00.000Z",
    );
    expect(within(items[1]!).getByText("Title old")).toBeTruthy();
  });

  it("marks one or all read, dismisses, and navigates from the item", async () => {
    const unread = notification("unread", "2026-09-01T19:00:00.000Z");
    const read = notification("read", "2026-09-01T18:00:00.000Z", {
      readAt: "2026-09-01T18:30:00.000Z",
    });
    const props = show([unread, read], 1);
    open(1);

    expect(screen.getByText("Unread")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark Title read read" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark Title unread read" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Title unread" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Title unread" }));

    expect(props.onMarkRead).toHaveBeenCalledWith("unread");
    expect(props.onMarkAllRead).toHaveBeenCalledTimes(1);
    expect(props.onDismiss).toHaveBeenCalledWith("unread");
    await waitFor(() => expect(props.onNavigate).toHaveBeenCalledWith(unread));
  });

  it("clears every notification through the bulk action", () => {
    const onDismissAll = vi.fn();
    show([notification("one", "2026-09-01T19:00:00.000Z")], 1, {
      onDismissAll,
    });
    open(1);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onDismissAll).toHaveBeenCalledTimes(1);
  });

  it("aggregates repeated lifecycle messages by agent", async () => {
    const first = notification("first", "2026-09-01T18:00:00.000Z", {
      category: "agent_lifecycle",
      kind: "agent_completion",
      title: "Router cleanup completed a turn",
      subject: {
        type: "agent",
        id: "session-1",
        label: "Router cleanup",
      },
      navigation: { type: "session", sessionId: "session-1" },
      data: { sessionId: "session-1" },
    });
    const second = notification("second", "2026-09-01T19:00:00.000Z", {
      category: "agent_lifecycle",
      kind: "agent_completion",
      title: "Router cleanup completed a turn",
      subject: {
        type: "agent",
        id: "session-1",
        label: "Router cleanup",
      },
      navigation: { type: "session", sessionId: "session-1" },
      data: { sessionId: "session-1" },
    });
    const props = show([first, second], 2);
    open(2);

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Router cleanup completed a turn")).toBeTruthy();
    expect(screen.getByText("2 updates")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Mark Router cleanup completed a turn read",
      }),
    );
    await waitFor(() => expect(props.onMarkRead).toHaveBeenCalledTimes(2));
    expect(props.onMarkRead).toHaveBeenNthCalledWith(1, "second");
    expect(props.onMarkRead).toHaveBeenNthCalledWith(2, "first");
  });

  it("serializes grouped mutations and finishes older reads before navigation", async () => {
    let releaseRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const onMarkRead = vi
      .fn()
      .mockImplementationOnce(() => firstRead)
      .mockResolvedValue(undefined);
    const onNavigate = vi.fn();
    const first = notification("first", "2026-09-01T18:00:00.000Z", {
      category: "agent_lifecycle",
      kind: "agent_completion",
      navigation: { type: "session", sessionId: "session-1" },
      data: { sessionId: "session-1" },
    });
    const second = notification("second", "2026-09-01T19:00:00.000Z", {
      category: "agent_lifecycle",
      kind: "agent_completion",
      navigation: { type: "session", sessionId: "session-1" },
      data: { sessionId: "session-1" },
    });
    show([first, second], 2, { onMarkRead, onNavigate });
    open(2);

    fireEvent.click(screen.getByRole("button", { name: "Mark Title second read" }));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledWith("second");
    releaseRead();
    await waitFor(() => expect(onMarkRead).toHaveBeenCalledTimes(2));
    expect(onMarkRead).toHaveBeenNthCalledWith(2, "first");

    onMarkRead.mockClear();
    onMarkRead.mockImplementationOnce(() => firstRead);
    fireEvent.click(screen.getByRole("button", { name: "Open Title second" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(second));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledWith("first");
  });

  it("renders resolved permission and review items as no longer actionable", () => {
    show([
      notification("permission", "2026-09-01T19:00:00.000Z", {
        kind: "permission_request",
        category: "permission",
        status: "resolved",
        title: "Permission requested",
        body: "An agent is waiting for a permission decision.",
        subject: {
          type: "permission_request",
          id: "permission",
          label: "Tool request",
        },
        resolvedAt: "2026-09-01T19:01:00.000Z",
        updatedAt: "2026-09-01T19:01:00.000Z",
        readAt: "2026-09-01T19:01:00.000Z",
      }),
      notification("review", "2026-09-01T18:00:00.000Z", {
        kind: "orchestration_needs_review",
        status: "resolved",
        title: "Task needs review: Ship it",
        body: "A human decision is required.",
        subject: {
          type: "run",
          id: "r1",
          label: "Ship it",
        },
        resolvedAt: "2026-09-01T19:01:00.000Z",
        updatedAt: "2026-09-01T19:01:00.000Z",
      }),
    ]);
    open(0);

    expect(screen.getByText("Permission request resolved")).toBeTruthy();
    expect(screen.getByText("Review resolved: Ship it")).toBeTruthy();
    expect(screen.getAllByText("Resolved")).toHaveLength(2);
    expect(screen.getAllByText("This item no longer needs action.")).toHaveLength(2);
    expect(screen.queryByText("Permission required")).toBeNull();
    expect(screen.queryByText("Needs review")).toBeNull();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Unread")).toBeTruthy();
  });

  it("offers browser alerts only through an explicit control", () => {
    const onToggleBrowser = vi.fn();
    show([], 0, { onToggleBrowser });
    open(0);

    const toggle = screen.getByRole("button", { name: "Enable browser alerts" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggleBrowser).toHaveBeenCalledTimes(1);
  });
});
