import { z } from "zod";
import {
  CriterionOutcomeSchema,
  HOST_YOLO_CAPABILITY,
  MANAGED_WORKTREES_CAPABILITY,
  WorkspaceModeSchema,
  AccessIntentSchema,
  PrMaintenanceCheckpointSchema,
  PrMaintenanceEnableSchema,
  prMaintenanceProviderLabel,
  prMaintenanceUrl,
  type PrMaintenanceAdmission,
  checkoutLockKey,
  type WorkspaceMode,
  isChatsWorkspace,
  RunCriterionSchema,
  canTransitionRun,
  isWritingCategory,
  terminalRunStates,
  terminalRunStepStates,
  terminalSessionStates,
  type CriterionOutcome,
  type FleetSession,
  type Placement,
  type Run,
  type RunCriterion,
  type RunStep,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { reservedSessionCount } from "../session-policy.js";
import { HANDOVER_SHAPE } from "./briefing.js";
import { archiveRun, purgeRun } from "./lifecycle.js";
import { decidePlacement, remainingCapacity } from "./schedule.js";
import { truncateMiddle, workerOutput } from "./engine.js";
import { CommandConflict } from "../command-execution-store.js";
import { PrMaintenanceError } from "../pr-maintenance-store.js";

/** The kinds of work an orchestrator can ask for, and what each one means. */
export const WORKER_CATEGORIES = [
  "implement",
  "test",
  "explore",
  "review-quick",
  "review-deep",
] as const;

/**
 * Every limit below is advertised to the caller, because `mcp-routes` builds
 * each tool's JSON Schema from these shapes rather than from a second
 * hand-written copy. A limit a model cannot see is one it will keep walking
 * into: the failure it produces arrives *after* the call, phrased as a schema
 * violation, at the point where the model believed it had just delegated the
 * work. Keeping the description and the constraint on the same line is what
 * stops the two drifting apart again.
 *
 * The free-text fields carry a minimum and no maximum, and the asymmetry is the
 * point. A minimum enforces the thing this tool exists to enforce — a brief with
 * no way to check it is refused before a machine is spent on it. A maximum only
 * enforces brevity, and brevity is not worth a refused dispatch: an orchestrator
 * relaying what a person said, what an earlier worker found, and the constraints
 * agreed along the way is doing exactly what `context` is for, and being stopped
 * for it teaches it to send less than the worker needed. Size is bounded once,
 * at the transport in `mcp-routes`, where it is a resource question rather than
 * a matter of taste.
 */
export const StartWorkSchema = z.object({
  category: z
    .enum(WORKER_CATEGORIES)
    .describe("What kind of work this is. Reviews are read-only."),
  /** Bounded because it is a label, not a brief: the UI renders it in a row. */
  title: z.string().min(1).max(120).describe("A short label, shown to the human."),
  /**
   * What the worker has to send back.
   *
   * These four replace a single free-text prompt on purpose. A blob lets a
   * dispatch leave out the part that matters and still look complete; asking
   * for the parts separately means a brief with no way to check it is refused
   * before a machine is spent on it, and means every worker gets told the same
   * things in the same order.
   */
  deliverable: z
    .string()
    .min(10, "deliverable must say what comes back concretely enough to recognise it")
    .describe(
      "What the worker must send back. A patch, an answer, a number, a passing suite — " +
        "concretely enough that you could tell whether you got it.",
    ),
  /** Where to work and where not to — files, directories, boundaries. */
  scope: z
    .string()
    .min(10, "scope must say where to work and where not to")
    .describe(
      "Where to work and where not to: the files or directories in play, and anything it " +
        "should leave alone.",
    ),
  /** The command or observation that will show the deliverable is real. */
  verify: z
    .string()
    .min(
      10,
      "verify must name the command to run or the observation to make. " +
        '"check it works" is not something a worker can do',
    )
    .describe(
      'The command or observation that will show the deliverable is real — "npm test -- auth", ' +
        '"curl the endpoint and read the status". Not "check it works".',
    ),
  /**
   * What the worker cannot find out for itself.
   *
   * It cannot see the orchestrator's conversation, the person's messages, or
   * any other worker's output. Anything decided elsewhere has to be repeated
   * here or it does not exist as far as the worker is concerned.
   *
   * Unbounded, because this is the field whose whole job is bulk relay, and the
   * cost of clipping it is paid by a worker that never finds out what it was not
   * told. What is left is a judgement the orchestrator makes rather than one the
   * schema makes for it: the worker can open the repository itself, so quoted
   * code spends the brief on something it could have looked up.
   */
  context: z
    .string()
    .optional()
    .describe(
      "What the worker cannot find out for itself. It cannot see this conversation, the " +
        "person's messages, or any other worker's output, so repeat anything decided elsewhere. " +
        "No length limit — though it can read the repository itself, so this goes further spent " +
        "on decisions and constraints than on quoted code.",
    ),
  workspace: z
    .string()
    .optional()
    .describe(
      "Which workspace to work in, by name. Defaults to the one the current task is already " +
        'using. Name one to work on a different repository, or "Chats" for a question or a ' +
        "piece of research that needs no checkout at all.",
    ),
  /**
   * Which machine, when it matters.
   *
   * The Host's own choice is capacity-driven and knows nothing else: it cannot
   * see that one machine has the GPU, the signing key, the licensed toolchain
   * or the only copy of a dependency. Optional because that is the exception —
   * a run that names a machine for every step has given up the fleet's ability
   * to spread work and gets a refusal instead of a slower node.
   */
  node: z
    .string()
    .optional()
    .describe(
      "Which machine to run on, by name from fleet_list_nodes. Leave this out unless the " +
        "work genuinely needs a particular machine — hardware, credentials or a toolchain " +
        "only it has. The Host otherwise picks the one with the most free capacity, and " +
        "naming a busy machine gets a refusal rather than a slower one.",
    ),
  /**
   * Which piece of work this belongs to.
   *
   * Steps under one task share a budget, a checkout once something has been
   * written, and a place in the UI; unrelated errands should not. Omitting it
   * continues whatever was started last, so a single line of work never has to
   * think about this at all.
   */
  task: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "The task's stable ID from fleet_list_work, or its exact name. Prefer the ID. " +
        "A new name opens a separate task; never use that as a fallback for a failed lookup. " +
        "Omit to continue the most recent open task. This creates a NEW worker: use " +
        "fleet_follow_up for another revision by an existing worker.",
    ),
});

/**
 * The brief a worker actually receives.
 *
 * Composed by the Host rather than by the orchestrator, so every session gets
 * the same shape whichever model dispatched it — and so the closing line, which
 * is the one that decides whether a worker checks its own work, cannot be
 * dropped by a model in a hurry.
 */
export function composeWorkerPrompt(input: {
  title: string;
  deliverable: string;
  scope: string;
  verify: string;
  context?: string | undefined;
}): string {
  return [
    `TASK: ${input.title}`,
    "",
    `DELIVERABLE`,
    input.deliverable,
    "",
    `SCOPE`,
    input.scope,
    "",
    `VERIFY`,
    input.verify,
    ...(input.context ? ["", `CONTEXT`, input.context] : []),
    "",
    "Do the verification before you answer, and say what it produced. If you",
    "could not, say that instead — an unchecked claim is worse than an honest",
    "gap, because it will be believed.",
  ].join("\n");
}

export const PlanTaskSchema = z.object({
  workspaceMode: WorkspaceModeSchema.optional().describe(
    "Auto uses the current app default for NEW tasks only. Existing task bindings never change.",
  ),
  accessIntent: AccessIntentSchema.optional().describe(
    "Use no-checkout only for nonrepository work in Chats. Shell-capable repository work always requires a checkout lease.",
  ),
  task: z.string().min(1).max(80).describe("A short name for this piece of work."),
  objective: z
    .string()
    .min(1)
    .describe("What finishing it means, in a sentence the person would recognise."),
  /**
   * The stages this task will go through, in order.
   *
   * Chosen per task rather than fixed. A small fix can use one phase including
   * verification; add investigation or independent review when warranted.
   * The list is what the person sees as progress, so use meaningful names.
   */
  phases: z
    .array(z.string().min(1).max(40))
    .min(1)
    .max(8)
    .describe(
      "The stages, in order. Choose the fewest justified by complexity, uncertainty and risk: " +
        '["Implement and verify"] for a simple fix, ["Inspect", "Implement and verify"] or ' +
        '["Implement and verify", "Review"] when one extra handoff adds value, ' +
        '["Plan", "Implement and verify", "Review"] for substantial or high-risk work. ' +
        "Names are shown to the person as progress. Between one and eight.",
    ),
  /**
   * What has to be observably true for this task to be finished.
   *
   * Required, and required *here* — before any work goes out. A definition of
   * done arrived at afterwards describes what happened instead of testing it,
   * and an orchestrator with no written definition decides done by feel after
   * reading a great deal of plausible output.
   */
  successCriteria: z
    .array(RunCriterionSchema)
    .min(1)
    .max(8)
    .describe(
      "What has to be observably true before this task is done. Write these now, not later — " +
        "you will be held to them when you hand the task over, and an essential one that is " +
        "not met blocks the handover.",
    ),
  /** One line: the exact observable state that ends this task. */
  stopWhen: z
    .string()
    .min(10)
    .describe(
      "One line naming the observable state that ends this task, so you can tell finished " +
        "from nearly finished.",
    ),
  workspace: z
    .string()
    .optional()
    .describe(
      'Which workspace this task is about, by name. "Chats" for a question or a piece of ' +
        "research that needs no checkout.",
    ),
});

export const TaskRefSchema = z.object({
  task: z
    .string()
    .min(1)
    .max(80)
    .describe(
      "The task's stable ID from fleet_list_work, or its exact name. Prefer the ID: " +
        "names can change or be ambiguous. Only tasks owned by this orchestrator are accessible.",
    ),
});

export const ListWorkSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Search this orchestrator's open AND closed tasks by keywords, PR number, task/session ID, " +
        "workspace, objective, worker briefs/output or notes. All words must match. " +
        "Omit to browse; this is not a host-wide session search.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Tasks per page, from 1 to 100. Defaults to 20."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of matching tasks to skip. Defaults to 0."),
});

