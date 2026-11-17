import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webDarkTheme } from "@fluentui/react-components";
import {
  NodeSchema,
  SESSION_CONSOLE_RESYNC_CAPABILITY,
  type FleetNode,
} from "@fleet/protocol";
import { NodesPanel } from "./NodesPanel";

const resyncNodeConsole = vi.fn(async () => true);
vi.mock("../hooks/useCatalog", () => ({
  useCatalog: () => ({
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    updateNode: vi.fn(),
    updateAllNodes: vi.fn(),
    resyncNodeConsole,
  }),
}));
vi.mock("./ConnectNodeCard", () => ({ ConnectNodeCard: () => null }));

const sampledAt = "2026-10-15T12:00:00.000Z";
const node = NodeSchema.parse({
  id: "n1",
  name: "alpha",
  os: "win32",
  arch: "x64",
  version: "0.3.0",
  capabilities: [SESSION_CONSOLE_RESYNC_CAPABILITY],
  maxSessions: 2,
  activeSessions: 0,
  lastHeartbeat: sampledAt,
  online: true,
  homeDir: "C:\\Users\\alpha",
});

const show = (value: FleetNode = node) =>
  render(
    <FluentProvider theme={webDarkTheme}>
      <NodesPanel nodes={[value]} hostRevision="" nodeUpdates={{}} />
    </FluentProvider>,
  );

const buttonName = "Reconcile session history on alpha";

afterEach(() => {
  vi.clearAllMocks();
});

describe("Nodes panel connection route", () => {
  it.each([
    ["corp-direct", "Corp direct (private IP)"],
    ["devtunnel", "Dev Tunnels"],
    ["cloudflare", "Cloudflare"],
    ["ngrok", "ngrok"],
    ["direct", "Direct / local"],
  ] as const)("shows %s in its own connection column", (provider, label) => {
    show({ ...node, connection: { provider } });
    expect(screen.getByRole("columnheader", { name: "Connection" })).toBeTruthy();
    expect(screen.getByLabelText("Connection for alpha").textContent).toContain(label);
  });

  it("identifies unavailable metadata without guessing", () => {
    show();
    expect(screen.getByLabelText("Connection for alpha").textContent).toContain(
      "Unknown",
    );
  });

  it("distinguishes an offline last-known connection", () => {
    show({ ...node, online: false, connection: { provider: "devtunnel" } });
    expect(screen.getByLabelText("Connection for alpha").textContent).toContain(
      "Dev Tunnels",
    );
    expect(screen.getByLabelText("Connection for alpha").textContent).toContain(
      "Last known",
    );
  });
});

describe("Nodes panel session-history reconcile action", () => {
  it("asks the Host to resynchronize that Node when clicked", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    expect(resyncNodeConsole).toHaveBeenCalledExactlyOnceWith("n1");
  });

  it("is absent for a Node that cannot resynchronize on request", () => {
    show({ ...node, capabilities: [] });
    expect(screen.queryByRole("button", { name: buttonName })).toBeNull();
  });

  it("is absent while the Node is offline, since the Host could not reach it", () => {
    show({ ...node, online: false });
    expect(screen.queryByRole("button", { name: buttonName })).toBeNull();
  });
});

describe("Nodes panel session-history synchronization", () => {
  const now = Date.parse("2026-10-15T12:05:00.000Z");
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows how far a reconnecting Node has got and why earlier attempts ended", () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    show({
      ...node,
      consoleSync: {
        phase: "replaying",
        since: new Date(now - 130_000).toISOString(),
        attempts: 7,
        updatedAt: new Date(now - 2_000).toISOString(),
        sentEvents: 300,
        totalEvents: 700,
        error: "The connection dropped before synchronization finished",
      },
    });
    const summary = screen.getByText(
      "Syncing history: 300 of 700 events · 2m 10s · attempt 7",
    );
    expect(summary.closest("[title]")?.getAttribute("title")).toContain(
      "previous attempt: The connection dropped before synchronization finished",
    );
    expect(
      screen
        .getByRole("progressbar", { name: "Session history synchronization" })
        .getAttribute("aria-valuenow"),
    ).toBe(String(300 / 700));
  });

  it("calls out a stalled wait and a refused sync", () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const since = new Date(now - 90_000).toISOString();
    const { unmount } = show({
      ...node,
      consoleSync: {
        phase: "waiting",
        since,
        attempts: 1,
        updatedAt: since,
        sentEvents: 0,
      },
    });
    expect(
      screen.getByText(
        "Syncing history: waiting for the Node · 1m 30s · no progress for 1m 30s",
      ),
    ).toBeTruthy();
    unmount();
    show({
      ...node,
      consoleSync: {
        phase: "failed",
        since,
        attempts: 1,
        updatedAt: since,
        sentEvents: 0,
        error: "History synchronization is incomplete",
      },
    });
    expect(
      screen.getByText("History sync failed: History synchronization is incomplete"),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: buttonName })).toBeTruthy();
  });
});
