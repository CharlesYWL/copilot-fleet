import {
  terminalRunStates,
  terminalRunStepStates,
  type FleetSession,
  type Placement,
  type Run,
  type RunStep,
  type SessionEvent,
} from "@fleet/protocol";

/**
 * The four columns a task moves through on the board.
 *
 * Derived rather than stored. A Run already knows its own phases — the
 * orchestrator names those — but those names are per task and cannot be
 * columns. This is the coarse shape every task shares, so that a board can put
 * unrelated tasks side by side and still mean something.
 */
export type OrchestrationStage =
  "planning" | "implementation" | "validation" | "delivery";

export const ORCHESTRATION_STAGES: readonly OrchestrationStage[] = [
  "planning",
  "implementation",
  "validation",
  "delivery",
];

export const STAGE_LABELS: Record<OrchestrationStage, string> = {
  planning: "Planning",
  implementation: "In progress",
  validation: "Validation",
  delivery: "Done",
};

/**
 * Why a task needs a person, if it does.
 *
 * Ordered: a permission blocks an agent right now, a failure has already
 * happened, an offline node may yet come back on its own.
 */
export type RunAttention = "permission" | "failed-step" | "offline-node" | undefined;

export type RunViewModel = {
  run: Run;
  steps: RunStep[];
  /**
   * Steps whose session is still on the fleet, so a link to one leads somewhere.
   *
   * A step keeps its session id forever; the session does not. Archiving a task
   * removes them, and joining here — once, where the sessions are already in
   * hand — is what stops every surface that offers a transcript from having to
   * remember that.
   */
  reachableSteps: RunStep[];
  stage: OrchestrationStage;
  attention: RunAttention;
  /** The session a permission is waiting on, so the UI can go straight there. */
  attentionSessionId: string;
  liveSteps: number;
  completedSteps: number;
  totalSteps: number;
  /** Newest of the run and its steps, so the list can sort by real activity. */
  latestActivityAt: string;
  /** Where the work is happening, when the snapshot can say. */
  placement: Placement | undefined;
  /** Sorting key: attention first, then work, then rest. */
  priority: number;
};

export type BuildRunViewModelsInput = {
  runs: readonly Run[];
  stepsByRun: Readonly<Record<string, RunStep[]>>;
  sessions: readonly FleetSession[];
  placements?: readonly Placement[];
  /** Pending permission events, already filtered by the caller. */
  waitingPermissions?: readonly SessionEvent[];
  /** Failed step attempts the operator has already acknowledged, keyed by run. */
  acknowledgedFailedSteps?: Readonly<Record<string, readonly string[]>>;
};

const isLive = (step: RunStep) => step.state === "running" || step.state === "starting";

export const failedStepTokens = (steps: readonly RunStep[]): string[] =>
  steps
    .filter((step) => step.state === "failed" || step.state === "cancelled")
    // A retry increments attempts. updatedAt is deliberately excluded because
    // bookkeeping edits to an already-failed step are not a new failure.
    .map((step) => JSON.stringify([step.id, step.attempts]))
    .sort();

/**
 * Everything the orchestrator views need, computed once.
 *
 * A pure function on purpose: the awkward cases here are about how facts from
 * three different places line up — a run's state, its steps' states, and a
 * permission event that belongs to a session — and those are worth being able
 * to test without a fleet.
 */
export function buildRunViewModels(input: BuildRunViewModelsInput): RunViewModel[] {
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
  const placementById = new Map(
    (input.placements ?? []).map((placement) => [placement.id, placement]),
  );
  /*
   * A permission is an event on a session; a task only learns about it through
   * the step that session is running. Inferring attention from run state alone
   * would miss it entirely — the run is `running`, which is exactly what it
   * looks like when nothing is wrong.
   */
  const blockedSessions = new Set(
    (input.waitingPermissions ?? []).map((event) => event.sessionId),
  );

  return input.runs
    .map((run) => {
      const steps = input.stepsByRun[run.id] ?? [];
      const live = steps.filter(isLive);
      const completed = steps.filter((step) => step.state === "succeeded");
      const blocked = steps.find(
        (step) => step.sessionId && blockedSessions.has(step.sessionId),
      );
      const acknowledgedFailures = new Set(input.acknowledgedFailedSteps?.[run.id] ?? []);
      const failed = failedStepTokens(steps).some(
        (token) => !acknowledgedFailures.has(token),
      );
      const offline = steps.some((step) => {
        if (terminalRunStepStates.has(step.state)) return false;
        const session = step.sessionId ? sessionById.get(step.sessionId) : undefined;
        return session?.state === "offline";
      });

      /*
       * A finished task asks nothing of anyone.
       *
       * Every check below reads the steps, and abandoning a task cancels the
       * ones still in flight — so without this guard every abandoned task
       * claimed "a step failed" forever, floated to the top of its column, and
       * held the badge that says a person is needed. There is no action left
       * to take on it, which is what makes the claim false rather than merely
       * noisy.
       */
      const attention: RunAttention = terminalRunStates.has(run.state)
        ? undefined
        : blocked || run.state === "awaiting_human"
          ? "permission"
          : failed
            ? "failed-step"
            : offline
              ? "offline-node"
              : undefined;

      return {
        run,
        steps,
        reachableSteps: steps.filter(
          (step) => step.sessionId && sessionById.has(step.sessionId),
        ),
        stage: stageOf(run, steps),
        attention,
        attentionSessionId: blocked?.sessionId ?? "",
        liveSteps: live.length,
        completedSteps: completed.length,
        totalSteps: steps.length,
        latestActivityAt: latestActivity(run, steps),
        placement: run.placementId ? placementById.get(run.placementId) : undefined,
        priority: priorityOf(attention, live.length, run),
      } satisfies RunViewModel;
    })
    .sort(
      (a, b) =>
        b.priority - a.priority || b.latestActivityAt.localeCompare(a.latestActivityAt),
    );
}

