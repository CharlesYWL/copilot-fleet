import {
  HOST_YOLO_CAPABILITY,
  isWritingCategory,
  terminalRunStates,
  terminalRunStepStates,
  terminalSessionStates,
  type FleetNode,
  type FleetSession,
  type Placement,
  type Run,
  type RunState,
  type RunStep,
  type RunStepState,
} from "@fleet/protocol";
import {
  capacityFor,
  reservedSessionCount,
  type SessionKind,
} from "../session-policy.js";

/**
 * What the engine should do next, decided without touching the database or the
 * network.
 *
 * Keeping the decision pure is what makes the awkward cases testable: a Host
 * restart, a node that vanished mid-dispatch, two steps settling at once. Every
 * one of those is a snapshot in, a list of actions out.
 */
export type ScheduleAction =
  | { type: "start_step"; stepId: string; placementId: string; prompt: string }
  /** The Node took the command: `starting` becomes `running`. */
  | { type: "advance_step"; stepId: string }
  | { type: "settle_step"; stepId: string; state: RunStepState; output: string }
  | { type: "skip_step"; stepId: string; reason: string }
  | { type: "stop_session"; sessionId: string; reason: string }
  /** Hands over a message the run has been holding for its Lead. */
  | { type: "deliver_prompt"; runId: string; prompt: string }
  | { type: "wake_lead"; runId: string; prompt: string }
  | { type: "finish_run"; state: RunState; reason: string };

export type ScheduleInput = {
  run: Run;
  steps: readonly RunStep[];
  sessions: readonly FleetSession[];
  nodes: readonly FleetNode[];
  placements: readonly Placement[];
  /**
   * Sessions whose current turn has ended.
   *
   * Passed in rather than read here because completion is two facts — a
   * `turn_complete` event and an idle state — and only the caller has the event
   * log. A session that is idle without having completed a turn is a session
   * that never started one.
   */
  turnCompleteSessionIds: ReadonlySet<string>;
  /** Collected agent text per step id, so the decision never reads the database. */
  stepOutputs: ReadonlyMap<string, string>;
  nowMs: number;
};

/**
 * Slots this node can still take of a given kind, one held back.
 *
 * Filling a node to its ceiling makes the next dispatch hit the Node's own
 * fatal "at capacity" check, which costs the whole connection rather than one
 * step. A single-slot node is the exception: reserving headroom there would
 * mean it could never run anything at all.
 *
 * Read-only work has its own ceiling, so a machine busy implementing can still
 * be asked to look something up. What it cannot do is take an unlimited number
 * of lookups — an explore is a real process, and the second ceiling is what
 * keeps "reads do not queue behind writes" from meaning "reads are free".
 */
export function remainingCapacity(
  node: FleetNode,
  reserved: number,
  kind: SessionKind = "writing",
): number {
  const ceiling = capacityFor(node, kind);
  if (ceiling <= 1) return Math.max(0, ceiling - reserved);
  return Math.max(0, ceiling - reserved - 1);
}

const isInFlight = (state: RunStepState) => state === "starting" || state === "running";

