import { z } from "zod";
import { createHash } from "node:crypto";
import {
  CopilotClient,
  ToolSet,
  type CopilotSession,
  type CurrentToolMetadata,
  type MCPServerConfig,
} from "@github/copilot-sdk";
import {
  CallToolResultSchema,
  ReadResourceResultSchema,
  ToolSchema,
  type CallToolResult,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { HostMcpServerConfig } from "./host-mcp.js";

export type ConfiguredHostMcp = Awaited<
  ReturnType<CopilotClient["rpc"]["mcp"]["config"]["list"]>
>["servers"][string];

export const hostMcpSourceDigest = (config: ConfiguredHostMcp): string =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");

const SOURCE_CHANGED =
  "The Host MCP configuration changed. Turn forwarding off and on in Settings to review it again.";

/** Listing configuration does not connect to or execute any configured MCP. */
export async function listConfiguredHostMcps(): Promise<
  Record<string, ConfiguredHostMcp>
> {
  const client = new CopilotClient({ logLevel: "error" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      (async () => {
        await client.start();
        return (await client.rpc.mcp.config.list()).servers;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("Timed out reading Host MCP configuration"));
        }, 30_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) await client.forceStop();
    else await client.stop();
  }
}

export function hostMcpUnavailable(
  name: string,
  config: ConfiguredHostMcp,
): string | undefined {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(name) ||
    name === "fleet" ||
    name.startsWith("fleet-host-")
  )
    return "This server name is reserved or cannot be forwarded.";
  if ("url" in config) {
    try {
      const url = new URL(config.url);
      if (
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      )
        return undefined;
    } catch {
      return "The Host MCP endpoint is not a valid URL.";
    }
    return "HTTP MCPs require HTTPS or a loopback endpoint.";
  }
  return config.command.trim() ? undefined : "The Host MCP command is missing.";
}

function sdkConfig(config: ConfiguredHostMcp, tools: string[]): MCPServerConfig {
  const strings = (values: Record<string, string | undefined> = {}) =>
    Object.fromEntries(
      Object.entries(values).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  return "command" in config
    ? {
        ...config,
        env: strings(config.env),
        tools,
        ...(config.cwd ? { workingDirectory: config.cwd } : {}),
      }
    : { ...config, type: config.type ?? "http", headers: strings(config.headers), tools };
}

export interface HostMcpClient {
  listTools(): Promise<Tool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    authorized: () => boolean,
  ): Promise<CallToolResult>;
  readResource(uri: string, authorized: () => boolean): Promise<ReadResourceResult>;
  close(): Promise<void>;
}