/**
 * Which column a task belongs in.
 *
 * Read from the steps first, because that is what is actually happening:
 * anything in flight is implementation regardless of what the run row says.
 */
export function stageOf(run: Run, steps: readonly RunStep[]): OrchestrationStage {
  if (terminalRunStates.has(run.state)) return "delivery";
  if (run.state === "awaiting_human") return "validation";
  if (steps.some(isLive)) return "implementation";
  if (run.state === "awaiting_approval" || run.state === "planning") return "planning";
  // Nothing running and the lead has the ball: it is deciding, not building.
  if (run.state === "awaiting_lead" || run.state === "aggregating") {
    return steps.length > 0 ? "validation" : "planning";
  }
  return steps.length > 0 ? "implementation" : "planning";
}

/**
 * Attention above work, work above rest.
 *
 * A finished task sinks below a queued one: it is the only kind that will never
 * change again on its own.
 */
function priorityOf(attention: RunAttention, live: number, run: Run): number {
  if (attention === "permission") return 100;
  if (attention === "failed-step") return 80;
  if (attention === "offline-node") return 70;
  if (live > 0) return 50;
  if (run.state === "completed" || run.state === "cancelled") return 0;
  if (run.state === "failed") return 10;
  return 20;
}

function latestActivity(run: Run, steps: readonly RunStep[]): string {
  let newest = run.updatedAt;
  for (const step of steps) {
    if (step.updatedAt > newest) newest = step.updatedAt;
  }
  return newest;
}

/** Steps that are still out on a machine somewhere. */
export function liveSteps(steps: readonly RunStep[]): RunStep[] {
  return steps.filter(isLive);
}

/** Tasks the orchestrator has handed over and cannot move on without a person. */
export function tasksAwaitingHuman(runs: readonly Run[]): Run[] {
  return runs.filter((run) => run.state === "awaiting_human");
}

/** What the header counts. */
export type OrchestratorSummary = {
  total: number;
  running: number;
  needsYou: number;
  /** The stage most tasks are in, for a one-line "where is this up to". */
  dominantStage: OrchestrationStage | undefined;
};

export function summarise(models: readonly RunViewModel[]): OrchestratorSummary {
  const counts = new Map<OrchestrationStage, number>();
  let running = 0;
  let needsYou = 0;
  for (const model of models) {
    if (model.liveSteps > 0) running += 1;
    if (model.attention) needsYou += 1;
    if (model.stage !== "delivery") {
      counts.set(model.stage, (counts.get(model.stage) ?? 0) + 1);
    }
  }
  let dominantStage: OrchestrationStage | undefined;
  let best = 0;
  for (const stage of ORCHESTRATION_STAGES) {
    const count = counts.get(stage) ?? 0;
    if (count > best) {
      best = count;
      dominantStage = stage;
    }
  }
  return { total: models.length, running, needsYou, dominantStage };
}

/** The run states a person would call finished, shown as one word. */
export function runStateLabel(run: Run): string {
  switch (run.state) {
    case "awaiting_human":
      return "Needs you";
    case "awaiting_lead":
      return "Deciding";
    case "awaiting_approval":
      return "Not started";
    case "cancelled":
      // Product word: the run and its output survive, so "cancelled" reads
      // more destructive than what actually happened.
      return "Abandoned";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return "Running";
  }
}

/** The phase the orchestrator itself named, when it named any. */
export function currentPhase(run: Run): string {
  if (run.phases.length === 0) return "";
  return run.phases[Math.min(run.phaseIndex, run.phases.length - 1)] ?? "";
}

/**
 * A task that exists but has no plan yet.
 *
 * Opening a task writes the record first and only then briefs the orchestrator,
 * so this is the ordinary state for the second between the two — and a lasting
 * one if the orchestrator never gets to it. It needs a name because without one
 * the task detail simply renders empty, which reads as broken rather than as
 * "asked, waiting for an answer", and hides the fact that a task and a message
 * in the conversation are two halves of the same thing.
 */
export function awaitingPlan(model: RunViewModel): boolean {
  return (
    !terminalRunStates.has(model.run.state) &&
    model.run.phases.length === 0 &&
    model.totalSteps === 0
  );
}
