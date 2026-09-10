import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  DriCapabilitySchema,
  DriKey,
  DriProviderDefinitionSchema,
  McpHttpServerSchema,
  type DriCapability,
  type DriCapabilityReadiness,
} from "@fleet/protocol";
import { SdkMcpReadClient } from "./adapters.js";
import {
  assertReadOnlyTool,
  assertProviderPageCapability,
  ProviderPageSchema,
  READ_ONLY_TOOLS,
  telemetryPlan,
  type DiscoveredMcpClient,
  type DiscoveredReadTool,
  type InvestigationProvider,
  type ProviderContext,
  type ProviderPage,
} from "./providers.js";
import { contentHash, DriError, stableId } from "./safety.js";

const MAX_CATALOG_BYTES = 262_144;
const MAX_DISCOVERY_BYTES = 1_048_576;
const selectors = z.enum([
  "scope",
  "incidentId",
  "artifactRef",
  "timeRange",
  "queryPlan",
  "profileId",
  "cursor",
  "maxRows",
  "maxBytes",
  "timeoutMs",
]);
const BindingSchema = z
  .object({
    capability: DriCapabilitySchema,
    tool: DriKey,
    arguments: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), selectors)
      .refine((value) => Object.keys(value).length <= 12, "Too many mapped arguments"),
    response: z.literal("provider-page-v1"),
  })
  .strict();
export const DriMcpManifestSchema = z
  .object({
    version: z.literal(1),
    bindings: z.array(BindingSchema).min(1).max(20),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const binding of manifest.bindings) {
      const key = `${binding.capability}:${binding.tool}`;
      if (seen.has(key) || !READ_ONLY_TOOLS[binding.capability].includes(binding.tool))
        context.addIssue({
          code: "custom",
          message: "Duplicate, unknown or non-read-only binding",
        });
      seen.add(key);
      const values = Object.values(binding.arguments);
      if (!values.includes("scope") && !values.includes("incidentId"))
        context.addIssue({ code: "custom", message: "An incident scope is required" });
      if (
        binding.capability === "telemetry.query" &&
        !values.includes("scope") &&
        !values.includes("queryPlan")
      )
        context.addIssue({
          code: "custom",
          message: "Telemetry requires a trusted bounded query plan",
        });
    }
  });
type Binding = z.infer<typeof BindingSchema>;
const CatalogEntrySchema = z
  .object({
    type: z.literal("http"),
    url: z.string().max(2_048),
    headers: z.record(z.string().max(120), z.string().max(8_192)).default({}),
    disabled: z.boolean().optional(),
    _meta: z.object({ "fleet/dri": DriMcpManifestSchema }).passthrough(),
  })
  .passthrough();
export type DriMcpServer = {
  name: string;
  url: string;
  headers: Record<string, string>;
  manifest: z.infer<typeof DriMcpManifestSchema>;
};
type Issue = Pick<DriCapabilityReadiness, "state" | "reason">;
export type DriProviderDiscovery = {
  providers: InvestigationProvider[];
  issues: Partial<Record<DriCapability, Issue>>;
};
type Catalog = { servers: DriMcpServer[]; issue?: Issue };
export type DriMcpOptions = {
  /** Test/embedding injection; an empty catalog avoids reading any operator configuration. */
  catalog?: unknown;
  configPath?: string;
  connect?: <T>(
    server: DriMcpServer,
    maxBytes: number,
    signal: AbortSignal,
    work: (client: DiscoveredMcpClient) => Promise<T>,
  ) => Promise<T>;
};

function secureEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export function parseDriMcpCatalog(raw: unknown): Catalog {
  const parsed = z
    .object({
      mcpServers: z
        .record(z.string().min(1).max(160), z.unknown())
        .refine((value) => Object.keys(value).length <= 20),
    })
    .safeParse(raw);
  const incompatible: Issue = {
    state: "incompatible",
    reason:
      "MCP catalog or fleet/dri manifest is invalid. Only approved HTTP read-only bindings are supported.",
  };
  if (!parsed.success) return { servers: [], issue: incompatible };
  const servers: DriMcpServer[] = [];
  let issue: Issue | undefined;
  for (const [name, value] of Object.entries(parsed.data.mcpServers)) {
    if (
      value &&
      typeof value === "object" &&
      "disabled" in value &&
      value.disabled === true
    )
      continue;
    const entry = CatalogEntrySchema.safeParse(value);
    if (!entry.success || !secureEndpoint(entry.data.url)) {
      issue = incompatible;
      continue;
    }
    const native = McpHttpServerSchema.safeParse({
      type: "http",
      name,
      url: entry.data.url,
      headers: Object.entries(entry.data.headers).map(([name, value]) => ({
        name,
        value,
      })),
    });
    if (
      !native.success ||
      Object.keys(entry.data.headers).length > 20 ||
      Object.entries(entry.data.headers).some(
        ([key, value]) =>
          /[\r\n]/.test(key + value) ||
          ["host", "cookie", "content-length"].includes(key.toLowerCase()),
      )
    ) {
      issue = incompatible;
      continue;
    }
    servers.push({
      name,
      url: native.data.url,
      headers: entry.data.headers,
      manifest: entry.data._meta["fleet/dri"],
    });
  }
  return { servers, ...(issue ? { issue } : {}) };
}

async function loadCatalog(path: string): Promise<Catalog> {
  let file;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES)
      return {
        servers: [],
        issue: {
          state: "incompatible",
          reason: "MCP catalog must be a file of at most 256 KiB.",
        },
      };
    const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CATALOG_BYTES)
      return {
        servers: [],
        issue: { state: "incompatible", reason: "MCP catalog exceeds its byte budget." },
      };
    return parseDriMcpCatalog(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } catch (error) {
    return {
      servers: [],
      issue: {
        state: error instanceof SyntaxError ? "incompatible" : "unavailable",
        reason:
          error instanceof SyntaxError
            ? "MCP catalog JSON is invalid."
            : "Host MCP catalog is missing or unreadable. Configure the Host account's MCP catalog.",
      },
    };
  } finally {
    await file?.close();
  }
}

/** Bounds SDK JSON and SSE responses before parsing; redirects cannot forward credentials. */
async function connect<T>(
  server: DriMcpServer,
  maxBytes: number,
  signal: AbortSignal,
  work: (client: DiscoveredMcpClient) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "fleet-dri-readonly", version: "1.0.0" });
  let streamFailure: DriError | undefined;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers, redirect: "error" },
    fetch: async (input, init) => {
      const response = await fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      });
      if (!response.body) return response;
      const reader = response.body.getReader();
      let bytes = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                return;
              }
              bytes += chunk.value.byteLength;
              if (bytes > maxBytes) {
                await reader.cancel();
                streamFailure = new DriError("MCP response exceeded byte budget", 413);
                controller.error(streamFailure);
              } else controller.enqueue(chunk.value);
            } catch {
              controller.error(new DriError("MCP response interrupted", 502));
            }
          },
          async cancel() {
            await reader.cancel();
          },
        }),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    },
  });
  // The SDK HTTP transport widens optional sessionId; bridge it without weakening exact optional types.
  const bridge: Transport = {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: () => transport.close(),
  };
  transport.onmessage = (message) => bridge.onmessage?.(message);
  transport.onerror = (error) => bridge.onerror?.(error);
  transport.onclose = () => bridge.onclose?.();
  try {
    await client.connect(bridge, { signal, timeout: 15_000 });
    return await work(new SdkMcpReadClient(client));
  } catch (error) {
    throw streamFailure ?? error;
  } finally {
    await client.close();
  }
}