/** No model is prompted. The runtime owns OAuth storage and refresh on the Host. */
export class CopilotHostMcpClient implements HostMcpClient {
  private readonly client = new CopilotClient({
    logLevel: "error",
  });
  private ready: Promise<CopilotSession> | undefined;
  private metadata: CurrentToolMetadata[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;

  constructor(private readonly config: HostMcpServerConfig) {}

  private async connect(): Promise<CopilotSession> {
    await this.client.start();
    const configured = await this.client.rpc.mcp.config.list();
    const source =
      this.config.source === "host" ? configured.servers[this.config.name] : undefined;
    if (
      this.config.source === "host" &&
      (!source || hostMcpSourceDigest(source) !== this.config.sourceDigest)
    ) {
      throw new Error(SOURCE_CHANGED);
    }
    const discovery = this.config.tools.length === 0;
    const tools = discovery ? (source?.tools ?? ["*"]) : this.config.tools;
    const upstream: MCPServerConfig = source
      ? sdkConfig(source, tools)
      : { type: "http", url: z.string().url().parse(this.config.url), tools };
    const session = await this.client.createSession({
      availableTools: discovery
        ? new ToolSet().addMcp("*")
        : this.config.tools.reduce(
            (set, name) => set.addMcp(`${this.config.name}-${name}`),
            new ToolSet(),
          ),
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      enableSkills: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      memory: { enabled: false },
      disabledMcpServers: [
        ...Object.keys(configured.servers).filter((name) => name !== this.config.name),
        "github-mcp-server",
        "githubiq",
      ],
      mcpServers: {
        [this.config.name]: upstream,
      },
      onPermissionRequest: (request) => ({
        kind:
          request.kind === "mcp" &&
          request.serverName === this.config.name &&
          this.config.tools.includes(request.toolName)
            ? "approved"
            : "denied-interactively-by-user",
      }),
    });
    try {
      await session.rpc.mcp.startServer({ serverName: this.config.name });
    } catch (error) {
      if (
        !("url" in upstream) ||
        !(error instanceof Error) ||
        !/requires authentication/i.test(error.message)
      )
        throw error;
      // ACP/headless startup can leave cached OAuth inactive. The SDK activates
      // it without copying tokens or prompting a model; no forced reauthentication.
      const login = await session.rpc.mcp.oauth.login({ serverName: this.config.name });
      if (login.authorizationUrl)
        throw new Error(
          `Authenticate ${this.config.name} in Copilot on the Host with /mcp auth ${this.config.name}, then retry`,
          { cause: error },
        );
    }
    await session.rpc.mcp.listTools({ serverName: this.config.name });
    await session.rpc.tools.initializeAndValidate();
    this.metadata = (await session.rpc.tools.getCurrentMetadata()).tools ?? [];
    const missing = this.config.tools.filter(
      (name) =>
        !this.metadata.some(
          (tool) => tool.mcpServerName === this.config.name && tool.mcpToolName === name,
        ),
    );
    if (missing.length)
      throw new Error(`Configured Host MCP tools are unavailable: ${missing.join(", ")}`);
    if (this.closed) {
      await this.client.stop();
      throw new Error("Host MCP client was closed during startup");
    }
    return session;
  }

  private run<T>(action: (session: CopilotSession) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Host MCP client is closed"));
    if (this.pending >= 8)
      return Promise.reject(new Error("Host MCP is busy; retry when a call finishes"));
    this.pending++;
    const operation = this.tail.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let active = true;
      let timedOut = false;
      try {
        if (this.closed) throw new Error("Host MCP client is closed");
        this.ready ??= this.connect();
        return await Promise.race([
          this.ready.then((session) => {
            if (!active || this.closed)
              throw new Error("Host MCP request is no longer active");
            return action(session);
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              active = false;
              timedOut = true;
              reject(new Error("Host MCP request timed out; the call was not retried"));
            }, 120_000);
            timer.unref();
          }),
        ]);
      } catch (error) {
        active = false;
        // Do not replay a tool call: the upstream may already have performed it.
        if (timedOut) await this.client.forceStop();
        else await this.client.stop();
        this.ready = undefined;
        if (this.config.source === "host" && error instanceof Error) {
          // Stdio errors can contain command arguments or environment values.
          const reason = /requires authentication|authenticate|oauth/i.test(error.message)
            ? `Authenticate ${this.config.name} in Copilot on the Host, then retry.`
            : error.message === SOURCE_CHANGED
              ? SOURCE_CHANGED
              : `Host MCP ${this.config.name} could not complete the request. Check that server in Copilot on the Host.`;
          throw new Error(reason, { cause: error });
        }
        throw error;
      } finally {
        active = false;
        if (timer) clearTimeout(timer);
        this.pending--;
      }
    });
    // Keep the queue usable after an error; the caller still receives the rejection.
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  listTools(): Promise<Tool[]> {
    return this.run(async () =>
      this.metadata
        .filter(
          (tool) =>
            tool.mcpServerName === this.config.name &&
            tool.mcpToolName !== undefined &&
            (this.config.tools.length === 0 ||
              this.config.tools.includes(tool.mcpToolName)),
        )
        .map((tool) =>
          ToolSchema.parse({
            name: tool.mcpToolName,
            description: `Host-authenticated ${this.config.name} through Fleet. ${tool.description}`,
            inputSchema: tool.input_schema,
            ...(this.config.readOnly ? { annotations: { readOnlyHint: true } } : {}),
          }),
        ),
    );
  }

  /** Snapshot the selected server's tools before granting remote access. */
  async inspect(): Promise<{ tools: Tool[]; resources: string[] }> {
    const tools = await this.listTools();
    if (this.config.tools.length) return { tools, resources: this.config.resources };
    const resources = await this.run(async (session) => {
      const uris: string[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        let page;
        try {
          page = await session.rpc.mcp.resources.list({
            serverName: this.config.name,
            ...(cursor ? { cursor } : {}),
          });
        } catch (error) {
          if (
            error instanceof Error &&
            /method not found|does not support resources|resources.*not supported/i.test(
              error.message,
            )
          )
            return [];
          throw error;
        }
        uris.push(...page.resources.map((resource) => resource.uri));
        if (uris.length > 20)
          throw new Error("This MCP advertises too many resources for Host forwarding.");
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw new Error("MCP resource pagination repeated a cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return uris;
    });
    return { tools, resources };
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    authorized: () => boolean,
  ): Promise<CallToolResult> {
    if (!this.config.tools.includes(name))
      return Promise.reject(new Error("This tool is not enabled by the Host"));
    return this.run(async (session) => {
      if (!authorized())
        throw new Error("The session's Host MCP grant has been withdrawn");
      const tool = this.metadata.find(
        (item) => item.mcpServerName === this.config.name && item.mcpToolName === name,
      );
      if (!tool) throw new Error("The upstream MCP server does not offer this tool");
      const result = await session.rpc.tools.execute({
        name: tool.name,
        arguments: z.json().parse(args),
      });
      if (typeof result === "string")
        return { content: [{ type: "text", text: result }] };
      return CallToolResultSchema.parse({
        content: result.contents?.length
          ? result.contents
          : [
              { type: "text", text: result.textResultForLlm ?? result.error ?? "" },
              ...(result.binaryResultsForLlm ?? []),
            ],
        isError: result.resultType !== "success",
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.mcpMeta ? { _meta: result.mcpMeta } : {}),
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.stop();
    await this.tail;
  }

  readResource(uri: string, authorized: () => boolean): Promise<ReadResourceResult> {
    if (!this.config.resources.includes(uri))
      return Promise.reject(new Error("This resource is not enabled by the Host"));
    return this.run(async (session) => {
      if (!authorized())
        throw new Error("The session's Host MCP grant has been withdrawn");
      return ReadResourceResultSchema.parse(
        await session.rpc.mcp.resources.read({ serverName: this.config.name, uri }),
      );
    });
  }
}
