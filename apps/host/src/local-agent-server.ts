import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  LOCAL_AGENT_HEADER,
  LOCAL_AGENT_LIMITS,
  LocalAgentCreateTaskSchema,
  LocalAgentMessageSchema,
  errorMessage,
  type LocalAgentListenerStatus,
} from "@fleet/protocol";
import {
  clearLocalAgentMarker,
  localAgentMarkerPath,
  writeLocalAgentMarker,
} from "./local-agent-marker.js";
import {
  localAgentErrorResponse,
  type LocalAgentService,
} from "./local-agent-service.js";

const LOOPBACK = "127.0.0.1";
const PEERS = new Set([LOOPBACK, `::ffff:${LOOPBACK}`]);
const READ_CONCURRENCY = 16;
const DRAIN_MS = 5_000;
const RESPONSE_DEADLINE_MS = 30_000;

/**
 * Headers only a browser, a proxy or another Fleet protocol would send. Any
 * one of them means the request is not a local program speaking for itself.
 *
 * `Sec-Fetch-Mode` alone is not on the list: Node's own `fetch` sends
 * `sec-fetch-mode: cors` on every request, so refusing it would refuse every
 * Node-based agent and MCP client. A browser always adds `Sec-Fetch-Site` and
 * `Origin` as well, and those are refused.
 */
const REFUSED_HEADERS = new Set([
  "origin",
  "cookie",
  "authorization",
  "proxy-authorization",
  "forwarded",
  "via",
  "upgrade",
  "sec-fetch-site",
  "sec-fetch-dest",
  "sec-fetch-user",
  "x-csrf-token",
]);
const REFUSED_PREFIXES = ["x-forwarded-", "x-fleet-node-"];

type Refusal = { status: number; code: string; error: string };

const refusal = (status: number, code: string, error: string): Refusal => ({
  status,
  code,
  error,
});

/**
 * Whether a request may reach a route at all, decided from the socket and
 * headers alone — before a body is read, and the same way for every path.
 */
export function localAgentAdmission(
  request: {
    method: string;
    url: string;
    rawHeaders: string[];
    peer: string | undefined;
  },
  port: number,
): Refusal | undefined {
  if (!request.peer || !PEERS.has(request.peer))
    return refusal(
      403,
      "forbidden_transport",
      "Only a program on this machine may call this API.",
    );
  const names = new Map<string, string[]>();
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    const values = names.get(name) ?? [];
    values.push(request.rawHeaders[index + 1]!);
    names.set(name, values);
  }
  const host = names.get("host");
  if (host?.length !== 1 || host[0] !== `${LOOPBACK}:${port}`)
    return refusal(
      403,
      "forbidden_transport",
      `Address the API as http://${LOOPBACK}:${port}; the Host header must be exactly ${LOOPBACK}:${port}.`,
    );
  if (!request.url.startsWith("/") || request.url.startsWith("//"))
    return refusal(403, "forbidden_transport", "Use an origin-form request target.");
  for (const name of names.keys()) {
    if (
      REFUSED_HEADERS.has(name) ||
      REFUSED_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
      return refusal(
        403,
        "forbidden_transport",
        `The ${name} header is not accepted: browsers, proxies and credentials have no place on this API.`,
      );
  }
  const marker = names.get(LOCAL_AGENT_HEADER);
  if (marker?.length !== 1 || marker[0] !== "1")
    return refusal(
      403,
      "forbidden_transport",
      `Send the header "${LOCAL_AGENT_HEADER}: 1" on every request. It is not a secret.`,
    );
  if (request.method !== "GET" && request.method !== "POST")
    return refusal(405, "method_not_allowed", "Only GET and POST are supported.");
  if (request.method === "POST") {
    const type = names.get("content-type");
    const media = type?.length === 1 ? type[0]!.split(";")[0]!.trim().toLowerCase() : "";
    if (media !== "application/json")
      return refusal(415, "unsupported_media_type", "Send the body as application/json.");
  }
  return undefined;
}