const selectorTypes: Record<z.infer<typeof selectors>, string> = {
  scope: "object",
  incidentId: "string",
  artifactRef: "string",
  timeRange: "object",
  queryPlan: "object",
  profileId: "string",
  cursor: "string",
  maxRows: "integer",
  maxBytes: "integer",
  timeoutMs: "integer",
};
function compatible(tool: DiscoveredReadTool | undefined, binding: Binding): boolean {
  if (!tool?.readOnly || !tool.inputSchema) return false;
  const schema = z
    .object({
      type: z.literal("object"),
      properties: z.record(z.string(), z.object({ type: z.string() }).passthrough()),
      required: z.array(z.string()).default([]),
    })
    .safeParse(tool.inputSchema);
  return (
    schema.success &&
    schema.data.required.every((key) => Object.hasOwn(binding.arguments, key)) &&
    Object.entries(binding.arguments).every(([key, selector]) => {
      const type = schema.data.properties[key]?.type;
      return (
        type === selectorTypes[selector] ||
        (type === "number" && selectorTypes[selector] === "integer")
      );
    })
  );
}
function argumentsFor(
  binding: Binding,
  context: ProviderContext,
): Record<string, unknown> {
  const scope = {
    incidentId: context.investigation.incident.id,
    profileId: context.profile.id,
    timeRange: context.query.timeRange,
    maxRows: context.query.bounds.maxRows,
    maxBytes: context.query.bounds.maxBytes,
    timeoutMs: context.query.bounds.timeoutMs,
    ...(context.investigation.artifactRef
      ? { artifactRef: context.investigation.artifactRef }
      : {}),
    ...(context.cursor ? { cursor: context.cursor } : {}),
    ...(binding.capability === "telemetry.query"
      ? { queryPlan: telemetryPlan(context.profile, context.query) }
      : {}),
  };
  const values: Record<string, unknown> = { ...scope, scope };
  return Object.fromEntries(
    Object.entries(binding.arguments)
      .filter(([, selector]) => values[selector] !== undefined)
      .map(([key, selector]) => [key, values[selector]]),
  );
}
function normalize(raw: unknown, capability: DriCapability): ProviderPage {
  const envelope = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }).strict())
        .max(1)
        .optional(),
    })
    .passthrough()
    .parse(raw);
  if (envelope.isError)
    return ProviderPageSchema.parse({
      state: "failed",
      summary: "The approved MCP read failed; no result was accepted.",
    });
  const data =
    envelope.structuredContent ??
    (envelope.content?.[0] ? JSON.parse(envelope.content[0].text) : undefined);
  const page = ProviderPageSchema.parse(data);
  assertProviderPageCapability(capability, page);
  return page;
}

