import type { FastifyBaseLogger } from "fastify";
import { ZodError, z } from "zod";
import {
  LOCAL_AGENT_API_VERSION,
  LOCAL_AGENT_LIMITS,
  LocalAgentConfigUpdateSchema,
  LocalAgentCreateTaskSchema,
  LocalAgentDispositionSchema,
  LocalAgentMessageSchema,
  RunStateSchema,
  terminalRunStates,
  terminalSessionStates,
  type FleetSession,
  type LocalAgentConfig,
  type LocalAgentRequest,
  type Run,
  type RunNote,
  type RunStep,
  type TerminalBlock,
  type Workspace,
} from "@fleet/protocol";
import { CommandConflict } from "./command-execution-store.js";
import type { FleetService } from "./fleet-service.js";
import {
  LocalAgentError,
  canonicalDigest,
  sha256,
  withoutBrief,
  type LocalAgentLedgerEntry,
} from "./local-agent-store.js";
import {
  TaskApplicationError,
  assertTaskAdmissible,
  createTaskOnLead,
  findTaskLead,
  taskWouldBeManaged,
} from "./orchestrator/task-application.js";
import { SessionCleanupPendingError } from "./store.js";

type Query = Record<string, unknown>;
type Reply<T> = { status: number; body: T };

const STEP_BUDGET = 128 * 1024;
const NOTE_BUDGET = 96 * 1024;
const STEP_TEXT = 4_000;
const OBJECTIVE_TEXT = LOCAL_AGENT_LIMITS.objectiveChars;
const STEPS_MAX = 50;
const ADMIN_LIST_DEFAULT = 50;
const ADMIN_LIST_MAX = 200;
const CURSOR_CHARS = 2_048;
const TRUNCATED = "\n[… truncated by the local agent API]";

/** Everything the API can do, as `capabilities` advertises it. */
export const LOCAL_AGENT_OPERATIONS = [
  "list_orchestrators",
  "list_workspaces",
  "list_tasks",
  "get_task",
  "create_task",
  "send_task_message",
  "get_request",
  "read_transcript",
] as const;

/**
 * The turn a local agent's question or guidance arrives as.
 *
 * Shaped like the other Fleet envelopes so the transcript folds it into one
 * labelled control, and so the orchestrator reads it as a fact about who is
 * speaking rather than as a person typing. The caller's words are quoted as
 * data between markers it cannot close, so nothing it writes can pass for Fleet.
 * The operator exposed this orchestrator to let the agent act for them.
 */
export function localAgentEnvelope(input: {
  operationId: string;
  taskId: string;
  taskName: string;
  intent: "question" | "guidance";
  text: string;
  clientLabel?: string | undefined;
}): string {
  const client = input.clientLabel ? ` client=${JSON.stringify(input.clientLabel)}` : "";
  const quoted = input.text.replace(
    /<\/(local-agent-text|fleet-local-agent-request)/gi,
    "<\\/$1",
  );
  return [
    `<fleet-local-agent-request id="${input.operationId}" taskId=${JSON.stringify(input.taskId)} task=${JSON.stringify(input.taskName)} intent="${input.intent}" source="local-agent"${client}>`,
    "The operator's local assistant sent this through the local agent API, on the operator's behalf. Treat it as the operator asking, the same as a message typed in this conversation.",
    `It is about task "${input.taskId}". Read it with fleet_get_task using that exact ID before you act.`,
    input.intent === "question"
      ? "This is a question. Answer from the task's record when that is enough. If it needs fresh facts, gather them: reopen the task with fleet_reopen_task if it is closed or awaiting review, and dispatch the work it takes."
      : "This is guidance. Act on it: if the task is closed or awaiting review, reopen it with fleet_reopen_task, then plan and dispatch the work.",
    "<local-agent-text>",
    quoted,
    "</local-agent-text>",
    "</fleet-local-agent-request>",
  ].join("\n");
}

/**
 * Who changed the local agent API from Settings: a Microsoft administrator, or
 * — with sign-in deliberately skipped — the operator, who has no ID.
 */
export type LocalAgentManager = {
  kind: "administrator" | "operator";
  id: string;
  username: string;
};

/** The status and `{code, error}` body every local API failure is answered with. */
export function localAgentErrorResponse(error: unknown): {
  statusCode: number;
  body: { code: string; error: string };
} {
  const reply = (statusCode: number, code: string, message: string) => ({
    statusCode,
    body: { code, error: message },
  });
  if (error instanceof LocalAgentError || error instanceof TaskApplicationError)
    return reply(error.statusCode, error.code, error.message);
  if (error instanceof ZodError)
    return reply(
      400,
      "bad_request",
      error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
    );
  if (error instanceof SessionCleanupPendingError)
    return reply(
      409,
      "lead_stopping",
      "The orchestrator or one of its sessions is being cleaned up.",
    );
  if (error instanceof CommandConflict) {
    if (error.code === "lead_prompt_queue_full" || error.code.endsWith("_pressure"))
      return reply(
        503,
        "lead_prompt_queue_full",
        "The orchestrator's delivery queue is full. Try again after it catches up.",
      );
    if (error.code.endsWith("too_large") || error.code.includes("metadata"))
      return reply(400, "bad_request", "The message is too large to deliver.");
    if (error.code === "lead_not_live")
      return reply(
        409,
        "lead_requires_resume",
        "The orchestrator is not running. A person must resume it first.",
      );
    if (error.code === "durable_lead_delivery_required")
      return reply(
        503,
        "lead_unavailable",
        "The orchestrator's Node is offline or cannot take durable deliveries.",
      );
    return reply(error.statusCode, error.code, error.message);
  }
  return reply(500, "internal_error", "The Host could not complete the request.");
}

