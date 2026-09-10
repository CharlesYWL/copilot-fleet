import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  DriCapabilitySchema,
  DriInvestigationSchema,
  DriLimitsSchema,
  DriQuerySchema,
  type DriCapability,
} from "@fleet/protocol";
import {
  DriMcpCatalog,
  DriMcpManifestSchema,
  parseDriMcpCatalog,
  type DriMcpOptions,
} from "./mcp.js";
import { dmsProfile } from "./profiles.js";
import {
  ProviderPageSchema,
  type DiscoveredMcpClient,
  type ProviderContext,
} from "./providers.js";

const now = "2025-01-01T00:00:00.000Z";
const toolNames: Record<DriCapability, string> = {
  "incident.read": "get_incident_details_by_id",
  "artifact.read": "artifact_metadata_read",
  "har.analyze": "har_analyze_local",
  "telemetry.query": "telemetry_query_readonly",
  "similar.search": "get_similar_incidents",
  "change.read": "get_commit",
};
const binding = (capability: DriCapability, tool = toolNames[capability]) => ({
  capability,
  tool,
  arguments: { scope: "scope" },
  response: "provider-page-v1",
});
const schema = {
  type: "object",
  properties: { scope: { type: "object" } },
  required: ["scope"],
};
const catalog = (bindings = [binding("incident.read")]) => ({
  mcpServers: {
    approved: {
      type: "http",
      url: "https://synthetic.invalid/mcp",
      headers: { Authorization: "Bearer synthetic-test-only" },
      _meta: { "fleet/dri": { version: 1, bindings } },
    },
  },
});
const empty = ProviderPageSchema.parse({
  state: "no_results",
  summary: "No results in the bounded synthetic test.",
});
function context(capability: DriCapability = "incident.read"): ProviderContext {
  const limits = DriLimitsSchema.parse({});
  const investigation = DriInvestigationSchema.parse({
    id: "synthetic-investigation",
    version: 1,
    revision: 0,
    generation: 1,
    runId: "synthetic-run",
    leadSessionId: "",
    incident: {
      id: "42",
      url: "https://portal.microsofticm.com/imp/v5/incidents/details/42",
    },
    requestedProfile: "auto",
    profile: {
      id: "decision",
      profileId: "dms",
      profileVersion: "1.0.0",
      method: "auto",
      confidence: 1,
      evidenceIds: [],
      explanation: "Synthetic test",
      revision: 1,
      decidedAt: now,
    },
    mode: "live",
    phase: "collect",
    status: "collect",
    limits,
    question: "untrusted-private-query; .drop table",
    hints: [],
    artifactRef: "artifact:approved",
    createdAt: now,
    updatedAt: now,
    lifecycleCause: "created",
    limitation: "",
  });
  return {
    investigation,
    profile: dmsProfile,
    cursor: undefined,
    signal: new AbortController().signal,
    privateBindings: { secret: "synthetic-private" },
    query: DriQuerySchema.parse({
      id: "query",
      investigationId: investigation.id,
      profileId: "dms",
      generation: 1,
      attempt: 1,
      invocationId: "domain",
      createdAt: now,
      kind: "queries",
      key: "query-key",
      stepId: "step",
      agentId: "agent",
      providerId: "mcp.test",
      capability,
      purpose: "Scoped read",
      template:
        capability === "telemetry.query"
          ? "dms.operation-cohorts.v1"
          : `${capability}.v1`,
      parameters: [],
      privateParameterNames: [],
      parameterHash: "a".repeat(64),
      bounds: limits,
      timeRange: { start: now, end: "2025-01-01T01:00:00.000Z" },
      state: "running",
      summary: "",
      error: "none",
      rows: 0,
      bytes: 0,
      pages: 0,
      cursor: "",
    }),
  };
}
const connectTo =
  (client: DiscoveredMcpClient): NonNullable<DriMcpOptions["connect"]> =>
  async (_server, _bytes, _signal, work) =>
    work(client);
const clientFor = (names = Object.values(toolNames)) => ({
  discover: vi.fn<DiscoveredMcpClient["discover"]>(async () =>
    names.map((name) => ({ name, readOnly: true, inputSchema: schema })),
  ),
  call: vi.fn<DiscoveredMcpClient["call"]>(async () => ({ structuredContent: empty })),
});

