import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostMcpSelection } from "@fleet/protocol";
import type { FleetAuth } from "../auth/service.js";
import { fleet } from "../orchestrator/fleet-harness.js";
import { HostMcpConfigSchema, HostMcpRelay, readHostMcpConfig } from "../host-mcp.js";
import { hostMcpSourceDigest, type ConfiguredHostMcp } from "../host-mcp-client.js";
import {
  HostMcpSettingsService,
  hostMcpRevision,
  hostMcpSettingsRoutes,
  saveHostMcpConfig,
} from "./host-mcp-settings.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup() {
  const f = fleet();
  const directory = await mkdtemp(join(tmpdir(), "fleet-host-mcp-settings-"));
  cleanups.push(async () => {
    f.store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "host-mcp.json");
  const config = HostMcpConfigSchema.parse({
    servers: [
      {
        name: "figma",
        url: "https://mcp.figma.com/mcp",
        tools: ["whoami"],
        resources: ["skill://figma/figma-design-to-code/SKILL.md"],
        readOnly: true,
        nodeIds: [f.leadSubject.nodeId],
        sessionIds: [],
      },
    ],
  });
  await saveHostMcpConfig(path, config);
  const relay = new HostMcpRelay(f.service, config, () => "https://fleet.example");
  cleanups.push(() => relay.close());
  const source: Record<string, ConfiguredHostMcp> = {
    figma: { type: "http", url: "https://mcp.figma.com/mcp" },
    mail: {
      command: "configured-mail.exe",
      args: ["private-argument"],
      env: { SECRET: "not-for-browser" },
    },
    context7: {
      type: "http",
      url: "https://mcp.context7.com/mcp",
      headers: { API_KEY: "private-header" },
    },
  };
  const dependencies = {
    catalog: vi.fn(async () => source),
    inspect: vi.fn(async () => ({
      tools: [{ name: "read", inputSchema: { type: "object" as const } }],
      resources: [] as string[],
    })),
    save: vi.fn(saveHostMcpConfig),
  };
  const app = Fastify({ logger: false });
  cleanups.push(() => app.close());
  const settings = new HostMcpSettingsService(relay, path, app.log, dependencies);
  const selection = (name: string, enabled = true): HostMcpSelection => ({
    name,
    enabled,
    expectedRevision: hostMcpRevision(relay.config),
    ...(source[name] ? { sourceDigest: hostMcpSourceDigest(source[name]) } : {}),
  });
  return {
    ...f,
    app,
    config,
    directory,
    path,
    relay,
    source,
    dependencies,
    settings,
    selection,
  };
}

