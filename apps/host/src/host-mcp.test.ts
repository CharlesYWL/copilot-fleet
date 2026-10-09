import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fleet } from "./orchestrator/fleet-harness.js";
import { LeadTokens } from "./orchestrator/lead-tokens.js";
import {
  HostMcpConfigSchema,
  HostMcpRelay,
  hostMcpRoutes,
  type HostMcpConfig,
} from "./host-mcp.js";
import type { HostMcpClient } from "./host-mcp-client.js";
import { resolveMcpServers } from "../../node/src/mcp-endpoint.js";

const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function setup() {
  const h = fleet();
  resources.push(() => {
    h.store.close();
  });
  const worker = h.store.createSession(
    h.store.listPlacements()[0]!,
    "MCP probe",
    false,
    "",
    {
      runRole: "worker",
    },
  );
  const config: HostMcpConfig = {
    servers: [
      {
        name: "figma",
        url: "https://mcp.figma.com/mcp",
        tools: ["whoami", "get_screenshot"],
        readOnly: false,
        resources: [],
        nodeIds: [],
        sessionIds: [worker.id],
      },
    ],
  };
  const result: CallToolResult = {
    content: [
      { type: "text", text: "Authenticated on the Host" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ],
  };
  const client = {
    listTools: vi.fn(async () => [
      { name: "whoami", inputSchema: { type: "object" as const } },
      { name: "get_screenshot", inputSchema: { type: "object" as const } },
    ]),
    callTool: vi.fn<HostMcpClient["callTool"]>(async (_name, _args, authorized) => {
      if (!authorized()) throw new Error("revoked");
      return result;
    }),
    readResource: vi.fn<HostMcpClient["readResource"]>(async (uri, authorized) => {
      if (!authorized()) throw new Error("revoked");
      return { contents: [{ uri, mimeType: "text/markdown", text: "# Guidance" }] };
    }),
    close: vi.fn(async () => {}),
  };
  const createClient = vi.fn(() => client);
  const relay = new HostMcpRelay(
    h.service,
    config,
    () => "https://host.example",
    createClient,
  );
  resources.push(() => relay.close());
  h.service.attachHostMcp((session) => relay.serversFor(session));
  const token = relay.serversFor(worker)[0]!.headers[0]!.value.slice(7);
  return { ...h, worker, config, relay, client, createClient, token, result };
}

describe("Host MCP grants", () => {
  it("requires explicit scope, HTTPS and an exact tool allowlist", () => {
    const valid = setup().config;
    expect(HostMcpConfigSchema.safeParse(valid).success).toBe(true);
    const server = valid.servers[0]!;
    for (const override of [
      { nodeIds: [], sessionIds: [] },
      { name: "fleet" },
      { tools: ["*"] },
      { tools: [] },
      { url: "http://mcp.figma.com/mcp" },
      { url: "https://user:secret@mcp.figma.com/mcp" },
      { url: "https://mcp.figma.com/mcp?token=secret" },
    ]) {
      expect(
        HostMcpConfigSchema.safeParse({ servers: [{ ...server, ...override }] }).success,
      ).toBe(false);
    }
    expect(HostMcpConfigSchema.safeParse({ servers: [server, server] }).success).toBe(
      false,
    );
  });

  it("injects scoped workers without giving them the orchestrator token", () => {
    const { service, store, worker, leadId, relay, token } = setup();
    expect(service.mcpServersFor(worker).map((server) => server.name)).toEqual([
      "fleet-host-figma",
    ]);
    expect(
      service.mcpServersFor(store.getSession(leadId)!).map((server) => server.name),
    ).toEqual(["fleet"]);
    expect(relay.authorize("figma", token)?.name).toBe("figma");
    expect(new LeadTokens(store).resolve(token)).toBeUndefined();
    const leadToken = new LeadTokens(store).mint({
      sessionId: worker.id,
      nodeId: worker.nodeId,
      runId: worker.runId,
    });
    expect(relay.authorize("figma", leadToken)).toBeUndefined();
  });

  it("rebases only the relay address onto the remote Node's secure Host connection", () => {
    const { relay, worker } = setup();
    const declared = relay.serversFor(worker);
    const resolved = resolveMcpServers(declared, "https://node-tunnel.example");
    expect(resolved[0]!.url).toBe("https://node-tunnel.example/mcp/host/figma");
    expect(resolved[0]!.headers).toEqual(declared[0]!.headers);
    expect(JSON.stringify(resolved)).not.toContain("mcp.figma.com");
    expect(() => resolveMcpServers(declared, "http://192.168.1.2:8787")).toThrow();
  });

  it("preserves signed grants across a Host restart but not across config changes", async () => {
    const { service, config, token, relay } = setup();
    await relay.close();
    const restarted = new HostMcpRelay(service, config, () => "https://host.example");
    resources.push(() => restarted.close());
    expect(restarted.authorize("figma", token)).toBeDefined();
    const changed = new HostMcpRelay(
      service,
      { servers: [{ ...config.servers[0]!, tools: ["whoami"] }] },
      () => "https://host.example",
    );
    resources.push(() => changed.close());
    expect(changed.authorize("figma", token)).toBeUndefined();
    expect(restarted.authorize("another-server", token)).toBeUndefined();
  });

  it.each([
    { state: "stopped" as const },
    { stopRequested: true },
    { cleanupRequested: true },
    { readOnly: true },
    { runId: "different-run" },
    { nodeId: "different-node" },
  ])("revokes a grant when the session changes: %j", (change) => {
    const { store, relay, token, worker } = setup();
    vi.spyOn(store, "getSession").mockReturnValue({ ...worker, ...change });
    expect(relay.authorize("figma", token)).toBeUndefined();
  });

  it("revokes disconnected Nodes and suspended relays", async () => {
    const { store, relay, token, worker } = setup();
    store.setNodeOnline(worker.nodeId, false);
    expect(relay.authorize("figma", token)).toBeUndefined();
    store.setNodeOnline(worker.nodeId, true);
    await relay.close();
    expect(relay.authorize("figma", token)).toBeUndefined();
    expect(relay.serversFor(worker)).toEqual([]);
  });

  it.each(["awaiting_human", "awaiting_approval", "completed"] as const)(
    "withdraws grants when a task is %s",
    (state) => {
      const { store, worker, relay } = setup();
      const run = store.createRun({
        workspaceId: worker.workspaceId,
        name: "MCP task",
        objective: "Read design",
      });
      const subject = { ...worker, runId: run.id };
      vi.spyOn(store, "getSession").mockReturnValue(subject);
      vi.spyOn(store, "getRun").mockReturnValue({ ...run, state });
      const token = relay.serversFor(subject)[0]!.headers[0]!.value.slice(7);
      expect(relay.authorize("figma", token)).toBeUndefined();
    },
  );

  it("does not share Host tools with read-only workers", () => {
    const { store, service, worker } = setup();
    vi.spyOn(store, "getSession").mockReturnValue({ ...worker, readOnly: true });
    expect(service.mcpServersFor(worker)).toEqual([]);
  });

  it("shares declared read-only tools without changing a worker's read-only policy", () => {
    const { config, store, service, worker, relay } = setup();
    config.servers[0]!.readOnly = true;
    vi.spyOn(store, "getSession").mockReturnValue({ ...worker, readOnly: true });
    const servers = service.mcpServersFor(worker);
    expect(servers.map((server) => server.name)).toEqual(["fleet-host-figma"]);
    expect(
      relay.authorize("figma", servers[0]!.headers[0]!.value.slice(7)),
    ).toBeDefined();
    expect(store.getSession(worker.id)!.readOnly).toBe(true);
  });
});

describe("Host MCP transport", () => {
  async function endpoint() {
    const h = setup();
    const app = Fastify();
    await app.register(hostMcpRoutes, { relay: h.relay });
    resources.push(() => app.close());
    const rpc = (
      method: string,
      params?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method: "POST",
        url: "/mcp/host/figma",
        headers: {
          authorization: `Bearer ${h.token}`,
          accept: "application/json, text/event-stream",
          ...headers,
        },
        payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
      });
    return { ...h, app, rpc };
  }

  it("lists and forwards only explicitly enabled tools, preserving image content", async () => {
    const { rpc, result, client } = await endpoint();
    expect((await rpc("tools/list")).json().result.tools).toHaveLength(2);
    const response = await rpc("tools/call", {
      name: "get_screenshot",
      arguments: { nodeId: "1:2" },
    });
    expect(response.json().result).toEqual(result);
    expect(client.callTool).toHaveBeenCalledWith(
      "get_screenshot",
      { nodeId: "1:2" },
      expect.any(Function),
    );
    const rejected = await rpc("tools/call", { name: "delete_file", arguments: {} });
    expect(rejected.json().result.isError).toBe(true);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects missing tokens and browser origins before opening the upstream", async () => {
    const { rpc, createClient } = await endpoint();
    expect((await rpc("tools/list", undefined, { authorization: "" })).statusCode).toBe(
      401,
    );
    expect(
      (await rpc("tools/list", undefined, { origin: "https://host.example" })).statusCode,
    ).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reports upstream authentication errors without retrying tool calls", async () => {
    const { rpc, client } = await endpoint();
    client.callTool.mockRejectedValueOnce(new Error("Figma requires authentication"));
    const response = await rpc("tools/call", { name: "whoami" });
    expect(response.json().result.isError).toBe(true);
    expect(response.json().result.content[0].text).toContain("on the Host");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("forwards only explicitly granted resources, including a tool adapter for ACP clients", async () => {
    const { rpc, config, relay, worker, client } = await endpoint();
    const uri = "skill://figma/figma-design-to-code/SKILL.md";
    config.servers[0]!.resources = [uri];
    const headers = { authorization: relay.serversFor(worker)[0]!.headers[0]!.value };
    expect(
      (await rpc("resources/list", undefined, headers)).json().result.resources,
    ).toEqual([{ uri, name: uri }]);
    expect(
      (await rpc("resources/read", { uri }, headers)).json().result.contents[0].text,
    ).toBe("# Guidance");
    const tools = (await rpc("tools/list", undefined, headers)).json().result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toContain("read_resource");
    const result = await rpc(
      "tools/call",
      { name: "read_resource", arguments: { uri } },
      headers,
    );
    expect(result.json().result.content[0]).toMatchObject({
      type: "resource",
      resource: { uri, text: "# Guidance" },
    });
    const rejected = await rpc(
      "tools/call",
      {
        name: "read_resource",
        arguments: { uri: "file:///private/credentials" },
      },
      headers,
    );
    expect(rejected.json().result.isError).toBe(true);
    expect(client.readResource).toHaveBeenCalledTimes(2);
  });
});