/** Catalog metadata grants the scope; discovered annotations never grant it by themselves. */
export class DriMcpCatalog {
  constructor(private readonly options: DriMcpOptions = {}) {}
  private load(): Promise<Catalog> {
    return this.options.catalog === undefined
      ? loadCatalog(
          this.options.configPath ?? join(homedir(), ".copilot", "mcp-config.json"),
        )
      : Promise.resolve(parseDriMcpCatalog(this.options.catalog));
  }
  async discover(signal: AbortSignal): Promise<DriProviderDiscovery> {
    const catalog = await this.load();
    const issues: DriProviderDiscovery["issues"] = Object.fromEntries(
      DriCapabilitySchema.options.map((capability) => [
        capability,
        catalog.issue ?? {
          state: "unavailable",
          reason: `No operator-approved MCP binding for ${capability}.`,
        },
      ]),
    );
    const sources = new Map<
      DriCapability,
      { server: DriMcpServer; binding: Binding }[]
    >();
    const rejected = new Set<DriCapability>();
    for (const server of catalog.servers) {
      if (signal.aborted) {
        for (const binding of server.manifest.bindings) {
          rejected.add(binding.capability);
          issues[binding.capability] = {
            state: "unavailable",
            reason:
              "Discovery was interrupted before all declared sources were authorized. Resume to rediscover.",
          };
        }
        continue;
      }
      try {
        const tools = await (this.options.connect ?? connect)(
          server,
          MAX_DISCOVERY_BYTES,
          signal,
          (client) => client.discover(signal),
        );
        for (const binding of server.manifest.bindings) {
          if (
            !compatible(
              tools.find((tool) => tool.name === binding.tool),
              binding,
            )
          ) {
            rejected.add(binding.capability);
            issues[binding.capability] = {
              state: "incompatible",
              reason:
                "Approved tool missing, not annotated read-only, destructive, or incompatible with its argument manifest.",
            };
            continue;
          }
          sources.set(binding.capability, [
            ...(sources.get(binding.capability) ?? []),
            { server, binding },
          ]);
        }
      } catch {
        for (const binding of server.manifest.bindings) {
          rejected.add(binding.capability);
          issues[binding.capability] = {
            state: "unavailable",
            reason:
              "MCP discovery failed or access was denied. Check the configured transport and read-only credentials.",
          };
        }
      }
    }
    const providers: InvestigationProvider[] = [];
    for (const [capability, entries] of sources) {
      if (rejected.has(capability)) continue;
      const definition = DriProviderDefinitionSchema.parse({
        id: stableId(
          `mcp.${capability}`,
          entries.map(({ server, binding }) => [server.name, binding]),
        ),
        version: "1.0.0",
        readOnly: true,
        capabilities: [capability],
        tools: [...new Set(entries.map(({ binding }) => binding.tool))],
        readiness: "ready",
      });
      delete issues[capability];
      providers.push({
        definition,
        read: async (context) => {
          if (context.signal.aborted) throw new DriError("MCP read interrupted", 408);
          if (context.query.capability !== capability)
            throw new DriError("MCP capability scope mismatch", 403);
          const cursor = context.cursor
            ? z
                .object({
                  source: z
                    .number()
                    .int()
                    .min(0)
                    .max(entries.length - 1),
                  cursor: z.string().max(160).optional(),
                })
                .strict()
                .parse(JSON.parse(context.cursor))
            : { source: 0, cursor: undefined };
          const entry = entries[cursor.source]!;
          const current = await this.load();
          if (context.signal.aborted) throw new DriError("MCP read interrupted", 408);
          const authorized = entries.every(({ server, binding }) =>
            current.servers.some(
              (candidate) =>
                contentHash(candidate) === contentHash(server) &&
                candidate.manifest.bindings.some(
                  (candidateBinding) =>
                    contentHash(candidateBinding) === contentHash(binding),
                ),
            ),
          );
          if (!authorized)
            return ProviderPageSchema.parse({
              state: "access_denied",
              summary:
                "MCP catalog authorization changed. Resume to rediscover approved providers.",
            });
          assertReadOnlyTool(capability, entry.binding.tool);
          return (this.options.connect ?? connect)(
            entry.server,
            context.query.bounds.maxBytes,
            context.signal,
            async (client) => {
              const tools = await client.discover(context.signal);
              if (context.signal.aborted) throw new DriError("MCP read interrupted", 408);
              if (
                !compatible(
                  tools.find((tool) => tool.name === entry.binding.tool),
                  entry.binding,
                )
              )
                return ProviderPageSchema.parse({
                  state: "unavailable",
                  summary:
                    "MCP read-only annotation or schema changed; execution refused.",
                });
              const raw = await client.call(
                entry.binding.tool,
                argumentsFor(entry.binding, { ...context, cursor: cursor.cursor }),
                context.signal,
              );
              if (
                Buffer.byteLength(JSON.stringify(raw) ?? "") >
                context.query.bounds.maxBytes
              )
                throw new DriError("MCP result exceeded byte budget", 413);
              const page = normalize(raw, capability);
              if (
                page.nextCursor &&
                !Object.values(entry.binding.arguments).some(
                  (value) => value === "cursor" || value === "scope",
                )
              )
                throw new DriError(
                  "MCP pagination is not declared by its argument manifest",
                  422,
                );
              const next = page.nextCursor
                ? {
                    source: cursor.source,
                    cursor: z.string().max(160).parse(page.nextCursor),
                  }
                : cursor.source + 1 < entries.length
                  ? { source: cursor.source + 1 }
                  : undefined;
              return ProviderPageSchema.parse({
                ...page,
                // Continue successful empty sources without claiming global absence.
                state: page.state === "no_results" && next ? "succeeded" : page.state,
                nextCursor: next ? JSON.stringify(next) : undefined,
              });
            },
          );
        },
      });
    }
    return { providers, issues };
  }
}
