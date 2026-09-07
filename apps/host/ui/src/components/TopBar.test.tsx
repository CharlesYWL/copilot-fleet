import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { Notification } from "@fleet/protocol";
import { useAppNotifications } from "../hooks/useAppNotifications";
import { fleetDarkTheme } from "../theme";
import markUrl from "../assets/copilot-fleet-mark.svg";
import { TopBar } from "./TopBar";

const show = (overrides: Partial<Parameters<typeof TopBar>[0]> = {}) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <TopBar
        nodesOnline={2}
        liveSessions={3}
        waitingPermissions={0}
        connected
        context={{ kind: "session", mode: "tree", onChange: vi.fn() }}
        soundEnabled
        onToggleSound={vi.fn()}
        onSignOut={vi.fn()}
        {...overrides}
      />
    </FluentProvider>,
  );

describe("TopBar counts", () => {
  it("keeps the notification badge numeric and hides zero", () => {
    const first = show({ notificationUnreadCount: 0 });
    const emptyBell = screen.getByRole("button", {
      name: "Notifications, 0 unread notifications",
    });
    expect(emptyBell.textContent).toBe("");
    first.unmount();

    show({ notificationUnreadCount: 2 });
    const unreadBell = screen.getByRole("button", {
      name: "Notifications, 2 unread notifications",
    });
    expect(unreadBell.textContent).toBe("2");
  });

  it("still says what each number counts, now that the words are icons", () => {
    /*
     * The labels moved into the icons to stop three strings pushing the mode
     * switch off centre. They moved visually, not out of the page: without a
     * name of its own each count reached assistive tech as a bare digit.
     */
    show();
    expect(screen.getByRole("img", { name: "2 nodes online" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "3 live sessions" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "0 waiting for you" })).toBeTruthy();
  });

  it("counts one thing in the singular", () => {
    show({ nodesOnline: 1, liveSessions: 1 });
    expect(screen.getByRole("img", { name: "1 node online" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "1 live session" })).toBeTruthy();
  });

  it("keeps the number visible, because that is the information", () => {
    show({ nodesOnline: 7 });
    const stat = screen.getByRole("img", { name: "7 nodes online" });
    expect(stat.textContent).toContain("7");
  });

  it("becomes a way in once something is waiting", () => {
    const onShowAttention = vi.fn();
    show({ waitingPermissions: 4, onShowAttention });

    const button = screen.getByRole("button", { name: "4 waiting for you" });
    button.click();

    expect(onShowAttention).toHaveBeenCalled();
  });

  it("does not offer a way in when nothing is waiting", () => {
    show({ waitingPermissions: 0, onShowAttention: vi.fn() });
    expect(screen.queryByRole("button", { name: /waiting for you/ })).toBeNull();
  });

  it("says whether the Host is reachable without spending a word on it", () => {
    const { rerender } = show({ connected: true });
    expect(screen.getByRole("img", { name: "Connected to the Host" })).toBeTruthy();

    rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <TopBar
          nodesOnline={2}
          liveSessions={3}
          waitingPermissions={0}
          connected={false}
          context={{ kind: "none" }}
          soundEnabled
          onToggleSound={vi.fn()}
          onSignOut={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(screen.getByRole("img", { name: /Reconnecting/ })).toBeTruthy();
  });
});

describe("TopBar layout", () => {
  it("shows the Microsoft account beside sign out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              state: "microsoft-only",
              authenticated: true,
              passwordEnabled: false,
              entraConfigured: true,
              deviceFlowEnabled: false,
              claimCodeRequired: false,
              canSignIn: true,
              codeLogin: { available: true, localForwardRequired: false },
              identity: {
                username: "charlesyin@microsoft.com",
                displayName: "Charles Yin",
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    try {
      show();
      expect(await screen.findByText("Charles Yin")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wears the fleet's own mark, and still says whose console this is", () => {
    /*
     * The mark replaced a gradient tile with "CF" written on it. It is
     * decorative because the words are right there: an accessible name on the
     * image would only make the brand be read twice.
     */
    show();
    const bar = screen.getByRole("banner");
    const mark = bar.querySelector("img");

    expect(mark?.getAttribute("src")).toBe(markUrl);
    expect(mark?.getAttribute("width")).toBe("30");
    expect(mark?.getAttribute("height")).toBe("30");
    expect(within(bar).getByText("Copilot Fleet")).toBeTruthy();
    expect(within(bar).queryByRole("img", { name: /Copilot Fleet/ })).toBeNull();
  });

  it("puts the mode switch in a column of its own, not between two auto margins", () => {
    /*
     * Auto margins only centre within whatever the sides leave, so the switch
     * drifted as the brand or the counts changed width. A three-column grid is
     * what makes "centre" mean the centre of the window.
     */
    show();
    const bar = screen.getByRole("banner");
    const group = within(bar).getByRole("group", { name: "Session layout" });

    expect(bar.childElementCount).toBe(3);
    // The switch is alone in the middle column, so nothing beside it can move it.
    const middle = bar.children[1]!;
    expect(middle.contains(group)).toBe(true);
    expect(middle.childElementCount).toBe(1);
  });

  it("offers no mode column where there is no mode to choose", () => {
    show({ context: { kind: "none" } });
    const bar = screen.getByRole("banner");
    expect(within(bar).queryByRole("group")).toBeNull();
    // The column stays, so the sides do not reflow when the switch goes away.
    expect(bar.childElementCount).toBe(3);
  });
});

describe("TopBar sidebar fold", () => {
  it("folds the tree away and says which way the control goes", () => {
    /*
     * The label is the whole affordance: the two panel glyphs differ by a
     * chevron, and an operator should not have to read an icon to find out
     * whether pressing it takes the sidebar away or brings it back.
     */
    const onToggleNavCollapsed = vi.fn();
    const { rerender } = show({ onToggleNavCollapsed, navCollapsed: false });

    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    hide.click();
    expect(onToggleNavCollapsed).toHaveBeenCalled();

    rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <TopBar
          nodesOnline={2}
          liveSessions={3}
          waitingPermissions={0}
          connected
          context={{ kind: "session", mode: "tree", onChange: vi.fn() }}
          soundEnabled
          onToggleSound={vi.fn()}
          onSignOut={vi.fn()}
          onToggleNavCollapsed={onToggleNavCollapsed}
          navCollapsed
        />
      </FluentProvider>,
    );
    const show_ = screen.getByRole("button", { name: "Show sidebar" });
    expect(show_.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the fold and the drawer as separate controls", () => {
    /*
     * They belong to different layouts — one opens a drawer over the page, the
     * other gives the page the sidebar's width back — and CSS decides which is
     * on screen. One button doing both would have to guess.
     */
    show({ onToggleNav: vi.fn(), onToggleNavCollapsed: vi.fn() });
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeTruthy();
  });

  it("offers nothing to fold where there is no sidebar", () => {
    show();
    expect(screen.queryByRole("button", { name: /sidebar/ })).toBeNull();
  });
});

describe("TopBar application notifications", () => {
  const serverNotification: Notification = {
    id: "server",
    sourceKey: "server",
    category: "orchestration",
    kind: "orchestration_step_failure",
    severity: "error",
    status: "active",
    title: "Server failure",
    body: "Authoritative event",
    subject: { type: "run", id: "run", label: "Run" },
    navigation: { type: "run", runId: "run" },
    data: {},
    createdAt: "2026-09-01T19:00:00.000Z",
    updatedAt: "2026-09-01T19:00:00.000Z",
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
  };

  const setup = (
    notifications: Notification[] = [],
    {
      unreadCount,
      localMessages = ["Local error"],
    }: { unreadCount?: number; localMessages?: string[] } = {},
  ) => {
    const server = {
      onMarkNotificationRead: vi.fn(),
      onDismissNotification: vi.fn(),
      onMarkAllNotificationsRead: vi.fn(),
      onDismissAllNotifications: vi.fn(),
      onNavigateNotification: vi.fn(),
    };
    const Harness = ({ items }: { items: Notification[] }) => {
      const local = useAppNotifications();
      return (
        <FluentProvider theme={fleetDarkTheme}>
          <button onClick={() => localMessages.forEach((message) => local.add(message))}>
            Add local error
          </button>
          <TopBar
            nodesOnline={0}
            liveSessions={0}
            waitingPermissions={0}
            connected={false}
            context={{ kind: "none" }}
            soundEnabled={false}
            onToggleSound={vi.fn()}
            onSignOut={vi.fn()}
            notifications={items}
            notificationUnreadCount={
              unreadCount ?? items.filter((item) => !item.readAt).length
            }
            appNotifications={local}
            {...server}
          />
        </FluentProvider>
      );
    };
    const rendered = render(<Harness items={notifications} />);
    fireEvent.click(screen.getByRole("button", { name: "Add local error" }));
    return {
      server,
      snapshot: (items: Notification[]) => rendered.rerender(<Harness items={items} />),
    };
  };

  const openNotifications = (count: number) =>
    fireEvent.click(
      screen.getByRole("button", {
        name: `Notifications, ${count} unread notification${count === 1 ? "" : "s"}`,
      }),
    );

  it("merges authoritative and local items and preserves local history across snapshots", async () => {
    const { server, snapshot } = setup([serverNotification]);
    openNotifications(2);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Read Application error" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Notifications, 1 unread/ }),
      ).toBeTruthy(),
    );
    expect(server.onMarkNotificationRead).not.toHaveBeenCalled();
    expect(server.onNavigateNotification).not.toHaveBeenCalled();
    snapshot([{ ...serverNotification, body: "Updated by snapshot" }]);
    expect(screen.getByText("Local error")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Updated by snapshot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Application error" }));
    expect(screen.queryByText("Local error")).toBeNull();
    expect(server.onDismissNotification).not.toHaveBeenCalled();
    snapshot([{ ...serverNotification }]);
    expect(screen.queryByText("Local error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark Server failure read" }));
    expect(server.onMarkNotificationRead).toHaveBeenCalledExactlyOnceWith("server");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Server failure" }));
    expect(server.onDismissNotification).toHaveBeenCalledExactlyOnceWith("server");
    fireEvent.click(screen.getByRole("button", { name: "Open Server failure" }));
    await waitFor(() =>
      expect(server.onNavigateNotification).toHaveBeenCalledWith(serverNotification),
    );
  });

  it("routes mixed bulk actions to both stores", () => {
    const { server } = setup([serverNotification]);
    openNotifications(2);
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(server.onMarkAllNotificationsRead).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Read")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(server.onDismissAllNotifications).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Local error")).toBeNull();
  });

  it("clears local history and requests durable dismissal for unread rows outside the loaded list", () => {
    const { server } = setup([], { unreadCount: 1 });
    openNotifications(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(server.onDismissAllNotifications).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Local error")).toBeNull();
  });

  it("can clear authoritative unread history even when neither list has loaded rows", () => {
    const { server } = setup([], { unreadCount: 1, localMessages: [] });
    openNotifications(1);
    const clear = screen.getByRole("button", { name: "Clear all" });
    expect(clear.hasAttribute("disabled")).toBe(false);
    fireEvent.click(clear);
    expect(server.onDismissAllNotifications).toHaveBeenCalledTimes(1);
  });

  it("renders same-millisecond local arrivals newest first across decimal sequence boundaries", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T19:00:00.000Z"));
    try {
      const messages = Array.from({ length: 11 }, (_, index) => `Local message ${index}`);
      setup([], { localMessages: messages });
      openNotifications(11);
      const rows = screen.getAllByRole("listitem");
      expect(rows).toHaveLength(11);
      for (const [index, message] of messages.toReversed().entries()) {
        expect(within(rows[index]!).getByText(message, { exact: true })).toBeTruthy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads and clears offline local-only notifications without server mutations", () => {
    const { server } = setup();
    openNotifications(1);
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(screen.getByRole("button", { name: /Notifications, 0 unread/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("No notifications yet.")).toBeTruthy();
    for (const callback of Object.values(server)) {
      expect(callback).not.toHaveBeenCalled();
    }
  });
});