function bounded(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === "EADDRINUSE") return "That port is already in use on 127.0.0.1.";
  if (code === "EACCES") return "This process may not listen on that port.";
  const message = errorMessage(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * The loopback listener for the local agent API: its own Fastify instance on
 * its own port, so nothing about the main Host's routes, guards, cookies or
 * tunnels can leak onto it, and nothing about it onto them.
 *
 * It is inert until `activate()` — called once the main Host is listening — so
 * an in-memory server fixture never opens a socket. After that, `reconcile()`
 * moves it to whatever the saved configuration asks for, one transition at a
 * time. A bind failure is reported, never worked around with another port.
 */
export class LocalAgentListener {
  private app: FastifyInstance | undefined;
  private port: number | undefined;
  private admitting = false;
  private active = false;
  private closed = false;
  private inFlight = 0;
  private current: LocalAgentListenerStatus = { state: "disabled" };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly markerPath: string | null;

  constructor(
    private readonly options: {
      agent: LocalAgentService;
      log: FastifyBaseLogger;
      mainPort: number;
      /** Where the tunnel guard learns the port; `null` writes none (in-memory fixtures). */
      markerPath?: string | null;
    },
  ) {
    this.markerPath =
      options.markerPath === undefined ? localAgentMarkerPath() : options.markerPath;
  }

  status(): LocalAgentListenerStatus {
    return { ...this.current };
  }

  /** Starts following the configuration; until then reconcile does nothing. */
  activate(): Promise<LocalAgentListenerStatus> {
    if (!this.closed) this.active = true;
    return this.reconcile();
  }

  reconcile(): Promise<LocalAgentListenerStatus> {
    const next = this.queue.then(() => this.apply());
    this.queue = next.catch(() => undefined);
    return next.then(() => this.status());
  }

  /** Closes for good: the Host is shutting down. */
  async close(): Promise<void> {
    this.closed = true;
    this.active = false;
    await this.reconcile();
  }

  private async apply(): Promise<void> {
    if (!this.active) {
      if (this.app) await this.stop();
      return;
    }
    const config = this.options.agent.config();
    const wanted =
      config.enabled && config.port !== this.options.mainPort ? config.port : undefined;
    if (this.app && this.port === wanted) return;
    if (this.app) await this.stop();
    if (wanted === undefined) {
      if (this.markerPath) clearLocalAgentMarker(this.markerPath);
      this.current = { state: "disabled" };
      return;
    }
    await this.start(wanted);
  }

  private async start(port: number): Promise<void> {
    this.current = { state: "starting" };
    const app = this.build(port);
    try {
      await app.listen({ host: LOOPBACK, port });
      const address = app.server.address();
      if (
        !address ||
        typeof address === "string" ||
        address.address !== LOOPBACK ||
        address.port !== port
      )
        throw new Error("The listener did not bind 127.0.0.1 on the configured port.");
    } catch (error) {
      await app.close().catch(() => undefined);
      this.current = { state: "error", error: bounded(error) };
      this.options.log.warn(
        { err: error, port },
        "The local agent API could not start; the rest of the Host is unaffected",
      );
      return;
    }
    const url = `http://${LOOPBACK}:${port}`;
    this.app = app;
    this.port = port;
    this.admitting = true;
    try {
      if (this.markerPath)
        writeLocalAgentMarker(this.markerPath, { port, pid: process.pid, url });
    } catch (error) {
      this.options.log.warn({ err: error }, "Could not record the local agent API port");
    }
    this.current = { state: "listening", url };
    this.options.log.info({ url }, "Local agent API listening");
  }

  private async stop(): Promise<void> {
    const app = this.app!;
    this.current = {
      state: "stopping",
      ...(this.current.url ? { url: this.current.url } : {}),
    };
    // Admission closes first, so a keep-alive request already on the wire is
    // refused rather than slipping in while the socket drains.
    this.admitting = false;
    this.app = undefined;
    this.port = undefined;
    if (this.markerPath) clearLocalAgentMarker(this.markerPath);
    const timer = setTimeout(() => app.server.closeAllConnections(), DRAIN_MS);
    try {
      await app.close();
    } catch (error) {
      this.options.log.warn({ err: error }, "The local agent API did not close cleanly");
    } finally {
      clearTimeout(timer);
    }
    this.current = { state: "disabled" };
    this.options.log.info("Local agent API stopped");
  }

  private build(port: number): FastifyInstance {
    const agent = this.options.agent;
    const log = this.options.log;
    const app = Fastify({
      logger: false,
      trustProxy: false,
      exposeHeadRoutes: false,
      return503OnClosing: false,
      bodyLimit: LOCAL_AGENT_LIMITS.bodyBytes,
      requestTimeout: LOCAL_AGENT_LIMITS.requestTimeoutMs,
      connectionTimeout: RESPONSE_DEADLINE_MS,
      keepAliveTimeout: 5_000,
    });
    app.server.headersTimeout = LOCAL_AGENT_LIMITS.requestTimeoutMs;

    const send = (reply: FastifyReply, failure: Refusal) =>
      reply.code(failure.status).send({ code: failure.code, error: failure.error });

    app.addHook("onRequest", async (request, reply) => {
      reply.raw.setHeader("cache-control", "no-store");
      reply.raw.setHeader("x-content-type-options", "nosniff");
      const refused = localAgentAdmission(
        {
          method: request.raw.method ?? "",
          url: request.raw.url ?? "",
          rawHeaders: request.raw.rawHeaders,
          peer: request.raw.socket.remoteAddress,
        },
        port,
      );
      if (refused) {
        if (refused.status === 405) reply.header("allow", "GET, POST");
        return send(reply, refused);
      }
      const config = agent.config();
      if (
        !this.admitting ||
        this.port !== port ||
        !config.enabled ||
        config.port !== port
      )
        return send(
          reply,
          refusal(503, "api_disabled", "The local agent API is turned off on this Host."),
        );
      if (this.inFlight >= READ_CONCURRENCY)
        return send(
          reply,
          refusal(429, "rate_limited", "Too many requests at once. Retry shortly."),
        );
      this.inFlight += 1;
      reply.raw.once("close", () => {
        this.inFlight -= 1;
      });
    });

    app.setErrorHandler((error, _request, reply) => {
      const mapped = localAgentErrorResponse(error);
      if (mapped.body.code !== "internal_error")
        return reply.code(mapped.statusCode).send(mapped.body);
      const status = (error as { statusCode?: unknown }).statusCode;
      if (status === 413)
        return send(
          reply,
          refusal(
            413,
            "payload_too_large",
            `Bodies are limited to ${LOCAL_AGENT_LIMITS.bodyBytes} bytes.`,
          ),
        );
      if (status === 415)
        return send(
          reply,
          refusal(415, "unsupported_media_type", "Send the body as application/json."),
        );
      if (typeof status === "number" && status >= 400 && status < 500)
        return send(
          reply,
          refusal(400, "bad_request", "The request could not be read as JSON."),
        );
      log.error({ err: error }, "Local agent API request failed");
      return reply.code(500).send(mapped.body);
    });
    app.setNotFoundHandler((_request, reply) =>
      send(reply, refusal(404, "not_found", "No such route. See GET /v1/capabilities.")),
    );

    type Params = Record<string, string>;
    const query = (request: FastifyRequest) => request.query as Record<string, unknown>;
    const params = (request: FastifyRequest) => request.params as Params;

    app.get("/v1/capabilities", async () => agent.capabilities());
    app.get("/v1/orchestrators", async (request) =>
      agent.listOrchestrators(query(request)),
    );
    app.get("/v1/workspaces", async (request) => agent.listWorkspaces(query(request)));
    app.get("/v1/tasks", async (request) => agent.listTasks(query(request)));
    app.get("/v1/tasks/:taskId", async (request) =>
      agent.getTask(params(request).taskId!, query(request)),
    );
    app.get("/v1/requests/:operationId", async (request) =>
      agent.getRequest(params(request).operationId!),
    );
    app.get("/v1/orchestrators/:leadId/transcript", async (request) =>
      agent.transcript(params(request).leadId!, query(request)),
    );
    app.post("/v1/orchestrators/:leadId/tasks", async (request, reply) => {
      const result = await agent.createTask(params(request).leadId!, request.body);
      return reply.code(result.status).send(result.body);
    });
    app.post("/v1/tasks/:taskId/messages", async (request, reply) => {
      const result = agent.sendMessage(params(request).taskId!, request.body);
      return reply.code(result.status).send(result.body);
    });

    // Streamable HTTP MCP, stateless: every POST is a whole exchange, so
    // there is no session for a GET stream or a DELETE to refer to.
    app.get("/v1/mcp", async (_request, reply) => {
      reply.header("allow", "POST");
      return send(
        reply,
        refusal(
          405,
          "method_not_allowed",
          "This MCP endpoint is stateless; POST JSON-RPC to it.",
        ),
      );
    });
    app.post("/v1/mcp", async (request, reply) => {
      const server = localAgentMcpServer(agent, log);
      // See mcp-routes.ts: `undefined` selects stateless mode, which
      // exactOptionalPropertyTypes cannot express without the cast.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      reply.hijack();
      try {
        await server.connect(
          transport as unknown as Parameters<typeof server.connect>[0],
        );
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        log.error({ err: error }, "Local agent MCP request failed");
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "content-type": "application/json" });
          reply.raw.end(
            JSON.stringify({ code: "internal_error", error: "MCP request failed." }),
          );
        }
      } finally {
        await server.close().catch(() => undefined);
      }
    });
    return app;
  }
}

