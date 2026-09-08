import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserMessage, Notification, Snapshot } from "@fleet/protocol";
import { useFleet } from "../hooks/useFleet";
import { useAppNotifications } from "../hooks/useAppNotifications";
import { forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";
import { NotificationCenter } from "./NotificationCenter";
import { TopBar } from "./TopBar";

const ISO = "2026-09-01T19:00:00.000Z";

const item: Notification = {
  id: "authoritative",
  sourceKey: "permission:s1:p1",
  category: "permission",
  kind: "permission_request",
  severity: "warning",
  status: "active",
  title: "Permission needed",
  body: "A tool call is waiting for a decision.",
  subject: { type: "permission_request", id: "p1", label: "Tool request" },
  navigation: { type: "permission_request", sessionId: "s1" },
  data: {},
  createdAt: ISO,
  updatedAt: ISO,
  readAt: null,
  dismissedAt: null,
  resolvedAt: null,
};

const empty: Snapshot = {
  nodes: [],
  workspaces: [],
  placements: [],
  sessions: [],
  runs: [],
  notifications: [],
  notificationUnreadCount: 0,
  hostRevision: "",
};

class MockWebSocket {
  static instance: MockWebSocket;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();

  constructor() {
    MockWebSocket.instance = this;
  }

  send(message: BrowserMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

beforeEach(() => {
  forgetCsrfToken();
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string | URL | Request) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(path) === "/api/auth/csrf"
              ? { csrfToken: "proof" }
              : { notification: { ...item, readAt: ISO }, unreadCount: 0 },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );
});

afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

describe("notification shell integration", () => {
  it("renders an authoritative live upsert in the badge and navigates to its session", async () => {
    const Harness = () => {
      const fleet = useFleet(vi.fn());
      const [destination, setDestination] = useState("");
      return (
        <>
          <NotificationCenter
            notifications={fleet.snapshot.notifications}
            unreadCount={fleet.snapshot.notificationUnreadCount}
            browserEnabled={false}
            onToggleBrowser={vi.fn()}
            onNavigate={(notification) => {
              if (notification.kind === "app_message") return;
              void fleet.markNotificationRead(notification.id);
              setDestination(notification.navigation.sessionId ?? "fleet");
            }}
            onMarkRead={fleet.markNotificationRead}
            onMarkAllRead={() => void fleet.markAllNotificationsRead()}
            onDismissAll={() => void fleet.dismissAllNotifications()}
            onDismiss={fleet.dismissNotification}
          />
          <output aria-label="Destination">{destination}</output>
        </>
      );
    };
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <Harness />
      </FluentProvider>,
    );

    act(() => {
      MockWebSocket.instance.send({ type: "snapshot", data: empty });
      MockWebSocket.instance.send({ type: "notification_upsert", notification: item });
      MockWebSocket.instance.send({
        type: "notification_unread_count",
        unreadCount: 1,
      });
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Notifications, 1 unread notification",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Permission needed" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Destination").textContent).toBe("s1"),
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/notifications/authoritative/read",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("keeps local operation messages through live server snapshots without posting them", async () => {
    const Harness = () => {
      const local = useAppNotifications();
      const fleet = useFleet(local.add);
      return (
        <>
          <button onClick={() => local.add("Offline operation failed")}>Notify</button>
          <TopBar
            nodesOnline={0}
            liveSessions={0}
            waitingPermissions={0}
            connected={fleet.connected}
            context={{ kind: "none" }}
            soundEnabled={false}
            onToggleSound={vi.fn()}
            onSignOut={vi.fn()}
            notifications={fleet.snapshot.notifications}
            notificationUnreadCount={fleet.snapshot.notificationUnreadCount}
            appNotifications={local}
            onMarkNotificationRead={fleet.markNotificationRead}
            onDismissNotification={fleet.dismissNotification}
            onMarkAllNotificationsRead={() => void fleet.markAllNotificationsRead()}
            onDismissAllNotifications={() => void fleet.dismissAllNotifications()}
          />
        </>
      );
    };
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <Harness />
      </FluentProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    act(() => {
      MockWebSocket.instance.send({
        type: "snapshot",
        data: { ...empty, notifications: [item], notificationUnreadCount: 1 },
      });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications, 2 unread notifications" }),
    );
    expect(screen.getByText("Offline operation failed")).toBeTruthy();
    expect(screen.getByText("Permission needed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Read Application error" }));
    await waitFor(() => expect(screen.getByText("Read")).toBeTruthy());
    act(() => {
      MockWebSocket.instance.send({ type: "snapshot", data: empty });
    });
    expect(screen.getByText("Offline operation failed")).toBeTruthy();
    expect(screen.queryByText("Permission needed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Application error" }));
    expect(screen.queryByText("Offline operation failed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications, 1 unread notification" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("No notifications yet.")).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toEqual([]);
  });
});