describe("operator-approved read-only MCP catalog", () => {
  it("discovers every capability, including source and pipeline read tools, through exact manifests", async () => {
    const bindings = [
      ...DriCapabilitySchema.options.map((capability) => binding(capability)),
      binding("change.read", "actions_get"),
      binding("change.read", "actions_list"),
    ];
    const client = clientFor([
      ...Object.values(toolNames),
      "actions_get",
      "actions_list",
      "update_incident",
    ]);
    const discovery = await new DriMcpCatalog({
      catalog: catalog(bindings),
      connect: connectTo(client),
    }).discover(context().signal);
    expect(discovery.providers).toHaveLength(6);
    expect(discovery.issues).toEqual({});
    expect(client.discover).toHaveBeenCalledTimes(1);
    for (const provider of discovery.providers) {
      const capability = provider.definition.capabilities[0]!;
      await provider.read(context(capability));
    }
    expect(client.call.mock.calls.map((call) => call[0])).not.toContain(
      "update_incident",
    );
  });
  it.each([
    "update_incident",
    "mitigate_incident",
    "post_discussion_entry",
    "resolve_incident",
    "get_incident_details_by_id_write",
    "get_commit_admin",
    "execute_any_tool",
  ])("rejects a write, admin or similarly named tool: %s", async (tool) => {
    expect(
      DriMcpManifestSchema.safeParse({
        version: 1,
        bindings: [binding("incident.read", tool)],
      }).success,
    ).toBe(false);
    const client = clientFor([tool]);
    const result = await new DriMcpCatalog({
      catalog: catalog([binding("incident.read", tool)]),
      connect: connectTo(client),
    }).discover(context().signal);
    expect(result.providers).toHaveLength(0);
    expect(result.issues["incident.read"]?.state).toBe("incompatible");
    expect(client.discover).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });
  it("requires explicit read-only discovery and mapped required arguments, not just an allowlisted name", async () => {
    for (const tool of [
      { name: toolNames["incident.read"], readOnly: false, inputSchema: schema },
      {
        name: toolNames["incident.read"],
        readOnly: true,
        inputSchema: { ...schema, required: ["arbitraryTool"] },
      },
      {
        name: toolNames["incident.read"],
        readOnly: true,
        inputSchema: { type: "string" },
      },
    ]) {
      const client = { discover: vi.fn(async () => [tool]), call: vi.fn() };
      const result = await new DriMcpCatalog({
        catalog: catalog(),
        connect: connectTo(client),
      }).discover(context().signal);
      expect(result.providers).toHaveLength(0);
      expect(client.call).not.toHaveBeenCalled();
    }
  });
  it("refuses unmanifested, insecure, credential-in-URL and unsupported catalog entries", () => {
    for (const overrides of [
      { url: "http://remote.invalid/mcp" },
      { url: "https://user:password@synthetic.invalid/mcp" },
      { url: "https://synthetic.invalid/mcp?token=synthetic" },
      { type: "stdio" },
      { _meta: {} },
      { headers: { Host: "remote.invalid" } },
      { disabled: true },
    ]) {
      const raw = catalog();
      expect(
        parseDriMcpCatalog({
          mcpServers: { approved: { ...raw.mcpServers.approved, ...overrides } },
        }).servers,
      ).toHaveLength(0);
    }
    expect(parseDriMcpCatalog({ mcpServers: {} }).servers).toHaveLength(0);
  });
  it("passes only incident scope and trusted bounded plans, never request text, private hints or arbitrary KQL", async () => {
    const client = clientFor();
    const { providers } = await new DriMcpCatalog({
      catalog: catalog([binding("telemetry.query")]),
      connect: connectTo(client),
    }).discover(context().signal);
    await providers[0]!.read(context("telemetry.query"));
    const args = client.call.mock.calls[0]?.[1];
    expect(args).toMatchObject({
      scope: {
        incidentId: "42",
        maxRows: 200,
        maxBytes: 524288,
        timeoutMs: 15000,
        queryPlan: {
          template: "dms.operation-cohorts.v1",
          filterOrder: ["environment", "utc_time", "correlation"],
        },
      },
    });
    expect(JSON.stringify(args)).not.toMatch(
      /untrusted-private|synthetic-private|drop table|synthetic\.invalid|Authorization/,
    );
  });
  it("rechecks catalog authorization and discovery before every invocation", async () => {
    const raw = catalog();
    const client = clientFor();
    const discovery = await new DriMcpCatalog({
      catalog: raw,
      connect: connectTo(client),
    }).discover(context().signal);
    raw.mcpServers.approved._meta["fleet/dri"].bindings = [];
    expect((await discovery.providers[0]!.read(context())).state).toBe("access_denied");
    expect(client.call).not.toHaveBeenCalled();
    const next = await new DriMcpCatalog({
      catalog: catalog(),
      connect: connectTo(client),
    }).discover(context().signal);
    client.discover.mockResolvedValueOnce([]);
    expect((await next.providers[0]!.read(context())).state).toBe("unavailable");
    expect(client.call).not.toHaveBeenCalled();
  });
  it("rejects raw envelopes, out-of-scope evidence, excessive bytes and untrusted error success", async () => {
    const malformed = [
      { content: [{ type: "text", text: "Incident text is not normalized evidence." }] },
      {
        structuredContent: {
          ...empty,
          evidence: [{ type: "telemetry", finding: "Fake cause", observedAt: now }],
        },
      },
      { structuredContent: { ...empty, summary: "x".repeat(600_000) } },
    ];
    for (const raw of malformed) {
      const client = { ...clientFor(), call: vi.fn(async () => raw) };
      const { providers } = await new DriMcpCatalog({
        catalog: catalog(),
        connect: connectTo(client),
      }).discover(context().signal);
      await expect(providers[0]!.read(context())).rejects.toThrow();
    }
    const client = {
      ...clientFor(),
      call: vi.fn(async () => ({ isError: true, structuredContent: empty })),
    };
    const { providers } = await new DriMcpCatalog({
      catalog: catalog(),
      connect: connectTo(client),
    }).discover(context().signal);
    expect((await providers[0]!.read(context())).state).toBe("failed");
  });
  it("collects all declared source-control and pipeline tools with bounded continuation", async () => {
    const client = clientFor(["get_commit", "actions_get"]);
    const { providers } = await new DriMcpCatalog({
      catalog: catalog([
        binding("change.read", "get_commit"),
        binding("change.read", "actions_get"),
      ]),
      connect: connectTo(client),
    }).discover(context().signal);
    const first = await providers[0]!.read(context("change.read"));
    expect(first.nextCursor).toBeTruthy();
    const last = await providers[0]!.read({
      ...context("change.read"),
      cursor: first.nextCursor,
    });
    expect(last.state).toBe("no_results");
    expect(last.nextCursor).toBeUndefined();
    expect(client.call.mock.calls.map((call) => call[0])).toEqual([
      "get_commit",
      "actions_get",
    ]);
  });
  it("does not advertise partial discovery as complete capability coverage", async () => {
    const client = clientFor(["get_commit"]);
    const result = await new DriMcpCatalog({
      catalog: catalog([
        binding("change.read", "get_commit"),
        binding("change.read", "actions_get"),
      ]),
      connect: connectTo(client),
    }).discover(context().signal);
    expect(result.providers).toHaveLength(0);
    expect(result.issues["change.read"]?.state).toBe("incompatible");
  });
  it("does not silently omit unvisited sources when discovery is aborted", async () => {
    const raw = catalog();
    const controller = new AbortController();
    const client = {
      ...clientFor(),
      discover: vi.fn<DiscoveredMcpClient["discover"]>(async () => {
        controller.abort();
        return [
          { name: "get_incident_details_by_id", readOnly: true, inputSchema: schema },
        ];
      }),
    };
    const result = await new DriMcpCatalog({
      catalog: {
        mcpServers: { first: raw.mcpServers.approved, second: raw.mcpServers.approved },
      },
      connect: connectTo(client),
    }).discover(controller.signal);
    expect(result.providers).toHaveLength(0);
    expect(result.issues["incident.read"]?.reason).toContain("interrupted");
  });
  it("surfaces absent catalogs and discovery failures without fixture fallback or secret errors", async () => {
    const result = await new DriMcpCatalog({ catalog: { mcpServers: {} } }).discover(
      context().signal,
    );
    expect(result.providers).toHaveLength(0);
    expect(Object.keys(result.issues)).toHaveLength(6);
    const client = {
      ...clientFor(),
      discover: vi.fn(async () => {
        throw new Error("Bearer synthetic-secret");
      }),
    };
    const failed = await new DriMcpCatalog({
      catalog: catalog(),
      connect: connectTo(client),
    }).discover(context().signal);
    expect(failed.providers).toHaveLength(0);
    expect(failed.issues["incident.read"]?.reason).toContain("discovery failed");
    expect(JSON.stringify(failed)).not.toContain("synthetic-secret");
  });
  it("uses the shipped HTTP SDK transport against a synthetic loopback MCP server", async () => {
    const app = Fastify({ logger: false });
    const calls: string[] = [];
    let oversized = false;
    app.post("/mcp", async (request, reply) => {
      const body = request.body as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string };
      };
      if (body.id === undefined) return reply.code(202).send();
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: body.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic-read-server", version: "1" },
            }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "get_incident_details_by_id",
                    inputSchema: schema,
                    annotations: { readOnlyHint: true, destructiveHint: false },
                  },
                  {
                    name: "update_incident",
                    inputSchema: schema,
                    annotations: { readOnlyHint: true },
                  },
                ],
              }
            : {
                content: [],
                structuredContent: oversized
                  ? { ...empty, summary: "x".repeat(2_048) }
                  : empty,
              };
      if (body.method === "tools/call") calls.push(body.params?.name ?? "");
      return { jsonrpc: "2.0", id: body.id, result };
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const raw = catalog();
      raw.mcpServers.approved.url = `${address}/mcp`;
      const result = await new DriMcpCatalog({ catalog: raw }).discover(
        AbortSignal.timeout(4_000),
      );
      expect(result.providers).toHaveLength(1);
      expect(
        (
          await result.providers[0]!.read({
            ...context(),
            signal: AbortSignal.timeout(4_000),
          })
        ).state,
      ).toBe("no_results");
      expect(calls).toEqual(["get_incident_details_by_id"]);
      oversized = true;
      const bounded = context();
      bounded.query.bounds.maxBytes = 1_024;
      await expect(result.providers[0]!.read(bounded)).rejects.toMatchObject({
        statusCode: 413,
      });
    } finally {
      await app.close();
    }
  }, 15_000);
});
