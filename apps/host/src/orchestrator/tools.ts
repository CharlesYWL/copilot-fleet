import { z } from "zod";
import {
  HOST_YOLO_CAPABILITY,
  canTransitionRun,
  eventPayload,
  isWritingCategory,
  terminalRunStates,
  terminalRunStepStates,
  terminalSessionStates,
  type FleetSession,
  type Placement,
  type Run,
  type RunStep,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { reservedSessionCount } from "../session-policy.js";
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

export const StartWorkSchema = z.object({
  category: z.enum(WORKER_CATEGORIES),
  title: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8_000),
  workspace: z.string().optional(),
  /**
   * Which piece of work this belongs to.
   *
   * Steps under one task share a budget, a checkout once something has been
   * written, and a place in the UI; unrelated errands should not. Omitting it
   * continues whatever was started last, so a single line of work never has to
   * think about this at all.
   */
  task: z.string().min(1).max(80).optional(),
});

export const PlanTaskSchema = z.object({
  task: z.string().min(1).max(80),
  objective: z.string().min(1).max(2_000),
  /**
   * The stages this task will go through, in order.
   *
   * Chosen per task rather than fixed. Most changes want something like
   * plan / implement / review; a question may want one. The list is what the
   * person sees as progress, so the names should mean something to them.
   */
  phases: z.array(z.string().min(1).max(40)).min(1).max(8),
  workspace: z.string().optional(),
});

export const TaskRefSchema = z.object({ task: z.string().min(1).max(80) });

export const AdvanceTaskSchema = TaskRefSchema.extend({
  /** What this phase established, in a sentence, for the person reading later. */
  note: z.string().min(1).max(2_000),
});

export const SubmitTaskSchema = TaskRefSchema.extend({
  /** What was done and what the person should look at. */
  summary: z.string().min(1).max(4_000),
});

export const SessionRefSchema = z.object({ sessionId: z.string().min(1) });

export const FollowUpSchema = SessionRefSchema.extend({
  prompt: z.string().min(1).max(8_000),
});

export type ToolResult = { ok: boolean; text: string };

const ok = (text: string): ToolResult => ({ ok: true, text });
const refuse = (text: string): ToolResult => ({ ok: false, text });

/** What the orchestrator is told once a task has its phases. */
function planTaskReply(name: string, phases: readonly string[]): string {
  return [
    `Planned "${name}".`,
    `  phases: ${phases.join(" → ")}`,
    `  now on: ${phases[0]}`,
    "",
    "Dispatch the work for this phase, then end your turn. When you are woken,",
    "check what came back: call fleet_advance_task if the phase is done, or",
    "dispatch more work if it is not.",
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
  private openTask(name: string, phases: readonly string[] = []): Run | undefined {
    const lead = this.store.getSession(this.leadSessionId);
    if (!lead) return undefined;
    const template = this.runs()[0];
    const run = this.store.createRun({
      workspaceId: lead.workspaceId,
      name,
      objective: name,
      phases,
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
      })!;
      this.service.publishRun(planned);
      return ok(planTaskReply(planned.name, input.phases));
    }
    if (existing) {
      return refuse(
        `"${existing.name}" already exists (${this.phaseLine(existing)}). ` +
          `Use a different name, or dispatch into it with fleet_start_work.`,
      );
    }
    const run = this.openTask(input.task, input.phases);
    if (!run) {
      return refuse("Could not open that task. Ask a human to restart the orchestrator.");
    }
    this.service.publishRun(run);
    return ok(planTaskReply(run.name, input.phases));
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

    this.store.appendRunNote(run.id, run.phaseIndex, input.summary);
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

  listNodes(): ToolResult {
    const sessions = this.store.listSessions();
    const placements = this.store.listPlacements();
    const lines = this.store.listNodes().map((node) => {
      const reserved = reservedSessionCount(sessions, node.id);
      const free = remainingCapacity(node, reserved);
      const paths = placements
        .filter((placement) => placement.nodeId === node.id)
        .map((placement) => `${placement.workspaceName}:${placement.localPath}`);
      return [
        `${node.name} — ${node.online ? "online" : "offline"}, ${free} free slot(s)`,
        `  os: ${node.os}/${node.arch}`,
        `  yolo: ${node.capabilities.includes(HOST_YOLO_CAPABILITY) ? "yes" : "no"}`,
        `  workspaces: ${paths.length > 0 ? paths.join(", ") : "(none)"}`,
      ].join("\n");
    });
    return ok(lines.length > 0 ? lines.join("\n") : "No nodes are enrolled yet.");
  }

  /**
   * Starts one worker.
   *
   * Placement is chosen here rather than by the caller: which machine is free,
   * and which checkout a reviewer has to land on to see the diff, are facts
   * the Host holds and the model does not.
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
      prompt: input.prompt,
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
        `  node: ${session?.nodeName ?? "?"}`,
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
      steps
        .filter(
          (step) =>
            !terminalRunStepStates.has(step.state) &&
            isWritingCategory(step.category) &&
            step.placementId,
        )
        .map((step) => step.placementId),
    );

    return decidePlacement({
      run,
      category: input.category,
      workspace: input.workspace,
      hasWritingStep: steps.some((step) => isWritingCategory(step.category)),
      placements: this.store.listPlacements(),
      nodeById,
      reservedFor: (nodeId) => reservedSessionCount(sessions, nodeId),
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
    const owned = this.ownedSession(input.sessionId);
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
   * Adds a turn to a worker that is still in flight.
   *
   * Only while its step is open. Once a step settles the worker is stopped and
   * its slot released, and a prompt sent after that used to be answered with
   * "you will be woken when it finishes" — which was untrue, because no step
   * was tracking that turn and so nothing would ever settle or wake. Starting
   * fresh work is the honest way to continue, and it lands on the same checkout.
   */
  followUp(input: z.infer<typeof FollowUpSchema>): ToolResult {
    const owned = this.ownedSession(input.sessionId);
    if (typeof owned === "string") return refuse(owned);
    const step = this.stepFor(owned.id);
    if (!step || terminalRunStepStates.has(step.state)) {
      return refuse(
        `That worker's step has already settled, so a follow-up would go nowhere. ` +
          `Call fleet_start_work again — it lands on the same checkout.`,
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
  private ownedSession(sessionId: string): FleetSession | string {
    const session = this.store.getSession(sessionId);
    if (!session) return "No such session.";
    const mine = new Set(this.runs().map((run) => run.id));
    if (!session.runId || !mine.has(session.runId)) {
      return "That session does not belong to you.";
    }
    if (terminalSessionStates.has(session.state)) {
      return `That worker has already ended (${session.state}).`;
    }
    return session;
  }
}
