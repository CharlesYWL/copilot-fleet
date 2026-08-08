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

  it("answers 404 for anything else", async () => {
    const { route } = router();
    expect((await route("GET", "/api/nope", "")).status).toBe(404);
    expect((await route("DELETE", "/api/config", "")).status).toBe(404);
  });
});
