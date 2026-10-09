import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  errorMessage,
  terminalRunStates,
  terminalSessionStates,
  type FleetSession,
  type McpHttpServer,
} from "@fleet/protocol";
import type { FleetService } from "./fleet-service.js";
import { LeadTokens } from "./orchestrator/lead-tokens.js";
import { CopilotHostMcpClient, type HostMcpClient } from "./host-mcp-client.js";

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const HostMcpServerConfigSchema = z
  .object({
    name: name.refine((value) => value !== "fleet", "fleet is a reserved MCP name"),
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, "Upstream MCP URLs must use HTTPS without credentials, query, or fragment")
      .optional(),
    source: z.literal("host").optional(),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    generation: z.string().uuid().optional(),
    tools: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/))
      .min(1)
      .max(1000),
    readOnly: z.boolean().default(false),
    resources: z.array(z.string().url().max(2048)).max(20).default([]),
    nodeIds: z.array(z.string().uuid()).max(100).default([]),
    sessionIds: z.array(z.string().uuid()).max(100).default([]),
    allNodes: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (server) =>
      server.source === "host"
        ? Boolean(server.sourceDigest) && !server.url
        : Boolean(server.url) && !server.sourceDigest,
    "Use a pinned Host configuration or an explicit HTTPS URL",
  )
  .refine(
    (server) => !server.resources.length || !server.tools.includes("read_resource"),
    "read_resource is reserved when Host MCP resources are enabled",
  )
  .refine(
    (server) => server.allNodes || server.nodeIds.length + server.sessionIds.length > 0,
    "Choose all nodes or explicitly allow at least one Node or session",
  );

export const HostMcpConfigSchema = z
  .object({ servers: z.array(HostMcpServerConfigSchema).max(100) })
  .strict()
  .refine(
    ({ servers }) =>
      new Set(servers.map((server) => server.name)).size === servers.length,
    "MCP server names must be unique",
  );
export type HostMcpServerConfig = z.infer<typeof HostMcpServerConfigSchema>;
export type HostMcpConfig = z.infer<typeof HostMcpConfigSchema>;

/** A local console configuration, not portable data and never supplied by a Node. */
export async function readHostMcpConfig(path: string): Promise<HostMcpConfig> {
  try {
    return HostMcpConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { servers: [] };
    throw new Error(`Invalid Host MCP configuration at ${path}`, { cause: error });
  }
}

type Subject = Pick<FleetSession, "id" | "runId" | "nodeId">;
export const HOST_MCP_PATH = "/mcp/host";
export const HOST_MCP_TOKEN_KEY = "hostMcp.tokenKey";

export class HostMcpRelay {
  private readonly tokens: LeadTokens;
  private readonly clients = new Map<string, HostMcpClient>();
  private suspended = false;

  constructor(
    private readonly service: FleetService,
    public config: HostMcpConfig,
    private readonly baseUrl: () => string,
    private readonly createClient: (config: HostMcpServerConfig) => HostMcpClient = (
      config,
    ) => new CopilotHostMcpClient(config),
  ) {
    this.tokens = new LeadTokens({
      getSetting: () => service.store.getSetting(HOST_MCP_TOKEN_KEY),
      setSetting: (_key, value) => service.store.setSetting(HOST_MCP_TOKEN_KEY, value),
    });
  }

  private allowed(config: HostMcpServerConfig, session: Subject): boolean {
    return (
      !this.suspended &&
      config.enabled !== false &&
      (!this.service.store.getSession(session.id)?.readOnly || config.readOnly) &&
      (config.allNodes ||
        config.sessionIds.includes(session.id) ||
        config.nodeIds.includes(session.nodeId))
    );
  }

  private binding(config: HostMcpServerConfig, session: Subject): string {
    return createHash("sha256")
      .update(JSON.stringify({ config, runId: session.runId }))
      .digest("hex");
  }

  serversFor(session: Subject): McpHttpServer[] {
    return this.config.servers
      .filter((config) => this.allowed(config, session))
      .map((config) => ({
        // Copilot's local MCP configuration wins over an ACP server of the same name.
        name: `fleet-host-${config.name}`,
        url: new URL(`${HOST_MCP_PATH}/${config.name}`, this.baseUrl()).toString(),
        headers: [
          {
            name: "Authorization",
            value: `Bearer ${this.tokens.mint({
              sessionId: session.id,
              nodeId: session.nodeId,
              runId: this.binding(config, session),
            })}`,
          },
        ],
      }));
  }

  authorize(serverName: string, token: string): HostMcpServerConfig | undefined {
    const config = this.config.servers.find((server) => server.name === serverName);
    const claims = this.tokens.resolve(token);
    if (!config || !claims) return undefined;
    const session = this.service.store.getSession(claims.sessionId);
    if (
      !session ||
      !this.allowed(config, session) ||
      session.nodeId !== claims.nodeId ||
      this.binding(config, session) !== claims.runId ||
      session.stopRequested ||
      session.cleanupRequested ||
      terminalSessionStates.has(session.state) ||
      !this.service.store.getNode(session.nodeId)?.online
    )
      return undefined;
    const run = session.runId ? this.service.store.getRun(session.runId) : undefined;
    if (
      run &&
      (terminalRunStates.has(run.state) ||
        run.state === "awaiting_human" ||
        run.state === "awaiting_approval")
    )
      return undefined;
    return config;
  }