export function planNextActions(input: ScheduleInput): ScheduleAction[] {
  const { run, steps } = input;
  if (terminalRunStates.has(run.state)) return [];
  if (run.state === "awaiting_approval") return [];
  /*
   * A task waiting on a person is not waiting on the fleet: nothing new is
   * dispatched and the orchestrator is not woken, because that would be the
   * engine talking over the review it just asked for.
   *
   * Recording what already happened still runs, though. Settling a step and
   * reclaiming its worker are facts about the past, and skipping them would
   * leave an agent holding a slot for as long as the person took to look.
   */
  const heldByHuman = run.state === "awaiting_human";

  /*
   * A Host that just restarted has not heard from anyone yet, and every session
   * it owns reads `offline`. Settling on that would mark live work as failed and
   * finish runs that are still going; waiting costs one reconnect.
   */
  if (input.nodes.length > 0 && input.nodes.every((node) => !node.online)) return [];

  const actions: ScheduleAction[] = [];
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const placementById = new Map(input.placements.map((p) => [p.id, p]));

  const nodeOnlineForStep = (step: RunStep): boolean | undefined => {
    const placement = step.placementId ? placementById.get(step.placementId) : undefined;
    const nodeId = placement?.nodeId ?? sessionById.get(step.sessionId)?.nodeId;
    if (!nodeId) return undefined;
    return nodeById.get(nodeId)?.online;
  };

  // Settled states are computed here rather than mutated so that later phases in
  // this same pass see the run as it will be, not as it was.
  const settled = new Map<string, RunStepState>();
  const effectiveState = (step: RunStep) => settled.get(step.id) ?? step.state;

  for (const step of steps) {
    if (terminalRunStepStates.has(step.state)) continue;

    let phase: RunStepState = step.state;

    if (phase === "starting") {
      const pending = step.sessionId ? sessionById.get(step.sessionId) : undefined;
      /*
       * A session that has left `queued` is the Node confirming it took the
       * command. This is read from session state rather than from a
       * `command_result` receipt on purpose: state is persisted and re-reported
       * on every reconnect, so it survives a Host restart, while a command id
       * does not.
       */
      if (pending && pending.state !== "queued" && pending.state !== "offline") {
        settled.set(step.id, "running");
        actions.push({ type: "advance_step", stepId: step.id });
        // Falls through: a fast agent can finish before the next tick arrives.
        phase = "running";
      } else {
        // Only a node we can see is one we can conclude anything about.
        const online = nodeOnlineForStep(step);
        if (online === false) continue;
        const since = step.dispatchedAt ? Date.parse(step.dispatchedAt) : Number.NaN;
        const overdue =
          Number.isFinite(since) && input.nowMs - since > run.policy.startingTimeoutMs;
        if (overdue) {
          settled.set(step.id, "failed");
          actions.push({
            type: "settle_step",
            stepId: step.id,
            state: "failed",
            output: "The node never acknowledged this dispatch.",
          });
        }
        continue;
      }
    }

    if (phase !== "running") continue;

    const session = step.sessionId ? sessionById.get(step.sessionId) : undefined;
    if (!session) {
      settled.set(step.id, "failed");
      actions.push({
        type: "settle_step",
        stepId: step.id,
        state: "failed",
        output: "The session running this step is gone.",
      });
      continue;
    }
    // Offline is unknown, not lost: the Node may still be holding the agent.
    if (session.state === "offline") continue;

    if (terminalSessionStates.has(session.state)) {
      const succeeded =
        session.state === "completed" && input.turnCompleteSessionIds.has(session.id);
      const state: RunStepState = succeeded ? "succeeded" : "failed";
      settled.set(step.id, state);
      actions.push({
        type: "settle_step",
        stepId: step.id,
        state,
        output: input.stepOutputs.get(step.id) ?? "",
      });
      continue;
    }

    // The only success: the agent finished a turn and went back to idle.
    if (session.state === "idle" && input.turnCompleteSessionIds.has(session.id)) {
      settled.set(step.id, "succeeded");
      actions.push({
        type: "settle_step",
        stepId: step.id,
        state: "succeeded",
        output: input.stepOutputs.get(step.id) ?? "",
      });
      continue;
    }

    const updated = Date.parse(step.updatedAt);
    if (
      Number.isFinite(updated) &&
      input.nowMs - updated > run.policy.stepTimeoutMs &&
      !terminalSessionStates.has(session.state)
    ) {
      // Stop, never cancel: cancel ends a turn and leaves the process holding a
      // slot. A later tick settles the step on the terminal event.
      actions.push({
        type: "stop_session",
        sessionId: session.id,
        reason: "Step exceeded its time budget",
      });
    }
  }

  const stateByKey = new Map(steps.map((s) => [s.stepKey, effectiveState(s)]));
  const failedDependency = (step: RunStep) =>
    step.dependsOn.find((key) => {
      const state = stateByKey.get(key);
      return state === "failed" || state === "skipped" || state === "cancelled";
    });

  for (const step of steps) {
    if (effectiveState(step) !== "pending") continue;
    const blocked = failedDependency(step);
    if (!blocked) continue;
    settled.set(step.id, "skipped");
    actions.push({
      type: "skip_step",
      stepId: step.id,
      reason: `Depends on ${blocked}, which did not succeed.`,
    });
  }

  const live = steps.filter((step) => !terminalRunStepStates.has(effectiveState(step)));
  const inFlight = live.filter((step) => isInFlight(effectiveState(step)));

  /*
   * A worker whose step is finished is done, and an agent sitting `idle` still
   * reserves a slot on its node — `idle` means "waiting for another turn", not
   * "finished". Nothing used to reclaim these until the whole run ended, which
   * was survivable while a run was a short batch and is not survivable now that
   * an orchestrator is long-lived: three explores in a row and the fleet is
   * wedged, reporting a node full of agents that have nothing left to do.
   *
   * Asked of the state rather than of the transition, deliberately. Reclaiming
   * only at the moment a step settled left anything that was already settled
   * stranded forever — the step is terminal, so no later pass looks at it
   * again. That covers the Host restarting between the settle and the stop, a
   * `stop` that never reached its node, and steps that settled before this
   * existed at all. Re-sending a stop to a session that is already stopping is
   * harmless; never sending one is not.
   *
   * The transcript outlives the process, so stopping costs nothing a later
   * `fleet_transcript` needs.
   */
  for (const step of steps) {
    if (!terminalRunStepStates.has(effectiveState(step))) continue;
    const session = step.sessionId ? sessionById.get(step.sessionId) : undefined;
    if (!session || terminalSessionStates.has(session.state)) continue;
    // Offline is unknown, not lost: the command would not reach it anyway.
    if (session.state === "offline") continue;
    actions.push({
      type: "stop_session",
      sessionId: session.id,
      reason: "Its step has settled",
    });
  }

  // Dispatch before finishing, so a run with work left never looks done.
  const reservedByNode = new Map<string, number>();
  const key = (nodeId: string, kind: SessionKind) => `${nodeId}:${kind}`;
  const reservedFor = (nodeId: string, kind: SessionKind) => {
    const cacheKey = key(nodeId, kind);
    if (!reservedByNode.has(cacheKey)) {
      reservedByNode.set(cacheKey, reservedSessionCount(input.sessions, nodeId, kind));
    }
    return reservedByNode.get(cacheKey)!;
  };

  const writingInFlight = new Set(
    inFlight
      .filter((step) => isWritingCategory(step.category) && step.placementId)
      .map((step) => step.placementId),
  );
  // Any writing step, settled or not: its changes are still in that tree.
  const hasWritingStep = steps.some((step) => isWritingCategory(step.category));
  let started = 0;
  const parallelBudget = heldByHuman ? 0 : run.policy.maxParallel - inFlight.length;

  for (const step of steps) {
    if (started >= parallelBudget) break;
    if (effectiveState(step) !== "pending") continue;
    const unmet = step.dependsOn.some((key) => stateByKey.get(key) !== "succeeded");
    if (unmet) continue;

    const placementId = choosePlacement(step, {
      run,
      placements: input.placements,
      nodeById,
      reservedFor,
      writingInFlight,
      hasWritingStep,
    });
    if (!placementId) continue;

    const placement = placementById.get(placementId)!;
    const startedKind: SessionKind = isReadOnlyCategory(step.category)
      ? "read-only"
      : "writing";
    reservedByNode.set(
      key(placement.nodeId, startedKind),
      reservedFor(placement.nodeId, startedKind) + 1,
    );
    if (isWritingCategory(step.category)) writingInFlight.add(placementId);
    settled.set(step.id, "starting");
    started += 1;
    actions.push({
      type: "start_step",
      stepId: step.id,
      placementId,
      // `start_session` carries the first prompt itself; a second command would
      // race the agent's own first turn.
      prompt: step.prompt,
    });
  }

  const remaining = steps.filter(
    (step) => !terminalRunStepStates.has(effectiveState(step)),
  );

  /*
   * A message the run is holding takes precedence over anything else it might
   * say, and suppresses a wake for this tick: both are prompts, and Copilot
   * accepts one turn at a time. A wake stays owed in `settleSeq`, so nothing
   * is lost by waiting a tick. Decided before the wake policy is consulted,
   * because a held message is owed regardless of how this run wakes.
   */
  const lead = run.leadSessionId ? sessionById.get(run.leadSessionId) : undefined;
  if (run.pendingPrompt && lead?.state === "idle") {
    actions.push({ type: "deliver_prompt", runId: run.id, prompt: run.pendingPrompt });
    return actions;
  }

  if (run.policy.wakePolicy === "none") {
    if (remaining.length === 0 && steps.length > 0) {
      const anyFailed = steps.some((step) =>
        ["failed", "cancelled"].includes(effectiveState(step)),
      );
      const fatal = anyFailed && run.policy.onStepFailure !== "continue";
      for (const session of ownedLiveSessions(input)) {
        actions.push({
          type: "stop_session",
          sessionId: session.id,
          reason: "The run that owned this session finished",
        });
      }
      actions.push({
        type: "finish_run",
        state: fatal ? "failed" : "completed",
        reason: fatal ? "A step failed." : "",
      });
    }
    return actions;
  }

  /*
   * One wake per unseen settle, and only into an idle Lead. The counters carry
   * the "owed a wake" fact across restarts, which is why they are compared here
   * rather than remembered in the engine.
   */
  if (!heldByHuman && run.settleSeq > run.wakeSeq && run.emptyWakeCount < 2) {
    if (lead?.state === "idle") {
      actions.push({ type: "wake_lead", runId: run.id, prompt: "" });
    }
  }

  return actions;
}

