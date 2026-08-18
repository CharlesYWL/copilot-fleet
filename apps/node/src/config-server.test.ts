import { describe, expect, it, vi } from "vitest";
import {
  createConfigRouter,
  type ConfigServerOptions,
  type FleetApi,
} from "./config-server.js";
import { settingsFromEnv } from "./settings.js";

const workspace = { id: "ws-1", name: "fleet", description: "" };
const placement = {
  id: "pl-1",
  workspaceId: "ws-1",
  nodeId: "node-1",
  localPath: "/tmp/fleet",
};

function router(overrides: Partial<ConfigServerOptions> = {}) {
  const fleet: FleetApi = {
    listWorkspaces: vi.fn(async () => [workspace]),
    listOwnPlacements: vi.fn(async () => [placement]),
    createWorkspace: vi.fn(async () => workspace),
    updateWorkspace: vi.fn(async () => workspace),
    createOwnPlacement: vi.fn(async () => placement),
    updateOwnPlacementPath: vi.fn(async () => placement),
  };
  const options: ConfigServerOptions = {
    getSettings: () => settingsFromEnv({}),
    getStatus: () => ({
      nodeId: "node-1",
      version: "0.1.0",
      connected: true,
      activeSessions: 0,
      mockAgent: false,
    }),
    applySettings: vi.fn(async () => {}),
    getCredentials: () => ({
      hostUrl: "http://127.0.0.1:8787",
      nodeId: "node-1",
      secret: "secret",
      name: "node",
    }),
    applyBackup: vi.fn(async () => {}),
    log: () => {},
    fleet,
    inspectPath: (path) =>
      path.trim() === "/tmp/fleet"
        ? { ok: true, kind: "directory" }
        : { ok: false, reason: "No such folder" },
    ...overrides,
  };
  return { route: createConfigRouter(options), fleet, options };
}

