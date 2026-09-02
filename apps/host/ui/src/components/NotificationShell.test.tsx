import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserMessage, Notification, Snapshot } from "@fleet/protocol";
import { useFleet } from "../hooks/useFleet";
import { fleetDarkTheme } from "../theme";
import { NotificationCenter } from "./NotificationCenter";

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
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            notification: { ...item, readAt: ISO },
            unreadCount: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );
});

afterEach(() => vi.unstubAllGlobals());

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
    expect(fetch).toHaveBeenCalledWith(
      "/api/notifications/authoritative/read",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
