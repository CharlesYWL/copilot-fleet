import { act, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";
import { SettingsPanel, type SettingsTab } from "./SettingsPanel";

const responses: Record<string, unknown> = {
  "/api/defaults": {
    yolo: true,
    autoResume: false,
    notificationLifecycleEnabled: true,
    model: "",
    reasoningEffort: "",
  },
  "/api/auth/status": {
    state: "hybrid",
    authenticated: true,
    passwordEnabled: true,
    entraConfigured: true,
    deviceFlowEnabled: false,
    claimCodeRequired: false,
    canSignIn: true,
    codeLogin: { available: true, localForwardRequired: false },
    identity: { username: "alice@example.com", displayName: "Alice" },
    entra: { tenantId: "tenant-1", clientId: "client-1" },
  },
  "/api/auth/administrators": {
    currentAdministratorId: "alice",
    administrators: [],
    pending: [],
  },
  "/api/security/audit?limit=100": { events: [] },
  "/api/enrollment": {
    hostUrl: "http://localhost:8787",
    hostId: "host-1",
    hostFingerprint: "a".repeat(64),
    hostPublicKey: "cHVibGlj",
    nodeAuthentication: { total: 1, mutualAuth: 0, legacy: 1 },
    mutualAuthenticationRequired: false,
  },
  "/api/tunnel": {
    primary: null,
    publicUrl: "http://localhost:8787",
    providers: [
      {
        id: "devtunnel",
        label: "Dev Tunnels",
        binary: "devtunnel",
        binaryPresent: false,
        installHint: "Install devtunnel.",
        setupSteps: [],
        externalScheme: "https",
        access: "creator-private",
        controlPlaneEligible: true,
      },
    ],
    tunnels: [],
  },
  "/api/logs": { entries: [] },
};

const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <App />
    </FluentProvider>,
  );

const openSettings = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  });
};

const selectTab = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name }));
  });
};

const readCount = (path: string) =>
  vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === path).length;