export const AdvanceTaskSchema = TaskRefSchema.extend({
  /** What this phase established, in a sentence, for the person reading later. */
  note: z
    .string()
    .min(1)
    .describe(
      "What this phase established, in a sentence. The person reads these as the story of the task.",
    ),
});

export const SubmitTaskSchema = TaskRefSchema.extend({
  /** What was done and what the person should look at. */
  summary: z
    .string()
    .min(1)
    .describe(
      "The report a person reads before approving or sending this back. Markdown, written to be " +
        "scanned: a bold one-line verdict, then short `###` sections — what was done, how it was " +
        "proven, what to look at first, what is still unverified — with bullets under each. " +
        "One unbroken paragraph is refused. Keep it short; the criteria below carry the evidence.",
    ),
  /**
   * How each criterion turned out, and what shows it.
   *
   * One entry per criterion, because the alternative — a summary and a wave of
   * the hand — is exactly what criteria exist to replace. An orchestrator that
   * cannot say what proves a criterion has not established it.
   */
  criteria: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(40)
          .describe("The criterion id you set when planning the task."),
        outcome: CriterionOutcomeSchema.describe(
          "met = you checked and it holds. blocked = it could not be checked at all. " +
            "Neither of the last two lets the task be handed over.",
        ),
        /** The observable behind the claim. Not "looks correct". */
        evidence: z
          .string()
          .min(10)
          .describe(
            "The observation behind that. A command and what it printed, a test that ran, a file you read. " +
              'A worker saying it was done is not evidence; "looks correct" is not evidence.',
          ),
      }),
    )
    .max(8)
    .default([])
    .describe("One entry per criterion of this task."),
});

export const SessionRefSchema = z.object({
  sessionId: z.string().min(1).describe("The worker's session id."),
});

/**
 * The way out when a task cannot be finished as promised.
 *
 * Needed because the criteria gate is deliberately unsympathetic: an essential
 * criterion that cannot be met stops `fleet_submit_task`, and without this the
 * orchestrator has no legal move left. Being stuck is not a reason to let it
 * quietly lower the bar instead — dropping a criterion is a person's decision,
 * so the task goes to them with the obstacle named.
 */
export const EscalateSchema = TaskRefSchema.extend({
  /** What is in the way, concretely enough for a person to act on. */
  reason: z
    .string()
    .min(10)
    .describe(
      "What is in the way, concretely enough for a person to act on: what you tried, what " +
        "happened, and what you would need in order to continue.",
    ),
  maintenance: z
    .object({
      recordId: z.string().min(1),
      expectedVersion: z.number().int().positive(),
      decisionId: z.string().min(1).max(200),
    })
    .strict()
    .optional()
    .describe(
      "Pause the whole registered PR for this stable decision. Retries preserve the existing human question.",
    ),
});

export const FollowUpSchema = SessionRefSchema.extend({
  prompt: z.string().min(1).describe("What it should do next."),
  maintenance: z
    .object({
      recordId: z.string().min(1),
      generation: z.number().int().positive(),
      batchId: z.string().min(1).max(200),
    })
    .strict()
    .optional()
    .describe(
      "Link this turn to the exact prepared PR-maintenance batch. The prompt must match its persisted prompt byte for byte.",
    ),
});

export const SetPrMaintenanceSchema = z
  .object({
    recordId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    action: z.enum(["enable", "pause", "resume", "release"]),
    reason: z.string().min(1).max(8_192).optional(),
  })
  .strict();

export const ProposePrMaintenanceSchema = PrMaintenanceEnableSchema.extend({
  expectedVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Current pending proposal version when replacing its contents. Omit for the first proposal.",
    ),
});

export const GetPrMaintenanceSchema = z
  .object({
    recordId: z.string().min(1).optional(),
    taskId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Read an owned task's pending authorization proposal and retained registration.",
      ),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    takeDue: z.boolean().default(false),
    reserveRequests: z.number().int().min(1).max(40).optional(),
  })
  .strict();

export const CheckpointPrMaintenanceSchema = z
  .object({
    recordId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    checkpoint: PrMaintenanceCheckpointSchema,
  })
  .strict();

/**
 * Ending a task that is not going to be handed over.
 *
 * The third ending, next to submitting and escalating, and the one that was
 * missing: a task can stop being worth doing. The request is withdrawn, another
 * task turns out to cover it, or what it was for no longer exists. Without this
 * the orchestrator's only honest move was to escalate — sending a person a
 * decision they had already made — and its dishonest one was to leave the task
 * open forever.
 *
 * A reason is required for the same reason every other ending needs one: the
 * record outlives the conversation the decision was made in.
 */
export const CloseTaskSchema = TaskRefSchema.extend({
  reason: z
    .string()
    .min(10)
    .describe(
      "Why this task is not going to be finished — what changed, or what covers it instead. " +
        "This is what the record will say, so write it for someone who was not in the conversation.",
    ),
});

/**
 * Taking a task back, whether a person is holding it or it is already closed.
 *
 * Both directions matter and neither had a tool. A task in review is frozen —
 * submitting and advancing both refuse while a person holds it — so an
 * orchestrator told "wait, also do X" in conversation had nothing to call and
 * could only wait for a button. A finished task has the opposite problem: its
 * criteria, notes and steps are exactly the context the follow-up work needs,
 * and a fresh task starts with none of it.
 */
export const ReopenTaskSchema = TaskRefSchema.extend({
  reason: z
    .string()
    .min(10)
    .describe(
      "What is still wanted, concretely. This is appended to the task's notes and read " +
        "alongside the criteria it was already held to.",
    ),
});

/**
 * Removing a task, record and all.
 *
 * Guarded rather than offered freely. The real use is a task that should not
 * exist — opened twice, named wrongly, or planned against a misread request —
 * and for that, deleting is tidier than leaving a cancelled ghost on the board.
 * Once a task has dispatched work or written a note it has a record, and a
 * record is a person's to destroy; the tool refuses and points at closing
 * instead, which keeps what was learned.
 */
export const DiscardTaskSchema = TaskRefSchema.extend({
  reason: z
    .string()
    .min(10)
    .describe(
      "Why this task should not exist. Said to the person reading along, not filed.",
    ),
});

export type ToolResult = { ok: boolean; text: string };

type Continuation = {
  action:
    | "follow_up"
    | "resume"
    | "reopen_task"
    | "queued"
    | "in_flight"
    | "wait_for_human"
    | "wait"
    | "restore_session"
    | "replace_worker"
    | "unavailable";
  reason: string;
};

const ok = (text: string): ToolResult => ({ ok: true, text });
const refuse = (text: string): ToolResult => ({ ok: false, text });

/** Follows an issue's path into the arguments, to report what was actually sent. */
function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** One schema complaint, in the terms of what the caller actually sent. */
function describeIssue(issue: z.core.$ZodIssue, args: unknown): string {
  const field = issue.path.length > 0 ? issue.path.join(".") : "(the call itself)";
  const value = valueAtPath(args, issue.path);
  const count = (n: number | bigint) => Number(n).toLocaleString("en-US");

  if (issue.code === "too_big" && typeof value === "string") {
    return `${field}: ${issue.message} — it was ${count(value.length)} characters, and the limit is ${count(issue.maximum)}.`;
  }
  if (issue.code === "too_big" && Array.isArray(value)) {
    return `${field}: ${issue.message} — it had ${count(value.length)} entries, and the limit is ${count(issue.maximum)}.`;
  }
  if (issue.code === "invalid_type" && value === undefined) {
    return `${field}: missing, and required.`;
  }
  return `${field}: ${issue.message}`;
}

/**
 * What a caller is told when its arguments do not fit the schema.
 *
 * A net rather than the usual path: the MCP server validates against this same
 * schema before a handler runs, and each limit carries its own message, so this
 * only fires if those two ever come apart. It exists because of what the
 * default is — Zod's `ZodError.message` is a JSON array of issue objects, which
 * reads to a model as a malfunction rather than as something it did, and says
 * nothing about the fact that decides what to do next: that the call had no
 * effect. A model that cannot tell a rejected dispatch from a failed one will
 * either give up on work it could have had by shortening a field, or settle
 * down to wait for a worker that was never started.
 */
export function explainInvalidArgs(
  tool: string,
  error: z.ZodError,
  args: unknown,
): ToolResult {
  return refuse(
    [
      `${tool} did nothing: the call did not fit the tool's schema.`,
      ...error.issues.map((issue) => `  ${describeIssue(issue, args)}`),
      "",
      "Nothing was started and no budget was spent. Every limit is in this tool's schema,",
      "so fix what is listed above and call it again.",
    ].join("\n"),
  );
}

/** What the orchestrator is told once a task has its phases. */
function planTaskReply(run: Run): string {
  const { name, phases, successCriteria: criteria } = run;
  return [
    `Planned "${name}".`,
    `  task id: ${run.id} (use this as task in later calls)`,
    `  phases: ${phases.join(" → ")}`,
    `  now on: ${phases[0]}`,
    `  done when: ${criteria.length} criteria are met`,
    ...criteria.map(
      (c) => `    ${c.id}${c.essential ? "" : " (optional)"}: ${c.scenario}`,
    ),
    "",
    "Those criteria are what fleet_submit_task will hold you to. You will have to",
    "say how each one turned out and what shows it, so gather the evidence as you",
    "go rather than reconstructing it at the end.",
    "",
    "Dispatch the work for this phase, then end your turn. When you are woken,",
    "check what came back: call fleet_advance_task if the phase is done, or",
    "dispatch more work if it is not.",
  ].join("\n");
}

/**
 * Whether a task may be handed over, given what it promised and what came back.
 *
 * The whole point of writing criteria down at plan time is that something other
 * than the model's mood decides whether they were met. So this is deliberately
 * unsympathetic: an essential criterion that is unmet, blocked, or simply not
 * mentioned stops the handover. Optional ones are recorded and ignored.
 *
 * It does not judge the *evidence* — no code can tell a real observation from a
 * confident sentence. What it can do is make the orchestrator write one down per
 * criterion, next to the claim, where a person will read them together.
 */