describe("Host MCP selection settings", () => {
  it("lists HTTP and stdio Host MCPs without connecting or exposing credentials/commands", async () => {
    const h = await setup();
    const view = await h.settings.view();
    expect(
      view.servers.map(({ name, enabled, transport }) => ({ name, enabled, transport })),
    ).toEqual([
      { name: "context7", enabled: false, transport: "http" },
      { name: "figma", enabled: true, transport: "http" },
      { name: "mail", enabled: false, transport: "stdio" },
    ]);
    expect(h.dependencies.inspect).not.toHaveBeenCalled();
    for (const secret of [
      "private-argument",
      "not-for-browser",
      "private-header",
      "configured-mail.exe",
    ])
      expect(JSON.stringify(view)).not.toContain(secret);
  });

  it("promotes the selected Figma grant to all current and future Nodes, preserving its read tools", async () => {
    const h = await setup();
    await h.settings.update(h.selection("figma"));
    const saved = await readHostMcpConfig(h.path);
    expect(saved.servers[0]).toMatchObject({
      name: "figma",
      allNodes: true,
      readOnly: true,
      nodeIds: [],
      sessionIds: [],
      tools: ["whoami"],
      resources: ["skill://figma/figma-design-to-code/SKILL.md"],
    });
    const future = h.addNode("future");
    const placement = h.store.listPlacements().find((p) => p.nodeId === future.id)!;
    const session = h.store.createSession(placement, "Use Figma");
    expect(h.relay.serversFor(session)[0]!.name).toBe("fleet-host-figma");
    expect(
      h.relay.authorize(
        "figma",
        h.relay.serversFor(session)[0]!.headers[0]!.value.slice(7),
      ),
    ).toBeDefined();
    expect(
      (await h.settings.view()).servers.find((s) => s.name === "mail")!.enabled,
    ).toBe(false);
    expect(await readdir(h.directory)).toEqual(["host-mcp.json"]);
  });

  it("snapshots a selected stdio MCP by name and digest without persisting executable details", async () => {
    const h = await setup();
    const view = await h.settings.update(h.selection("mail"));
    expect(view.servers.find((s) => s.name === "mail")).toMatchObject({
      enabled: true,
      allNodes: true,
      toolCount: 1,
      readOnly: false,
    });
    const config = await readHostMcpConfig(h.path);
    expect(config.servers.find((s) => s.name === "mail")).toMatchObject({
      source: "host",
      sourceDigest: hostMcpSourceDigest(h.source.mail!),
      tools: ["read"],
      allNodes: true,
    });
    expect(JSON.stringify(config)).not.toContain("private-argument");
    expect(JSON.stringify(config)).not.toContain("not-for-browser");
  });

  it("disables immediately and never resurrects an old grant after reenabling", async () => {
    const h = await setup();
    const session = h.store.getSession(h.leadId)!;
    const oldToken = h.relay.serversFor(session)[0]!.headers[0]!.value.slice(7);
    const client = {
      listTools: vi.fn(),
      readResource: vi.fn(),
      callTool: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const create = vi.spyOn(h.relay, "client").mockReturnValue(client);
    await h.settings.update(h.selection("figma", false));
    expect(h.relay.authorize("figma", oldToken)).toBeUndefined();
    expect(h.relay.config.servers[0]).toMatchObject({
      enabled: false,
      readOnly: true,
      tools: ["whoami"],
    });
    expect(h.dependencies.inspect).not.toHaveBeenCalled();
    await h.settings.update(h.selection("figma"));
    expect(h.relay.authorize("figma", oldToken)).toBeUndefined();
    expect(h.relay.config.servers[0]).toMatchObject({
      enabled: true,
      readOnly: true,
      tools: ["whoami"],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not save on authentication failure, and keeps errors credential-free", async () => {
    const h = await setup();
    h.dependencies.inspect.mockRejectedValueOnce(
      new Error("requires authentication secret-token-here"),
    );
    await expect(h.settings.update(h.selection("mail"))).rejects.toThrow(
      "Authenticate mail in Copilot on the Host",
    );
    expect(h.dependencies.save).not.toHaveBeenCalled();
    expect(
      (await h.settings.view()).servers.find((s) => s.name === "mail")!.enabled,
    ).toBe(false);
  });

  it("refuses stale UI revisions, changed Host definitions, and local file edits", async () => {
    const h = await setup();
    await expect(
      h.settings.update({ ...h.selection("mail"), expectedRevision: "0".repeat(64) }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      h.settings.update({ ...h.selection("mail"), sourceDigest: "0".repeat(64) }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await saveHostMcpConfig(h.path, { servers: [] });
    await expect(h.settings.update(h.selection("figma", false))).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(h.relay.config.servers).toHaveLength(1);
  });

  it("preserves current access when disk persistence fails", async () => {
    const h = await setup();
    h.dependencies.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.settings.update(h.selection("figma", false))).rejects.toThrow(
      "disk full",
    );
    expect(h.relay.config.servers).toHaveLength(1);
    expect((await readHostMcpConfig(h.path)).servers).toHaveLength(1);
  });

  it("can disable saved forwarding even when Copilot's catalog is unavailable", async () => {
    const h = await setup();
    h.dependencies.catalog.mockRejectedValue(new Error("runtime unavailable"));
    expect((await h.settings.view()).catalogError).toMatch(
      /Existing forwarding can still be turned off/,
    );
    const view = await h.settings.update(h.selection("figma", false));
    expect(view.servers).toMatchObject([{ name: "figma", enabled: false }]);
    expect(view.catalogError).toBeDefined();
  });

  it("does not lift restore suspension while disabling or enabling a radio", async () => {
    const h = await setup();
    await h.relay.close();
    await expect(h.settings.update(h.selection("mail"))).rejects.toMatchObject({
      statusCode: 409,
    });
    await h.settings.update(h.selection("figma", false));
    expect(h.relay.isSuspended).toBe(true);
  });

  it("rejects overlapping changes while the selected connection is checked", async () => {
    const h = await setup();
    let finish!: (value: {
      tools: { name: string; inputSchema: { type: "object" } }[];
      resources: string[];
    }) => void;
    h.dependencies.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const save = h.settings.update(h.selection("mail"));
    await vi.waitFor(() => expect(h.dependencies.inspect).toHaveBeenCalled());
    await expect(h.settings.update(h.selection("figma", false))).rejects.toMatchObject({
      statusCode: 409,
    });
    finish({ tools: [{ name: "read", inputSchema: { type: "object" } }], resources: [] });
    await save;
  });
});

describe("Host MCP settings admission", () => {
  it("requires an administrator and fresh authorization to share, not to disable", async () => {
    const h = await setup();
    h.app.addHook("onRequest", async (request) => {
      const freshness = request.headers["fixture-admin"];
      if (typeof freshness === "string")
        request.fleetSession = {
          tokenHash: freshness,
          administratorId: "admin-1",
          authMethod: "microsoft-code",
          authenticatedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
    });
    let noAuth = false;
    const auth = {
      administratorFor: () => ({ id: "admin-1" }),
      requireRecentReauth: (session: { tokenHash: string }) =>
        session.tokenHash === "fresh",
      noAuthEnabled: () => noAuth,
      noAuthEndpointAllowed: (host: string | undefined) => host?.startsWith("localhost"),
      audit: vi.fn(),
    } as unknown as FleetAuth;
    await h.app.register(hostMcpSettingsRoutes, { auth, settings: h.settings });
    const url = "/api/host-mcp/settings";
    expect((await h.app.inject({ url })).statusCode).toBe(403);
    expect(h.dependencies.catalog).not.toHaveBeenCalled();
    const stale = await h.app.inject({
      method: "PUT",
      url,
      headers: { "fixture-admin": "stale" },
      payload: h.selection("mail"),
    });
    expect([stale.statusCode, stale.json().reauthRequired]).toEqual([403, true]);
    expect(h.dependencies.inspect).not.toHaveBeenCalled();
    const enabled = await h.app.inject({
      method: "PUT",
      url,
      headers: { "fixture-admin": "fresh" },
      payload: h.selection("mail"),
    });
    expect(enabled.statusCode).toBe(200);
    expect(auth.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "host_mcp_forwarding_changed",
        targetId: "mail",
        actorKind: "administrator",
      }),
    );
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url,
          headers: { "fixture-admin": "stale" },
          payload: h.selection("mail", false),
        })
      ).statusCode,
    ).toBe(200);
    noAuth = true;
    expect(
      (await h.app.inject({ url, headers: { host: "outside.example" } })).statusCode,
    ).toBe(403);
    expect((await h.app.inject({ url })).statusCode).toBe(200);
  });
});