/** Sessions this run is still holding open, which each reserve a node slot. */
function ownedLiveSessions(input: ScheduleInput): FleetSession[] {
  return input.sessions.filter(
    (session) =>
      session.runId === input.run.id && !terminalSessionStates.has(session.state),
  );
}

/** Read-only work: it cannot disturb a checkout, so it takes no write lock. */
export function isReadOnlyCategory(category: string): boolean {
  return !isWritingCategory(category);
}

/** A review has to see the changes, so it cannot be sent to a different tree. */
export function isReviewCategory(category: string): boolean {
  return category.startsWith("review");
}

export type PlacementRequest = {
  run: Run;
  category: string;
  /** The workspace the orchestrator named, if it named one. */
  workspace?: string | undefined;
  /**
   * Whether this run has ever written to its pinned checkout.
   *
   * The pin is only meaningful once something has changed a tree; asked rather
   * than assumed because a pin set by anything else is not a fact about where
   * the changes are. Read-only work used to set one, and that stale value
   * would otherwise go on constraining the run forever.
   */
  hasWritingStep: boolean;
  placements: readonly Placement[];
  nodeById: ReadonlyMap<string, FleetNode>;
  reservedFor: (nodeId: string, kind: SessionKind) => number;
  writingInFlight: ReadonlySet<string>;
};