  client(config: HostMcpServerConfig): HostMcpClient {
    let client = this.clients.get(config.name);
    if (!client) {
      client = this.createClient(config);
      this.clients.set(config.name, client);
    }
    return client;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  async replaceConfig(config: HostMcpConfig): Promise<void> {
    const retired: HostMcpClient[] = [];
    for (const [name, client] of this.clients) {
      if (
        JSON.stringify(this.config.servers.find((server) => server.name === name)) !==
        JSON.stringify(config.servers.find((server) => server.name === name))
      ) {
        retired.push(client);
        this.clients.delete(name);
      }
    }
    // Revoke admission synchronously, before waiting for old upstream processes.
    this.config = config;
    await Promise.all(retired.map((client) => client.close()));
  }

  async close(): Promise<void> {
    this.suspended = true;
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }
}

export const hostMcpRoutes: FastifyPluginAsync<{
  relay: HostMcpRelay;
}> = async (app, { relay }) => {
  app.get("/api/host-mcp", async () => ({
    servers: relay.config.servers.map(
      ({ name, tools, readOnly, resources, nodeIds, sessionIds, allNodes, enabled }) => ({
        name,
        tools,
        readOnly,
        resources,
        nodeIds,
        sessionIds,
        allNodes: allNodes ?? false,
        enabled: enabled !== false,
      }),
    ),
  }));
  app.post<{ Params: { name: string } }>(
    `${HOST_MCP_PATH}/:name`,
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      if (request.headers.origin !== undefined)
        return reply.code(403).send({ error: "Browser requests are not allowed" });
      const header = request.headers.authorization ?? "";
      const config = relay.authorize(
        request.params.name,
        header.startsWith("Bearer ") ? header.slice(7).trim() : "",
      );
      if (!config) {
        app.log.warn({ server: request.params.name }, "Host MCP authorization refused");
        return reply.code(401).send({ error: "No live Host MCP grant for this session" });
      }
      const server = new Server(
        { name: `fleet-host-${config.name}`, version: "1.0.0" },
        {
          capabilities: {
            tools: {},
            ...(config.resources.length ? { resources: {} } : {}),
          },
        },
      );
      const client = relay.client(config);
      const failure = (error: unknown) => {
        app.log.warn({ server: config.name }, "Host MCP upstream request failed");
        const reason = errorMessage(error, "Connection failed");
        const hint = /requires authentication|authenticate .+ on the host|oauth/i.test(
          reason,
        )
          ? " Authenticate this MCP on the Host, not on the worker."
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Host MCP ${config.name}: ${reason}${hint}`,
            },
          ],
          isError: true,
        };
      };
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          ...(await client.listTools()),
          ...(config.resources.length
            ? [
                {
                  name: "read_resource",
                  description:
                    "Read a Host-allowed MCP resource. Load required skill:// guidance here before calling design tools.",
                  inputSchema: {
                    type: "object" as const,
                    properties: { uri: { type: "string", enum: config.resources } },
                    required: ["uri"],
                    additionalProperties: false,
                  },
                  annotations: { readOnlyHint: true },
                },
              ]
            : []),
        ],
      }));
      const authorized = () =>
        Boolean(relay.authorize(request.params.name, header.slice(7).trim()));
      const readResource = async (uri: string) => {
        if (!config.resources.includes(uri))
          throw new Error("This resource is not enabled by the Host");
        return client.readResource(uri, authorized);
      };
      if (config.resources.length) {
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: config.resources.map((uri) => ({ uri, name: uri })),
        }));
        server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
          resourceTemplates: [],
        }));
        server.setRequestHandler(ReadResourceRequestSchema, ({ params }) =>
          readResource(params.uri),
        );
      }
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        // Recheck when executing, not only when accepting a potentially slow request.
        if (!authorized())
          return failure(new Error("The session's Host MCP grant has been withdrawn"));
        try {
          if (params.name === "read_resource" && config.resources.length) {
            const { uri } = z
              .object({ uri: z.string() })
              .strict()
              .parse(params.arguments);
            const result = await readResource(uri);
            return {
              content: result.contents.map((resource) => ({
                type: "resource" as const,
                resource,
              })),
            };
          }
          if (!config.tools.includes(params.name))
            return failure(new Error("This tool is not enabled by the Host"));
          return await client.callTool(params.name, params.arguments ?? {}, authorized);
        } catch (error) {
          return failure(error);
        }
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      reply.hijack();
      try {
        // The SDK's optional callbacks are not exactOptionalPropertyTypes-compatible.
        await server.connect(
          transport as unknown as Parameters<typeof server.connect>[0],
        );
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        app.log.error({ server: config.name }, "Host MCP transport failed");
        if (!reply.raw.headersSent)
          reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ error: "Host MCP transport failed" }));
      } finally {
        await server.close();
      }
    },
  );
};
