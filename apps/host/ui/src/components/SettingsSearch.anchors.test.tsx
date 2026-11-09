import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  tunnelProviders,
  type FleetNode,
  type HostUpdateStatus,
  type Placement,
  type Workspace,
} from "@fleet/protocol";
import { forgetCsrfToken } from "../lib/auth";
import {
  buildSettingsIndex,
  settingAnchorSelector,
  settingsSections,
  staticSettingEntries,
  type SettingsTab,
} from "../lib/settings-search";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";
import { CatalogProvider } from "../hooks/useCatalog";
import { SettingsPanel } from "./SettingsPanel";

/**
 * Every Settings page, drawn with everything this Host could offer switched on,
 * so each search result can be checked against the page it names.
 *
 * Settings that only some Hosts show — Agency mode for Microsoft staff, the
 * Microsoft sign-in setup that replaces most of Security when sign-in is off,
 * the pending-approval table — are listed with the state that draws them.
 */
const signedIn = {
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
};
const noAuth = {
  state: "no-auth",
  authenticated: false,
  passwordEnabled: false,
  entraConfigured: false,
  deviceFlowEnabled: false,
  claimCodeRequired: false,
  canSignIn: true,
  codeLogin: { available: true, localForwardRequired: false },
};

const provider = (id: string, label: string) => ({
  id,
  label,
  binary: id,
  binaryPresent: true,
  installHint: "",
  setupSteps: [],
  externalScheme: "https",
  access: "public",
  controlPlaneEligible: true,
});

const responses = (authStatus: unknown): Record<string, unknown> => ({
  "/api/defaults": {
    yolo: false,
    autoResume: true,
    notificationLifecycleEnabled: true,
    model: "",
    reasoningEffort: "",
    agencyModeAvailable: true,
    managedWorktreesRevision: 1,
    managedWorktreePolicy: {
      retentionDays: 7,
      maxPerRepository: 8,
      maxPerNode: 32,
      freeSpaceFloorBytes: 1,
      byteBudget: 1,
      cleanupIgnoredOnly: false,
    },
    orchestratorHeartbeatSchedule: "0 9-18 * * 1-5",
  },
  "/api/worker-model-routing": {
    revision: 0,
    mode: "off",
    minProbability: 0.5,
    timeoutMs: 5000,
    providers: [],
    profiles: [],
    suspended: false,
    proposals: [],
  },
  "/api/auth/status": authStatus,
  "/api/auth/administrators": {
    currentAdministratorId: "alice",
    administrators: [],
    pending: [
      {
        id: "candidate",
        tenantId: "tenant-1",
        objectId: "bob-oid",
        username: "bob@example.com",
        displayName: "Bob",
        consumedAt: "2026-08-01T10:00:00.000Z",
      },
    ],
  },
  "/api/security/audit": { events: [] },
  "/api/enrollment": {
    hostUrl: "http://localhost:8787",
    hostId: "host-1",
    hostFingerprint: "a".repeat(64),
    hostPublicKey: "cHVibGlj",
    nodeAuthentication: { total: 1, mutualAuth: 1, legacy: 0 },
    mutualAuthenticationRequired: false,
  },
  "/api/local-agent/config": {
    config: {
      enabled: false,
      port: 8786,
      allowedLeadSessionIds: [],
      allowedWorkspaceIds: [],
      revision: 0,
    },
    status: { state: "disabled" },
    hostPort: 8787,
    defaultPort: 8786,
    choices: { orchestrators: [], workspaces: [] },
  },
  "/api/local-agent/requests": { requests: [] },
  "/api/host-mcp/settings": { revision: "a".repeat(64), suspended: false, servers: [] },
  "/api/tunnel": {
    primary: "devtunnel",
    publicUrl: "http://localhost:8787",
    providers: [
      provider("cloudflare", "Cloudflare"),
      provider("tailscale", "Tailscale Funnel"),
      provider("ngrok", "ngrok"),
      provider("bore", "bore"),
      provider("devtunnel", "Dev Tunnels"),
      provider("corp-direct", "Corp direct (private IP)"),
    ],
    tunnels: [],
    policy: { kind: "microsoft-corp", allowedProviders: ["devtunnel", "corp-direct"] },
    corpDirect: { supported: true, addresses: ["10.0.0.5"], configuration: null },
  },
  "/api/logs": { entries: [] },
  "/api/auth/csrf": { csrfToken: "proof" },
});

let reads: Record<string, unknown>;