/**
 * Where one step should run, or a sentence saying why nowhere will do.
 *
 * Shared by the engine and the tools deliberately. They used to decide this
 * separately and had drifted, so the tool could answer the model with one path
 * and the engine then dispatch to another.
 *
 * The pin exists so that work which must see this run's changes lands on the
 * checkout holding them — a reviewer above all, but a test or a follow-up
 * implementation just as much. What it must not do is decide where *unrelated*
 * work goes. Reading it as a hard constraint on every step froze an
 * orchestrator onto the first checkout it ever touched, so a workspace added
 * later could never be reached at all.
 *
 * Naming a workspace is therefore how the orchestrator says "this is different
 * work"; saying nothing means "carry on where we were".
 */
export function decidePlacement(request: PlacementRequest): Placement | string {
  const { run, placements, nodeById, reservedFor, writingInFlight } = request;
  const writes = isWritingCategory(request.category);
  const kind: SessionKind = writes ? "writing" : "read-only";
  const pinned =
    run.placementId && request.hasWritingStep
      ? placements.find((placement) => placement.id === run.placementId)
      : undefined;
  const wanted = request.workspace?.trim().toLowerCase();

  /*
   * A review of changes it cannot see is worthless, so the pin wins here even
   * if a workspace was named — that combination is a mistake, not a request.
   */
  const mustSeeChanges = pinned && (isReviewCategory(request.category) || !wanted);
  if (mustSeeChanges) {
    const why = isReviewCategory(request.category)
      ? "holds the changes to review"
      : "holds this run's changes";
    if (writes && writingInFlight.has(pinned!.id)) {
      return `Another step is already writing to ${pinned!.nodeName}, which ${why}. Only one writer at a time; a review can go now.`;
    }
    const node = nodeById.get(pinned!.nodeId);
    if (!usable(node, run)) {
      return `${pinned!.nodeName} ${why} and is not available. Wait for it, or ask a human.`;
    }
    if (remainingCapacity(node!, reservedFor(node!.id, kind), kind) < 1) {
      return `${pinned!.nodeName} ${why} but has no free slot. Wait for a step to settle — you will be told when one does.`;
    }
    return pinned!;
  }

  const candidates = placements.filter((placement) =>
    wanted
      ? (placement.workspaceName ?? "").toLowerCase().includes(wanted)
      : placement.workspaceId === run.workspaceId,
  );
  if (candidates.length === 0) {
    return wanted
      ? `No checkout matches "${request.workspace}". Call fleet_list_nodes to see which workspaces exist.`
      : "This run's workspace has no checkout on any node. Ask a human to add one.";
  }

  let blockedByWriter = false;
  let full = false;
  const ranked = candidates
    .flatMap((placement) => {
      const node = nodeById.get(placement.nodeId);
      if (!usable(node, run)) return [];
      return [
        { placement, free: remainingCapacity(node!, reservedFor(node!.id, kind), kind) },
      ];
    })
    .sort((a, b) => b.free - a.free);

  for (const { placement, free } of ranked) {
    if (writes && writingInFlight.has(placement.id)) {
      blockedByWriter = true;
      continue;
    }
    if (free < 1) {
      full = true;
      continue;
    }
    return placement;
  }

  if (full) {
    return "Every node with that checkout is full. Wait for a step to settle — you will be told when one does.";
  }
  if (blockedByWriter) {
    return "Another step is already writing to that checkout. Only one writer at a time; a review or an explore can go now.";
  }
  return "No online node has that checkout. Call fleet_list_nodes to see what is available.";
}