const Limit = (max: number) => z.number().int().min(1).max(max).optional();
const Cursor = z.string().max(2_048).optional();

const MCP_INSTRUCTIONS = [
  "Fleet's local agent API: hand work to, and ask about work held by, the orchestrators an administrator exposed to programs on this machine.",
  "You are not a person here. You cannot approve, accept, publish, reopen or stop anything; the orchestrator weighs what you send within the task's existing permissions.",
  "Writes take an operationId: a fresh UUID for each new request, and the same UUID when retrying one whose outcome you did not see. A replay returns the original receipt.",
  "Replies are asynchronous. After create_task or send_task_message, poll get_request and get_task, and read the orchestrator's answer with read_transcript.",
].join("\n");

/** The same operations as the REST routes, as MCP tools over the same service. */
export function localAgentMcpServer(
  agent: LocalAgentService,
  log: FastifyBaseLogger,
): McpServer {
  const server = new McpServer(
    { name: "fleet-local-agent", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );
  const text = (value: unknown) => [
    { type: "text" as const, text: JSON.stringify(value, null, 2) },
  ];
  const run = async (act: () => unknown) => {
    try {
      return { content: text(await act()) };
    } catch (error) {
      const mapped = localAgentErrorResponse(error);
      if (mapped.statusCode >= 500)
        log.error({ err: error }, "Local agent MCP tool failed");
      return { content: text(mapped.body), isError: true };
    }
  };
  /** The service reads query strings; MCP arguments arrive typed. */
  const asQuery = (input: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(input)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );

  const ListInput = { limit: Limit(LOCAL_AGENT_LIMITS.listMax), cursor: Cursor };
  server.registerTool(
    "list_orchestrators",
    {
      title: "List orchestrators",
      description:
        "The orchestrators exposed to local agents, with whether each can take requests right now (`writable`) and why not when it cannot.",
      inputSchema: ListInput,
    },
    (input) => run(() => agent.listOrchestrators(asQuery(input))),
  );
  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "The workspaces new tasks may be created in. When `sourceRequired` is true, create_task needs a `sourcePlacementId` from that workspace's `placements`.",
      inputSchema: ListInput,
    },
    (input) => run(() => agent.listWorkspaces(asQuery(input))),
  );
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Tasks owned by exposed orchestrators in exposed workspaces, newest first. Filter by orchestrator, by `state` (open, closed or an exact task state), or by a name substring.",
      inputSchema: {
        leadSessionId: z.string().max(200).optional(),
        state: z.string().max(40).optional(),
        query: z.string().max(LOCAL_AGENT_LIMITS.nameChars).optional(),
        ...ListInput,
      },
    },
    (input) => run(() => agent.listTasks(asQuery(input))),
  );
  server.registerTool(
    "get_task",
    {
      title: "Read a task",
      description:
        "A task's objective, state, steps, notes and unresolved local requests. Long fields are truncated and marked; page steps and notes with the returned cursors.",
      inputSchema: {
        taskId: z.string().min(1).max(200),
        stepsCursor: Cursor,
        notesCursor: Cursor,
      },
    },
    ({ taskId, ...rest }) => run(() => agent.getTask(taskId, asQuery(rest))),
  );
  server.registerTool(
    "read_transcript",
    {
      title: "Read an orchestrator's transcript",
      description:
        "Recent blocks of an exposed orchestrator's conversation — where its answers to your questions appear. The whole conversation is visible, not just your task. Page backwards with `before`.",
      inputSchema: {
        leadSessionId: z.string().min(1).max(200),
        before: z.number().int().nonnegative().optional(),
        limit: Limit(LOCAL_AGENT_LIMITS.transcriptMax),
      },
    },
    ({ leadSessionId, ...rest }) =>
      run(() => agent.transcript(leadSessionId, asQuery(rest))),
  );
  server.registerTool(
    "get_request",
    {
      title: "Read a request receipt",
      description:
        "Where a create_task or send_task_message request stands: waiting_for_brief, pending, reserved, accepted, settled, rejected, orphaned or abandoned.",
      inputSchema: { operationId: z.string().min(1).max(200) },
    },
    ({ operationId }) => run(() => agent.getRequest(operationId)),
  );
  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description:
        "Hand an exposed orchestrator a new task in an exposed workspace. It is created at once and its brief reaches the orchestrator on its next turn. Use a fresh UUID operationId; reuse it only to retry this same request.",
      inputSchema: {
        leadSessionId: z.string().min(1).max(200),
        ...LocalAgentCreateTaskSchema.shape,
      },
    },
    ({ leadSessionId, ...body }) =>
      run(async () => (await agent.createTask(leadSessionId, body)).body),
  );
  server.registerTool(
    "send_task_message",
    {
      title: "Ask about or guide a task",
      description:
        "Queue a question or guidance about a task for its orchestrator. A question never changes the task and is allowed on closed tasks; guidance is refused on closed tasks and on tasks waiting for a person. Name the orchestrator you believe owns it as expectedLeadSessionId. The answer appears in read_transcript.",
      inputSchema: {
        taskId: z.string().min(1).max(200),
        ...LocalAgentMessageSchema.shape,
      },
    },
    ({ taskId, ...body }) => run(() => agent.sendMessage(taskId, body).body),
  );
  return server;
}
