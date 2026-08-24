import type { FastifyPluginAsync } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { z } from "zod";
import { terminalSessionStates } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { LeadTokens } from "./lead-tokens.js";
import {
  AdvanceTaskSchema,
  CloseTaskSchema,
  DiscardTaskSchema,
  EscalateSchema,
  FleetTools,
  FollowUpSchema,
  PlanTaskSchema,
  ReopenTaskSchema,
  SessionRefSchema,
  StartWorkSchema,
  SubmitTaskSchema,
  WORKER_CATEGORIES,
  explainInvalidArgs,
  type ToolResult,
} from "./tools.js";

export const MCP_PATH = "/mcp";

/**
 * How large a single tool call may be.
 *
 * The one bound left on a brief, and the only place a bound belongs: the schema
 * no longer caps the free-text fields, because a dispatch refused for saying too
 * much is worse than a long one. Fastify's default is 1 MB, and hitting it is
 * the worst failure available here — a bare HTTP 413 that never reaches the MCP
 * layer, so the caller gets a transport error with no tool, no reason, and no
 * word that its worker was never started. This is set far above any brief an
 * orchestrator would write, so what remains is a real resource limit rather than
 * an opinion about length.
 */
export const MCP_BODY_LIMIT = 32 * 1024 * 1024;

export type McpRouteOptions = { service: FleetService; tokens: LeadTokens };

/**
 * The tool surface an orchestrator session reaches the fleet through.
 *
 * Stateless: a fresh server and transport per request, because every fact
 * these tools read lives in SQLite and none of it belongs to an MCP session.
 * A Host restart therefore costs an orchestrator nothing at all — there is no
 * session to resynchronise, and its token is signed rather than remembered.
 */
export const mcpRoutes: FastifyPluginAsync<McpRouteOptions> = async (
  app,
  { service, tokens },
) => {
  app.post(MCP_PATH, { bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const leadSessionId = tokens.resolve(token);
    /*
     * The signature says which session this is; the session itself says whether
     * it may still act. That is what revocation is now — stopping an
     * orchestrator takes its tools away on the next call, with no token list to
     * keep in step.
     */
    const lead = leadSessionId ? service.store.getSession(leadSessionId) : undefined;
    const live =
      lead && lead.runRole === "lead" && !terminalSessionStates.has(lead.state);
    if (!leadSessionId || !live) {
      return reply
        .code(401)
        .send({ error: "This token does not belong to a live orchestrator" });
    }

    const server = buildServer(service, leadSessionId);
    /*
     * Stateless mode, which the SDK selects by an explicit `undefined` session
     * generator. This repo compiles with `exactOptionalPropertyTypes`, under
     * which "present and undefined" is not the same as "absent" — so the one
     * place the two conventions meet is cast here rather than by loosening the
     * setting for every file.
     */
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    // Fastify has already parsed the body, so it is handed over rather than
    // left for the transport to read from a stream that is now empty.
    reply.hijack();
    try {
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      app.log.error({ err: error }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ error: "MCP request failed" }));
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });
};

