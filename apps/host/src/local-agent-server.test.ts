import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DURABLE_LEAD_DELIVERY_CAPABILITY,
  LOCAL_AGENT_HEADER,
  LOCAL_AGENT_LIMITS,
} from "@fleet/protocol";
import type { AuthenticatedChannel } from "@fleet/protocol/node-auth";
import { FleetStore } from "./store.js";
import { FleetService } from "./fleet-service.js";
import { SealedNodeLink } from "./gateway/node-channel.js";
import { HostIdentityService } from "./auth/host-identity.js";
import { OrchestratorEngine } from "./orchestrator/engine.js";
import { LocalAgentService } from "./local-agent-service.js";
import { LocalAgentListener, localAgentAdmission } from "./local-agent-server.js";
import { localAgentTunnelConflict } from "./local-agent-marker.js";
import { localAgentSettingsRoutes } from "./routes/local-agent-settings.js";
import type { FleetAuth } from "./auth/service.js";

const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as FastifyBaseLogger;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A Host with one durable Node, one workspace and one idle orchestrator, exposed on `port`. */
async function host(options: { markerPath?: string | null } = {}) {
  const store = new FleetStore(":memory:");
  cleanups.push(() => store.close());
  new HostIdentityService(store).identity();
  const service = new FleetService(store, log, "test");
  const node = store.registerNode({
    name: "box",
    os: "win32",
    arch: "x64",
    version: "test",
    capabilities: [DURABLE_LEAD_DELIVERY_CAPABILITY],
    maxSessions: 8,
  }).node;
  const raw = { OPEN: 1, readyState: 1, send() {}, close() {} };
  const channel = {
    seal: (text: string) => JSON.parse(text),
  } as unknown as AuthenticatedChannel;
  service.attachNode(node.id, new SealedNodeLink(raw, channel));
  store.setNodeOnline(node.id, true, 0);
  service.commands.nodeReady(node.id, {
    capabilities: [DURABLE_LEAD_DELIVERY_CAPABILITY],
  });
  const workspace = store.createWorkspace("repo", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
  const lead = store.createSession(placement, "orchestrate", false, "Lead", {
    runRole: "lead",
  });
  store.transitionSession(lead.id, "starting");
  store.transitionSession(lead.id, "running");
  const engine = new OrchestratorEngine(service);
  service.attachOrchestration({
    leadTokens: { mint: () => "flt_test" },
    mcpUrl: () => "http://127.0.0.1/mcp",
    tickRun: (runId) => engine.tickRun(runId),
    resume: engine.resume,
  });
  const port = await freePort();
  store.setLocalAgentConfig(
    {
      enabled: true,
      port,
      allowedLeadSessionIds: [lead.id],
      allowedWorkspaceIds: [workspace.id],
    },
    0,
  );
  const agent = new LocalAgentService(service, engine, log);
  const listener = new LocalAgentListener({
    agent,
    log,
    mainPort: 1,
    markerPath: options.markerPath === undefined ? null : options.markerPath,
  });
  cleanups.push(() => listener.close());
  const setEnabled = async (enabled: boolean, next = port) => {
    const config = store.getLocalAgentConfig();
    store.setLocalAgentConfig({ ...config, enabled, port: next }, config.revision);
    return listener.reconcile();
  };
  return { store, agent, listener, port, lead, workspace, setEnabled };
}

type Reply = {
  status: number;
  headers: IncomingHttpHeaders;
  json: Record<string, unknown>;
};

/** One HTTP exchange with every header under the test's control. */
function call(
  port: number,
  init: {
    method?: string;
    path?: string;
    headers?: Record<string, string | undefined>;
    body?: string;
  } = {},
): Promise<Reply> {
  const headers = Object.fromEntries(
    Object.entries({
      host: `127.0.0.1:${port}`,
      [LOCAL_AGENT_HEADER]: "1",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: init.method ?? "GET",
        path: init.path ?? "/v1/capabilities",
        headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });
}

describe("local agent admission", () => {
  const admit = (
    headers: Record<string, string>,
    overrides: Partial<{ method: string; url: string; peer: string | undefined }> = {},
  ) =>
    localAgentAdmission(
      {
        method: "GET",
        url: "/v1/tasks",
        peer: "127.0.0.1",
        rawHeaders: Object.entries({
          Host: "127.0.0.1:8786",
          [LOCAL_AGENT_HEADER]: "1",
          ...headers,
        }).flat(),
        ...overrides,
      },
      8786,
    )?.code;

  it("admits a plain loopback request carrying the marker", () => {
    expect(admit({})).toBeUndefined();
    expect(admit({ "Sec-Fetch-Mode": "cors" })).toBeUndefined();
    expect(admit({}, { peer: "::ffff:127.0.0.1" })).toBeUndefined();
    expect(
      admit({ "Content-Type": "application/json; charset=utf-8" }, { method: "POST" }),
    ).toBeUndefined();
  });

  it("refuses anything a browser, proxy or remote peer would bring", () => {
    expect(admit({}, { peer: "10.0.0.5" })).toBe("forbidden_transport");
    expect(admit({}, { peer: "::1" })).toBe("forbidden_transport");
    expect(admit({ Host: "localhost:8786" })).toBe("forbidden_transport");
    expect(admit({ Host: "127.0.0.1" })).toBe("forbidden_transport");
    expect(admit({}, { url: "http://127.0.0.1:8786/v1/tasks" })).toBe(
      "forbidden_transport",
    );
    expect(admit({}, { url: "//evil/v1/tasks" })).toBe("forbidden_transport");
    for (const name of [
      "Origin",
      "Cookie",
      "Authorization",
      "Forwarded",
      "Via",
      "Upgrade",
      "Sec-Fetch-Site",
      "X-Forwarded-For",
      "X-Fleet-Node-Id",
    ])
      expect(admit({ [name]: "x" }), name).toBe("forbidden_transport");
    expect(admit({ [LOCAL_AGENT_HEADER]: "true" })).toBe("forbidden_transport");
    expect(
      localAgentAdmission(
        {
          method: "GET",
          url: "/v1/tasks",
          peer: "127.0.0.1",
          rawHeaders: ["Host", "127.0.0.1:8786"],
        },
        8786,
      )?.code,
    ).toBe("forbidden_transport");
    expect(
      localAgentAdmission(
        {
          method: "GET",
          url: "/v1/tasks",
          peer: "127.0.0.1",
          rawHeaders: [
            "Host",
            "127.0.0.1:8786",
            "Host",
            "127.0.0.1:8786",
            LOCAL_AGENT_HEADER,
            "1",
          ],
        },
        8786,
      )?.code,
    ).toBe("forbidden_transport");
  });

  it("allows only GET and JSON POST", () => {
    expect(admit({}, { method: "DELETE" })).toBe("method_not_allowed");
    expect(admit({}, { method: "OPTIONS" })).toBe("method_not_allowed");
    expect(admit({}, { method: "POST" })).toBe("unsupported_media_type");
    expect(admit({ "Content-Type": "text/plain" }, { method: "POST" })).toBe(
      "unsupported_media_type",
    );
  });
});

describe("local agent listener", () => {
  it("stays closed until the Host is listening, then follows the configuration", async () => {
    const h = await host();
    expect(await h.listener.reconcile()).toEqual({ state: "disabled" });
    await expect(call(h.port)).rejects.toThrow();

    expect(await h.listener.activate()).toEqual({
      state: "listening",
      url: `http://127.0.0.1:${h.port}`,
    });
    const capabilities = await call(h.port);
    expect(capabilities.status).toBe(200);
    expect(capabilities.headers["cache-control"]).toBe("no-store");
    expect(capabilities.json).toMatchObject({
      version: "v1",
      trust: "unauthenticated-loopback",
      mcp: "/v1/mcp",
    });

    expect(await h.setEnabled(false)).toEqual({ state: "disabled" });
    await expect(call(h.port)).rejects.toThrow();
  });

  it("answers REST reads and writes over real HTTP", async () => {
    const h = await host();
    await h.listener.activate();
    const leads = await call(h.port, { path: "/v1/orchestrators" });
    expect(leads.status).toBe(200);
    expect(leads.json.orchestrators).toEqual([
      expect.objectContaining({ id: h.lead.id, writable: true }),
    ]);
    const operationId = randomUUID();
    const body = JSON.stringify({
      operationId,
      workspaceId: h.workspace.id,
      name: "From REST",
      objective: "Prove the route.",
      clientLabel: "test",
    });
    const created = await call(h.port, {
      method: "POST",
      path: `/v1/orchestrators/${h.lead.id}/tasks`,
      body,
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      request: { operationId, state: "waiting_for_brief" },
    });
    const replay = await call(h.port, {
      method: "POST",
      path: `/v1/orchestrators/${h.lead.id}/tasks`,
      body,
    });
    expect(replay.json).toMatchObject({ replayed: true });
    const receipt = await call(h.port, { path: `/v1/requests/${operationId}` });
    expect(receipt.json).toMatchObject({ request: { operationId } });

    expect((await call(h.port, { path: "/v1/tasks/missing" })).json.code).toBe(
      "not_found",
    );
    expect((await call(h.port, { path: "/v1/nothing" })).status).toBe(404);
    const invalid = await call(h.port, {
      method: "POST",
      path: `/v1/orchestrators/${h.lead.id}/tasks`,
      body: JSON.stringify({ operationId: "not-a-uuid" }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json.code).toBe("bad_request");
    const malformed = await call(h.port, {
      method: "POST",
      path: `/v1/orchestrators/${h.lead.id}/tasks`,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.json.code).toBe("bad_request");
  });

  it("refuses browsers, missing markers, oversized bodies and other verbs on the wire", async () => {
    const h = await host();
    await h.listener.activate();
    const refused = async (init: Parameters<typeof call>[1]) => {
      const reply = await call(h.port, init);
      return [reply.status, reply.json.code];
    };
    expect(await refused({ headers: { [LOCAL_AGENT_HEADER]: undefined } })).toEqual([
      403,
      "forbidden_transport",
    ]);
    expect(await refused({ headers: { origin: "https://evil.example" } })).toEqual([
      403,
      "forbidden_transport",
    ]);
    expect(await refused({ headers: { "sec-fetch-site": "cross-site" } })).toEqual([
      403,
      "forbidden_transport",
    ]);
    expect(await refused({ headers: { host: `localhost:${h.port}` } })).toEqual([
      403,
      "forbidden_transport",
    ]);
    const deleted = await call(h.port, { method: "DELETE", path: "/v1/tasks/x" });
    expect([deleted.status, deleted.json.code, deleted.headers.allow]).toEqual([
      405,
      "method_not_allowed",
      "GET, POST",
    ]);
    expect(
      await refused({
        method: "POST",
        path: `/v1/orchestrators/${h.lead.id}/tasks`,
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    ).toEqual([415, "unsupported_media_type"]);
    expect(
      await refused({
        method: "POST",
        path: `/v1/orchestrators/${h.lead.id}/tasks`,
        body: JSON.stringify({ pad: "x".repeat(LOCAL_AGENT_LIMITS.bodyBytes) }),
      }),
    ).toEqual([413, "payload_too_large"]);
    expect(await refused({ path: "/v1/mcp" })).toEqual([405, "method_not_allowed"]);
  });

  it("works with Node's own fetch, which sends sec-fetch-mode", async () => {
    const h = await host();
    await h.listener.activate();
    const response = await fetch(`http://127.0.0.1:${h.port}/v1/workspaces`, {
      headers: { [LOCAL_AGENT_HEADER]: "1" },
    });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { workspaces: { id: string }[] }).workspaces,
    ).toEqual([expect.objectContaining({ id: h.workspace.id })]);
  });

  it("reports a port it cannot take without touching anything else", async () => {
    const h = await host();
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(h.port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())));
    const status = await h.listener.activate();
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/already in use/);

    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    expect((await h.listener.reconcile()).state).toBe("listening");
  });

  it("never shares the main Host's port", async () => {
    const h = await host();
    const listener = new LocalAgentListener({
      agent: h.agent,
      log,
      mainPort: h.port,
      markerPath: null,
    });
    cleanups.push(() => listener.close());
    expect(await listener.activate()).toEqual({ state: "disabled" });
  });

  it("records its port for the tunnel guard while it listens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-local-agent-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const markerPath = join(dir, "local-agent.json");
    const h = await host({ markerPath });
    await h.listener.activate();
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { port: number };
    expect(marker.port).toBe(h.port);
    expect(
      localAgentTunnelConflict(h.port, 8787, { ...marker, pid: 1, url: "" }),
    ).toMatch(/must never be tunnelled/);
    await h.setEnabled(false);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("local agent tunnel guard", () => {
  it("refuses the default port and any port a listener recorded, but not the Host's own", () => {
    expect(localAgentTunnelConflict(8787, 8787, undefined)).toBeUndefined();
    expect(localAgentTunnelConflict(8786, 8787, undefined)).toMatch(/reserved/);
    expect(localAgentTunnelConflict(8786, 8786, undefined)).toBeUndefined();
    expect(
      localAgentTunnelConflict(9100, 8787, {
        port: 9100,
        pid: 1,
        url: "http://127.0.0.1:9100",
      }),
    ).toMatch(/must never be tunnelled/);
    expect(
      localAgentTunnelConflict(8787, 8787, {
        port: 9100,
        pid: 1,
        url: "http://127.0.0.1:9100",
      }),
    ).toBeUndefined();
  });
});

describe("local agent settings routes", () => {
  it("are an administrator's alone, and only widening needs a recent sign-in", async () => {
    const h = await host();
    await h.listener.activate();
    const app = Fastify({ logger: false });
    cleanups.push(() => app.close());
    const signedIn = (request: { headers: Record<string, unknown> }) =>
      request.headers["fixture-admin"] as string | undefined;
    app.addHook("onRequest", async (request) => {
      const who = signedIn(request);
      if (who)
        request.fleetSession = {
          tokenHash: who,
          administratorId: "admin-1",
          authMethod: "microsoft-code",
          authenticatedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
    });
    let noAuth = false;
    const auth = {
      administratorFor: () => ({ id: "admin-1", username: "admin@example.com" }),
      requireRecentReauth: (session: { tokenHash: string }) =>
        session.tokenHash === "fresh",
      noAuthEnabled: () => noAuth,
      noAuthEndpointAllowed: (hostHeader: string | undefined) =>
        hostHeader?.startsWith("localhost") === true,
    } as unknown as FleetAuth;
    await app.register(localAgentSettingsRoutes, {
      auth,
      agent: h.agent,
      listener: h.listener,
      mainPort: 1,
    });
    await app.ready();

    expect((await app.inject({ url: "/api/local-agent/config" })).statusCode).toBe(403);
    const read = await app.inject({
      url: "/api/local-agent/config",
      headers: { "fixture-admin": "stale" },
    });
    expect(read.json()).toMatchObject({
      config: { enabled: true, port: h.port },
      status: { state: "listening" },
      hostPort: 1,
      defaultPort: 8786,
    });

    const config = h.store.getLocalAgentConfig();
    const disable = {
      enabled: false,
      port: h.port,
      allowedLeadSessionIds: config.allowedLeadSessionIds,
      allowedWorkspaceIds: config.allowedWorkspaceIds,
      expectedRevision: config.revision,
    };
    // Turning it off narrows exposure, so an older administrator sign-in will do.
    const saved = await app.inject({
      method: "PUT",
      url: "/api/local-agent/config",
      headers: { "fixture-admin": "stale" },
      payload: disable,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      config: { enabled: false },
      status: { state: "disabled" },
    });
    await expect(call(h.port)).rejects.toThrow();

    const enable = {
      ...disable,
      enabled: true,
      expectedRevision: h.store.getLocalAgentConfig().revision,
    };
    const stale = await app.inject({
      method: "PUT",
      url: "/api/local-agent/config",
      headers: { "fixture-admin": "stale" },
      payload: enable,
    });
    expect([stale.statusCode, stale.json().reauthRequired]).toEqual([403, true]);
    const reenabled = await app.inject({
      method: "PUT",
      url: "/api/local-agent/config",
      headers: { "fixture-admin": "fresh" },
      payload: enable,
    });
    expect(reenabled.json()).toMatchObject({
      config: { enabled: true },
      status: { state: "listening" },
    });
    expect((await call(h.port)).status).toBe(200);

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/local-agent/config",
      headers: { "fixture-admin": "fresh" },
      payload: disable,
    });
    expect([conflict.statusCode, conflict.json().code]).toEqual([409, "stale_request"]);
    expect(
      (
        await app.inject({
          url: "/api/local-agent/requests",
          headers: { "fixture-admin": "stale" },
        })
      ).json(),
    ).toMatchObject({ requests: [] });

    // With sign-in deliberately skipped, the local operator manages it, as it
    // manages Nodes; an outside address still gets nothing.
    noAuth = true;
    expect(
      (
        await app.inject({
          url: "/api/local-agent/config",
          headers: { host: "fleet.example" },
        })
      ).statusCode,
    ).toBe(403);
    const operatorOff = await app.inject({
      method: "PUT",
      url: "/api/local-agent/config",
      payload: { ...disable, expectedRevision: h.store.getLocalAgentConfig().revision },
    });
    expect(operatorOff.json()).toMatchObject({ config: { enabled: false } });
    expect(
      h.store
        .listSecurityAudit(10)
        .find((event) => event.eventType === "local_agent_config_changed"),
    ).toMatchObject({ actorKind: "operator" });
  });
});

describe("local agent MCP", () => {
  it("serves an off-the-shelf MCP client the same operations", async () => {
    const h = await host();
    await h.listener.activate();
    const client = new Client({ name: "hermes-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${h.port}/v1/mcp`),
      { requestInit: { headers: { [LOCAL_AGENT_HEADER]: "1" } } },
    );
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    cleanups.push(() => client.close());
    expect(client.getInstructions()).toMatch(/operationId/);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_task",
      "get_request",
      "get_task",
      "list_orchestrators",
      "list_tasks",
      "list_workspaces",
      "read_transcript",
      "send_task_message",
    ]);

    const text = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      JSON.parse((result.content as { text: string }[])[0]!.text) as Record<
        string,
        unknown
      >;
    const operationId = randomUUID();
    const created = await client.callTool({
      name: "create_task",
      arguments: {
        leadSessionId: h.lead.id,
        operationId,
        workspaceId: h.workspace.id,
        name: "From MCP",
        objective: "Prove the tool.",
      },
    });
    expect(created.isError).toBeFalsy();
    const task = text(created).task as { id: string };
    expect(h.store.getRun(task.id)).toMatchObject({ leadSessionId: h.lead.id });

    const asked = await client.callTool({
      name: "send_task_message",
      arguments: {
        taskId: task.id,
        operationId: randomUUID(),
        expectedLeadSessionId: h.lead.id,
        intent: "question",
        text: "Status?",
      },
    });
    expect(text(asked)).toMatchObject({
      request: { kind: "question", state: "pending" },
    });

    const listed = await client.callTool({
      name: "list_tasks",
      arguments: { state: "open" },
    });
    expect((text(listed).tasks as { id: string }[]).map((t) => t.id)).toEqual([task.id]);

    const missing = await client.callTool({
      name: "get_task",
      arguments: { taskId: "nope" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatchObject({ code: "not_found" });
  });

  it("is refused to a client that leaves out the marker header", async () => {
    const h = await host();
    await h.listener.activate();
    const client = new Client({ name: "browserish", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${h.port}/v1/mcp`),
    );
    await expect(
      client.connect(transport as unknown as Parameters<typeof client.connect>[0]),
    ).rejects.toThrow();
    await client.close().catch(() => undefined);
  });
});