function judgeCriteria(
  promised: readonly RunCriterion[],
  reported: readonly { id: string; outcome: CriterionOutcome; evidence: string }[],
): { refusal?: string; record: string } {
  if (promised.length === 0) return { record: "" };

  const byId = new Map(reported.map((entry) => [entry.id, entry]));
  const unknown = reported.filter((entry) => !promised.some((c) => c.id === entry.id));
  if (unknown.length > 0) {
    return {
      record: "",
      refusal:
        `No criterion called ${unknown.map((e) => `"${e.id}"`).join(", ")} on this task. ` +
        `Its criteria are: ${promised.map((c) => c.id).join(", ")}.`,
    };
  }

  const missing = promised.filter((c) => c.essential && !byId.has(c.id));
  if (missing.length > 0) {
    return {
      record: "",
      refusal:
        `Say how ${missing.map((c) => `"${c.id}"`).join(", ")} turned out before handing this over.\n` +
        missing
          .map((c) => `  ${c.id}: ${c.scenario}\n    expects: ${c.expectedEvidence}`)
          .join("\n"),
    };
  }

  const failed = promised.filter((c) => c.essential && byId.get(c.id)?.outcome !== "met");
  if (failed.length > 0) {
    return {
      record: "",
      refusal:
        `${failed.length} of this task's criteria are not met, so it is not finished:\n` +
        failed
          .map((c) => `  ${c.id} (${byId.get(c.id)!.outcome}): ${c.scenario}`)
          .join("\n") +
        `\n\nDispatch work to close them. If one cannot be met at all, say so with ` +
        `fleet_escalate — a person decides whether to drop a criterion, not you.`,
    };
  }

  return {
    record:
      "\n\n### Checked against what this task promised\n\n" +
      promised
        .map((c) => {
          const entry = byId.get(c.id);
          if (!entry) return `- **${c.id}** *(optional)* — not reported`;
          return `- **${c.id}** — ${entry.outcome}\n  ${entry.evidence.trim()}`;
        })
        .join("\n"),
  };
}

/**
 * Whether a handover can be read, which is a different question from whether it
 * is true. Nothing here can tell an honest report from a confident one.
 *
 * Only long summaries are held to it. A one-line answer to a one-line question
 * needs no headings, and demanding them would turn this into ceremony. A wall
 * of prose is where the reader actually loses, so that is where it bites.
 */
const PROSE_WALL = 320;