function choosePlacement(
  step: RunStep,
  context: Omit<PlacementRequest, "category" | "workspace">,
): string | undefined {
  /*
   * A step that already names a checkout keeps it. The orchestrator tools
   * resolve one up front so they can answer the model with a real path, and
   * deciding again here is how that answer used to become a lie — including
   * losing the workspace the model asked for, which the step itself does not
   * carry.
   */
  if (step.placementId) {
    const chosen = context.placements.find((p) => p.id === step.placementId);
    if (!chosen) return undefined;
    const node = context.nodeById.get(chosen.nodeId);
    if (!usable(node, context.run)) return undefined;
    if (isWritingCategory(step.category) && context.writingInFlight.has(chosen.id)) {
      return undefined;
    }
    const kind: SessionKind = isReadOnlyCategory(step.category) ? "read-only" : "writing";
    if (remainingCapacity(node!, context.reservedFor(node!.id, kind), kind) < 1) {
      return undefined;
    }
    return chosen.id;
  }

  const decided = decidePlacement({ ...context, category: step.category });
  return typeof decided === "string" ? undefined : decided.id;
}

function usable(node: FleetNode | undefined, run: Run): boolean {
  if (!node?.online) return false;
  // Refused rather than downgraded: an older agent ignores the flag and runs
  // with prompts on, which is not the unattended execution the run authorised.
  if (run.policy.yolo && !node.capabilities.includes(HOST_YOLO_CAPABILITY)) return false;
  return true;
}
