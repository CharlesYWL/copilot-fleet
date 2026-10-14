import { createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import {
  HostMcpSelectionSchema,
  type HostMcpSelection,
  type HostMcpSettings,
} from "@fleet/protocol";
import type { FleetAuth } from "../auth/service.js";
import {
  HostMcpConfigSchema,
  readHostMcpConfig,
  type HostMcpConfig,
  type HostMcpRelay,
  type HostMcpServerConfig,
} from "../host-mcp.js";
import {
  CopilotHostMcpClient,
  hostMcpSourceDigest,
  hostMcpUnavailable,
  listConfiguredHostMcps,
  type ConfiguredHostMcp,
} from "../host-mcp-client.js";
import { requireNodeOperator } from "./require-administrator.js";
import { savePrivateJson } from "../private-config.js";

export const hostMcpRevision = (config: HostMcpConfig): string =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");

export async function saveHostMcpConfig(
  path: string,
  config: HostMcpConfig,
): Promise<void> {
  await savePrivateJson(path, config);
}

class SettingsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

async function inspect(config: HostMcpServerConfig) {
  const client = new CopilotHostMcpClient(config);
  try {
    return await client.inspect();
  } finally {
    await client.close();
  }
}

export class HostMcpSettingsService {
  private saving = false;
  private catalogPromise: ReturnType<typeof listConfiguredHostMcps> | undefined;
  private catalogUntil = 0;

  constructor(
    private readonly relay: HostMcpRelay,
    private readonly path: string | undefined,
    private readonly log: FastifyBaseLogger,
    private readonly dependencies = {
      catalog: listConfiguredHostMcps,
      inspect,
      save: saveHostMcpConfig,
    },
  ) {}

  private catalog() {
    if (!this.catalogPromise || Date.now() >= this.catalogUntil) {
      this.catalogUntil = Date.now() + 15_000;
      this.catalogPromise = this.dependencies.catalog().catch((error: unknown) => {
        this.catalogPromise = undefined;
        this.log.warn("Could not read Host MCP catalog");
        throw new SettingsError(
          503,
          "Could not read Host MCPs. Check Copilot on the Host and refresh.",
          { cause: error },
        );
      });
    }
    return this.catalogPromise;
  }

  async view(): Promise<HostMcpSettings> {
    let catalog: Record<string, ConfiguredHostMcp> = {};
    let catalogError: string | undefined;
    try {
      catalog = await this.catalog();
    } catch {
      catalogError =
        "Could not read available Host MCPs. Existing forwarding can still be turned off. Check Copilot on the Host and refresh.";
    }
    const names = [
      ...new Set([
        ...Object.keys(catalog),
        ...this.relay.config.servers.map((server) => server.name),
      ]),
    ].sort((a, b) => a.localeCompare(b));
    return {
      revision: hostMcpRevision(this.relay.config),
      suspended: this.relay.isSuspended,
      ...(catalogError ? { catalogError } : {}),
      servers: names.map((name) => {
        const source = catalog[name];
        const selected = this.relay.config.servers.find((server) => server.name === name);
        const unavailable = source
          ? hostMcpUnavailable(name, source)
          : selected?.url
            ? undefined
            : "No longer configured in Copilot on the Host.";
        return {
          name,
          transport:
            source && "command" in source
              ? "stdio"
              : source?.type === "sse"
                ? "sse"
                : "http",
          ...(source ? { sourceDigest: hostMcpSourceDigest(source) } : {}),
          enabled: Boolean(selected && selected.enabled !== false),
          allNodes: selected?.allNodes ?? false,
          toolCount: selected?.tools.length ?? 0,
          readOnly: selected?.readOnly ?? false,
          ...(unavailable ? { unavailable } : {}),
        };
      }),
    };
  }

  async update(input: HostMcpSelection): Promise<HostMcpSettings> {
    if (!this.path)
      throw new SettingsError(
        503,
        "Persistent Host storage is required to change MCP forwarding.",
      );
    if (this.saving)
      throw new SettingsError(
        409,
        "Another MCP setting is being saved. Refresh and try again.",
      );
    this.saving = true;
    const suspended = this.relay.isSuspended;
    try {
      const current = this.relay.config;
      const revision = hostMcpRevision(current);
      if (input.expectedRevision !== revision)
        throw new SettingsError(409, "Host MCP settings changed. Refresh before saving.");
      const selected = current.servers.find((server) => server.name === input.name);
      if (!input.enabled && (!selected || selected.enabled === false)) return this.view();
      let next: HostMcpServerConfig | undefined = selected
        ? { ...selected, enabled: false, generation: randomUUID() }
        : undefined;
      if (input.enabled) {
        if (suspended)
          throw new SettingsError(
            409,
            "Forwarding is suspended after a restore. Review the local MCP configuration and restart the Host before sharing again.",
          );
        const catalog = await this.dependencies.catalog();
        const source = catalog[input.name];
        if (source && hostMcpUnavailable(input.name, source))
          throw new SettingsError(400, "This Host MCP cannot be forwarded.");
        if (source && input.sourceDigest !== hostMcpSourceDigest(source))
          throw new SettingsError(
            409,
            "The Host MCP configuration changed. Refresh before enabling it.",
          );
        if (!source && !selected?.url)
          throw new SettingsError(404, "This MCP is no longer configured on the Host.");
        const sourceChanged =
          selected?.source === "host" && selected.sourceDigest !== input.sourceDigest;
        if (sourceChanged && selected.enabled !== false)
          throw new SettingsError(
            409,
            "Turn this MCP off, then enable it again to use its changed Host configuration.",
          );
        const retained = sourceChanged ? undefined : selected;
        next = {
          ...(retained ?? {
            name: input.name,
            source: "host" as const,
            sourceDigest: hostMcpSourceDigest(source!),
            tools: [],
            resources: [],
            readOnly: false,
          }),
          allNodes: true,
          enabled: true,
          nodeIds: [],
          sessionIds: [],
          generation: randomUUID(),
        };
        try {
          const observed = await this.dependencies.inspect(next);
          if (!retained) {
            next.tools = observed.tools.map((tool) => tool.name);
            next.resources = observed.resources;
          }
        } catch (error) {
          this.log.warn({ server: input.name }, "Host MCP connection check failed");
          // Do not expose stdio arguments, headers, OAuth URLs or upstream secrets.
          const auth = error instanceof Error && /authenticat|oauth/i.test(error.message);
          throw new SettingsError(
            502,
            auth
              ? `Authenticate ${input.name} in Copilot on the Host, then try sharing it again.`
              : `Could not connect to ${input.name} on the Host. Check that MCP in Copilot; forwarding was not changed.`,
            { cause: error },
          );
        }
      }
      const config = HostMcpConfigSchema.parse({
        servers: [
          ...current.servers.filter((server) => server.name !== input.name),
          ...(next ? [next] : []),
        ],
      });
      // A restore or local edit must not be overwritten while discovery is in flight.
      if (
        this.relay.isSuspended !== suspended ||
        hostMcpRevision(this.relay.config) !== revision ||
        hostMcpRevision(await readHostMcpConfig(this.path)) !== revision
      )
        throw new SettingsError(
          409,
          "Host MCP configuration changed during this request. Refresh before saving.",
        );
      await this.dependencies.save(this.path, config);
      if (this.relay.isSuspended !== suspended)
        throw new SettingsError(
          409,
          "The Host was restored while saving. Forwarding remains suspended; review the saved configuration before restarting.",
        );
      try {
        await this.relay.replaceConfig(config);
      } catch {
        this.log.error("Host MCP settings saved but an old MCP process could not close");
        throw new SettingsError(
          503,
          "Settings were saved and access was updated, but an old MCP process could not close. Refresh to see the saved state.",
        );
      }
      this.catalogPromise = undefined;
      return this.view();
    } finally {
      this.saving = false;
    }
  }
}

export const hostMcpSettingsRoutes: FastifyPluginAsync<{
  auth: FleetAuth;
  settings: HostMcpSettingsService;
}> = async (app, { auth, settings }) => {
  app.get("/api/host-mcp/settings", async (request, reply) => {
    if (!requireNodeOperator(auth, request, reply, false)) return reply;
    return settings.view();
  });
  app.put("/api/host-mcp/settings", async (request, reply) => {
    const input = HostMcpSelectionSchema.parse(request.body);
    const actor = requireNodeOperator(auth, request, reply, input.enabled);
    if (!actor) return reply;
    const result = await settings.update(input);
    auth.audit({
      eventType: "host_mcp_forwarding_changed",
      ...actor,
      outcome: "success",
      targetId: input.name,
      detail: input.enabled ? "Shared with all enrolled nodes" : "Forwarding disabled",
    });
    return result;
  });
};