function judgeSummary(summary: string): string | undefined {
  const text = summary.trim();
  if (text.length <= PROSE_WALL) return undefined;
  const structured = /^\s{0,3}(#{1,6} |[-*+] |\d+[.)] |> |\|)/m.test(text);
  if (structured) return undefined;

  return [
    `That summary is ${text.length} characters of unbroken prose, and it is the only thing`,
    "a person sees before approving this or sending it back. Nothing else was changed:",
    "the task is still yours, so call this again with the same criteria and a summary",
    "they can scan.",
    "",
    HANDOVER_SHAPE,
    "",
    "Drop any section that has nothing in it. Keep it short — the criteria you report",
    "carry the evidence, so the summary does not have to repeat it.",
  ].join("\n");
}

/**
 * What an orchestrator session is allowed to do, and nothing else.
 *
 * Every call is scoped to one lead session, which is resolved from the bearer
 * token before this is reached — so an orchestrator cannot name another one's
 * run, and a worker has no token at all.
 *
 * Refusals are returned as text rather than thrown. A model that gets an
 * exception tends to retry it; a model that is told "that node is full, here
 * is what is free" tends to pick something else.
 */
export class FleetTools {
  constructor(
    private readonly service: FleetService,
    private readonly leadSessionId: string,
  ) {}

  private get store() {
    return this.service.store;
  }

  private maintenanceRefusal(input: PrMaintenanceAdmission): ToolResult | undefined {
    const result = this.store.prMaintenance.admission({
      ...input,
      leadSessionId: this.leadSessionId,
    });
    if (result.allowed) return undefined;
    return refuse(
      `PR maintenance ${result.recordId}: ${result.reason}` +
        (result.decisionId ? `; decision ${result.decisionId}` : "") +
        ". Read fleet_get_pr_maintenance. Do not reopen, replace the worker, or bypass this gate.",
    );
  }

  private maintenanceResult(action: () => unknown): ToolResult {
    try {
      return ok(JSON.stringify(action()));
    } catch (error) {
      if (error instanceof PrMaintenanceError) {
        return refuse(`${error.code}: ${error.message}`);
      }
      throw error;
    }
  }

  private requireMaintenanceVisit(recordId: string, admitOperation: boolean): string {
    const registry = this.store.prMaintenance;
    const wakeId = this.store.getSessionDispatchAttempt(this.leadSessionId)?.commandId;
    if (!wakeId)
      throw new PrMaintenanceError(
        "wake_required",
        "This operation needs an existing Host-recorded lead turn.",
      );
    const wake = registry.beginWake(this.leadSessionId, wakeId);
    if (!wake.visitedIds.includes(recordId)) {
      throw new PrMaintenanceError(
        "visit_required",
        "Claim the persisted oldest-due PR with takeDue before admitting maintenance work.",
      );
    }
    const remaining = registry.remainingWake(this.leadSessionId, wakeId);
    if (admitOperation && (!remaining.requests || !remaining.milliseconds)) {
      throw new PrMaintenanceError(
        "wake_exhausted",
        "End this maintenance pass; only receipt reconciliation remains available.",
      );
    }
    return wakeId;
  }

  setPrMaintenance(input: z.infer<typeof SetPrMaintenanceSchema>): ToolResult {
    return this.maintenanceResult(() => {
      const record = this.store.prMaintenance.set(this.leadSessionId, {
        id: input.recordId,
        expectedVersion: input.expectedVersion,
        action: input.action,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      this.service.cancelPausedPrMaintenance();
      this.service.publishSnapshot();
      return record;
    });
  }

  proposePrMaintenance(input: z.infer<typeof ProposePrMaintenanceSchema>): ToolResult {
    return this.maintenanceResult(() => {
      const { expectedVersion, ...registration } = input;
      const proposal = this.service.notifications.commitAtomically(() => {
        const previous = this.store.prMaintenance.getProposal(
          registration.taskId,
          this.leadSessionId,
        );
        const proposed = this.store.prMaintenance.propose(
          this.leadSessionId,
          registration,
          expectedVersion,
        );
        if (previous && previous.version !== proposed.version)
          this.service.notifications.resolvePrMaintenanceProposal(previous);
        this.service.notifications.createPrMaintenanceProposal(proposed);
        return proposed;
      });
      this.service.publishSnapshot();
      return {
        proposalId: proposal.id,
        version: proposal.version,
        taskId: proposal.registration.taskId,
        status: "awaiting_operator_authorization",
        instruction:
          "Nothing is enabled. The operator can open the task's PR maintenance panel and review the prefilled proposal. Do not ask them to copy JSON or dispatch maintenance work. End your turn.",
      };
    });
  }

  getPrMaintenance(input: z.input<typeof GetPrMaintenanceSchema> = {}): ToolResult {
    const parsed = GetPrMaintenanceSchema.parse(input);
    return this.maintenanceResult(() => {
      const registry = this.store.prMaintenance;
      if (parsed.taskId) {
        if (parsed.recordId || parsed.takeDue || parsed.reserveRequests)
          throw new PrMaintenanceError(
            "invalid_scan",
            "Read task context separately from a record or due-work claim.",
          );
        if (this.store.getRun(parsed.taskId)?.leadSessionId !== this.leadSessionId)
          throw new PrMaintenanceError(
            "ownership",
            "That task does not belong to this lead.",
          );
        return {
          ...registry.list({
            leadSessionId: this.leadSessionId,
            taskId: parsed.taskId,
            retainedOnly: true,
            limit: parsed.limit,
            ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
          }),
          proposal: registry.getProposal(parsed.taskId, this.leadSessionId) ?? null,
        };
      }
      if (parsed.recordId) {
        const record = registry.get(parsed.recordId, this.leadSessionId);
        if (!record)
          throw new PrMaintenanceError("not_found", "Maintenance record not found.");
        if (parsed.takeDue || parsed.reserveRequests) {
          throw new PrMaintenanceError(
            "invalid_scan",
            "Claim oldest-due work without a record ID.",
          );
        }
        return record;
      }
      // The caller cannot invent a wake ID to reset the per-turn allowance.
      const wakeId = this.store.getSessionDispatchAttempt(this.leadSessionId)?.commandId;
      if (parsed.takeDue) {
        if (!wakeId) {
          throw new PrMaintenanceError(
            "wake_required",
            "A recorded lead turn is required to claim maintenance work.",
          );
        }
        registry.beginWake(this.leadSessionId, wakeId);
        return this.store.writeAtomically(() => {
          const record = registry.takeDue(this.leadSessionId, wakeId);
          const allowance = registry.remainingWake(this.leadSessionId, wakeId);
          if (!record) return { record: null, allowance };
          const requests = Math.min(parsed.reserveRequests ?? 8, allowance.requests);
          registry.chargeWake(this.leadSessionId, wakeId, { requests, milliseconds: 0 });
          return {
            record,
            observationAllowance: { requests, milliseconds: allowance.milliseconds },
            allowance: registry.remainingWake(this.leadSessionId, wakeId),
            instruction:
              "Allowance is reserved, including lost responses. Run the bounded helper once, checkpoint its result, and do not reclaim this visit. Paused/terminal records permit reconciliation only.",
          };
        });
      }
      if (parsed.reserveRequests) {
        throw new PrMaintenanceError("invalid_scan", "reserveRequests requires takeDue.");
      }
      const page = registry.list({
        leadSessionId: this.leadSessionId,
        limit: parsed.limit,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      });
      return {
        ...page,
        records: page.records.map((record) => ({
          id: record.id,
          version: record.version,
          generation: record.generation,
          taskId: record.taskId,
          workerSessionId: record.workerSessionId,
          identity: record.identity,
          lifecycle: record.lifecycle,
          pauseReason: record.pauseReason,
          lastSuccessAt: record.lastSuccessAt,
          nextCheckAt: record.nextCheckAt,
          decision: record.decision,
          ownershipReleasedAt: record.ownershipReleasedAt,
          counters: record.counters,
          pendingBatches: record.batches
            .filter((batch) =>
              ["prepared", "accepted", "reconciling", "uncertain"].includes(batch.state),
            )
            .map((batch) => ({ id: batch.id, state: batch.state })),
        })),
        instruction:
          "Read a record by ID for its complete checkpoint; use takeDue for a persisted oldest-due visit and bounded helper allowance.",
      };
    });
  }

  checkpointPrMaintenance(
    input: z.infer<typeof CheckpointPrMaintenanceSchema>,
  ): ToolResult {
    return this.maintenanceResult(() => {
      const record = this.store.writeAtomically(() => {
        const registry = this.store.prMaintenance;
        if (input.checkpoint.kind === "prepare_batch") {
          this.requireMaintenanceVisit(input.recordId, true);
        }
        if (
          input.checkpoint.kind === "observation" ||
          (input.checkpoint.kind === "action" &&
            input.checkpoint.effect.state === "reserved")
        ) {
          const wakeId = this.requireMaintenanceVisit(
            input.recordId,
            input.checkpoint.kind === "action",
          );
          if (
            input.checkpoint.kind === "action" &&
            input.checkpoint.effect.kind !== "notification"
          ) {
            const effect = input.checkpoint.effect;
            const previous = registry
              .get(input.recordId, this.leadSessionId)
              ?.actions.find((entry) => entry.key === effect.key);
            const requests = effect.attempts - (previous?.attempts ?? 0);
            if (requests > 0) {
              if (
                requests > registry.remainingWake(this.leadSessionId, wakeId).requests
              ) {
                throw new PrMaintenanceError(
                  "wake_exhausted",
                  "Not enough lead request allowance; end this maintenance pass.",
                );
              }
              registry.chargeWake(this.leadSessionId, wakeId, {
                requests,
                milliseconds: 0,
              });
            }
          }
        }
        return registry.checkpoint(
          this.leadSessionId,
          input.recordId,
          input.expectedVersion,
          input.checkpoint,
        );
      });
      this.service.cancelPausedPrMaintenance();
      this.service.publishSnapshot();
      return record;
    });
  }

  /** Every task this orchestrator is running, newest last. */
  private runs(): Run[] {
    return this.store
      .listRuns()
      .filter((run) => run.leadSessionId === this.leadSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * The task a call belongs to.
   *
   * Named tasks are found or opened; an unnamed call continues the most recent
   * live one. An orchestrator is long-lived and will be asked for unrelated
   * things over its life, and putting those in one bucket meant they shared a
   * budget and a checkout for no reason anyone could see.
   */
  private run(task?: string): Run | ToolResult | undefined {
    const runs = this.runs();
    if (!task) {
      const live = runs.filter((run) => !terminalRunStates.has(run.state));
      return live[live.length - 1] ?? runs[runs.length - 1];
    }
    const wanted = task.trim().toLowerCase();
    const byId = runs.find((run) => run.id.toLowerCase() === wanted);
    if (byId) return byId;
    const matches = runs.filter((run) => run.name.trim().toLowerCase() === wanted);
    if (matches.length > 1) {
      return refuse(
        [
          `The task name "${task}" is ambiguous in this orchestrator. Nothing was changed.`,
          "Use one of these stable task IDs as task; no match was chosen automatically:",
          ...matches.map(
            (run) => `  ${run.id}: ${JSON.stringify(run.name)} (${run.state})`,
          ),
        ].join("\n"),
      );
    }
    return matches[0];
  }

  private missingTask(task: string): ToolResult {
    const recent = this.runs().slice(-10).reverse();
    return refuse(
      [
        `No task matching "${task}" is visible to this orchestrator (${this.leadSessionId}). Nothing was changed.`,
        "This is an exact ID/name lookup, not a search. It does not prove that the earlier worker conversation was deleted.",
        "Call fleet_list_work with a short query such as the PR number, then fleet_get_task with the returned task ID.",
        "Closed tasks are included. Tasks owned by another orchestrator are not: use the owning orchestrator rather than recreating its work here.",
        ...(recent.length
          ? [
              "Recent tasks in this scope (use the ID as task):",
              ...recent.map(
                (run) => `  ${run.id}: ${JSON.stringify(run.name)} (${run.state})`,
              ),
            ]
          : ["There are no task records in this orchestrator's scope."]),
      ].join("\n"),
    );
  }

  private requireTask(task: string): Run | ToolResult {
    return this.run(task) ?? this.missingTask(task);
  }

  /** Opens a task, so the orchestrator can start one without asking a human. */
  private openTask(
    name: string,
    phases: readonly string[] = [],
    done: {
      successCriteria?: readonly RunCriterion[];
      stopWhen?: string;
      objective?: string;
      workspaceId?: string;
      workspaceMode?: WorkspaceMode | undefined;
      accessIntent?: "checkout" | "no-checkout" | undefined;
    } = {},
  ): Run | undefined {
    const lead = this.store.getSession(this.leadSessionId);
    if (!lead) return undefined;
    const template = this.runs()[0];
    const activeAdministrators = this.store
      .listAdministrators()
      .filter((administrator) => !administrator.disabledAt);
    const run = this.store.createRun({
      workspaceMode: done.workspaceMode ?? "auto",
      integrationUsername:
        template?.workspaceBinding?.integrationUsername ||
        lead.operatorUsername ||
        (activeAdministrators.length === 1 ? activeAdministrators[0]!.username : "") ||
        "operator",
      accessIntent: isChatsWorkspace(done.workspaceId ?? lead.workspaceId)
        ? "no-checkout"
        : "checkout",
      workspaceId: done.workspaceId ?? lead.workspaceId,
      name,
      objective: done.objective ?? name,
      phases,
      successCriteria: done.successCriteria ?? [],
      stopWhen: done.stopWhen ?? "",
      policy: {
        ...(template ? template.policy : {}),
        wakePolicy: "on_any_settle",
        onStepFailure: "wake",
      },
    });
    const opened = this.store.updateRun(run.id, {
      leadSessionId: this.leadSessionId,
      state: "running",
    });
    void this.service.worktrees.prepare(run.id);
    return opened;
  }

  /** The phase a task is on, as a line to show the model. */
  private phaseLine(run: Run): string {
    if (run.phases.length === 0) return "no phases";
    const name = run.phases[run.phaseIndex] ?? "done";
    return `phase ${run.phaseIndex + 1}/${run.phases.length}: ${name}`;
  }

  /**
   * Opens a task and says what stages it will go through.
   *
   * Separate from dispatching because the plan is a decision in its own right,
   * and because a person watching wants to see the shape of the work before
   * the first worker starts rather than inferring it from what has run so far.
   */
  planTask(input: z.infer<typeof PlanTaskSchema>): ToolResult {
    const existing = this.run(input.task);
    if (existing && "ok" in existing) return existing;
    if (existing) {
      const held = this.maintenanceRefusal({ action: "advance", taskId: existing.id });
      if (held) return held;
    }
    if (existing?.state === "awaiting_human") {
      return refuse(
        `"${existing.name}" is with the person for review. Take it back with ` +
          `fleet_reopen_task (task: "${existing.id}") before changing its plan or workers.`,
      );
    }
    const workspaceName = input.workspace?.trim().toLowerCase();
    const workspaces = input.workspace
      ? this.store
          .listWorkspaces()
          .filter((workspace) => workspace.name.trim().toLowerCase() === workspaceName)
      : [];
    if (input.workspace && workspaces.length !== 1) {
      return refuse(
        `Workspace "${input.workspace}" is ${workspaces.length ? "ambiguous" : "unknown"}. ` +
          "Nothing was planned. Use fleet_list_nodes to find the exact workspace name.",
      );
    }
    const workspaceId =
      workspaces[0]?.id ??
      existing?.workspaceId ??
      this.store.getSession(this.leadSessionId)?.workspaceId;
    if (!workspaceId) {
      return refuse("Could not open that task. Ask a human to restart the orchestrator.");
    }
    if (
      existing &&
      existing.workspaceId !== workspaceId &&
      (this.store.listRunSteps(existing.id).length > 0 ||
        existing.workspaceBinding?.effectiveMode === "managed")
    ) {
      return refuse(
        "That task already has workers in its original workspace. Do not move its context " +
          "to another checkout; name workspace on distinct work instead.",
      );
    }
    /*
     * A task a person opened arrives here already created — the Host makes the
     * run and briefs the orchestrator in one call, so the record cannot go
     * missing if the brief does. Planning it is exactly what this is for, so an
     * unplanned task is adopted rather than refused.
     */
    if (
      existing &&
      existing.phases.length === 0 &&
      !terminalRunStates.has(existing.state)
    ) {
      const planned = this.store.updateRun(existing.id, {
        objective: input.objective,
        workspaceId,
        phases: input.phases,
        phaseIndex: 0,
        successCriteria: input.successCriteria,
        stopWhen: input.stopWhen,
      })!;
      this.service.publishRun(planned);
      return ok(planTaskReply(planned));
    }
    if (existing) {
      /*
       * A closed task keeps its name, and until closing was possible that was
       * rare enough to ignore. It is not now: an orchestrator that closes
       * "Fix login" and is later asked for it again would be refused and told
       * to dispatch into a cancelled run, which refuses in turn. Reopening is
       * what it actually wants — the criteria and notes are still there.
       */
      if (terminalRunStates.has(existing.state)) {
        return refuse(
          `"${existing.name}" already exists and is ${existing.state}. ` +
            `Reopen it with fleet_reopen_task, which keeps its criteria and notes, ` +
            `or plan this under a different name.`,
        );
      }
      return refuse(
        `"${existing.name}" already exists (${this.phaseLine(existing)}). ` +
          `Read it with fleet_get_task (task: "${existing.id}"). Use fleet_follow_up for ` +
          `the same deliverable, or fleet_start_work for a genuinely different unit of work.`,
      );
    }
    const run = this.openTask(input.task, input.phases, {
      workspaceMode: input.workspaceMode,
      accessIntent: input.accessIntent,
      successCriteria: input.successCriteria,
      stopWhen: input.stopWhen,
      objective: input.objective,
      workspaceId,
    });
    if (!run) {
      return refuse("Could not open that task. Ask a human to restart the orchestrator.");
    }
    this.service.publishRun(run);
    return ok(planTaskReply(run));
  }

  /**
   * Moves a task to its next phase.
   *
   * The orchestrator's own judgement, not a person's. It has read what the
   * worker produced and decided the phase is finished; if it has not, the
   * answer is more work rather than this.
   */
  advanceTask(input: z.infer<typeof AdvanceTaskSchema>): ToolResult {
    const run = this.requireTask(input.task);
    if ("ok" in run) return run;
    const held = this.maintenanceRefusal({ action: "advance", taskId: run.id });
    if (held) return held;
    if (terminalRunStates.has(run.state)) {
      return refuse(`"${run.name}" is already closed.`);
    }
    if (run.state === "awaiting_human") {
      return refuse(`"${run.name}" is with the person for review. Wait for them.`);
    }
    if (run.phases.length === 0) {
      return refuse(
        `"${run.name}" has no phases, so there is nothing to advance. ` +
          `Call fleet_submit_task when the work is done.`,
      );
    }

    const live = this.store
      .listRunSteps(run.id)
      .filter((step) => !terminalRunStepStates.has(step.state));
    if (live.length > 0) {
      return refuse(
        `${live.length} step(s) of "${run.name}" are still running. ` +
          `Wait to be woken — you cannot judge a phase you have not seen the end of.`,
      );
    }

    const next = run.phaseIndex + 1;
    if (next >= run.phases.length) {
      return refuse(
        `"${run.phases[run.phaseIndex]}" is the last phase of "${run.name}". ` +
          `Call fleet_submit_task to hand it to the person.`,
      );
    }
    const moved = this.store.updateRun(run.id, { phaseIndex: next })!;
    this.store.appendRunNote(run.id, run.phaseIndex, input.note);
    this.service.publishRun(moved);
    return ok(
      [
        `"${moved.name}" moved to ${this.phaseLine(moved)}.`,
        "Dispatch the work for it, then end your turn.",
      ].join("\n"),
    );
  }

  /**
   * Hands a finished task to the person.
   *
   * The only point at which a human is asked for anything. Everything before
   * it — checking a worker, deciding a phase is done, choosing what comes next
   * — is the orchestrator's to do.
   */
  submitTask(input: z.infer<typeof SubmitTaskSchema>): ToolResult {
    const run = this.requireTask(input.task);
    if ("ok" in run) return run;
    const held = this.maintenanceRefusal({ action: "submit", taskId: run.id });
    if (held) return held;
    if (terminalRunStates.has(run.state)) {
      return refuse(`"${run.name}" is already closed.`);
    }
    if (run.state === "awaiting_human") {
      return refuse(`"${run.name}" is already with the person.`);
    }
    const live = this.store
      .listRunSteps(run.id)
      .filter((step) => !terminalRunStepStates.has(step.state));
    if (live.length > 0) {
      return refuse(
        `${live.length} step(s) of "${run.name}" are still running. ` +
          `Wait for them before handing it over.`,
      );
    }
    if (!canTransitionRun(run.state, "awaiting_human")) {
      return refuse(`"${run.name}" cannot be handed over from ${run.state}.`);
    }

    const verdict = judgeCriteria(run.successCriteria, input.criteria);
    if (verdict.refusal) return refuse(verdict.refusal);

    // After the criteria, deliberately. If the work is not finished, how the
    // report reads is not the orchestrator's next problem.
    const unreadable = judgeSummary(input.summary);
    if (unreadable) return refuse(unreadable);

    const submitted = this.service.requestRunReview({
      runId: run.id,
      note: [input.summary.trim(), verdict.record].join(""),
      reason: "completed",
    });
    if (!submitted) return refuse(`"${run.name}" is already with the person.`);
    return ok(
      [
        `Handed "${submitted.name}" to the person for review.`,
        "They will approve it or send it back with a note. Nothing more to do here;",
        "end your turn.",
      ].join("\n"),
    );
  }

  /**
   * Hands a task over unfinished, with what is in the way.
   *
   * The counterpart to the criteria gate. `fleet_submit_task` refuses while an
   * essential criterion is unmet, which is the point — but a criterion can turn
   * out to be impossible, and an orchestrator with no way to say so would be
   * left choosing between lying and going silent. This is the honest third
   * option, and it deliberately reaches the same place a submission does: a
   * person, who can drop the criterion, change it, or stop the task.
   *
   * Unlike submitting, work still out is not a reason to refuse. Being stuck
   * often *is* the running step, and telling someone about it should not have
   * to wait for the thing that is stuck.
   */
  escalate(input: z.infer<typeof EscalateSchema>): ToolResult {
    const run = this.requireTask(input.task);
    if ("ok" in run) return run;
    const registrations = this.store.prMaintenance.list({
      taskId: run.id,
      leadSessionId: this.leadSessionId,
      retainedOnly: true,
    }).records;
    if (input.maintenance || registrations.length) {
      return this.maintenanceResult(() => {
        const record = input.maintenance
          ? this.store.prMaintenance.get(input.maintenance.recordId, this.leadSessionId)
          : registrations[0];
        if (!record || record.taskId !== run.id) {
          throw new PrMaintenanceError(
            "ownership",
            "The maintenance record must belong to this task.",
          );
        }
        const headSha = record.observation?.headSha;
        if (!headSha)
          throw new PrMaintenanceError(
            "head_required",
            "Observe the PR before proposing a design decision.",
          );
        const held = this.store.prMaintenance.holdForDecision(
          this.leadSessionId,
          record.id,
          input.maintenance?.expectedVersion ?? record.version,
          {
            id:
              input.maintenance?.decisionId ??
              record.decision?.id ??
              `decision-${record.version}`,
            version: 1,
            proposal: input.reason,
            headSha,
            scope: record.authorization.scope.baseline,
          },
          () => {
            if (terminalRunStates.has(run.state)) {
              this.store.updateRun(run.id, { state: "running" });
            }
            if (
              !this.service.requestRunReview({
                runId: run.id,
                note: `**PR maintenance needs a design decision.**\n\n${input.reason}\n\nUse Send back with instructions for bounded direction. Approve task does not authorize a design change.`,
                reason: "blocked",
              })
            ) {
              throw new PrMaintenanceError(
                "review_conflict",
                "The existing human review cannot be overwritten.",
              );
            }
          },
        );
        this.service.cancelPausedPrMaintenance();
        return held;
      });
    }
    if (terminalRunStates.has(run.state)) {
      return refuse(`"${run.name}" is already closed.`);
    }
    if (run.state === "awaiting_human") {
      return refuse(`"${run.name}" is already with the person.`);
    }
    if (!canTransitionRun(run.state, "awaiting_human")) {
      return refuse(`"${run.name}" cannot be handed over from ${run.state}.`);
    }

    const unmet = run.successCriteria.filter((criterion) => criterion.essential);
    const note = [
      `**Escalated — this task is not finished.**`,
      "",
      input.reason.trim(),
      ...(unmet.length > 0
        ? [
            "",
            "### What it was supposed to satisfy",
            "",
            ...unmet.map((c) => `- **${c.id}** — ${c.scenario}`),
          ]
        : []),
    ].join("\n");
    const escalated = this.service.requestRunReview({
      runId: run.id,
      note,
      reason: "blocked",
    });
    if (!escalated) return refuse(`"${run.name}" is already with the person.`);
    return ok(
      [
        `Escalated "${escalated.name}" to the person.`,
        "They decide what happens to it — dropping a criterion, changing the task, or",
        "stopping it. Nothing more to do here; end your turn.",
      ].join("\n"),
    );
  }

  /**
   * Ends a task nobody is going to finish, and clears its workers away.
   *
   * The third ending. Submitting says it is done, escalating says it is stuck
   * and a person must choose — this says the question stopped mattering, which
   * needs no decision from anyone. What the task learned stays on the record;
   * only the machinery goes.
   *
   * Refused while a person is holding it. A task in review has been handed
   * over, and taking it back silently while they read it is the one version of
   * this that would surprise someone. `fleet_reopen_task` is the way back, and
   * it says so.
   */
  closeTask(input: z.infer<typeof CloseTaskSchema>): ToolResult {
    const run = this.requireTask(input.task);
    if ("ok" in run) return run;
    if (terminalRunStates.has(run.state)) {
      return refuse(`"${run.name}" is already closed (${run.state}).`);
    }
    if (run.state === "awaiting_human") {
      return refuse(
        `"${run.name}" is with the person for review, so it is not yours to close. ` +
          `Take it back with fleet_reopen_task first if it should not have gone to them.`,
      );
    }

    const reason = input.reason.trim();
    this.store.appendRunNote(
      run.id,
      run.phaseIndex,
      [`**Closed without finishing.**`, "", reason].join("\n"),
    );
    const live = this.store
      .listRunSteps(run.id)
      .filter((step) => !terminalRunStepStates.has(step.state)).length;
    archiveRun(this.service, run.id, reason);

    return ok(
      [
        `Closed "${run.name}".`,
        ...(live > 0
          ? [`  ${live} step(s) were still running and have been stopped.`]
          : []),
        "Its phases, steps, notes and worker conversations are kept. Reopen the task",
        "before sending any of those workers more work. Nothing more to do here; end your turn.",
      ].join("\n"),
    );
  }

  /**
   * Takes a task back — from the person holding it, or from being finished.
   *
   * One tool for both because they are one situation: the task is not over
   * after all, and the work that comes next belongs with the criteria and notes
   * it already has rather than in a new task that would start with none of
   * them.
   *
   * No wake is queued, unlike the person's reopen. That one exists to tell an
   * idle orchestrator something happened; here the orchestrator is the thing
   * that happened, and waking it would be talking to itself.
   */
  reopenTask(input: z.infer<typeof ReopenTaskSchema>): ToolResult {
    const run = this.requireTask(input.task);
    if ("ok" in run) return run;
    const maintenance = this.maintenanceRefusal({ action: "reopen", taskId: run.id });
    if (maintenance) return maintenance;
    if (!terminalRunStates.has(run.state) && run.state !== "awaiting_human") {
      return refuse(
        `"${run.name}" is still open (${this.phaseLine(run)}), so there is nothing to ` +
          `reopen. Read fleet_get_task, then use fleet_follow_up for the same worker's ` +
          `next revision. Use fleet_start_work only for distinct work.`,
      );
    }
    if (!canTransitionRun(run.state, "running")) {
      return refuse(`"${run.name}" cannot be reopened from ${run.state}.`);
    }

    const held = run.state === "awaiting_human";
    const reason = input.reason.trim();
    this.store.appendRunNote(
      run.id,
      run.phaseIndex,
      [held ? `**Taken back before review.**` : `**Reopened.**`, "", reason].join("\n"),
    );
    if (held) this.service.resolveRunReview(run.id);
    const reopened = this.store.updateRun(run.id, {
      state: "running",
      failureReason: "",
    })!;
    this.service.publishRun(reopened);

    return ok(
      [
        held
          ? `Took "${reopened.name}" back from review; the person is no longer being asked.`
          : `Reopened "${reopened.name}" on ${this.phaseLine(reopened)}.`,
        `  task id: ${reopened.id}`,
        "Its criteria and earlier notes still apply. Read fleet_get_task for those and",
        "the retained workers, then use fleet_follow_up on the worker whose role matches.",
        "Do not start a replacement merely because this task was closed.",
        "Send what this needs, then end your turn. Call fleet_submit_task again once",
        "it is addressed.",
      ].join("\n"),
    );
  }

  /**
   * Removes a task that should not exist.
   *
   * Narrow on purpose. A task with a note or a dispatched step has a record,
   * and destroying a record is a person's decision — the same rule that keeps
   * the orchestrator from dropping a success criterion. What is left is the
   * case this is actually for: a duplicate, a misreading, a name it wants back,
   * caught before any work went out.
   */
  discardTask(input: z.infer<typeof DiscardTaskSchema>): ToolResult {
    const run = this.requireTask(input.task);
    if ("ok" in run) return run;

    const steps = this.store.listRunSteps(run.id).length;
    const notes = this.store.listRunNotes(run.id).length;
    if (steps > 0 || notes > 0) {
      return refuse(
        [
          `"${run.name}" has a record — ${steps} step(s) and ${notes} note(s) — so it is not`,
          "yours to delete. Deleting is what a person does with a task nobody will read again.",
          run.state === "awaiting_human"
            ? "It is with the person now; leave it there."
            : terminalRunStates.has(run.state)
              ? "It is already closed, so there is nothing left to do to it."
              : "Call fleet_close_task instead — it stops the work and keeps what was learned.",
        ].join("\n"),
      );
    }

    const name = run.name;
    purgeRun(this.service, run.id);
    return ok(
      `Deleted "${name}". It had dispatched nothing, so nothing was lost. ` +
        `Say why in your next message — a task vanishing from the board is otherwise unexplained.`,
    );
  }

  listNodes(): ToolResult {
    const sessions = this.store.listSessions();
    const placements = this.store.listPlacements();
    const lines = this.store.listNodes().map((node) => {
      const writing = remainingCapacity(
        node,
        reservedSessionCount(sessions, node.id, "writing"),
        "writing",
      );
      const reading = remainingCapacity(
        node,
        reservedSessionCount(sessions, node.id, "read-only"),
        "read-only",
      );
      const paths = placements
        .filter((placement) => placement.nodeId === node.id)
        .map((placement) => `${placement.workspaceName}:${placement.localPath}`);
      return [
        // Two numbers because they are two budgets: reading never queues behind
        // writing, so one number would send the orchestrator away from a machine
        // that could have answered its question immediately.
        `${node.name} — ${node.online ? "online" : "offline"}, ${writing} free for changes, ${reading} free for reading`,
        `  os: ${node.os}/${node.arch}`,
        `  yolo: ${node.capabilities.includes(HOST_YOLO_CAPABILITY) ? "yes" : "no"}`,
        `  workspaces: ${paths.length > 0 ? paths.join(", ") : "(none)"}`,
      ].join("\n");
    });
    if (lines.length === 0) return ok("No nodes are enrolled yet.");
    // Said once at the end rather than beside every machine that has one:
    // Chats looks exactly like a checkout in the list above, and an
    // orchestrator that read it as one would send an implementation there.
    const chats = placements.some((placement) => isChatsWorkspace(placement.workspaceId));
    return ok(
      [
        lines.join("\n"),
        this.service.commands.discovery(this.leadSessionId),
        "",
        // The names above are the only place these come from, so the tool that
        // takes one says so here rather than leaving the orchestrator to guess
        // that a machine can be asked for at all.
        "Pass a name as `node` to fleet_start_work to pin a step to one of these machines. Only do that when the work needs that machine — hardware, credentials, a toolchain it alone has. Otherwise leave it out and the machine with the most free capacity is chosen for you.",
        ...(chats
          ? [
              "",
              "Chats is not a checkout — it is each node's home directory. Name it as the workspace for a question or a piece of research that needs no repository; work that changes or reviews code cannot go there.",
            ]
          : []),
      ].join("\n"),
    );
  }

  runCommand(input: unknown): ToolResult {
    return this.commandTool(() => {
      const execution = this.service.commands.request(this.leadSessionId, input);
      return {
        executionId: execution.id,
        state: execution.state,
        status: execution.state,
        nodeId: execution.nodeId,
        requestedPath: execution.requestedPath,
        nextAction: "End this turn; Fleet will notify you when the execution settles.",
      };
    });
  }

  getExecution(input: unknown): ToolResult {
    return this.commandTool(() => {
      const page = this.service.commands.read(this.leadSessionId, input);
      if ((input as { format?: string }).format === "raw") return page;
      let decodingLoss = false;
      const events = page.events.map((event) => {
        const bytes = Buffer.from(event.data, "base64");
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          decodingLoss = true;
        }
        return { ...event, text: bytes.toString("utf8") };
      });
      return {
        ...page,
        events,
        encoding: "UTF-8 assumed; native programs may use other encodings",
        decodingLoss,
      };
    });
  }

  cancelExecution(input: { executionId: string }): ToolResult {
    return this.commandTool(() => ({
      execution: this.service.commands.cancel(input.executionId, this.leadSessionId),
    }));
  }

  private commandTool(act: () => unknown): ToolResult {
    try {
      return ok(JSON.stringify(act()));
    } catch (error) {
      if (error instanceof CommandConflict)
        return { ok: false, text: `${error.code}: ${error.message}` };
      throw error;
    }
  }

  /**
   * Starts one worker.
   *
   * Placement is chosen here rather than by the caller, because which machine
   * is free and which checkout a reviewer has to land on to see the diff are
   * facts the Host holds and the model does not. `node` is the exception, and
   * only that: it narrows the choice to one machine for the cases the Host
   * cannot see — hardware, credentials, a toolchain — and every other rule
   * still applies on top of it.
   */
  startWork(input: z.infer<typeof StartWorkSchema>): ToolResult {
    const existing = this.run(input.task);
    if (existing && "ok" in existing) return existing;
    if (!existing && input.task && z.uuid().safeParse(input.task.trim()).success) {
      return this.missingTask(input.task);
    }
    const run = existing ?? (input.task ? this.openTask(input.task) : undefined);
    if (!run) {
      return refuse(
        input.task
          ? "Could not open that task. Ask a human to restart the orchestrator."
          : "This orchestrator has no task yet. Pass `task` to name one.",
      );
    }
    const held = this.maintenanceRefusal({ action: "dispatch", taskId: run.id });
    if (held) return held;
    if (terminalRunStates.has(run.state)) {
      return refuse(
        `The task "${run.name}" is closed. Use fleet_reopen_task (task: "${run.id}"), ` +
          "then fleet_follow_up for another revision in its existing worker. " +
          "A new task is only for unrelated work.",
      );
    }
    if (run.state === "awaiting_human") {
      return refuse(
        `"${run.name}" is with the person for review, so nothing more goes out ` +
          `until they answer or you take it back with fleet_reopen_task (task: "${run.id}").`,
      );
    }

    const steps = this.store.listRunSteps(run.id);
    const live = steps.filter((step) => !terminalRunStepStates.has(step.state));
    if (live.length >= run.policy.maxParallel) {
      return refuse(
        `"${run.name}" already has ${live.length} step(s) running, which is its ` +
          `parallel limit. Wait for one to settle — you will be told when it does.`,
      );
    }
    if (steps.length >= run.policy.maxSessions) {
      return refuse(
        `"${run.name}" has spent its budget of ${run.policy.maxSessions} sessions. ` +
          "Use fleet_follow_up for an existing worker's next revision, or report what you have. " +
          "Do not open another task to bypass this budget.",
      );
    }

    const placement = this.choosePlacement(run, input);
    if (typeof placement === "string") return refuse(placement);
    const reserved = this.maintenanceRefusal({
      action: "dispatch",
      taskId: run.id,
      placementId: placement.id,
    });
    if (reserved) return reserved;

    const stepKey = `step-${steps.length + 1}`;
    const step = this.store.upsertRunStep(run.id, {
      stepKey,
      title: input.title,
      prompt: composeWorkerPrompt(input),
      category: input.category,
      // Recorded so the engine dispatches where this reply says it will.
      placementId: placement.id,
      // And so the phase this belonged to survives the phase moving on.
      phaseIndex: run.phaseIndex,
    });

    // The receipt is already written; the engine takes it from here, which is
    // what keeps a dispatch accounted for even if this reply never lands.
    this.service.tickRun(run.id);

    const dispatched = this.store.getRunStep(step.id);
    if (!dispatched) {
      return refuse(
        "The step record is no longer available. Read fleet_list_work before retrying.",
      );
    }
    if (dispatched.state === "pending") {
      this.service.publishRun(run);
      this.service.publishRunSteps(run.id, this.store.listRunSteps(run.id));
      return ok(
        `Queued "${input.title}" in task "${run.name}" (task id: ${run.id}, step: ${stepKey}). ` +
          "The request is recorded and will start when scheduling allows. " +
          "Do not dispatch it again; you will be woken when it finishes.",
      );
    }
    const session = dispatched.sessionId
      ? this.store.getSession(dispatched.sessionId)
      : undefined;
    return ok(
      [
        `Started "${input.title}" (${input.category}) in task "${run.name}".`,
        `  task id: ${run.id}`,
        `  ${this.phaseLine(run)}`,
        `  step: ${stepKey}`,
        `  session: ${dispatched.sessionId}`,
        // Named whether or not it was asked for: an orchestrator that pinned a
        // step has to be able to see that the pin took, and one that did not
        // still has to know where its changes now live.
        `  node: ${session?.nodeName ?? placement.nodeName ?? "?"}${input.node ? " (as asked)" : ""}`,
        `  path: ${session?.executionBinding?.cwd ?? placement.localPath}`,
        "",
        "You will be woken when it finishes. Do not poll for it.",
      ].join("\n"),
    );
  }

  /**
   * Where a worker should run.
   *
   * The rule itself lives in `schedule.ts` and is shared with the engine, which
   * is what stops this from answering the model with one checkout while the
   * dispatch lands in another.
   */
  private choosePlacement(
    run: Run,
    input: z.infer<typeof StartWorkSchema>,
  ): Placement | string {
    const sessions = this.store.listSessions();
    const nodeById = new Map(this.store.listNodes().map((node) => [node.id, node]));
    const steps = this.store.listRunSteps(run.id);
    const writingInFlight = new Set(
      sessions
        .filter(
          (session) =>
            !(
              session.state === "idle" &&
              session.runRole !== "lead" &&
              terminalRunStepStates.has(
                this.store.getRunStepBySession(session.id)?.state ?? "pending",
              )
            ),
        )
        .filter(
          (session) =>
            session.runRole !== "lead" &&
            (Boolean(session.executionBinding?.worktreeId) ||
              Boolean(
                nodeById
                  .get(session.nodeId)
                  ?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY),
              ) ||
              (!session.readOnly && session.state !== "idle")) &&
            !terminalSessionStates.has(session.state) &&
            session.placementId,
        )
        .map(checkoutLockKey),
    );

    return decidePlacement({
      run,
      category: input.category,
      workspace: input.workspace,
      node: input.node,
      hasWritingStep: steps.some((step) => isWritingCategory(step.category)),
      placements: this.store.listPlacements(),
      nodeById,
      reservedFor: (nodeId, kind) => reservedSessionCount(sessions, nodeId, kind),
      writingInFlight,
      repositoryCapabilities: this.store.listPlacementRepositoryCapabilities(),
    });
  }

  listWork(input: z.infer<typeof ListWorkSchema> = {}): ToolResult {
    const words = input.query?.trim().toLowerCase().split(/\s+/) ?? [];
    const runs = this.runs()
      .reverse()
      .filter((run) => {
        if (!words.length) return true;
        const steps = this.store.listRunSteps(run.id);
        const proposal = this.store.prMaintenance.getProposal(run.id);
        const searchable = [
          run.id,
          run.name,
          run.objective,
          ...(proposal?.leadSessionId === this.leadSessionId
            ? [
                proposal.registration.identity.repository,
                prMaintenanceProviderLabel(proposal.registration.identity),
                prMaintenanceUrl(proposal.registration.identity),
                String(proposal.registration.identity.prNumber),
              ]
            : []),
          this.store.getWorkspace(run.workspaceId)?.name ?? "",
          ...steps.flatMap((step) => [
            step.title,
            step.sessionId,
            step.prompt,
            step.output,
            this.store.getSession(step.sessionId)?.initialPrompt ?? "",
          ]),
          ...this.store.listRunNotes(run.id).map((note) => note.body),
        ]
          .join("\n")
          .toLowerCase();
        return words.every((word) => searchable.includes(word));
      });
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;
    const page = runs.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return ok(
      [
        `Scope: this orchestrator (${this.leadSessionId}) only; open AND closed tasks are included.`,
        "This is not a host-wide session search. A missing match does not prove a conversation was deleted.",
        ...(page.length
          ? [
              `Showing ${offset + 1}-${nextOffset} of ${runs.length} matching tasks.`,
              ...page.map((run) =>
                this.taskSummary(run, this.store.listRunSteps(run.id)),
              ),
            ]
          : [
              runs.length
                ? `No tasks on this page; ${runs.length} match. Use a smaller offset.`
                : input.query
                  ? "No matching tasks. Try fewer keywords or browse without query before creating replacement work."
                  : "Nothing dispatched yet. There are no task records in this scope.",
            ]),
        ...(nextOffset < runs.length
          ? [
              `More tasks: call fleet_list_work with the same query/limit and offset: ${nextOffset}.`,
            ]
          : []),
        "Use the stable task ID as task in later calls. Read fleet_get_task for criteria, notes and worker context before deciding.",
        "Same deliverable: fleet_follow_up. Closed task: fleet_reopen_task, then follow up. Busy/offline/queued is a wait, not a reason to create a replacement.",
      ].join("\n\n"),
    );
  }

  /** The persisted context needed to choose between a revisit and distinct work. */
  getTask(input: z.infer<typeof TaskRefSchema>): ToolResult {
    const run = this.requireTask(input.task);
    if ("ok" in run) return run;
    const steps = this.store.listRunSteps(run.id);
    const notes = this.store.listRunNotes(run.id);
    return ok(
      [
        this.taskSummary(run, steps),
        `Objective:\n${truncateMiddle(run.objective, 4_000)}`,
        `Phases: ${run.phases.join(" -> ") || "(not planned)"}`,
        `Stop when: ${run.stopWhen || "(not recorded)"}`,
        "Success criteria:",
        ...run.successCriteria.map(
          (criterion) =>
            `  ${criterion.id}${criterion.essential ? "" : " (optional)"}: ${criterion.scenario}\n` +
            `    expected evidence: ${criterion.expectedEvidence}`,
        ),
        ...(run.failureReason ? [`Task failure: ${run.failureReason}`] : []),
        "Task notes (oldest first; long history is truncated in the middle):",
        truncateMiddle(
          notes
            .map(
              (note) => `${note.createdAt} [phase ${note.phaseIndex + 1}]\n${note.body}`,
            )
            .join("\n\n"),
          16_000,
        ) || "(none)",
        ...steps.map((step) => {
          const session = this.store.getSession(step.sessionId);
          const originalBrief = session?.initialPrompt ?? step.prompt;
          return [
            `Worker context: ${step.stepKey}, session ${step.sessionId || "(not started)"}`,
            `Original brief:\n${truncateMiddle(originalBrief, 3_000)}`,
            ...(step.prompt !== originalBrief
              ? [`Current turn brief:\n${truncateMiddle(step.prompt, 3_000)}`]
              : []),
            `Latest step output:\n${truncateMiddle(step.output, 3_000) || "(none yet)"}`,
          ].join("\n");
        }),
        "Read fleet_transcript with a worker's sessionId when its output is not enough. " +
          "A recorded Copilot conversation ID permits a resume attempt; it does not prove the Node still has that conversation on disk.",
      ].join("\n\n"),
    );
  }

  private taskSummary(run: Run, steps: readonly RunStep[]): string {
    const placement = this.store.getPlacement(run.placementId);
    const proposal = this.store.prMaintenance.getProposal(run.id);
    const maintenance = this.store.prMaintenance.list({
      taskId: run.id,
      leadSessionId: this.leadSessionId,
      retainedOnly: true,
    });
    return [
      `task: ${JSON.stringify(run.name)} - ${run.state} - ${this.phaseLine(run)}`,
      `  task id: ${run.id}`,
      `  updated: ${run.updatedAt}`,
      `  recent command executions: ${
        this.service.commands
          .list({ leadSessionId: this.leadSessionId, taskId: run.id, limit: 20 })
          .map(
            (execution) =>
              `${execution.id} (${execution.state}; delivery ${execution.delivery})`,
          )
          .join(", ") || "(none)"
      }`,
      ...(this.store.commands.fence(run.id)
        ? [`  command evidence: ${JSON.stringify(this.store.commands.fence(run.id))}`]
        : []),
      `  workspace: ${this.store.getWorkspace(run.workspaceId)?.name ?? run.workspaceId}`,
      `  objective: ${truncateMiddle(run.objective, 600)}`,
      ...(placement
        ? [`  pinned checkout: ${placement.nodeName}, ${placement.localPath}`]
        : []),
      `  budget: ${steps.length}/${run.policy.maxSessions} sessions, ${run.wakeSeq}/${run.policy.maxWakes} wakes`,
      ...(proposal?.leadSessionId === this.leadSessionId
        ? [
            `  PR maintenance proposal: ${proposal.id} v${proposal.version} for ${prMaintenanceProviderLabel(proposal.registration.identity)} ${proposal.registration.identity.repository} #${proposal.registration.identity.prNumber} (${prMaintenanceUrl(proposal.registration.identity)}) - awaiting operator authorization, not enabled. Read fleet_get_pr_maintenance with taskId: "${run.id}".`,
          ]
        : []),
      ...maintenance.records.map(
        (record) =>
          `  PR maintenance: ${record.id} - ${record.lifecycle}${record.pauseReason ? ` (${record.pauseReason})` : ""}; read fleet_get_pr_maintenance before continuation.`,
      ),
      ...(steps.length
        ? steps.map((step) => {
            const session = this.store.getSession(step.sessionId);
            const checkout = this.store.getPlacement(
              step.placementId || session?.placementId || "",
            );
            const continuation = this.continuation(run, step, session);
            return [
              `  ${step.stepKey}: ${step.title} (${step.category}) - step state: ${step.state}, attempt: ${step.attempts}`,
              `    session: ${step.sessionId || "(not started)"}; session state: ${session?.state ?? "unavailable"}`,
              ...(session
                ? [
                    `    node: ${session.nodeName} (${this.store.getNode(session.nodeId)?.online ? "online" : "offline"}); workspace: ${session.workspaceName}; path: ${checkout?.localPath ?? "(placement removed)"}`,
                    `    resumable conversation recorded: ${session.agentSessionId ? "yes" : "no"}`,
                  ]
                : []),
              `    next action: ${continuation.action} - ${continuation.reason}`,
            ].join("\n");
          })
        : ["  (nothing dispatched)"]),
    ].join("\n");
  }

  /** Shared by discovery and dispatch so their advice cannot contradict each other. */
  private continuation(run: Run, step: RunStep, session?: FleetSession): Continuation {
    const maintenance = this.store.prMaintenance.admission({
      action: "discover",
      taskId: run.id,
      ...(session ? { sessionId: session.id } : {}),
      leadSessionId: this.leadSessionId,
    });
    if (!maintenance.allowed) {
      return {
        action:
          maintenance.decisionId || maintenance.reason === "wait_for_human"
            ? "wait_for_human"
            : "wait",
        reason: `PR maintenance ${maintenance.recordId}: ${maintenance.reason}${maintenance.decisionId ? `; decision ${maintenance.decisionId}` : ""}. Read fleet_get_pr_maintenance; do not reopen or replace the worker.`,
      };
    }
    if (terminalRunStates.has(run.state) || run.state === "awaiting_human") {
      return {
        action: "reopen_task",
        reason: `The task is ${run.state}. Call fleet_reopen_task with task: "${run.id}", then fleet_follow_up on the matching worker.`,
      };
    }
    if (run.state === "awaiting_approval") {
      return {
        action: "wait",
        reason: "The task needs human approval before work can continue.",
      };
    }
    if (!session) {
      return step.sessionId
        ? {
            action: "unavailable",
            reason:
              "The tracked session record is missing. Read the task context before deciding on replacement work.",
          }
        : {
            action: "wait",
            reason:
              "This step has not started a worker yet. Do not dispatch a duplicate.",
          };
    }
    if (session.dismissed) {
      return {
        action: "restore_session",
        reason: "Restore the dismissed session in Fleet before sending it more work.",
      };
    }
    if (session.stopRequested) {
      return {
        action: "wait",
        reason:
          "The worker is still stopping. Wait for the Stop acknowledgement; do not start a replacement.",
      };
    }
    if (!terminalRunStepStates.has(step.state)) {
      if (step.attempts > 1) {
        return step.state === "pending"
          ? {
              action: "queued",
              reason:
                "A follow-up is already queued durably in this session. Wait for scheduling; do not resend or replace it.",
            }
          : {
              action: "in_flight",
              reason:
                "A follow-up is already dispatched in this session. Wait to be woken; do not send another turn yet.",
            };
      }
      return {
        action: "wait",
        reason: `The worker's step is ${step.state}. Wait to be woken, then use fleet_follow_up for the next revision.`,
      };
    }
    if (session.state === "offline" && !session.agentSessionId) {
      return {
        action: "wait",
        reason:
          "The worker is offline and its conversation identity is unknown. Wait for the Node to reconnect before deciding it cannot resume.",
      };
    }
    const needsResume =
      terminalSessionStates.has(session.state) || session.state === "offline";
    if (session.state !== "idle" && !needsResume) {
      return {
        action: "wait",
        reason: `The worker is ${session.state}. Wait for it to become idle; do not start a replacement.`,
      };
    }
    if (needsResume && !session.agentSessionId) {
      return {
        action: "replace_worker",
        reason:
          "That ended worker has no resumable Copilot conversation. Read fleet_get_task and fleet_transcript, then use fleet_start_work in the same task and repeat the lost context explicitly.",
      };
    }
    const placement = this.store.getPlacement(step.placementId || session.placementId);
    if (!placement || !this.store.getNode(session.nodeId)) {
      return {
        action: "unavailable",
        reason:
          "The worker's original placement or Node was removed. Restore it before resuming; do not silently move this work to another checkout.",
      };
    }
    return {
      action: needsResume ? "resume" : "follow_up",
      reason: `Use fleet_follow_up with sessionId: "${session.id}". It will ${needsResume ? "resume the original conversation" : "reuse the open worker"} when the Node and scheduling allow.`,
    };
  }

  /** The full transcript of one worker, for when the summary was not enough. */
  transcript(input: z.infer<typeof SessionRefSchema>): ToolResult {
    const owned = this.ownedSession(input.sessionId, { allowTerminal: true });
    if (typeof owned === "string") return refuse(owned);
    const text = workerOutput(this.store.listEvents(owned.id), owned);
    return ok(
      text ? truncateMiddle(text, 24_000) : "That worker has not said anything yet.",
    );
  }

  /**
   * Adds another tracked turn to the same worker.
   *
   * Settled workers normally remain idle and attached until the task is archived
   * or deleted, so the next turn needs no reconstruction or session/load. An
   * archived worker is stopped but retained, and uses the same resume path as a
   * Node restart or an explicitly stopped worker after its task is reopened.
   */
  followUp(input: z.infer<typeof FollowUpSchema>): ToolResult {
    const owned = this.ownedSession(input.sessionId, { allowTerminal: true });
    if (typeof owned === "string") return refuse(owned);
    const step = this.store.getRunStepBySession(owned.id);
    if (!step || step.runId !== owned.runId) {
      return refuse(
        "That worker is not attached to a tracked step. Read fleet_list_work before deciding on replacement work.",
      );
    }
    const run = this.store.getRun(step.runId);
    if (!run) return refuse("That worker's task record is no longer available.");
    if (input.maintenance) {
      const reference = input.maintenance;
      const record = this.store.prMaintenance.get(reference.recordId, this.leadSessionId);
      const batch = record?.batches.find((entry) => entry.id === reference.batchId);
      if (
        !record ||
        record.taskId !== run.id ||
        record.workerSessionId !== owned.id ||
        record.generation !== reference.generation ||
        !batch ||
        batch.prompt !== input.prompt
      ) {
        return refuse(
          "The maintenance generation, worker, task and exact prepared prompt must match.",
        );
      }
      if (batch.state !== "prepared") {
        return ok(
          `Batch ${batch.id} is already ${batch.state}; no prompt was sent. Reconcile its recorded step/attempt through fleet_get_pr_maintenance.`,
        );
      }
      try {
        this.requireMaintenanceVisit(record.id, true);
      } catch (error) {
        if (error instanceof PrMaintenanceError)
          return refuse(`${error.code}: ${error.message}`);
        throw error;
      }
    }
    const maintenance = this.maintenanceRefusal({
      action: "dispatch",
      taskId: run.id,
      sessionId: owned.id,
      placementId: owned.placementId,
      ...(input.maintenance ?? {}),
    });
    if (maintenance) return maintenance;
    const next = this.continuation(run, step, owned);
    if (
      (next.action === "queued" || next.action === "in_flight") &&
      step.prompt === input.prompt
    ) {
      return ok(
        `${next.reason} No duplicate was sent. Task: ${run.id}; session: ${owned.id}.`,
      );
    }
    if (next.action !== "follow_up" && next.action !== "resume") {
      return refuse(`${next.reason} This call did not send or overwrite a prompt.`);
    }

    try {
      this.store.writeAtomically(() => {
        this.store.retryRunStepInSession(
          run.id,
          {
            stepKey: step.stepKey,
            title: step.title,
            prompt: input.prompt,
            category: step.category,
            dependsOn: step.dependsOn,
            placementId: step.placementId || owned.placementId,
            phaseIndex: run.phaseIndex,
            position: step.position,
          },
          owned.id,
          this.store.maxEventSequence(owned.id),
        );
        if (input.maintenance) {
          const retried = this.store.getRunStep(step.id)!;
          this.store.prMaintenance.acceptBatch(
            this.leadSessionId,
            input.maintenance.recordId,
            input.maintenance.generation,
            input.maintenance.batchId,
            retried.id,
            retried.attempts,
            input.prompt,
          );
        }
      });
    } catch (error) {
      if (error instanceof PrMaintenanceError)
        return refuse(`${error.code}: ${error.message}`);
      throw error;
    }
    this.service.publishRunSteps(run.id, this.store.listRunSteps(run.id));
    this.service.tickRun(run.id);
    const retried = this.store.getRunStep(step.id);
    if (!retried) {
      return refuse(
        "The follow-up's step record is no longer available. Read fleet_list_work before retrying.",
      );
    }
    if (retried.state === "failed" || retried.state === "skipped") {
      return refuse(
        `The follow-up was recorded but could not start in session ${owned.id}: ${retried.output}. ` +
          `Read fleet_get_task (task: "${run.id}") before deciding what to do next.`,
      );
    }
    return ok(
      [
        next.action === "resume"
          ? "Queued the follow-up in the same worker session. It will resume when scheduling allows, and you will be woken when it finishes."
          : "Queued the follow-up in the same open worker session. It will start when scheduling allows, and you will be woken when it finishes.",
        `Task: ${run.id}; session: ${owned.id}; step: ${step.stepKey}; state: ${retried.state}.`,
        "The request is persisted. Do not send it again or create a replacement while it is queued.",
      ].join("\n"),
    );
  }

  stopWork(input: z.infer<typeof SessionRefSchema>): ToolResult {
    const owned = this.ownedSession(input.sessionId);
    if (typeof owned === "string") return refuse(owned);
    this.service.dispatch(owned.nodeId, { type: "stop", sessionId: owned.id });
    return ok("Stopping it.");
  }

  /**
   * A session this orchestrator is allowed to touch.
   *
   * Scoped to its own tasks, so one orchestrator cannot prompt or stop
   * another's worker — or a session a human opened by hand.
   */
  private ownedSession(
    sessionId: string,
    options: { allowTerminal?: boolean } = {},
  ): FleetSession | string {
    const session = this.store.getSession(sessionId);
    if (!session) return "No such session.";
    const mine = new Set(this.runs().map((run) => run.id));
    if (!session.runId || !mine.has(session.runId)) {
      return "That session does not belong to you.";
    }
    if (!options.allowTerminal && terminalSessionStates.has(session.state)) {
      return `That worker has already ended (${session.state}).`;
    }
    return session;
  }
}