const node = (id: string, name: string): FleetNode =>
  ({
    id,
    name,
    os: "win32",
    arch: "x64",
    version: "1",
    revision: "old",
    capabilities: ["self-update"],
    agents: [],
    maxSessions: 4,
    activeSessions: 0,
    lastHeartbeat: "2026-08-08T00:00:00.000Z",
    online: true,
    homeDir: "C:\\Users\\me",
    authProtocol: "mutual-auth-v1",
  }) as FleetNode;

const nodes = [node("n1", "WEILI-PC")];
const workspaces: Workspace[] = [
  {
    id: "w1",
    name: "checkout",
    description: "",
    createdAt: "2026-08-08T00:00:00.000Z",
    kind: "project",
  },
];
const placements: Placement[] = [
  { id: "p1", workspaceId: "w1", nodeId: "n1", localPath: "C:\\code\\checkout" },
];
const hostUpdate: HostUpdateStatus = {
  launch: "dev",
  restartCommand: "npm run dev",
  unavailableReason: "",
};

const catalog = {
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  createPlacement: vi.fn(),
  updatePlacement: vi.fn(),
  deletePlacement: vi.fn(),
  reorderPlacements: vi.fn(),
  reorderWorkspaces: vi.fn(),
  reorderSessions: vi.fn(),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
  updateNode: vi.fn(),
  updateAllNodes: vi.fn(),
  resyncNodeConsole: vi.fn(),
};

/** Holds the selected tab the way the App does, so a search result can move it. */
const ControlledSettings = ({ initial }: { initial: SettingsTab }) => {
  const [tab, setTab] = useState(initial);
  return (
    <SettingsPanel
      selectedTab={tab}
      onSelectedTabChange={setTab}
      workspaces={workspaces}
      placements={placements}
      nodes={nodes}
      sessions={[]}
      hostRevision="new"
      hostUpdate={hostUpdate}
      nodeUpdates={{}}
      onStartTour={vi.fn()}
    />
  );
};

const show = (tab: SettingsTab, notify = vi.fn()) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <CatalogProvider value={catalog}>
          <ControlledSettings initial={tab} />
        </CatalogProvider>
      </NotificationContext.Provider>
    </FluentProvider>,
  );

/** The page's own anchor appears with its heading, once its data is in. */
const settle = async (tab: SettingsTab) => {
  await screen.findByRole("tabpanel");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const page = document.querySelector(`[data-settings-page="${tab}"]`);
  await vi.waitFor(() =>
    expect(page?.querySelector(settingAnchorSelector(tab))).toBeTruthy(),
  );
};

const missingAnchors = (tab: SettingsTab, except: readonly string[] = []) => {
  const page = document.querySelector(`[data-settings-page="${tab}"]`)!;
  const index = buildSettingsIndex({ nodes, workspaces });
  return index
    .filter((entry) => entry.tab === tab && !except.includes(entry.id))
    .filter((entry) => !page.querySelector(settingAnchorSelector(entry.id)))
    .map((entry) => entry.id);
};

/** Tunnel providers a Microsoft corporate Host hides; see `visibleTunnelProviders`. */
const hiddenByCorpPolicy = ["cloudflare", "tailscale", "ngrok", "bore"].map(
  (provider) => `tunnel.provider.${provider}`,
);