beforeEach(() => {
  forgetCsrfToken();
  localStorage.clear();
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo) => {
      const path = String(input);
      if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
      return new Response(JSON.stringify(responses[path]), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("settings navigation", () => {
  it("puts heartbeat and agent settings in their own retained Orchestrator tab", async () => {
    show();
    await openSettings();
    expect(screen.queryByRole("textbox", { name: "Heartbeat schedule" })).toBeNull();
    await selectTab("Orchestrator");
    const schedule = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Heartbeat schedule",
    });
    expect(screen.getByRole("combobox", { name: "Preferred agent" })).toBeTruthy();
    fireEvent.change(schedule, { target: { value: "*/15 * * * *" } });
    await selectTab("General");
    await selectTab("Orchestrator");
    expect(screen.getByRole("textbox", { name: "Heartbeat schedule" })).toBe(schedule);
    expect(schedule.value).toBe("*/15 * * * *");
  });

  it("loads sections lazily and keeps their content without reloading or replaying warnings", async () => {
    show();
    const initialAuthReads = readCount("/api/auth/status");
    expect(readCount("/api/defaults")).toBe(0);
    expect(readCount("/api/enrollment")).toBe(0);
    await openSettings();
    const defaults = screen.getByRole("heading", { name: "Session defaults" });
    expect(readCount("/api/defaults")).toBe(1);
    expect(readCount("/api/auth/status")).toBe(initialAuthReads);
    expect(readCount("/api/tunnel")).toBe(0);

    await selectTab("Security");
    const security = screen.getByRole("heading", { name: "Security" });
    expect(defaults.isConnected).toBe(true);
    expect(screen.queryByRole("heading", { name: "Session defaults" })).toBeNull();

    await selectTab("General");
    expect(screen.getByRole("heading", { name: "Session defaults" })).toBe(defaults);
    await selectTab("Security");
    expect(screen.getByRole("heading", { name: "Security" })).toBe(security);
    expect(readCount("/api/defaults")).toBe(1);
    expect(readCount("/api/auth/status")).toBe(initialAuthReads + 1);
    expect(document.querySelectorAll(".fui-Toast")).toHaveLength(0);
  });

  it("preserves unfinished forms across section switches and leaving Settings", async () => {
    show();
    await openSettings();
    await selectTab("Workspaces");
    const name = screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unfinished workspace" } });

    await selectTab("Nodes");
    expect(name.isConnected).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    const hostUrl = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Host URL the node should dial",
    });
    fireEvent.change(hostUrl, { target: { value: "https://edited.example.com" } });

    await selectTab("Workspaces");
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(name);
    expect(name.value).toBe("Unfinished workspace");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Orchestrator" }));
    });
    expect(name.isConnected).toBe(true);
    expect(screen.queryByRole("tab", { name: "Workspaces" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();

    await openSettings();
    expect(screen.getByRole("tab", { name: "Workspaces", selected: true })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(name);
    expect(name.value).toBe("Unfinished workspace");
    await selectTab("Nodes");
    expect(screen.getByRole("textbox", { name: "Host URL the node should dial" })).toBe(
      hostUrl,
    );
    expect(hostUrl.value).toBe("https://edited.example.com");
    expect(document.querySelectorAll(".fui-Toast")).toHaveLength(0);
  });

  it.each([
    {
      tab: "security",
      button: "Disable password sign-in",
      dialog: "Disable password sign-in?",
    },
    {
      tab: "security",
      button: "Erase auth settings",
      dialog: "Erase all Host authentication?",
    },
    {
      tab: "tunnel",
      button: "How to set up Dev Tunnels",
      dialog: "Dev Tunnels",
    },
  ] satisfies { tab: SettingsTab; button: string; dialog: string }[])(
    "keeps the $dialog dialog out of inactive sections",
    async ({ tab, button, dialog }) => {
      const panel = (selectedTab: SettingsTab, active = true) => (
        <FluentProvider theme={fleetDarkTheme}>
          <SettingsPanel
            selectedTab={selectedTab}
            active={active}
            workspaces={[]}
            placements={[]}
            nodes={[]}
            sessions={[]}
            hostRevision=""
            nodeUpdates={{}}
          />
        </FluentProvider>
      );
      const view = render(panel(tab));
      fireEvent.click(await screen.findByRole("button", { name: button }));
      expect(await screen.findByRole("dialog", { name: dialog })).toBeTruthy();

      view.rerender(panel("general"));
      expect(screen.queryByRole("dialog", { name: dialog })).toBeNull();
      expect(
        await screen.findByRole("heading", { name: "Session defaults" }),
      ).toBeTruthy();
      view.rerender(panel(tab));
      expect(await screen.findByRole("dialog", { name: dialog })).toBeTruthy();

      view.rerender(panel(tab, false));
      expect(screen.queryByRole("dialog", { name: dialog })).toBeNull();
      view.rerender(panel(tab));
      expect(await screen.findByRole("dialog", { name: dialog })).toBeTruthy();
    },
  );

  it.each([
    { tab: "Tunnel", path: "/api/tunnel", interval: 2_000 },
    { tab: "Nodes", path: "/api/enrollment", interval: 3_000 },
    { tab: "Diagnostics", path: "/api/logs", interval: 5_000 },
  ])(
    "pauses $tab polling while hidden without discarding the loaded page",
    async ({ tab, path, interval }) => {
      vi.useFakeTimers();
      show();
      await openSettings();
      await selectTab(tab);
      const initialReads = readCount(path);
      expect(initialReads).toBe(1);
      await act(async () => vi.advanceTimersByTimeAsync(interval));
      expect(readCount(path)).toBe(initialReads + 1);

      await selectTab("General");
      const pausedReads = readCount(path);
      await act(async () => vi.advanceTimersByTimeAsync(interval * 3));
      expect(readCount(path)).toBe(pausedReads);

      await selectTab(tab);
      expect(readCount(path)).toBe(pausedReads);
      await act(async () => vi.advanceTimersByTimeAsync(interval));
      expect(readCount(path)).toBe(pausedReads + 1);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Orchestrator" }));
      });
      const hiddenReads = readCount(path);
      await act(async () => vi.advanceTimersByTimeAsync(interval * 3));
      expect(readCount(path)).toBe(hiddenReads);
      await openSettings();
      expect(readCount(path)).toBe(hiddenReads);
      await act(async () => vi.advanceTimersByTimeAsync(interval));
      expect(readCount(path)).toBe(hiddenReads + 1);
    },
  );
});