function buildServer(service: FleetService, leadSessionId: string): McpServer {
  const tools = new FleetTools(service, leadSessionId);
  const server = new McpServer(
    { name: "fleet", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const reply = (result: { ok: boolean; text: string }) => ({
    content: [{ type: "text" as const, text: result.text }],
    ...(result.ok ? {} : { isError: true }),
  });

  /**
   * Runs a tool behind the same schema that was advertised for it.
   *
   * The schemas come from `tools.ts` rather than being restated here, because
   * the two copies used to disagree: the advertisement carried the descriptions
   * and no limits, the handler carried the limits and no descriptions. A caller
   * that believed the advertisement wrote a `context` as long as it liked and
   * had the dispatch rejected afterwards, by a length it was never told about.
   * Passing the shape through means a limit cannot exist without being visible.
   */
  const guard =
    <T>(name: string, schema: z.ZodType<T>, act: (input: T) => ToolResult) =>
    (args: unknown) => {
      const parsed = schema.safeParse(args);
      return reply(
        parsed.success ? act(parsed.data) : explainInvalidArgs(name, parsed.error, args),
      );
    };

  server.registerTool(
    "fleet_list_nodes",
    {
      title: "List nodes",
      description:
        "The machines available to run work on, how loaded each one is, and which project checkouts they hold.",
      inputSchema: {},
    },
    async () => reply(tools.listNodes()),
  );

  server.registerTool(
    "fleet_start_work",
    {
      title: "Start work on a node",
      description: [
        "Start one worker agent on a node and return immediately.",
        "Say what must come back, where to work, and what will show it is real — the Host writes the worker's brief from those, so a dispatch with no way to check it is refused before a machine is spent on it.",
        "The Host picks the machine; a review always lands on the same checkout the implementation used, so it can see the changes.",
        "Group related steps under one `task`, and start a separate task for an unrelated request.",
        "You are woken with the result when it finishes — do not poll, and do not wait.",
        `Categories: ${WORKER_CATEGORIES.join(", ")}.`,
      ].join(" "),
      inputSchema: StartWorkSchema.shape,
    },
    guard("fleet_start_work", StartWorkSchema, (input) => tools.startWork(input)),
  );

  server.registerTool(
    "fleet_plan_task",
    {
      title: "Open a task and name its phases",
      description: [
        "Open a piece of work and say what stages it will go through.",
        "You own the task from here: you dispatch the work for each phase, check what comes back, and move it on yourself.",
        "A person is only asked at the very end, when you call fleet_submit_task.",
        "Choose phases that fit the request — three or four for a change, one for a question. Do not invent stages that have no work in them.",
      ].join(" "),
      inputSchema: PlanTaskSchema.shape,
    },
    guard("fleet_plan_task", PlanTaskSchema, (input) => tools.planTask(input)),
  );

  server.registerTool(
    "fleet_advance_task",
    {
      title: "Move a task to its next phase",
      description: [
        "Call this once you have read what a phase produced and judged it good enough to build on.",
        "If it is not good enough, dispatch more work instead — that is the same decision, made the other way.",
        "Refused while any step is still running: you cannot judge a phase you have not seen the end of.",
      ].join(" "),
      inputSchema: AdvanceTaskSchema.shape,
    },
    guard("fleet_advance_task", AdvanceTaskSchema, (input) => tools.advanceTask(input)),
  );

  server.registerTool(
    "fleet_submit_task",
    {
      title: "Hand a finished task to the person",
      description: [
        "The last phase is done and the work is ready to be looked at.",
        "Say how each of the task's success criteria turned out and what shows it — an essential criterion that is not met will be refused here, because the task is not finished.",
        "The summary is shown to the person as markdown above the approve and send-back buttons, so write it to be scanned — a bold one-line verdict, then short `###` sections with bullets under them. A long unbroken paragraph is refused.",
        "This is the only point at which a person is asked for anything; they approve it or send it back with a note, which arrives as a new turn.",
        "End your turn after calling it.",
      ].join(" "),
      inputSchema: SubmitTaskSchema.shape,
    },
    guard("fleet_submit_task", SubmitTaskSchema, (input) => tools.submitTask(input)),
  );

  server.registerTool(
    "fleet_escalate",
    {
      title: "Hand over a task you cannot finish",
      description: [
        "For when a success criterion turns out to be impossible, or the task needs a decision that is not yours — a product choice, a destructive action, something outside the workspace.",
        "Use this instead of lowering the bar: dropping a criterion is a person's decision, not yours.",
        "The task goes to the same place a finished one does, and they can change it, drop a criterion, or stop it. End your turn after calling it.",
      ].join(" "),
      inputSchema: EscalateSchema.shape,
    },
    guard("fleet_escalate", EscalateSchema, (input) => tools.escalate(input)),
  );

  server.registerTool(
    "fleet_close_task",
    {
      title: "End a task that is not going to be finished",
      description: [
        "For when a task stops being worth doing: the request was withdrawn, another task covers it, or what it was for no longer exists.",
        "This is not escalating — nobody has to decide anything, so do not send it to a person just to have it stopped.",
        "Any worker still running is stopped and its session removed; the task keeps its phases, steps and notes, and cannot be resumed except by fleet_reopen_task.",
        "Refused while a person holds it for review. End your turn after calling it.",
      ].join(" "),
      inputSchema: CloseTaskSchema.shape,
    },
    guard("fleet_close_task", CloseTaskSchema, (input) => tools.closeTask(input)),
  );

  server.registerTool(
    "fleet_reopen_task",
    {
      title: "Take a task back and carry on with it",
      description: [
        "For a task that turns out not to be over — either one you handed over and the person has not answered yet, or one that is already closed and the next thing to do belongs with it.",
        "Reopening keeps the task's criteria, notes and steps, which is the point: a new task would start with none of that context.",
        "Taking one back from review means the person is no longer being asked, so only do it when what you learned makes the question different.",
        "The task returns to the phase it was on. Dispatch what it needs, then end your turn.",
      ].join(" "),
      inputSchema: ReopenTaskSchema.shape,
    },
    guard("fleet_reopen_task", ReopenTaskSchema, (input) => tools.reopenTask(input)),
  );

  server.registerTool(
    "fleet_discard_task",
    {
      title: "Delete a task that should not exist",
      description: [
        "For a task opened by mistake — a duplicate, a misread request, a name you want back — caught before any work went out.",
        "It and its record are removed permanently. Refused once the task has a dispatched step or a note, because destroying a record a person might read is their decision, not yours: close it instead, which keeps what it learned.",
      ].join(" "),
      inputSchema: DiscardTaskSchema.shape,
    },
    guard("fleet_discard_task", DiscardTaskSchema, (input) => tools.discardTask(input)),
  );

  server.registerTool(
    "fleet_list_work",
    {
      title: "List this run's work",
      description:
        "Every task you have open, the phase each is on, its steps, and the budget left.",
      inputSchema: {},
    },
    async () => reply(tools.listWork()),
  );

  server.registerTool(
    "fleet_transcript",
    {
      title: "Read a worker's full output",
      description:
        "The complete transcript of one worker, for when the summary you were woken with was not enough.",
      inputSchema: SessionRefSchema.shape,
    },
    guard("fleet_transcript", SessionRefSchema, (input) => tools.transcript(input)),
  );

  server.registerTool(
    "fleet_follow_up",
    {
      title: "Send a worker another turn",
      description:
        "Add a follow-up instruction to a worker that has finished its turn but is still open. Use this instead of starting a second worker for the same task.",
      inputSchema: FollowUpSchema.shape,
    },
    guard("fleet_follow_up", FollowUpSchema, (input) => tools.followUp(input)),
  );

  server.registerTool(
    "fleet_stop_work",
    {
      title: "Stop a worker",
      description: "End a worker that is going nowhere, freeing its slot.",
      inputSchema: SessionRefSchema.shape,
    },
    guard("fleet_stop_work", SessionRefSchema, (input) => tools.stopWork(input)),
  );

  return server;
}
