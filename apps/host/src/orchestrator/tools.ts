import { z } from "zod";
import {
  CriterionOutcomeSchema,
  HOST_YOLO_CAPABILITY,
  isChatsWorkspace,
  RunCriterionSchema,
  canTransitionRun,
  eventPayload,
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
import { truncateMiddle } from "./engine.js";

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
      "Which piece of work this belongs to. Reuse a name to add to that task; pass a new name " +
        "to start a separate one. Omit to continue the task you started last.",
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
  task: z.string().min(1).max(80).describe("A short name for this piece of work."),
  objective: z
    .string()
    .min(1)
    .describe("What finishing it means, in a sentence the person would recognise."),
  /**
   * The stages this task will go through, in order.
   *
   * Chosen per task rather than fixed. Most changes want something like
   * plan / implement / review; a question may want one. The list is what the
   * person sees as progress, so the names should mean something to them.
   */
  phases: z
    .array(z.string().min(1).max(40))
    .min(1)
    .max(8)
    .describe(
      'The stages, in order — for example ["Plan", "Implement", "Review"]. Names are shown ' +
        "to the person as progress. Between one and eight.",
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
  task: z.string().min(1).max(80).describe("The task this is about, by name."),
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
});

export const FollowUpSchema = SessionRefSchema.extend({
  prompt: z.string().min(1).describe("What it should do next."),
});

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
function planTaskReply(
  name: string,
  phases: readonly string[],
  criteria: readonly RunCriterion[],
): string {
  return [
    `Planned "${name}".`,
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
  private run(task?: string): Run | undefined {
    const runs = this.runs();
    if (!task) {
      const live = runs.filter((run) => !terminalRunStates.has(run.state));
      return live[live.length - 1] ?? runs[runs.length - 1];
    }
    const wanted = task.trim().toLowerCase();
    return runs.find((run) => run.name.trim().toLowerCase() === wanted);
  }

  /** Opens a task, so the orchestrator can start one without asking a human. */
  private openTask(
    name: string,
    phases: readonly string[] = [],
    done: { successCriteria?: readonly RunCriterion[]; stopWhen?: string } = {},
  ): Run | undefined {
    const lead = this.store.getSession(this.leadSessionId);
    if (!lead) return undefined;
    const template = this.runs()[0];
    const run = this.store.createRun({
      workspaceId: lead.workspaceId,
      name,
      objective: name,
      phases,
      successCriteria: done.successCriteria ?? [],
      stopWhen: done.stopWhen ?? "",
      policy: {
        ...(template ? template.policy : {}),
        wakePolicy: "on_any_settle",
        onStepFailure: "wake",
      },
    });
    return this.store.updateRun(run.id, {
      leadSessionId: this.leadSessionId,
      state: "running",
    });
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
        phases: input.phases,
        phaseIndex: 0,
        successCriteria: input.successCriteria,
        stopWhen: input.stopWhen,
      })!;
      this.service.publishRun(planned);
      return ok(planTaskReply(planned.name, input.phases, input.successCriteria));
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
          `Use a different name, or dispatch into it with fleet_start_work.`,
      );
    }
    const run = this.openTask(input.task, input.phases, {
      successCriteria: input.successCriteria,
      stopWhen: input.stopWhen,
    });
    if (!run) {
      return refuse("Could not open that task. Ask a human to restart the orchestrator.");
    }
    this.service.publishRun(run);
    return ok(planTaskReply(run.name, input.phases, input.successCriteria));
  }

  /**
   * Moves a task to its next phase.
   *
   * The orchestrator's own judgement, not a person's. It has read what the
   * worker produced and decided the phase is finished; if it has not, the
   * answer is more work rather than this.
   */
  advanceTask(input: z.infer<typeof AdvanceTaskSchema>): ToolResult {
    const run = this.run(input.task);
    if (!run) return refuse(`No task called "${input.task}".`);
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
    const run = this.run(input.task);
    if (!run) return refuse(`No task called "${input.task}".`);
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

    this.store.appendRunNote(
      run.id,
      run.phaseIndex,
      [input.summary.trim(), verdict.record].join(""),
    );
    const submitted = this.store.updateRun(run.id, { state: "awaiting_human" })!;
    this.service.publishRun(submitted);
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
    const run = this.run(input.task);
    if (!run) return refuse(`No task called "${input.task}".`);
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
    this.store.appendRunNote(
      run.id,
      run.phaseIndex,
      [
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
      ].join("\n"),
    );
    const escalated = this.store.updateRun(run.id, { state: "awaiting_human" })!;
    this.service.publishRun(escalated);
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
    const run = this.run(input.task);
    if (!run) return refuse(`No task called "${input.task}".`);
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
        "Its phases, steps and notes are kept; its workers are gone. Nothing more to do",
        "here; end your turn.",
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
    const run = this.run(input.task);
    if (!run) return refuse(`No task called "${input.task}".`);
    if (!terminalRunStates.has(run.state) && run.state !== "awaiting_human") {
      return refuse(
        `"${run.name}" is still open (${this.phaseLine(run)}), so there is nothing to ` +
          `reopen. Dispatch the work with fleet_start_work.`,
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
        "Its criteria and notes are unchanged and still apply — read them before deciding",
        "anything, because they describe work you already did.",
        "Dispatch what this needs, then end your turn. Call fleet_submit_task again once",
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
    const run = this.run(input.task);
    if (!run) return refuse(`No task called "${input.task}".`);

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
    const run = existing ?? (input.task ? this.openTask(input.task) : undefined);
    if (!run) {
      return refuse(
        input.task
          ? "Could not open that task. Ask a human to restart the orchestrator."
          : "This orchestrator has no task yet. Pass `task` to name one.",
      );
    }
    if (terminalRunStates.has(run.state)) {
      return refuse(
        `The task "${run.name}" is closed. Pass a new \`task\` name to start another.`,
      );
    }
    if (run.state === "awaiting_human") {
      return refuse(
        `"${run.name}" is with the person for review, so nothing more goes out ` +
          `until they answer. Wait, or start a separate task.`,
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
          `Report what you have, or start a separate task.`,
      );
    }

    const placement = this.choosePlacement(run, input);
    if (typeof placement === "string") return refuse(placement);

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
    if (!dispatched || dispatched.state === "pending") {
      return refuse(
        `Queued "${input.title}" but no node could take it yet. ` +
          `It will start when one frees up.`,
      );
    }
    const session = dispatched.sessionId
      ? this.store.getSession(dispatched.sessionId)
      : undefined;
    return ok(
      [
        `Started "${input.title}" (${input.category}) in task "${run.name}".`,
        `  ${this.phaseLine(run)}`,
        `  step: ${stepKey}`,
        `  session: ${dispatched.sessionId}`,
        // Named whether or not it was asked for: an orchestrator that pinned a
        // step has to be able to see that the pin took, and one that did not
        // still has to know where its changes now live.
        `  node: ${session?.nodeName ?? placement.nodeName ?? "?"}${input.node ? " (as asked)" : ""}`,
        `  path: ${placement.localPath}`,
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
            session.runRole !== "lead" &&
            !session.readOnly &&
            session.state !== "idle" &&
            !terminalSessionStates.has(session.state) &&
            session.placementId,
        )
        .map((session) => session.placementId),
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
    });
  }

  listWork(): ToolResult {
    const runs = this.runs();
    if (runs.length === 0) return ok("Nothing dispatched yet.");
    const blocks = runs.map((run) => {
      const steps = this.store.listRunSteps(run.id);
      const lines = steps.map((step) => {
        const session = step.sessionId
          ? this.store.getSession(step.sessionId)
          : undefined;
        return `  ${step.stepKey} · ${step.title} (${step.category}) — ${step.state}${
          session ? ` on ${session.nodeName}, session ${session.id}` : ""
        }`;
      });
      return [
        `${run.name} — ${run.state} · ${this.phaseLine(run)} · ${steps.length}/${run.policy.maxSessions} sessions, ${run.wakeSeq}/${run.policy.maxWakes} wakes`,
        ...(lines.length > 0 ? lines : ["  (nothing dispatched)"]),
      ].join("\n");
    });
    return ok(blocks.join("\n"));
  }

  /** The full transcript of one worker, for when the summary was not enough. */
  transcript(input: z.infer<typeof SessionRefSchema>): ToolResult {
    const owned = this.ownedSession(input.sessionId, { allowTerminal: true });
    if (typeof owned === "string") return refuse(owned);
    const text = this.store
      .listEvents(owned.id)
      .filter((event) => event.type === "agent_text")
      .map((event) => eventPayload(event, "agent_text")?.text ?? "")
      .join("");
    return ok(
      text ? truncateMiddle(text, 24_000) : "That worker has not said anything yet.",
    );
  }

  /**
   * Adds another tracked turn to the same worker.
   *
   * Settled workers normally remain idle and attached until the task is archived
   * or deleted, so the next turn needs no reconstruction or session/load. Resume
   * remains the recovery path for a Node restart or an explicitly stopped worker.
   */
  followUp(input: z.infer<typeof FollowUpSchema>): ToolResult {
    const owned = this.ownedSession(input.sessionId, { allowTerminal: true });
    if (typeof owned === "string") return refuse(owned);
    const step = this.stepFor(owned.id);
    if (!step) return refuse("That worker is not attached to a tracked step.");
    if (terminalRunStepStates.has(step.state)) {
      const run = this.store.getRun(step.runId);
      if (!run || terminalRunStates.has(run.state) || run.state === "awaiting_human") {
        return refuse("That worker's task is not open for more work.");
      }
      const placementId = step.placementId || owned.placementId;
      const needsResume =
        terminalSessionStates.has(owned.state) || owned.state === "offline";
      if (owned.state !== "idle" && !needsResume) {
        return refuse(
          `That worker is ${owned.state}, so it cannot take a follow-up yet. Wait for it to become idle.`,
        );
      }
      if (needsResume && !owned.agentSessionId) {
        return refuse(
          "That worker has no resumable Copilot conversation. Start replacement work and repeat the lost context explicitly.",
        );
      }

      this.store.retryRunStepInSession(
        run.id,
        {
          stepKey: step.stepKey,
          title: step.title,
          prompt: input.prompt,
          category: step.category,
          dependsOn: step.dependsOn,
          placementId,
          phaseIndex: run.phaseIndex,
          position: step.position,
        },
        owned.id,
        this.store.maxEventSequence(owned.id),
      );
      this.service.tickRun(run.id);
      return ok(
        needsResume
          ? "Queued the follow-up in the same worker session. It will resume when scheduling allows, and you will be woken when it finishes."
          : "Queued the follow-up in the same open worker session. It will start when scheduling allows, and you will be woken when it finishes.",
      );
    }
    if (owned.state !== "idle") {
      return refuse(
        `That worker is ${owned.state}, so it cannot take a follow-up yet. ` +
          `Wait for it to finish, or stop it.`,
      );
    }
    const sent = this.service.dispatch(owned.nodeId, {
      type: "prompt",
      sessionId: owned.id,
      prompt: input.prompt,
      attachments: [],
    });
    return sent.sent
      ? ok(`Sent. You will be woken when it finishes.`)
      : refuse("That worker's node is not reachable right now.");
  }

  /** The step a worker session was started for, across every task. */
  private stepFor(sessionId: string): RunStep | undefined {
    for (const run of this.runs()) {
      const step = this.store
        .listRunSteps(run.id)
        .find((entry) => entry.sessionId === sessionId);
      if (step) return step;
    }
    return undefined;
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