function notFound(what: string): never {
  throw new LocalAgentError(404, "not_found", `${what} not found.`);
}

function invalidCursor(): LocalAgentError {
  return new LocalAgentError(
    400,
    "invalid_cursor",
    "That cursor is not valid for this request. Start again without it.",
  );
}

function badRequest(message: string): LocalAgentError {
  return new LocalAgentError(400, "bad_request", message);
}

/** A single string query parameter; a repeated one is refused rather than guessed at. */
function param(query: Query, name: string): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${name} must be given once.`);
  return value;
}

function limitOf(query: Query, fallback: number, max: number): number {
  const raw = param(query, "limit");
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw badRequest(`limit must be an integer from 1 to ${max}.`);
  const value = Number(raw);
  if (value < 1 || value > max)
    throw badRequest(`limit must be an integer from 1 to ${max}.`);
  return value;
}

/**
 * An opaque continuation. It names the route and filter it was issued for, so
 * one cannot be replayed against another listing; it carries a position only,
 * never authority — every page rechecks scope.
 */
function encodeCursor(route: string, filter: string, key: unknown): string {
  return Buffer.from(JSON.stringify({ v: 1, r: route, f: filter, k: key })).toString(
    "base64url",
  );
}

function decodeCursor<T>(
  raw: string | undefined,
  route: string,
  filter: string,
  key: z.ZodType<T>,
): T | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw.length > CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const envelope = z
    .object({ v: z.literal(1), r: z.literal(route), f: z.literal(filter), k: key })
    .safeParse(parsed);
  if (!envelope.success) throw invalidCursor();
  return envelope.data.k as T;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max) + TRUNCATED, truncated: true }
    : { text, truncated: false };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

const TaskStateFilterSchema = z.union([z.enum(["open", "closed"]), RunStateSchema]);
const KeysetSchema = z.tuple([z.string(), z.string()]);
const OffsetSchema = z.number().int().nonnegative();

/**
 * What a program on the Host machine may see and do through the local agent
 * API, and nothing more.
 *
 * Every read and write is scoped to the orchestrators and workspaces an
 * administrator exposed, rechecked on every call: an ID outside that scope is
 * answered exactly like one that does not exist. Writes go through the same
 * task application and durable lead queue the browser uses — this class adds
 * a receipt, a scope and a refusal for anything a person must decide, never a
 * second way to run work.
 */
export class LocalAgentService {
  /** Accepted-write timestamps in the last minute, Host-wide: there is no caller identity to split them by. */
  private readonly writes: number[] = [];

  constructor(
    private readonly service: FleetService,
    private readonly engine: { tick(): void },
    private readonly log: FastifyBaseLogger,
    private readonly now: () => number = Date.now,
  ) {}

  private get store() {
    return this.service.store;
  }

  config(): LocalAgentConfig {
    return this.store.getLocalAgentConfig();
  }

  // ---- scope ---------------------------------------------------------------

  private exposedLead(id: string): FleetSession | undefined {
    const config = this.config();
    if (!config.enabled || !config.allowedLeadSessionIds.includes(id)) return undefined;
    const lead = this.store.getSession(id);
    return lead && lead.runRole === "lead" && !lead.dismissed ? lead : undefined;
  }

  private exposedWorkspace(id: string): Workspace | undefined {
    const config = this.config();
    if (!config.enabled || !config.allowedWorkspaceIds.includes(id)) return undefined;
    return this.store.getWorkspace(id);
  }

  /** A task is visible only while both its current owner and its workspace are exposed. */
  private inScope(run: Run): boolean {
    return (
      !!run.leadSessionId &&
      !!this.exposedLead(run.leadSessionId) &&
      !!this.exposedWorkspace(run.workspaceId)
    );
  }

  private exposedTask(id: string): Run | undefined {
    const run = this.store.getRun(id);
    return run && this.inScope(run) ? run : undefined;
  }

  /** Why the orchestrator cannot take a new request now, if it cannot. */
  private writeBlocker(lead: FleetSession): LocalAgentError | undefined {
    if (
      terminalSessionStates.has(lead.state) ||
      (lead.runId &&
        terminalRunStates.has(this.store.getRun(lead.runId)?.state ?? "cancelled"))
    )
      return new LocalAgentError(
        409,
        "lead_requires_resume",
        "The orchestrator is not running. A person must resume it before it can take requests.",
      );
    if (
      lead.stopRequested ||
      lead.cleanupRequested ||
      this.store.getSessionTransitionIntent(lead.id) === "stop"
    )
      return new LocalAgentError(409, "lead_stopping", "The orchestrator is stopping.");
    if (!this.service.commands.durableLead(lead.id))
      return new LocalAgentError(
        503,
        "lead_unavailable",
        "The orchestrator's Node is offline or too old for durable delivery. Try again once it reconnects.",
      );
    return undefined;
  }

  private takeWriteToken(): void {
    const now = this.now();
    while (this.writes.length && now - this.writes[0]! >= 60_000) this.writes.shift();
    if (this.writes.length >= LOCAL_AGENT_LIMITS.writesPerMinute) {
      const wait = Math.max(1, Math.ceil((60_000 - (now - this.writes[0]!)) / 1000));
      throw new LocalAgentError(
        429,
        "rate_limited",
        `Too many writes in the last minute. Try again in ${wait} s.`,
      );
    }
    this.writes.push(now);
  }

  private assertUnresolvedRoom(leadId: string): void {
    if (
      this.store.localAgent.unresolvedForLead(leadId).length >=
      LOCAL_AGENT_LIMITS.unresolvedPerLead
    )
      throw new LocalAgentError(
        429,
        "too_many_unresolved",
        "This orchestrator already holds the most unresolved local requests it may. Wait for some to settle.",
      );
  }

  private audit(
    eventType: string,
    entry: { actorKind?: string; actorId?: string; targetId?: string; detail?: string },
  ): void {
    try {
      this.store.recordSecurityAudit({
        eventType,
        actorKind: entry.actorKind ?? "local_agent",
        outcome: "allowed",
        ...(entry.actorId ? { actorId: entry.actorId } : {}),
        ...(entry.targetId ? { targetId: entry.targetId } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      });
    } catch (error) {
      this.log.warn({ error, eventType }, "Could not record a local agent audit event");
    }
  }

  // ---- reads ---------------------------------------------------------------

  capabilities() {
    return {
      version: LOCAL_AGENT_API_VERSION,
      trust: "unauthenticated-loopback" as const,
      operations: LOCAL_AGENT_OPERATIONS,
      limits: LOCAL_AGENT_LIMITS,
      mcp: `/${LOCAL_AGENT_API_VERSION}/mcp`,
    };
  }

  private orchestratorView(lead: FleetSession) {
    const node = this.store.getNode(lead.nodeId);
    const blocker = this.writeBlocker(lead);
    return {
      id: lead.id,
      name: lead.name || `Orchestrator ${lead.id.slice(0, 8)}`,
      agent: lead.agentParams ?? { kind: "copilot" as const },
      state: lead.state,
      nodeName: node?.name ?? lead.nodeName,
      nodeOnline: node?.online ?? false,
      stopRequested: !!lead.stopRequested,
      cleanupRequested: !!lead.cleanupRequested,
      writable: !blocker,
      ...(blocker ? { unavailableReason: blocker.code } : {}),
      ...(lead.lastActivityAt ? { lastActivityAt: lead.lastActivityAt } : {}),
    };
  }

  listOrchestrators(query: Query) {
    const limit = limitOf(
      query,
      LOCAL_AGENT_LIMITS.listDefault,
      LOCAL_AGENT_LIMITS.listMax,
    );
    const after = decodeCursor(param(query, "cursor"), "orchestrators", "", z.string());
    const leads = [...new Set(this.config().allowedLeadSessionIds)]
      .sort()
      .filter((id) => after === undefined || id > after)
      .map((id) => this.exposedLead(id))
      .filter((lead): lead is FleetSession => !!lead);
    const page = leads.slice(0, limit);
    return {
      orchestrators: page.map((lead) => this.orchestratorView(lead)),
      ...(leads.length > limit
        ? { nextCursor: encodeCursor("orchestrators", "", page.at(-1)!.id) }
        : {}),
      measuredAt: new Date(this.now()).toISOString(),
    };
  }

  listWorkspaces(query: Query) {
    const limit = limitOf(
      query,
      LOCAL_AGENT_LIMITS.listDefault,
      LOCAL_AGENT_LIMITS.listMax,
    );
    const after = decodeCursor(param(query, "cursor"), "workspaces", "", z.string());
    const workspaces = [...new Set(this.config().allowedWorkspaceIds)]
      .sort()
      .filter((id) => after === undefined || id > after)
      .map((id) => this.exposedWorkspace(id))
      .filter((workspace): workspace is Workspace => !!workspace);
    const page = workspaces.slice(0, limit);
    const placements = this.store.listPlacements();
    return {
      workspaces: page.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        kind: workspace.kind,
        /** Whether a new task here needs `sourcePlacementId`: it would get a managed checkout. */
        sourceRequired: taskWouldBeManaged(this.store, workspace.id, "auto"),
        placements: placements
          .filter((placement) => placement.workspaceId === workspace.id)
          .map((placement) => {
            const node = this.store.getNode(placement.nodeId);
            return {
              id: placement.id,
              nodeId: placement.nodeId,
              nodeName: node?.name ?? placement.nodeName ?? "",
              online: node?.online ?? false,
            };
          }),
      })),
      ...(workspaces.length > limit
        ? { nextCursor: encodeCursor("workspaces", "", page.at(-1)!.id) }
        : {}),
      measuredAt: new Date(this.now()).toISOString(),
    };
  }

  private taskSummary(run: Run) {
    return {
      id: run.id,
      name: run.name,
      state: run.state,
      leadSessionId: run.leadSessionId,
      workspaceId: run.workspaceId,
      workspaceName: this.store.getWorkspace(run.workspaceId)?.name ?? "",
      phases: run.phases,
      phaseIndex: run.phaseIndex,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      unresolvedRequests: this.store.localAgent.unresolvedForTask(run.id).length,
    };
  }

  listTasks(query: Query) {
    const limit = limitOf(
      query,
      LOCAL_AGENT_LIMITS.listDefault,
      LOCAL_AGENT_LIMITS.listMax,
    );
    const lead = param(query, "leadSessionId") || undefined;
    if (lead !== undefined && !this.exposedLead(lead)) notFound("Orchestrator");
    const rawState = param(query, "state") || undefined;
    const state =
      rawState === undefined ? undefined : TaskStateFilterSchema.safeParse(rawState);
    if (state && !state.success)
      throw badRequest("state must be open, closed or a task state.");
    const text = param(query, "query")?.trim().toLowerCase() || undefined;
    if (text && text.length > LOCAL_AGENT_LIMITS.nameChars)
      throw badRequest(`query is limited to ${LOCAL_AGENT_LIMITS.nameChars} characters.`);
    const filter = canonicalDigest({ lead, state: rawState, text });
    const after = decodeCursor(param(query, "cursor"), "tasks", filter, KeysetSchema);
    const wanted = state?.data;
    const matches = this.store
      .listRuns()
      .filter(
        (run) =>
          (lead === undefined || run.leadSessionId === lead) &&
          (wanted === undefined ||
            (wanted === "open"
              ? !terminalRunStates.has(run.state)
              : wanted === "closed"
                ? terminalRunStates.has(run.state)
                : run.state === wanted)) &&
          (text === undefined || run.name.toLowerCase().includes(text)) &&
          this.inScope(run),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      )
      .filter(
        (run) =>
          !after ||
          run.createdAt < after[0] ||
          (run.createdAt === after[0] && run.id.localeCompare(after[1]) < 0),
      );
    const page = matches.slice(0, limit);
    const last = page.at(-1);
    return {
      tasks: page.map((run) => this.taskSummary(run)),
      ...(matches.length > limit && last
        ? { nextCursor: encodeCursor("tasks", filter, [last.createdAt, last.id]) }
        : {}),
      measuredAt: new Date(this.now()).toISOString(),
    };
  }

  private stepView(step: RunStep) {
    const prompt = clip(step.prompt, STEP_TEXT);
    const output = clip(step.output, STEP_TEXT);
    return {
      id: step.id,
      stepKey: step.stepKey,
      title: step.title,
      category: step.category,
      state: step.state,
      phaseIndex: step.phaseIndex,
      attempts: step.attempts,
      dependsOn: step.dependsOn,
      prompt: prompt.text,
      output: output.text,
      truncated: prompt.truncated || output.truncated,
      ...(step.workspaceState ? { workspaceState: step.workspaceState } : {}),
      ...(step.workspaceError ? { workspaceError: step.workspaceError } : {}),
      ...(step.resultSha ? { resultSha: step.resultSha } : {}),
      ...(step.admission
        ? {
            admission: {
              state: step.admission.state,
              code: step.admission.code,
              nodeName: step.admission.nodeName,
            },
          }
        : {}),
      ...(step.dispatchedAt ? { dispatchedAt: step.dispatchedAt } : {}),
      createdAt: step.createdAt,
      updatedAt: step.updatedAt,
    };
  }

  private noteView(note: RunNote) {
    const body = clip(note.body, LOCAL_AGENT_LIMITS.noteChars);
    return {
      id: note.id,
      phaseIndex: note.phaseIndex,
      body: body.text,
      truncated: body.truncated,
      ...(note.summary ? { summary: note.summary } : {}),
      ...(note.kind ? { kind: note.kind } : {}),
      ...(note.source ? { source: note.source } : {}),
      createdAt: note.createdAt,
    };
  }

  getTask(taskId: string, query: Query) {
    const run = this.exposedTask(taskId) ?? notFound("Task");
    const steps = this.service.withAdmission(run.id, this.store.listRunSteps(run.id));
    const notes = this.store.listRunNotes(run.id);

    const stepFrom =
      decodeCursor(param(query, "stepsCursor"), "task-steps", run.id, OffsetSchema) ?? 0;
    if (stepFrom > steps.length) throw invalidCursor();
    const stepPage: ReturnType<LocalAgentService["stepView"]>[] = [];
    let used = 0;
    let index = stepFrom;
    for (; index < steps.length && stepPage.length < STEPS_MAX; index++) {
      const view = this.stepView(steps[index]!);
      const size = bytes(view);
      if (stepPage.length && used + size > STEP_BUDGET) break;
      stepPage.push(view);
      used += size;
    }
    const nextStep = index;

    const noteBefore =
      decodeCursor(param(query, "notesCursor"), "task-notes", run.id, OffsetSchema) ??
      notes.length;
    if (noteBefore > notes.length) throw invalidCursor();
    const notePage: ReturnType<LocalAgentService["noteView"]>[] = [];
    used = 0;
    let cursor = noteBefore;
    for (; cursor > 0 && notePage.length < LOCAL_AGENT_LIMITS.notesMax; cursor--) {
      const view = this.noteView(notes[cursor - 1]!);
      const size = bytes(view);
      if (notePage.length && used + size > NOTE_BUDGET) break;
      notePage.push(view);
      used += size;
    }

    const binding = run.workspaceBinding;
    const objective = clip(run.objective, OBJECTIVE_TEXT);
    const lead = this.store.getSession(run.leadSessionId);
    const blocker = lead ? this.writeBlocker(lead) : undefined;
    return {
      task: {
        ...this.taskSummary(run),
        objective: objective.text,
        objectiveTruncated: objective.truncated,
        successCriteria: run.successCriteria,
        stopWhen: run.stopWhen,
        failureReason: run.failureReason,
        policy: run.policy,
        /** The orchestrator still owes this task's brief or an update it has not been sent. */
        owedPrompt: run.pendingPrompt !== "",
        ownerWritable: !!lead && !blocker,
        ...(blocker ? { ownerUnavailableReason: blocker.code } : {}),
        ...(binding
          ? {
              workspace: {
                requestedMode: binding.requestedMode,
                effectiveMode: binding.effectiveMode,
                accessIntent: binding.accessIntent,
                initialization: binding.initialization,
                setupState: binding.setupState,
                integrationTargetRef: binding.integrationTargetRef,
                aggregationState: binding.aggregationState,
                aggregationPhase: binding.aggregationPhase,
              },
            }
          : {}),
      },
      steps: stepPage,
      stepsTotal: steps.length,
      ...(nextStep < steps.length
        ? { nextStepsCursor: encodeCursor("task-steps", run.id, nextStep) }
        : {}),
      notes: notePage,
      notesTotal: notes.length,
      ...(cursor > 0
        ? { nextNotesCursor: encodeCursor("task-notes", run.id, cursor) }
        : {}),
      requests: this.store.localAgent.unresolvedForTask(run.id),
      measuredAt: new Date(this.now()).toISOString(),
    };
  }

  private links(row: Pick<LocalAgentLedgerEntry, "operationId" | "taskId">) {
    return {
      status: `/${LOCAL_AGENT_API_VERSION}/requests/${row.operationId}`,
      task: `/${LOCAL_AGENT_API_VERSION}/tasks/${row.taskId}`,
    };
  }

  /**
   * A receipt as a local agent may see it: only while the lead and workspace it
   * was made against are still exposed, and the task it names still in scope.
   */
  private requestView(row: LocalAgentLedgerEntry) {
    if (!this.exposedLead(row.leadSessionId) || !this.exposedWorkspace(row.workspaceId))
      notFound("Request");
    const run = this.store.getRun(row.taskId);
    if (!run || !this.inScope(run)) notFound("Request");
    return {
      task: this.taskSummary(run),
      request: this.store.localAgent.project(row),
      links: this.links(row),
    };
  }

  getRequest(operationId: string) {
    const row = this.store.localAgent.get(operationId) ?? notFound("Request");
    return this.requestView(row);
  }

  async transcript(leadId: string, query: Query) {
    if (!this.exposedLead(leadId)) notFound("Orchestrator");
    const limit = limitOf(
      query,
      LOCAL_AGENT_LIMITS.transcriptDefault,
      LOCAL_AGENT_LIMITS.transcriptMax,
    );
    const rawBefore = param(query, "before");
    if (rawBefore !== undefined && rawBefore !== "" && !/^\d+$/.test(rawBefore))
      throw badRequest("before must be a block index.");
    const before = rawBefore ? Number(rawBefore) : undefined;
    const page = await this.service.transcripts.page(leadId, { before, limit });
    // Scope can change while the projection builds; answer as of now.
    if (!this.exposedLead(leadId)) notFound("Orchestrator");
    const end = page.start + page.blocks.length;
    const recent = page.blocks.slice(-limit);
    const kept: TerminalBlock[] = [];
    let used = 0;
    let truncated = false;
    for (let index = recent.length - 1; index >= 0; index--) {
      let block = blockView(recent[index]!);
      let size = bytes(block);
      if (size > LOCAL_AGENT_LIMITS.transcriptBytes / 2) {
        block = cutBlock(block, LOCAL_AGENT_LIMITS.transcriptBytes / 8);
        size = bytes(block);
        truncated = true;
      }
      if (kept.length && used + size > LOCAL_AGENT_LIMITS.transcriptBytes) break;
      kept.unshift(block);
      used += size;
    }
    const start = end - kept.length;
    return {
      generation: page.generation,
      revision: page.revision,
      total: page.total,
      start,
      end,
      blocks: kept,
      hasMore: start > 0,
      ...(start > 0 ? { nextBefore: start } : {}),
      truncated,
    };
  }

  // ---- writes --------------------------------------------------------------

  private replay(
    existing: LocalAgentLedgerEntry,
    payloadDigest: string,
    status: number,
  ): Reply<ReturnType<LocalAgentService["requestView"]> & { replayed: true }> {
    if (existing.payloadDigest !== payloadDigest)
      throw new LocalAgentError(
        409,
        "idempotency_conflict",
        "That operationId was already used for a different request. Use a new UUID for new work.",
      );
    return { status, body: { ...this.requestView(existing), replayed: true } };
  }

  async createTask(leadId: string, body: unknown) {
    const input = LocalAgentCreateTaskSchema.parse(body);
    if (!this.exposedLead(leadId)) notFound("Orchestrator");
    const workspace = this.exposedWorkspace(input.workspaceId) ?? notFound("Workspace");
    this.takeWriteToken();
    const payloadDigest = canonicalDigest({
      op: "create_task",
      leadSessionId: leadId,
      ...input,
    });
    const existing = this.store.localAgent.get(input.operationId);
    if (existing) return this.replay(existing, payloadDigest, 201);

    const lead = findTaskLead(this.store, leadId);
    if (!lead)
      throw new LocalAgentError(
        409,
        "lead_requires_resume",
        "The orchestrator is not running. A person must resume it first.",
      );
    const blocked = this.writeBlocker(lead);
    if (blocked) throw blocked;
    this.store.assertOrchestratorMutable(lead.id);
    this.assertUnresolvedRoom(lead.id);
    assertTaskAdmissible(this.store, {
      lead,
      workspace,
      workspaceMode: "auto",
      sourcePlacementId: input.sourcePlacementId,
      hasOperationId: true,
    });
    let row: LocalAgentLedgerEntry | undefined;
    const run = createTaskOnLead(this.store, {
      lead,
      workspace,
      name: input.name,
      objective: input.objective,
      workspaceMode: "auto",
      sourcePlacementId: input.sourcePlacementId,
      record: (created) => {
        row = this.store.localAgent.insert({
          operationId: input.operationId,
          kind: "create_task",
          leadSessionId: lead.id,
          taskId: created.id,
          workspaceId: workspace.id,
          payloadDigest,
          phase: "waiting_for_brief",
          briefDigest: sha256(created.pendingPrompt),
          briefLength: created.pendingPrompt.length,
          clientLabel: input.clientLabel,
        });
      },
    });
    try {
      await this.service.worktrees.prepare(run.id);
    } catch (error) {
      // The task exists and its preparation is retried by its own lifecycle;
      // a retry of this request must find it, not make another.
      this.log.warn({ error, runId: run.id }, "Local agent task preparation failed");
    }
    this.service.publishRun(this.store.getRun(run.id) ?? run);
    this.engine.tick();
    this.audit("local_agent_task_created", {
      targetId: run.id,
      detail: `Task "${run.name}" on orchestrator ${lead.id} (operation ${input.operationId}${input.clientLabel ? `, client "${input.clientLabel}"` : ""}).`,
    });
    const created = this.store.localAgent.get(row!.operationId) ?? row!;
    const current = this.store.getRun(run.id) ?? run;
    return {
      status: 201,
      body: {
        task: this.taskSummary(current),
        request: this.store.localAgent.project(created),
        links: this.links(created),
      },
    };
  }

  sendMessage(taskId: string, body: unknown) {
    const input = LocalAgentMessageSchema.parse(body);
    const run = this.exposedTask(taskId) ?? notFound("Task");
    this.takeWriteToken();
    const payloadDigest = canonicalDigest({ op: "task_message", taskId, ...input });
    const existing = this.store.localAgent.get(input.operationId);
    if (existing) return this.replay(existing, payloadDigest, 202);

    if (run.leadSessionId !== input.expectedLeadSessionId)
      throw new LocalAgentError(
        409,
        "stale_owner",
        "The task now belongs to another orchestrator. Read it again and address its current owner.",
      );
    // The operator exposed this orchestrator so a local agent could speak for
    // them: closed or awaiting-review tasks are the lead's to reopen. Only an
    // unsettled command fence is a hard stop, because work behind it is unknown.
    if (input.intent === "guidance") this.store.commands.assertTaskUnfenced(run.id);
    const lead = this.store.getSession(run.leadSessionId) ?? notFound("Task");
    const blocked = this.writeBlocker(lead);
    if (blocked) throw blocked;
    this.store.assertRunMutable(run.id);
    this.assertUnresolvedRoom(lead.id);

    const row = this.store.writeAtomically(() => {
      if (this.store.getRun(run.id)?.leadSessionId !== input.expectedLeadSessionId)
        throw new LocalAgentError(
          409,
          "stale_owner",
          "The task now belongs to another orchestrator.",
        );
      const record = this.service.commands.queueLeadPrompt(
        lead.id,
        localAgentEnvelope({
          operationId: input.operationId,
          taskId: run.id,
          taskName: run.name,
          intent: input.intent,
          text: input.text,
          clientLabel: input.clientLabel,
        }),
        `local-agent:${input.operationId}`,
        [],
        lead.executionBinding,
      );
      return this.store.localAgent.insert({
        operationId: input.operationId,
        kind: input.intent,
        leadSessionId: lead.id,
        taskId: run.id,
        workspaceId: run.workspaceId,
        payloadDigest,
        phase: "queued",
        deliveryId: record.delivery.deliveryId,
        clientLabel: input.clientLabel,
      });
    });
    this.service.commands.pumpLead(lead.id);
    this.audit(`local_agent_${input.intent}_queued`, {
      targetId: run.id,
      detail: `${input.intent === "question" ? "Question" : "Guidance"} for task "${run.name}" to orchestrator ${lead.id} (operation ${input.operationId}${input.clientLabel ? `, client "${input.clientLabel}"` : ""}).`,
    });
    const current = this.store.localAgent.get(row.operationId) ?? row;
    return {
      status: 202,
      body: {
        task: this.taskSummary(this.store.getRun(run.id) ?? run),
        request: this.store.localAgent.project(current),
        links: this.links(current),
      },
    };
  }

  // ---- administration --------------------------------------------------------

  /** Every receipt, for the administrator: scope does not hide anything here. */
  listRequests(query: Query) {
    const limit = limitOf(query, ADMIN_LIST_DEFAULT, ADMIN_LIST_MAX);
    const before = decodeCursor(
      param(query, "cursor"),
      "admin-requests",
      "",
      KeysetSchema,
    );
    const rows = this.store.localAgent.list({
      limit: limit + 1,
      before: before ? { createdAt: before[0], operationId: before[1] } : undefined,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      requests: page.map((row) => {
        const run = this.store.getRun(row.taskId);
        const request = this.store.localAgent.project(row);
        const owed =
          request.state === "waiting_for_brief" && run
            ? clip(
                run.pendingPrompt.slice(0, row.briefLength),
                LOCAL_AGENT_LIMITS.noteChars,
              ).text
            : undefined;
        return {
          ...request,
          workspaceId: row.workspaceId,
          taskName: run?.name ?? "",
          targetDeleted: !run,
          ...(owed !== undefined ? { owedPreview: owed } : {}),
        };
      }),
      ...(rows.length > limit && last
        ? {
            nextCursor: encodeCursor("admin-requests", "", [
              last.createdAt,
              last.operationId,
            ]),
          }
        : {}),
    };
  }

  /**
   * An administrator gives up on a request.
   *
   * Only what provably never reached the orchestrator is withdrawn: a brief
   * still owed loses exactly its own bytes, and a queued message that was
   * never handed out is orphaned. Anything already handed to the agent cannot
   * be recalled, so it is only written off — as `abandoned_unknown` — once its
   * orchestrator has ended and nothing more can come of it.
   */
  dispose(operationId: string, body: unknown, actor: LocalAgentManager) {
    const input = LocalAgentDispositionSchema.parse(body);
    const ledger = this.store.localAgent;
    const row = ledger.get(operationId) ?? notFound("Request");
    if (row.version !== input.expectedRequestVersion || row.phase === "abandoned")
      throw new LocalAgentError(
        409,
        "stale_request",
        "The request changed since it was read. Reload it and try again.",
      );
    const at = new Date(this.now()).toISOString();
    const disposition = (action: "abandoned" | "abandoned_unknown") => ({
      action,
      reason: input.reason,
      at,
    });
    let result: LocalAgentLedgerEntry;
    let touchedRun: string | undefined;
    if (row.phase === "waiting_for_brief") {
      result = this.store.writeAtomically(() => {
        const run = this.store.getRun(row.taskId);
        if (run && ledger.briefStillOwed(row)) {
          if (input.expectedBriefDigest !== row.briefDigest)
            throw new LocalAgentError(
              409,
              "stale_request",
              "Name the digest of the brief you reviewed; it is what will be withdrawn.",
            );
          this.store.updateRun(run.id, {
            pendingPrompt: withoutBrief(run.pendingPrompt, row.briefLength!),
          });
          touchedRun = run.id;
        }
        return ledger.abandon(row.operationId, row.version, disposition("abandoned"));
      });
    } else {
      const record = row.deliveryId
        ? this.store.commands.prompt(row.deliveryId)
        : undefined;
      const handedOut = row.dispatchEverReserved || record?.receipt !== undefined;
      if (!record || (record.state === "orphaned" && !handedOut)) {
        result = ledger.abandon(row.operationId, row.version, disposition("abandoned"));
      } else if (record.state === "pending" && !handedOut) {
        result = this.store.writeAtomically(() => {
          this.store.commands.updatePrompt({ ...record, state: "orphaned" });
          return ledger.abandon(row.operationId, row.version, disposition("abandoned"));
        });
      } else if (record.state === "settled" || record.state === "rejected") {
        throw new LocalAgentError(
          409,
          "request_resolved",
          "The orchestrator already finished with this request; there is nothing to abandon.",
        );
      } else {
        const lead = this.store.getSession(row.leadSessionId);
        if (lead && !terminalSessionStates.has(lead.state))
          throw new LocalAgentError(
            409,
            "quiescence_required",
            "The orchestrator may already be acting on this request. Stop it, or wait for the delivery to settle, before writing it off.",
          );
        result = ledger.abandon(
          row.operationId,
          row.version,
          disposition("abandoned_unknown"),
        );
      }
    }
    if (touchedRun) {
      const run = this.store.getRun(touchedRun);
      if (run) this.service.publishRun(run);
    }
    this.audit("local_agent_request_abandoned", {
      actorKind: actor.kind,
      actorId: actor.id,
      targetId: row.operationId,
      detail: `${actor.username} abandoned ${row.kind} ${row.operationId} on task ${row.taskId} (${result.disposition?.action ?? "abandoned"}): ${input.reason}`,
    });
    return { request: ledger.project(result) };
  }

  /**
   * What an administrator may expose, for the Security card's pickers: every
   * live orchestrator and every workspace. A saved ID that no longer names one
   * of these grants nothing, and the card shows it as stale.
   */
  choices() {
    return {
      orchestrators: this.store
        .listSessions()
        .filter((session) => session.runRole === "lead" && !session.dismissed)
        .map((lead) => ({
          id: lead.id,
          name: lead.name || `Orchestrator ${lead.id.slice(0, 8)}`,
          state: lead.state,
          nodeName: this.store.getNode(lead.nodeId)?.name ?? lead.nodeName,
        })),
      workspaces: this.store.listWorkspaces().map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        kind: workspace.kind,
      })),
    };
  }

  /**
   * Saves what is exposed, refusing anything newly added that does not exist as
   * what it claims to be. An ID that was valid when saved and has since gone
   * stale may stay: it grants nothing, and refusing it would make every later
   * save — turning the API off included — wait on the operator to notice it.
   */
  updateConfig(
    body: unknown,
    actor: LocalAgentManager,
    mainPort: number,
  ): LocalAgentConfig {
    const input = LocalAgentConfigUpdateSchema.parse(body);
    const leads = [...new Set(input.allowedLeadSessionIds)];
    const workspaces = [...new Set(input.allowedWorkspaceIds)];
    const previous = this.config();
    for (const id of leads) {
      if (previous.allowedLeadSessionIds.includes(id)) continue;
      const lead = this.store.getSession(id);
      if (!lead || lead.runRole !== "lead" || lead.dismissed)
        throw badRequest(`${id} is not an orchestrator on this Host.`);
    }
    for (const id of workspaces) {
      if (previous.allowedWorkspaceIds.includes(id)) continue;
      if (!this.store.getWorkspace(id))
        throw badRequest(`${id} is not a workspace on this Host.`);
    }
    if (input.port === mainPort)
      throw badRequest("The local agent API needs its own port, not the Host's.");
    const saved = this.store.setLocalAgentConfig(
      {
        enabled: input.enabled,
        port: input.port,
        allowedLeadSessionIds: leads,
        allowedWorkspaceIds: workspaces,
      },
      input.expectedRevision,
    );
    if (!saved)
      throw new LocalAgentError(
        409,
        "stale_request",
        "Someone else changed these settings. Reload them and try again.",
      );
    this.audit("local_agent_config_changed", {
      actorKind: actor.kind,
      actorId: actor.id,
      detail: `${actor.username} ${saved.enabled ? (previous.enabled ? "updated" : "enabled") : previous.enabled ? "disabled" : "updated"} the local agent API on port ${saved.port}: ${saved.allowedLeadSessionIds.length} orchestrator(s), ${saved.allowedWorkspaceIds.length} workspace(s).`,
    });
    return saved;
  }
}

/** A transcript block without what a local agent has no use for (attachment names). */
function blockView(block: TerminalBlock): TerminalBlock {
  return {
    key: block.key,
    kind: block.kind,
    text: block.text,
    createdAt: block.createdAt,
    ...(block.status ? { status: block.status } : {}),
    ...(block.toolKind ? { toolKind: block.toolKind } : {}),
    ...(block.detail ? { detail: block.detail } : {}),
    ...(block.body ? { body: block.body } : {}),
  };
}

function cutBlock(block: TerminalBlock, chars: number): TerminalBlock {
  return {
    ...block,
    text: clip(block.text, chars).text,
    ...(block.body ? { body: clip(block.body, chars).text } : {}),
    ...(block.detail ? { detail: clip(block.detail, 1_000).text } : {}),
  };
}

export type { LocalAgentRequest };
