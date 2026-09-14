import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { FluentProvider, webDarkTheme } from "@fluentui/react-components";
import { NodeSchema, type FleetNode } from "@fleet/protocol";
import { NodeHealth, HEALTH_STALE_AFTER_MS } from "./NodeHealth";
import { NodesPanel } from "./NodesPanel";
import { SettingsActivityContext } from "../hooks/useSettingsActivity";

vi.mock("../hooks/useCatalog", () => ({
  useCatalog: () => ({
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    updateNode: vi.fn(),
    updateAllNodes: vi.fn(),
  }),
}));
vi.mock("./ConnectNodeCard", () => ({ ConnectNodeCard: () => null }));

const sampledAt = "2026-09-14T12:00:00.000Z";
const now = Date.parse(sampledAt);
const node = NodeSchema.parse({
  id: "n1",
  name: "alpha",
  os: "win32",
  arch: "x64",
  version: "0.3.0",
  capabilities: [],
  maxSessions: 2,
  activeSessions: 1,
  lastHeartbeat: sampledAt,
  online: true,
  homeDir: "C:\\Users\\alpha",
  health: {
    cpu: { sampledAt, usagePercent: 25 },
    memory: { sampledAt, totalBytes: 16 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 },
    disk: {
      sampledAt,
      totalBytes: 100 * 1024 ** 3,
      availableBytes: 40 * 1024 ** 3,
      scope: "home",
    },
  },
});

function show(value: FleetNode = node, clock = now) {
  return render(
    <FluentProvider theme={webDarkTheme}>
      <NodeHealth node={value} now={clock} />
    </FluentProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Node resource readouts", () => {
  it("shows compact colored meters with capacity details available on keyboard focus", async () => {
    show();
    expect(screen.getByRole("group", { name: "alpha machine health" })).toBeTruthy();
    expect(
      screen
        .getByRole("meter", { name: "CPU usage · Current" })
        .getAttribute("aria-valuenow"),
    ).toBe("25");
    expect(
      screen
        .getByRole("meter", { name: "RAM usage · Current" })
        .getAttribute("aria-valuenow"),
    ).toBe("75");
    expect(
      screen
        .getByRole("meter", { name: "Disk usage · Current" })
        .getAttribute("aria-valuenow"),
    ).toBe("60");
    expect(screen.queryByText("4 GiB free / 16 GiB total")).toBeNull();
    expect(
      screen
        .getByRole("meter", { name: "Disk usage · Current" })
        .getAttribute("aria-valuetext"),
    ).toContain("Home-directory volume · 40 GiB free / 100 GiB total");
    expect(screen.getByText("25%")).toBeTruthy();
    expect(
      screen
        .getByRole("meter", { name: "CPU usage · Current" })
        .getAttribute("aria-valuetext"),
    ).toContain(sampledAt);
    const colors = screen
      .getAllByRole("meter")
      .map((meter) => (meter.firstElementChild as HTMLElement).style.backgroundColor);
    expect(colors.every(Boolean)).toBe(true);
    expect(new Set(colors).size).toBe(3);
    fireEvent.focus(screen.getByRole("group", { name: "RAM: 75% · Current" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "4 GiB free / 16 GiB total",
    );
  });

  it("keeps missing metrics unavailable instead of showing zero or an indeterminate spinner", () => {
    show({ ...node, health: { memory: node.health!.memory } });
    expect(screen.getAllByLabelText("Unavailable")).toHaveLength(2);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getAllByRole("meter")).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("accepts an old Node without any telemetry", () => {
    const { health: _health, ...old } = node;
    show(old);
    expect(screen.getAllByLabelText("Unavailable")).toHaveLength(3);
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("marks each sample stale by its own time, even when the heartbeat just arrived", () => {
    const clock = now + HEALTH_STALE_AFTER_MS + 1;
    show(
      {
        ...node,
        lastHeartbeat: new Date(clock).toISOString(),
        health: {
          ...node.health,
          memory: { ...node.health!.memory!, sampledAt: new Date(clock).toISOString() },
        },
      },
      clock,
    );
    expect(screen.getByRole("meter", { name: "CPU usage · Stale" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "RAM usage · Current" })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Stale" })).toHaveLength(2);
    expect(screen.queryByText(/^Stale · sampled/)).toBeNull();
  });

  it("labels retained readings offline immediately rather than pretending they are live", () => {
    show({ ...node, online: false });
    expect(screen.getAllByRole("meter", { name: /Offline/ })).toHaveLength(3);
    for (const meter of screen.getAllByRole("meter")) {
      expect(meter.getAttribute("aria-valuetext")).toContain("Offline · sampled");
    }
  });

  it("does not label future-dated Node clocks as fresh forever", () => {
    show(node, now - 120_000);
    expect(screen.getAllByRole("meter", { name: /Clock skew/ })).toHaveLength(3);
    expect(screen.getAllByRole("img", { name: "Clock skew" })).toHaveLength(3);
    const fill = screen.getByRole("meter", {
      name: "CPU usage · Clock skew",
    }).firstElementChild as HTMLElement;
    expect(fill.style.backgroundColor).toBe("rgb(108, 140, 255)");
    expect(getComputedStyle(fill).opacity).toBe("0.65");
  });

  it("ages silent Nodes using one panel clock and stops it on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const intervals = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const result = render(
      <FluentProvider theme={webDarkTheme}>
        <NodesPanel
          nodes={[node, { ...node, id: "n2", name: "beta" }]}
          hostRevision=""
          nodeUpdates={{}}
        />
      </FluentProvider>,
    );
    expect(screen.getByRole("table", { name: "Registered nodes" })).toBeTruthy();
    expect(screen.getByRole("region", { name: /scroll horizontally/ }).tabIndex).toBe(0);
    expect(screen.getAllByText("1 / 2")).toHaveLength(2);
    expect(screen.getAllByText("0.3.0")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "Health" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Last seen" })).toBeNull();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1]!).getByRole("group", { name: "alpha machine health" }),
    ).toBeTruthy();
    const clocks = intervals.mock.calls
      .map((args, index) => ({
        delay: args[1],
        handle: intervals.mock.results[index]?.value,
      }))
      .filter((call) => call.delay === 10_000);
    expect(clocks).toHaveLength(1);
    act(() => vi.advanceTimersByTime(100_000));
    expect(screen.getAllByRole("meter", { name: /Stale/ })).toHaveLength(6);
    result.unmount();
    expect(clear).toHaveBeenCalledWith(clocks[0]!.handle);
  });

  it("refreshes the clock immediately when returning to the Nodes panel", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const panel = (active: boolean, value: FleetNode) => (
      <FluentProvider theme={webDarkTheme}>
        <SettingsActivityContext.Provider value={active}>
          <NodesPanel nodes={[value]} hostRevision="" nodeUpdates={{}} />
        </SettingsActivityContext.Provider>
      </FluentProvider>
    );
    const result = render(panel(false, node));
    vi.setSystemTime(now + 300_000);
    const fresh = new Date().toISOString();
    result.rerender(
      panel(true, {
        ...node,
        health: {
          cpu: { ...node.health!.cpu!, sampledAt: fresh },
          memory: { ...node.health!.memory!, sampledAt: fresh },
          disk: { ...node.health!.disk!, sampledAt: fresh },
        },
      }),
    );
    expect(screen.getAllByRole("meter", { name: /Current/ })).toHaveLength(3);
    expect(screen.queryByRole("img", { name: "Clock skew" })).toBeNull();
  });
});
