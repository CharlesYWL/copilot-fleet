import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { z } from "zod";
import {
  RunCommandSchema,
  GetCommandExecutionSchema,
  CancelCommandExecutionSchema,
  terminalRunStates,
  terminalSessionStates,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { hostnameOf } from "../request-guard.js";
import type { SecurityAuditInput } from "../store.js";
import type { LeadTokenClaims, LeadTokens } from "./lead-tokens.js";
import {
  AdvanceTaskSchema,
  CloseTaskSchema,
  CheckpointPrMaintenanceSchema,
  DiscardTaskSchema,
  EscalateSchema,
  FleetTools,
  FollowUpSchema,
  GetPrMaintenanceSchema,
  ListWorkSchema,
  PlanTaskSchema,
  PreparePrMaintenanceSchema,
  ProposePrMaintenanceSchema,
  ReopenTaskSchema,
  SessionRefSchema,
  SetPrMaintenanceSchema,
  StartWorkSchema,
  SubmitTaskSchema,
  TaskRefSchema,
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

export type McpRouteOptions = {
  service: FleetService;
  tokens: LeadTokens;
  /** Where a refusal is recorded. Optional so a harness can leave it out. */
  audit?: ((entry: SecurityAuditInput) => void) | undefined;
};

/**
 * Why a call was refused, in words short enough to store.
 *
 * Recorded, never returned: the caller gets one answer for all of them,
 * because telling it that the signature was fine but the run had moved on is
 * telling it which of its guesses was warm.
 */
type LeadRefusal =
  | "browser origin"
  | "no bearer token"
  | "token not signed by this Host"
  | "no such session"
  | "session is not a lead"
  | "lead has finished"
  | "run has finished"
  | "lead is being deleted"
  | "run no longer matches"
  | "node no longer matches";

const REFUSED_BODY = { error: "This token does not belong to a live orchestrator" };

declare module "fastify" {
  interface FastifyRequest {
    fleetLeadClaims?: LeadTokenClaims;
  }
}

/**
 * What the caller had to prove, in one place.
 *
 * `/mcp` is a machine principal rather than an operator exception: it takes a
 * signed claim set and nothing else. A browser must not be able to reach it at
 * all — an `Origin` header is the one thing only a browser sends — and an
 * operator cookie is never even read here, because operating a Host and
 * orchestrating a run are different authorities.
 */
function authorizeLead(
  request: FastifyRequest,
  service: FleetService,
  tokens: LeadTokens,
):
  | { ok: true; claims: LeadTokenClaims }
  | { ok: false; status: 401 | 403; why: LeadRefusal } {
  if (request.headers.origin !== undefined) {
    return { ok: false, status: 403, why: "browser origin" };
  }
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { ok: false, status: 401, why: "no bearer token" };
  const claims = tokens.resolve(token);
  if (!claims) return { ok: false, status: 401, why: "token not signed by this Host" };
  /*
   * The signature says what was authorised; the fleet says whether it still
   * is. That is what revocation is now — stopping an orchestrator, cancelling
   * its run, or deleting the machine it was placed on all take its tools away
   * on the next call, with no token list to keep in step.
   */
  const lead = service.store.getSession(claims.sessionId);
  if (!lead) return { ok: false, status: 401, why: "no such session" };
  if (lead.runRole !== "lead")
    return { ok: false, status: 401, why: "session is not a lead" };
  if (terminalSessionStates.has(lead.state) || lead.stopRequested) {
    return { ok: false, status: 401, why: "lead has finished" };
  }
  if (lead.cleanupRequested) {
    return { ok: false, status: 401, why: "lead is being deleted" };
  }
  if (lead.runId !== claims.runId) {
    return { ok: false, status: 401, why: "run no longer matches" };
  }
  if (lead.nodeId !== claims.nodeId) {
    return { ok: false, status: 401, why: "node no longer matches" };
  }
  /*
   * The task itself, not only the session running it. Cancelling a task sends
   * a stop to the machine and waits for it to be confirmed, so between the two
   * the lead is still a live session — and one more turn of tools inside that
   * window is exactly what an operator cancelling a run is trying to prevent.
   *
   * A lead with no task is not refused here: nothing was cancelled, and the
   * session check above is the whole authorisation for a bare conversation.
   */
  const run = claims.runId ? service.store.getRun(claims.runId) : undefined;
  if (run && terminalRunStates.has(run.state)) {
    return { ok: false, status: 401, why: "run has finished" };
  }
  return { ok: true, claims };
}

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
  { service, tokens, audit },
) => {
  app.post(
    MCP_PATH,
    {
      bodyLimit: MCP_BODY_LIMIT,
      onRequest: async (request, reply) => {
        const authorized = authorizeLead(request, service, tokens);
        if (!authorized.ok) {
          // The bearer itself is never written down: the audit is read by every
          // administrator, so a rejected token recorded there would be a working
          // token published to all of them if the rejection was a race.
          audit?.({
            eventType:
              authorized.why === "browser origin"
                ? "mcp_browser_origin_rejected"
                : "mcp_lead_token_rejected",
            actorKind: "lead",
            outcome: "denied",
            requestHost: (hostnameOf(request.headers.host) ?? "").slice(0, 100),
            detail: authorized.why,
          });
          return reply.code(authorized.status).send(REFUSED_BODY);
        }
        request.fleetLeadClaims = authorized.claims;
      },
    },
    async (request, reply) => {
      const claims = request.fleetLeadClaims;
      if (!claims) return reply.code(401).send(REFUSED_BODY);
      const server = buildServer(service, claims.sessionId);
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
        await server.connect(
          transport as unknown as Parameters<typeof server.connect>[0],
        );
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
    },
  );
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
    "fleet_run_command",
    {
      title: "Request an approved command",
      description:
        "Request a finite shell command on an exact Node target. The Node checks its command/path permissions; a matching built-in, orchestrator-session, or always rule can run automatically. Otherwise the Host prompts a Microsoft administrator for Once, this session, or Always. Simple command identities may ignore recognized flags; compound/dynamic requests require an exact full-script grant, never a first-token rule. Ordinary placement commands can coexist with sessions; managed task worktrees and maintenance remain protected. This tool cannot approve itself or edit permissions. Save the execution ID, end this turn, and Fleet will notify you when it settles. A durable-delivery capable lead Node is required independently of the target; older Nodes retain their Once-only flow.",
      inputSchema: RunCommandSchema.shape,
    },
    guard("fleet_run_command", RunCommandSchema, (input) => tools.runCommand(input)),
  );
  server.registerTool(
    "fleet_get_execution",
    {
      title: "Read command evidence",
      description:
        "Read an owned execution and bounded stdout/stderr evidence by cursor. Raw bytes are Base64; text decoding assumes UTF-8 and reports loss. Use for evidence, not a polling loop.",
      inputSchema: GetCommandExecutionSchema.shape,
    },
    guard("fleet_get_execution", GetCommandExecutionSchema, (input) =>
      tools.getExecution(input),
    ),
  );
  server.registerTool(
    "fleet_cancel_execution",
    {
      title: "Cancel an owned command",
      description:
        "Revoke a queued command or durably request cancellation. A dispatched attempt stays unresolved until its Node proves no launch or quiescence.",
      inputSchema: CancelCommandExecutionSchema.shape,
    },
    guard("fleet_cancel_execution", CancelCommandExecutionSchema, (input) =>
      tools.cancelExecution(input),
    ),
  );

  server.registerTool(
    "fleet_start_work",
    {
      title: "Start work on a node",
      description: [
        "Start one worker agent on a node and return immediately.",
        "This creates a NEW session. For follow-up requests, first find the prior task with fleet_list_work and read fleet_get_task; use fleet_follow_up for the same deliverable.",
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
        "Before opening follow-up work, search fleet_list_work (including closed tasks). A failed exact-name lookup does not mean the prior task or worker was deleted.",
        "You own the task from here: you dispatch the work for each phase, check what comes back, and move it on yourself.",
        "A person is only asked at the very end, when you call fleet_submit_task.",
        "Choose the fewest phases and workers justified by complexity, uncertainty and risk: one for a simple fix including inspection and verification, two when discovery or independent review adds value, three for substantial or high-risk work needing both. Do not invent stages that have no work in them.",
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
        "Any worker still running is stopped; the task keeps its phases, steps, notes and worker conversations, which can continue only after fleet_reopen_task.",
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
        "Use its stable task ID from fleet_list_work, not a remembered title.",
        "The task returns to the phase it was on. Read fleet_get_task, then use fleet_follow_up to continue a retained worker whose role matches.",
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
      title: "Find tasks and reusable workers",
      description: [
        "Search or browse this orchestrator's open AND closed tasks, with stable task/session IDs, workspace and checkout, step and session states, and the next continuation action.",
        "Use a short query such as a PR number before deciding to create a task or worker. Results are paginated.",
        "Only this orchestrator's records are visible; no match does not prove a previous conversation was deleted or that another orchestrator's work can be replaced.",
      ].join(" "),
      inputSchema: ListWorkSchema.shape,
      annotations: { readOnlyHint: true },
    },
    guard("fleet_list_work", ListWorkSchema, (input) => tools.listWork(input)),
  );

  server.registerTool(
    "fleet_get_task",
    {
      title: "Read task context and continuation options",
      description: [
        "Read one owned task by stable ID or exact name: objective, phases, success criteria, notes, worker briefs/output, original checkout and continuation actions.",
        "Use this after fleet_list_work to decide whether the same worker should continue, the task must reopen, or genuinely different work needs a new session.",
        "Long notes and worker output are bounded; use fleet_transcript for more worker output.",
      ].join(" "),
      inputSchema: TaskRefSchema.shape,
      annotations: { readOnlyHint: true },
    },
    guard("fleet_get_task", TaskRefSchema, (input) => tools.getTask(input)),
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
    "fleet_prepare_pr_maintenance",
    {
      title: "Prepare a PR maintenance job",
      description:
        "For a natural-language maintenance request, discover the real PR URL and fresh metadata with the helper or already-authorized provider MCP/CLI. Derives the approved task baseline and existing coder; returns choices if ambiguous and stores a readable unapproved proposal. Defaults to observe: no repairs/publication or remote mutations. Repair mode requires verified publicationEvidence; replies, resolveThreads, named reviewers and retryChecks must be requested explicitly and default off. Never broaden read-only task constraints. Metadata must be at most five minutes old and URL-matched. Returns exact mode/proposedActions; describe them accurately. Cannot authorize, create workers, dispatch repairs or change credentials. No human JSON/Fleet IDs.",
      inputSchema: PreparePrMaintenanceSchema.shape,
    },
    guard("fleet_prepare_pr_maintenance", PreparePrMaintenanceSchema, (input) =>
      tools.preparePrMaintenance(input),
    ),
  );

  server.registerTool(
    "fleet_propose_pr_maintenance",
    {
      title: "Propose PR maintenance for human authorization",
      description:
        "When the user asks to enable Azure DevOps or GitHub PR maintenance, collect verified provider/PR/task/worker facts through the packaged provider helper and propose the bounded scope here. ADO requires organization, project GUID, repository GUIDs and exact refs; raw reviewer votes cannot establish policy approval. This stores an unapproved proposal and notifies the operator; it cannot enable maintenance or grant permissions. The existing task authorization dialog is prefilled, so never ask the user to copy JSON. Read an existing proposal with fleet_get_pr_maintenance(taskId) before revising it. End your turn after proposing.",
      inputSchema: ProposePrMaintenanceSchema.shape,
    },
    guard("fleet_propose_pr_maintenance", ProposePrMaintenanceSchema, (input) =>
      tools.proposePrMaintenance(input),
    ),
  );

  server.registerTool(
    "fleet_set_pr_maintenance",
    {
      title: "Set owned PR maintenance",
      description:
        "Pause an owned registration or reconcile already authorized enablement. Enablement, renewal, resume and release require the authenticated task action; this tool cannot mint operator approval or clear a design decision.",
      inputSchema: SetPrMaintenanceSchema.shape,
    },
    guard("fleet_set_pr_maintenance", SetPrMaintenanceSchema, (input) =>
      tools.setPrMaintenance(input),
    ),
  );

  server.registerTool(
    "fleet_get_pr_maintenance",
    {
      title: "Read PR maintenance and claim due work",
      description:
        "Read this lead's durable registrations on every wake. Use taskId for its pending proposal, current job and historical PRs. Responses include serverTime for actual collection-start timestamps, never to re-date old evidence. List bounded summaries with nextCursor, or read a complete record by recordId. takeDue claims the next persisted oldest-due visit and reserves a bounded helper request allowance for this Host-recorded turn; it does not start a worker. A lost claim stays charged. Reconcile paused or terminal work without repairs.",
      inputSchema: GetPrMaintenanceSchema.shape,
    },
    guard("fleet_get_pr_maintenance", GetPrMaintenanceSchema, (input) =>
      tools.getPrMaintenance(input),
    ),
  );

  server.registerTool(
    "fleet_checkpoint_pr_maintenance",
    {
      title: "Checkpoint PR maintenance facts",
      description:
        "Persist observations, helper fallback errors, prepared batches, settlement or readiness with an optimistic version. For fallback, error is the STRING 'code: message' from result.error.code and result.error.message (not the helper error object), and observation is the unchanged original result.observation with its real timestamp. Correcting a rejected shape does not authorize another helper call. Claim a bounded visit, then reserve alternate_attempt with incidentId, stable resolutionId, source/method/evidenceRef and request budget BEFORE alternate provider I/O. Submit fresh structured alternate_observation with the same resolutionId; partial stays partial. At most 3 attempts/incident; no credential changes or hold bypass. Checkpointing cannot authorize, broaden scope or transfer ownership. A worker completion is not batch settlement.",
      inputSchema: CheckpointPrMaintenanceSchema.shape,
    },
    guard("fleet_checkpoint_pr_maintenance", CheckpointPrMaintenanceSchema, (input) =>
      tools.checkpointPrMaintenance(input),
    ),
  );

  server.registerTool(
    "fleet_follow_up",
    {
      title: "Send a worker another turn",
      description: [
        "Give the same worker another turn. Settled task workers normally stay open and idle, so revisits continue immediately in the same live session; interrupted sessions are resumed when possible.",
        "Use this for another revision of the same deliverable or another round of feedback for the same coder.",
        "Use the sessionId from fleet_list_work or fleet_get_task. A closed task must first be reopened with fleet_reopen_task.",
        "Accepted follow-ups are persisted and scheduled; queued means accepted, not failed. Repeating the same pending follow-up does not resend it; a different prompt cannot overwrite it.",
        "Busy, stopping or offline is not a reason to replace a worker. Use fleet_start_work only for genuinely different work or a confirmed non-resumable conversation.",
        "For registered PR maintenance, supply its recordId/generation/batchId in maintenance and the byte-identical prepared prompt. Acceptance binds the same step/attempt atomically; omitted metadata cannot bypass a hold.",
      ].join(" "),
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