beforeEach(() => {
  forgetCsrfToken();
  reads = responses(signedIn);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      const path = Object.keys(reads)
        .sort((a, b) => b.length - a.length)
        .find((key) => url.startsWith(key));
      return new Response(JSON.stringify(path ? reads[path] : {}), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

describe("Settings search anchors", () => {
  it.each(settingsSections.map((section) => section.value))(
    "draws every %s search anchor with sections initially collapsed",
    async (tab) => {
      show(tab);
      await settle(tab);
      // Shown instead of most of Security, only while sign-in is off; and the
      // public providers a corp Host hides, which the next case draws.
      expect(
        missingAnchors(tab, ["security.sign-in-setup", ...hiddenByCorpPolicy]),
      ).toEqual([]);
      const page = document.querySelector(`[data-settings-page="${tab}"]`)!;
      const folds = page.querySelectorAll<HTMLDetailsElement>("section > details");
      expect(folds.length).toBeGreaterThan(0);
      for (const fold of folds) {
        expect(fold.open, `${tab} sections should start collapsed`).toBe(false);
      }
      for (const anchor of page.querySelectorAll("[data-setting-id]")) {
        const id = anchor.getAttribute("data-setting-id");
        if (id === tab || id === "nodes.update-all") continue;
        expect(anchor.closest("details"), `${id} should be collapsible`).toBeTruthy();
      }
    },
  );

  it("draws the providers a corporate Host hides once the policy is open", async () => {
    reads["/api/tunnel"] = {
      ...(reads["/api/tunnel"] as object),
      policy: { kind: "open", allowedProviders: [] },
    };
    show("tunnel");
    await settle("tunnel");
    expect(missingAnchors("tunnel", ["tunnel.provider.corp-direct"])).toEqual([]);
  });

  it("offers Microsoft sign-in setup while sign-in is off", async () => {
    reads = responses(noAuth);
    show("security");
    await settle("security");
    expect(
      document.querySelector(settingAnchorSelector("security.sign-in-setup")),
    ).toBeTruthy();
  });

  it("marks as conditional only what some Host or state can leave out", () => {
    const conditional = staticSettingEntries
      .filter((entry) => entry.conditional)
      .map((entry) => entry.id);
    expect(conditional).toEqual([
      "general.managed-worktrees.quotas",
      "general.tour",
      "general.agency",
      "general.host-update",
      "security.sign-in-setup",
      "security.microsoft-config",
      "security.password",
      "security.device",
      "security.pending",
      "security.administrators",
      "security.portable-backup",
      "security.audit",
      "security.erase",
      ...tunnelProviders.map((provider) => `tunnel.provider.${provider}`),
      "nodes.update-all",
    ]);
  });

  it("checks every static entry on the page it names", () => {
    // The per-page checks above cover the whole index; this keeps an entry
    // filed under a page that no check renders from slipping through.
    const checked = new Set(settingsSections.map((section) => section.value));
    expect(staticSettingEntries.filter((entry) => !checked.has(entry.tab))).toEqual([]);
  });
});

describe("Settings search navigation", () => {
  it("reopens a collapsed section when a search result lands inside it", async () => {
    show("general");
    await settle("general");
    const target = document.querySelector<HTMLDetailsElement>(
      settingAnchorSelector("general.managed-worktrees"),
    );
    expect(target?.tagName).toBe("DETAILS");
    expect(target!.open).toBe(false);

    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), {
      target: { value: "quotas" },
    });
    expect(target!.open).toBe(false);
    fireEvent.click(
      await screen.findByRole("option", {
        name: "Managed retention and quotas, General",
      }),
    );

    await vi.waitFor(() => {
      const quotas = document.querySelector<HTMLDetailsElement>(
        settingAnchorSelector("general.managed-worktrees.quotas"),
      );
      expect(target!.open).toBe(true);
      expect(quotas?.open).toBe(true);
      expect(document.activeElement).toBe(quotas);
    });
    expect(
      document.querySelector<HTMLDetailsElement>(settingAnchorSelector("general.yolo"))
        ?.open,
    ).toBe(false);
  });

  it("opens the result's page and brings the setting into view", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    show("general");
    await settle("general");

    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), {
      target: { value: "heartbeat" },
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "Orchestrator heartbeat, Orchestrator" }),
    );

    const target = await vi.waitFor(() => {
      const element = document.querySelector<HTMLDetailsElement>(
        settingAnchorSelector("orchestrator.heartbeat"),
      );
      expect(element).toBeTruthy();
      expect(element!.open).toBe(true);
      expect(element!.closest("[hidden]")).toBeNull();
      expect(document.activeElement).toBe(element);
      return element!;
    });
    expect(target.hasAttribute("data-setting-highlighted")).toBe(true);
    expect(scrolled).toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Orchestrator" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("lands on a node's row in the inventory", async () => {
    show("general");
    await settle("general");

    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), {
      target: { value: "weili" },
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "WEILI-PC, node in Nodes" }),
    );

    await vi.waitFor(() => {
      const row = document.querySelector(settingAnchorSelector("node:n1"));
      expect(row?.tagName).toBe("TR");
      expect(document.activeElement).toBe(row);
      expect(
        document.querySelector<HTMLDetailsElement>(
          settingAnchorSelector("nodes.inventory"),
        )?.open,
      ).toBe(true);
    });
  });

  it("reports a setting this Host does not offer instead of leaving the operator hunting", async () => {
    const notify = vi.fn();
    reads = responses(noAuth);
    show("general", notify);
    await settle("general");

    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), {
      target: { value: "administrators" },
    });
    // Security has not been opened yet, so the result is still offered.
    fireEvent.click(
      await screen.findByRole("option", { name: "Administrators, Security" }),
    );

    await vi.waitFor(
      () =>
        expect(notify).toHaveBeenCalledWith(
          "“Administrators” is not available on this Host right now.",
          "info",
        ),
      { timeout: 8_000 },
    );

    // Once Security has drawn without it, the result is no longer offered.
    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), {
      target: { value: "administrators" },
    });
    expect(screen.queryByRole("option", { name: "Administrators, Security" })).toBeNull();
  });
});
