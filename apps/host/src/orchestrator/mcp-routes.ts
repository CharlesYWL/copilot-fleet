import type { FastifyPluginAsync } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { terminalSessionStates } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { LeadTokens } from "./lead-tokens.js";
import {
  AdvanceTaskSchema,
  EscalateSchema,
  FleetTools,
  FollowUpSchema,
  PlanTaskSchema,
  SessionRefSchema,
  StartWorkSchema,
  SubmitTaskSchema,
  WORKER_CATEGORIES,
} from "./tools.js";

export const MCP_PATH = "/mcp";

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
  app.post(MCP_PATH, async (request, reply) => {
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
      inputSchema: {
        category: z
          .enum(WORKER_CATEGORIES)
          .describe("What kind of work this is. Reviews are read-only."),
        title: z.string().describe("A short label, shown to the human."),
        deliverable: z
          .string()
          .describe(
            "What the worker must send back. A patch, an answer, a number, a passing suite — concretely enough that you could tell whether you got it.",
          ),
        scope: z
          .string()
          .describe(
            "Where to work and where not to: the files or directories in play, and anything it should leave alone.",
          ),
        verify: z
          .string()
          .describe(
            'The command or observation that will show the deliverable is real — "npm test -- auth", "curl the endpoint and read the status". Not "check it works".',
          ),
        context: z
          .string()
          .optional()
          .describe(
            "What the worker cannot find out for itself. It cannot see this conversation, the person's messages, or any other worker's output, so repeat anything decided elsewhere.",
          ),
        workspace: z
          .string()
          .optional()
          .describe(
            "Which workspace to work in, by name. Defaults to the one the current task is already using. Name one to work on a different repository.",
          ),
        task: z
          .string()
          .optional()
          .describe(
            "Which piece of work this belongs to. Reuse a name to add to that task; pass a new name to start a separate one. Omit to continue the task you started last.",
          ),
      },
    },
    async (args) => reply(tools.startWork(StartWorkSchema.parse(args))),
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
      inputSchema: {
        task: z.string().describe("A short name for this piece of work."),
        objective: z
          .string()
          .describe("What finishing it means, in a sentence the person would recognise."),
        phases: z
          .array(z.string())
          .describe(
            'The stages, in order — for example ["Plan", "Implement", "Review"]. Names are shown to the person as progress.',
          ),
        successCriteria: z
          .array(
            z.object({
              id: z
                .string()
                .describe(
                  'A short handle you will use again when reporting, e.g. "logout-clears-token".',
                ),
              scenario: z
                .string()
                .describe(
                  "What someone would do, and what should happen — concretely. " +
                    'Not "auth works": "posting to /logout with a valid token, then reusing that token, returns 401".',
                ),
              expectedEvidence: z
                .string()
                .describe(
                  "What will show this is true. A command and its output, a test name, a file that exists. Not an opinion.",
                ),
              essential: z
                .boolean()
                .optional()
                .describe("False if the task can finish without this. Defaults to true."),
            }),
          )
          .describe(
            "What has to be observably true before this task is done. Write these now, not later — " +
              "you will be held to them when you hand the task over, and an essential one that is not met blocks the handover.",
          ),
        stopWhen: z
          .string()
          .describe(
            "One line naming the observable state that ends this task, so you can tell finished from nearly finished.",
          ),
        workspace: z
          .string()
          .optional()
          .describe("Which workspace this task is about, by name."),
      },
    },
    async (args) => reply(tools.planTask(PlanTaskSchema.parse(args))),
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
      inputSchema: {
        task: z.string().describe("The task to advance."),
        note: z
          .string()
          .describe(
            "What this phase established, in a sentence. The person reads these as the story of the task.",
          ),
      },
    },
    async (args) => reply(tools.advanceTask(AdvanceTaskSchema.parse(args))),
  );

  server.registerTool(
    "fleet_submit_task",
    {
      title: "Hand a finished task to the person",
      description: [
        "The last phase is done and the work is ready to be looked at.",
        "Say how each of the task's success criteria turned out and what shows it — an essential criterion that is not met will be refused here, because the task is not finished.",
        "This is the only point at which a person is asked for anything; they approve it or send it back with a note, which arrives as a new turn.",
        "End your turn after calling it.",
      ].join(" "),
      inputSchema: {
        task: z.string().describe("The task to hand over."),
        summary: z
          .string()
          .describe("What was done and what the person should look at first."),
        criteria: z
          .array(
            z.object({
              id: z.string().describe("The criterion id you set when planning the task."),
              outcome: z
                .enum(["met", "unmet", "blocked"])
                .describe(
                  "met = you checked and it holds. blocked = it could not be checked at all. Neither of the last two lets the task be handed over.",
                ),
              evidence: z
                .string()
                .describe(
                  "The observation behind that. A command and what it printed, a test that ran, a file you read. " +
                    'A worker saying it was done is not evidence; "looks correct" is not evidence.',
                ),
            }),
          )
          .describe("One entry per criterion of this task."),
      },
    },
    async (args) => reply(tools.submitTask(SubmitTaskSchema.parse(args))),
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
      inputSchema: {
        task: z.string().describe("The task you are stuck on."),
        reason: z
          .string()
          .describe(
            "What is in the way, concretely enough for a person to act on: what you tried, what happened, and what you would need in order to continue.",
          ),
      },
    },
    async (args) => reply(tools.escalate(EscalateSchema.parse(args))),
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
      inputSchema: { sessionId: z.string().describe("The worker's session id.") },
    },
    async (args) => reply(tools.transcript(SessionRefSchema.parse(args))),
  );

  server.registerTool(
    "fleet_follow_up",
    {
      title: "Send a worker another turn",
      description:
        "Add a follow-up instruction to a worker that has finished its turn but is still open. Use this instead of starting a second worker for the same task.",
      inputSchema: {
        sessionId: z.string().describe("The worker's session id."),
        prompt: z.string().describe("What it should do next."),
      },
    },
    async (args) => reply(tools.followUp(FollowUpSchema.parse(args))),
  );

  server.registerTool(
    "fleet_stop_work",
    {
      title: "Stop a worker",
      description: "End a worker that is going nowhere, freeing its slot.",
      inputSchema: { sessionId: z.string().describe("The worker's session id.") },
    },
    async (args) => reply(tools.stopWork(SessionRefSchema.parse(args))),
  );

  return server;
}