describe("config router", () => {
  it("serves settings and status together", async () => {
    const { route } = router();
    const response = await route("GET", "/api/config", "");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: { nodeId: "node-1" } });
  });

  it("rejects settings the schema refuses without calling applySettings", async () => {
    const applySettings = vi.fn(async () => {});
    const { route } = router({ applySettings });
    const response = await route(
      "POST",
      "/api/config",
      JSON.stringify({ hostUrl: "nope" }),
    );
    expect(response.status).toBe(400);
    expect(applySettings).not.toHaveBeenCalled();
  });

  it("applies valid settings", async () => {
    const applySettings = vi.fn(async () => {});
    const { route } = router({ applySettings });
    const response = await route(
      "POST",
      "/api/config",
      JSON.stringify(settingsFromEnv({ FLEET_HOST_URL: "https://new.example" })),
    );
    expect(response.status).toBe(200);
    expect(applySettings).toHaveBeenCalledOnce();
  });

  it("keeps the fallback Host addresses a save never mentions", async () => {
    // The page posts back only the fields it shows. Parsing that as the whole
    // settings object would drop the addresses the Host announced, which are
    // the only way back if the current one stops resolving.
    const applySettings = vi.fn(async () => {});
    const { route } = router({
      applySettings,
      getSettings: () => ({
        ...settingsFromEnv({}),
        knownHostUrls: ["https://previous.trycloudflare.com"],
      }),
    });
    const form = settingsFromEnv({ FLEET_HOST_URL: "https://typed-by-hand.example" });
    const response = await route("POST", "/api/config", JSON.stringify(form));

    expect(response.status).toBe(200);
    expect(applySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        hostUrl: "https://typed-by-hand.example",
        knownHostUrls: ["https://previous.trycloudflare.com"],
      }),
    );
  });

  it("reports a Host that cannot be reached as 502, not 500", async () => {
    const { route, fleet } = router();
    vi.mocked(fleet.listWorkspaces).mockRejectedValueOnce(new Error("fetch failed"));
    const response = await route("GET", "/api/fleet", "");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "fetch failed" });
  });

  it("refuses a placement path this machine cannot open", async () => {
    const { route, fleet } = router();
    const response = await route(
      "POST",
      "/api/placements",
      JSON.stringify({ workspaceId: "ws-1", localPath: "/nope" }),
    );
    expect(response.status).toBe(400);
    expect(fleet.createOwnPlacement).not.toHaveBeenCalled();
  });

  it("creates a placement once the path checks out", async () => {
    const { route, fleet } = router();
    const response = await route(
      "POST",
      "/api/placements",
      JSON.stringify({ workspaceId: "ws-1", localPath: " /tmp/fleet " }),
    );
    expect(response.status).toBe(200);
    expect(fleet.createOwnPlacement).toHaveBeenCalledWith("ws-1", "/tmp/fleet");
  });

  it("routes a workspace id to update instead of create", async () => {
    const { route, fleet } = router();
    await route(
      "POST",
      "/api/workspaces",
      JSON.stringify({ id: "ws-1", name: "renamed" }),
    );
    expect(fleet.updateWorkspace).toHaveBeenCalledWith("ws-1", "renamed", "");
    expect(fleet.createWorkspace).not.toHaveBeenCalled();
  });

  it("turns a thrown handler into a logged 500", async () => {
    const log = vi.fn();
    const { route } = router({ log });
    const response = await route("POST", "/api/config", "not json");
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalled();
  });

  it("exports the stored identity", async () => {
    const { route } = router();
    const response = await route("GET", "/api/backup", "");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      kind: "copilot-fleet-node",
      version: 1,
      credentials: { nodeId: "node-1", secret: "secret" },
    });
  });

  it("refuses to export before the node has credentials", async () => {
    const { route } = router({ getCredentials: () => undefined });
    const response = await route("GET", "/api/backup", "");
    expect(response.status).toBe(409);
  });

  it("imports a node archive", async () => {
    const applyBackup = vi.fn(async () => {});
    const { route } = router({ applyBackup });
    const archive = {
      kind: "copilot-fleet-node",
      version: 1,
      exportedAt: "2026-08-14T12:00:00.000Z",
      credentials: {
        hostUrl: "https://fleet.example.com",
        nodeId: "moved",
        secret: "other-secret",
        name: "moved-box",
      },
      settings: {
        hostUrl: "https://fleet.example.com",
        nodeName: "moved-box",
        maxSessions: 8,
        copilotCommand: "",
        permissionTimeoutMs: 30_000,
      },
    };
    const response = await route("POST", "/api/backup", JSON.stringify(archive));
    expect(response.status).toBe(200);
    expect(applyBackup).toHaveBeenCalledOnce();
    expect(applyBackup.mock.calls[0]?.[0].credentials.nodeId).toBe("moved");
  });

  it("refuses a Host archive on the node import endpoint", async () => {
    const applyBackup = vi.fn(async () => {});
    const { route } = router({ applyBackup });
    const response = await route(
      "POST",
      "/api/backup",
      JSON.stringify({
        kind: "copilot-fleet-host",
        version: 1,
        exportedAt: "2026-08-14T12:00:00.000Z",
        enrollmentToken: "x",
        tunnel: { enabled: false, provider: "cloudflare" },
        defaults: { yolo: true, autoResume: true },
        nodes: [],
        workspaces: [],
        placements: [],
        sessions: [],
        events: [],
      }),
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("Settings → General"),
    });
    expect(applyBackup).not.toHaveBeenCalled();
  });

  it("answers 404 for anything else", async () => {
    const { route } = router();
    expect((await route("GET", "/api/nope", "")).status).toBe(404);
    expect((await route("DELETE", "/api/config", "")).status).toBe(404);
  });
});

describe("config router · dev tunnel rebuild", () => {
  it("rebuilds the tunnel when this node has one", async () => {
    const rebuildDevTunnel = vi.fn();
    const { route } = router({ rebuildDevTunnel });
    const response = await route("POST", "/api/devtunnel/rebuild", "");
    expect(response.status).toBe(200);
    expect(rebuildDevTunnel).toHaveBeenCalledTimes(1);
  });

  it("refuses on a node that dials the Host directly", async () => {
    // A node with no tunnel has nothing to rebuild, and a button that silently
    // does nothing is indistinguishable from one that is broken.
    const { route } = router();
    const response = await route("POST", "/api/devtunnel/rebuild", "");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: expect.stringContaining("directly") });
  });

  it("reports that the rebuild started rather than that it succeeded", async () => {
    // The CLI still has to come back with a port, and the node still has to
    // dial through it; claiming success here would be a guess.
    const { route } = router({ rebuildDevTunnel: vi.fn() });
    expect((await route("POST", "/api/devtunnel/rebuild", "")).body).toEqual({
      started: true,
    });
  });
});

describe("config router · logs", () => {
  it("serves what the node has been saying", async () => {
    const entries = [
      {
        at: "2026-08-18T21:04:22.000Z",
        level: "error" as const,
        message: "ECONNREFUSED",
      },
    ];
    const { route } = router({ recentLogs: () => entries });
    const response = await route("GET", "/api/logs", "");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ entries });
  });

  it("answers with an empty list rather than failing when nothing records logs", async () => {
    const { route } = router();
    expect(await route("GET", "/api/logs", "")).toEqual({
      status: 200,
      body: { entries: [] },
    });
  });
});
