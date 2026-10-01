import {
  HOST_YOLO_CAPABILITY,
  MANAGED_WORKTREES_CAPABILITY,
  PORTABLE_WORKTREE_RESULTS_CAPABILITY,
  checkoutLockKey,
  isChatsWorkspace,
  isWritingCategory,
  terminalRunStates,
  terminalRunStepStates,
  terminalSessionStates,
  type FleetNode,
  type FleetSession,
  type Placement,
  type PlacementRepositoryCapability,
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

const REPOSITORY_CAPABILITY_MAX_AGE_MS = 5 * 60_000;

const sessionLabel = (session: FleetSession) =>
  session.name ? `"${session.name}"` : `session ${session.id.slice(0, 8)}`;

/**
 * Names who holds a checkout, and whether Fleet will hand it over by itself.
 *
 * A settled task worker is parked before another task's worker takes its
 * checkout, so waiting clears. A session no task manages is a person's, and
 * nothing here stops it on their behalf.
 */
function checkoutBusyDetail(
  placement: Placement,
  node: FleetNode,
  occupants: readonly FleetSession[],
): string {
  const managed = occupants.every(
    (occupant) => occupant.runRole === "worker" || occupant.runRole === "reviewer",
  );
  return [
    `${placement.localPath} on ${node.name} is in use by ${occupants
      .map((occupant) => `${sessionLabel(occupant)} (${occupant.state})`)
      .join(", ")}.`,
    "One live session holds a checkout at a time, because Git state and build output are shared.",
    managed
      ? "Fleet parks a settled task worker before handing its checkout over, so this resumes by itself once that session finishes its turn."
      : "A session that no task manages keeps the checkout until whoever is using it stops it.",
  ].join(" ");
}

function sessionBusyDetail(state: FleetSession["state"]): string {
  switch (state) {
    case "starting":
      return "The worker's conversation is being started or restored; its queued follow-up is sent once it is idle.";
    case "running":
      return "The worker is running a turn; its queued follow-up is sent once that turn ends and the worker is idle.";
    case "cancelling":
      return "The worker is cancelling its current turn; its queued follow-up is sent once it is idle.";
    case "offline":
      return "The worker's Node connection is being re-established; its queued follow-up waits for the worker's state.";
    default:
      return `The worker is ${state}; its queued follow-up is sent once it is idle.`;
  }
}

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
  /**
   * Re-attaches the session a pending retry already belongs to.
   *
   * `exceptionId` names the operator-approved "Resume now" request this resume
   * spends, when the ordinary scheduling margin alone would have held it back.
   */
  | { type: "resume_step"; stepId: string; sessionId: string; exceptionId?: string }
  /** Starts the retry turn once its resumed session is idle. */
  | { type: "prompt_step"; stepId: string; sessionId: string; prompt: string }
  /** The Node took the command: `starting` becomes `running`. */
  | { type: "advance_step"; stepId: string }
  | { type: "settle_step"; stepId: string; state: RunStepState; output: string }
  | { type: "skip_step"; stepId: string; reason: string }
  | { type: "stop_session"; sessionId: string; reason: string }
  /** Hands over a message the run has been holding for its Lead. */
  | { type: "deliver_prompt"; runId: string; prompt: string }
  | { type: "wake_lead"; runId: string; prompt: string }
  | { type: "finish_run"; state: RunState; reason: string };

/** Why a pending step was left pending, in the terms the planner used. */
export type StepHoldCode =
  | "task_held"
  | "nodes_unknown"
  | "dependencies"
  | "workspace_not_ready"
  | "stop_pending"
  | "dismissed"
  | "node_offline"
  | "checkout_busy"
  | "parallel_limit"
  | "node_headroom"
  | "node_capacity"
  | "session_busy"
  | "no_placement"
  | "maintenance_hold"
  | "command_fence"
  | "cleanup_pending";

export type StepHold = {
  code: StepHoldCode;
  detail: string;
  /** Sessions holding what this step needs, most relevant first. */
  conflicts?: readonly string[];
  nodeId?: string;
  placementId?: string;
  checkoutKey?: string;
  /** Slot accounting when capacity is the reason. */
  capacity?: { kind: SessionKind; reserved: number; limit: number };
};

/**
 * An operator-approved, one-shot exception for one queued retry.
 *
 * It may only spend the scheduling margin (`node_headroom`), and only for the
 * exact session and attempt it was approved for. Everything else the planner
 * checks still applies.
 */
export type ScheduleException = {
  requestId: string;
  restriction: "node_headroom";
  sessionId: string;
  attempt: number;
};

export type ScheduleInput = {
  workspaceReady?: boolean;
  parkableSessionIds?: ReadonlySet<string>;
  run: Run;
  steps: readonly RunStep[];
  sessions: readonly FleetSession[];
  nodes: readonly FleetNode[];
  placements: readonly Placement[];
  repositoryCapabilities?: readonly PlacementRepositoryCapability[];
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
  /**
   * Receives why each pending step was left pending in this pass.
   *
   * Filled by the same decisions that dispatch, so an explanation shown to a
   * person or an orchestrator cannot drift from what the engine did.
   */
  holds?: Map<string, StepHold>;
  /** Operator-approved "Resume now" exceptions, keyed by step id. */
  exceptions?: ReadonlyMap<string, ScheduleException>;
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

/**
 * Whether a live session holds its checkout against another writer.
 *
 * On a Node with managed worktrees every live non-lead session holds its
 * physical checkout, idle or not, because its process can still change it.
 * Elsewhere only a writing session in a turn does. Shared by the scheduler
 * and the manual Resume guard so the two cannot disagree.
 */
export function holdsCheckout(
  session: FleetSession,
  node: FleetNode | undefined,
): boolean {
  const strict =
    Boolean(session.executionBinding?.worktreeId) ||
    Boolean(node?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY));
  return (
    session.runRole !== "lead" &&
    !terminalSessionStates.has(session.state) &&
    (strict || (!session.readOnly && session.state !== "idle"))
  );
}

/**
 * The live sessions holding the checkout `target` would write to, if it needs one.
 *
 * A read-only session on a Node without managed worktrees takes no lease, the
 * same exemption the scheduler gives a reviewer beside a writer.
 */
export function checkoutOccupants(
  target: FleetSession,
  sessions: readonly FleetSession[],
  nodes: readonly FleetNode[],
): FleetSession[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const node = nodeById.get(target.nodeId);
  const needsLease =
    Boolean(target.executionBinding?.worktreeId) ||
    Boolean(node?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY)) ||
    !target.readOnly;
  if (!needsLease) return [];
  const key = checkoutLockKey(target);
  return sessions.filter(
    (candidate) =>
      candidate.id !== target.id &&
      candidate.nodeId === target.nodeId &&
      checkoutLockKey(candidate) === key &&
      holdsCheckout(candidate, nodeById.get(candidate.nodeId)),
  );
}

export function planNextActions(input: ScheduleInput): ScheduleAction[] {
  const { run, steps } = input;
  const hold = (step: RunStep, value: StepHold) => input.holds?.set(step.id, value);
  const holdEveryPending = (value: StepHold) => {
    for (const step of steps) if (step.state === "pending") hold(step, value);
  };
  if (terminalRunStates.has(run.state)) return [];
  if (run.state === "awaiting_approval") {
    holdEveryPending({
      code: "task_held",
      detail:
        "The task is waiting for its plan to be approved; nothing is dispatched yet.",
    });
    return [];
  }
  if (run.state === "blocked") {
    holdEveryPending({
      code: "task_held",
      detail: "The task is blocked; nothing is dispatched until it is unblocked.",
    });
    return [];
  }
  /*
   * A task waiting on a person is not waiting on the fleet: nothing new is
   * dispatched and the orchestrator is not woken, because that would be the
   * engine talking over the review it just asked for.
   *
   * Recording what already happened still runs, though. Workers deliberately
   * remain attached and idle until the task is archived, so a person can send it
   * back without paying to reconstruct their context. Archive stops but retains
   * them for the same reason if the task is reopened later.
   */
  const heldByHuman = run.state === "awaiting_human";

  /*
   * A Host that just restarted has not heard from anyone yet, and every session
   * it owns reads `offline`. Settling on that would mark live work as failed and
   * finish runs that are still going; waiting costs one reconnect.
   */
  if (input.nodes.length > 0 && input.nodes.every((node) => !node.online)) {
    holdEveryPending({
      code: "nodes_unknown",
      detail:
        "No Node has reported since the Host started. Scheduling resumes when one reconnects.",
    });
    return [];
  }

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
      const acknowledged =
        pending &&
        (step.attempts > 1
          ? pending.state === "running" ||
            terminalSessionStates.has(pending.state) ||
            // A fast retry may finish between ticks (or during a Host restart).
            // Only a dispatched prompt's current-attempt receipt proves it ran.
            (Boolean(step.dispatchedAt) &&
              pending.state === "idle" &&
              input.turnCompleteSessionIds.has(pending.id))
          : pending.state !== "queued" && pending.state !== "offline");
      if (acknowledged) {
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
  const activeRetries = live.filter((step) => {
    if (effectiveState(step) !== "pending" || !step.sessionId) return false;
    const session = sessionById.get(step.sessionId);
    return Boolean(
      session && session.state !== "idle" && !terminalSessionStates.has(session.state),
    );
  });

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

  const strictSession = (session: FleetSession) =>
    Boolean(session.executionBinding?.worktreeId) ||
    Boolean(
      nodeById.get(session.nodeId)?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY),
    );
  const heldBy = (session: FleetSession) =>
    holdsCheckout(session, nodeById.get(session.nodeId));
  const writingInFlight = new Set(input.sessions.filter(heldBy).map(checkoutLockKey));
  for (const step of [...inFlight, ...activeRetries]) {
    if (
      requiresCheckoutLease(
        run,
        step.category,
        nodeById.get(placementById.get(step.placementId)?.nodeId ?? ""),
      ) &&
      step.placementId
    ) {
      writingInFlight.add(
        step.executionBinding?.checkoutKey ?? executionKey(run, step.placementId),
      );
    }
  }
  // Any writing step, settled or not: its changes are still in that tree.
  const hasWritingStep = steps.some((step) => isWritingCategory(step.category));
  let started = 0;
  const workspaceReady =
    input.workspaceReady ??
    (run.workspaceBinding?.effectiveMode !== "managed" ||
      run.workspaceBinding.initialization === "ready");
  const parallelBudget = heldByHuman
    ? 0
    : run.policy.maxParallel - inFlight.length - activeRetries.length;
  const dispatched = new Set<string>();
  const awaitingPerson: StepHold = {
    code: "task_held",
    detail:
      "The task is waiting for a person's review; nothing new is dispatched until it is approved, sent back or reopened.",
  };
  const budgetHold = (): StepHold =>
    heldByHuman
      ? awaitingPerson
      : {
          code: "parallel_limit",
          detail: `The task already runs ${inFlight.length + activeRetries.length + started} of its ${run.policy.maxParallel} parallel steps; this starts when one settles.`,
          conflicts: [...inFlight, ...activeRetries]
            .map((entry) => entry.sessionId)
            .filter(Boolean),
        };
  const stepKeyOf = (entry: RunStep) =>
    entry.executionBinding?.checkoutKey ?? executionKey(run, entry.placementId);
  let budgetExhausted = false;

  for (const step of steps) {
    if (effectiveState(step) !== "pending") continue;
    const retryWorkspaceReady =
      Boolean(step.sessionId) &&
      step.workspaceState === "ready" &&
      Boolean(step.executionBinding);
    if (!workspaceReady && !retryWorkspaceReady) {
      hold(step, {
        code: "workspace_not_ready",
        detail: "The task's workspace is still being prepared.",
      });
      continue;
    }
    const unmet = step.dependsOn.filter((key) => stateByKey.get(key) !== "succeeded");
    if (unmet.length) {
      hold(step, {
        code: "dependencies",
        detail: `Waiting for ${unmet.join(", ")} to succeed first.`,
      });
      continue;
    }
    if (run.workspaceBinding?.effectiveMode === "managed" && !step.executionBinding) {
      hold(step, {
        code: "workspace_not_ready",
        detail: "This step's isolated workspace is not ready yet.",
      });
      continue;
    }
    const desiredKey =
      step.executionBinding?.checkoutKey ??
      executionKey(run, step.placementId || run.placementId);
    if (!heldByHuman && workspaceReady) {
      for (const occupant of input.sessions) {
        if (
          occupant.id === step.sessionId ||
          !strictSession(occupant) ||
          occupant.runRole === "lead" ||
          occupant.state !== "idle" ||
          occupant.stopRequested ||
          checkoutLockKey(occupant) !== desiredKey
        )
          continue;
        const settledWorker =
          input.parkableSessionIds?.has(occupant.id) ||
          steps.some(
            (previous) =>
              previous.sessionId === occupant.id &&
              terminalRunStepStates.has(effectiveState(previous)),
          );
        if (
          settledWorker &&
          !actions.some(
            (action) =>
              action.type === "stop_session" && action.sessionId === occupant.id,
          )
        ) {
          actions.push({
            type: "stop_session",
            sessionId: occupant.id,
            reason:
              "Park the settled conversation and verify process quiescence before checkout handoff.",
          });
        }
      }
    }

    /*
     * A pending step with a session id is a retry of that same Copilot
     * conversation, not a request for another worker. Resuming and prompting
     * are separate actions because session/load lands on idle; keeping the
     * prompt in the step makes the hand-off durable across a Host restart.
     */
    if (step.sessionId) {
      const session = sessionById.get(step.sessionId);
      const placementId = step.placementId || session?.placementId || "";
      const placement = placementId ? placementById.get(placementId) : undefined;
      const node = placement ? nodeById.get(placement.nodeId) : undefined;
      if (!session || !placement || !node) {
        settled.set(step.id, "failed");
        actions.push({
          type: "settle_step",
          stepId: step.id,
          state: "failed",
          output:
            "The queued follow-up's original session, placement or Node was removed. " +
            "Read the task context before deciding on replacement work.",
        });
        continue;
      }
      const where = { nodeId: node.id, placementId };
      if (session.stopRequested) {
        hold(step, {
          code: "stop_pending",
          detail:
            "A Stop for this worker has not been acknowledged yet; the queued follow-up waits for it.",
          ...where,
        });
        continue;
      }
      if (session.dismissed) {
        hold(step, {
          code: "dismissed",
          detail:
            "The worker session is dismissed; restore it before its queued follow-up can run.",
          ...where,
        });
        continue;
      }
      if (!node.online) {
        hold(step, {
          code: "node_offline",
          detail: `${node.name} is offline; the queued follow-up waits for it to reconnect.`,
          ...where,
        });
        continue;
      }
      const needsLease = requiresCheckoutLease(run, step.category, node);
      const retryKey =
        step.executionBinding?.checkoutKey ?? executionKey(run, placementId);
      const occupants = needsLease
        ? input.sessions.filter(
            (candidate) =>
              candidate.id !== session.id &&
              checkoutLockKey(candidate) === retryKey &&
              heldBy(candidate),
          )
        : [];
      if (occupants.length) {
        hold(step, {
          code: "checkout_busy",
          detail: checkoutBusyDetail(placement, node, occupants),
          conflicts: occupants.map((occupant) => occupant.id),
          checkoutKey: retryKey,
          ...where,
        });
        continue;
      }
      const sameTaskWriters = () =>
        [...inFlight, ...activeRetries]
          .filter((entry) => entry.id !== step.id && stepKeyOf(entry) === retryKey)
          .map((entry) => entry.sessionId)
          .filter(Boolean);
      const sameTaskBusy: StepHold = {
        code: "checkout_busy",
        detail: `Another step of this task is writing to ${placement.localPath} on ${node.name}; one writer per checkout.`,
        conflicts: sameTaskWriters(),
        checkoutKey: retryKey,
        ...where,
      };

      if (session.state === "idle") {
        if (started >= parallelBudget) {
          hold(step, { ...budgetHold(), ...where });
          continue;
        }
        if (
          needsLease &&
          writingInFlight.has(retryKey) &&
          !(strictSession(session) && started === 0)
        ) {
          hold(step, sameTaskBusy);
          continue;
        }
        if (needsLease) writingInFlight.add(retryKey);
        started += 1;
        dispatched.add(step.id);
        actions.push({
          type: "prompt_step",
          stepId: step.id,
          sessionId: session.id,
          prompt: step.prompt,
        });
        continue;
      }
      if (!terminalSessionStates.has(session.state)) {
        hold(step, {
          code: "session_busy",
          detail: sessionBusyDetail(session.state),
          ...where,
        });
        continue;
      }
      if (step.dispatchedAt) {
        settled.set(step.id, "failed");
        actions.push({
          type: "settle_step",
          stepId: step.id,
          state: "failed",
          output:
            session.currentActivity ||
            "The existing worker session ended while it was being resumed.",
        });
        continue;
      }
      if (started >= parallelBudget) {
        hold(step, { ...budgetHold(), ...where });
        continue;
      }
      if (needsLease && writingInFlight.has(retryKey)) {
        hold(step, sameTaskBusy);
        continue;
      }

      const kind: SessionKind = session.readOnly ? "read-only" : "writing";
      const reserved = reservedFor(node.id, kind);
      const limit = capacityFor(node, kind);
      let exceptionId: string | undefined;
      if (remainingCapacity(node, reserved, kind) <= 0) {
        const exception = input.exceptions?.get(step.id);
        const holders = input.sessions
          .filter(
            (candidate) =>
              candidate.nodeId === node.id &&
              !terminalSessionStates.has(candidate.state) &&
              Boolean(candidate.readOnly) === (kind === "read-only"),
          )
          .map((candidate) => candidate.id);
        // The approved exception spends only the reserved margin. A Node that
        // is at its hard limit refuses the launch whatever was approved.
        if (
          reserved < limit &&
          exception?.restriction === "node_headroom" &&
          exception.sessionId === session.id &&
          exception.attempt === step.attempts
        ) {
          exceptionId = exception.requestId;
        } else {
          hold(step, {
            code: reserved < limit ? "node_headroom" : "node_capacity",
            detail:
              reserved < limit
                ? `${node.name} is at Fleet's scheduling limit for ${kind} work: ${reserved} of ${limit} slots are held, and Fleet keeps the last slot free on a multi-slot Node.`
                : `${node.name} is full for ${kind} work: ${reserved} of ${limit} slots are held. The follow-up resumes when one frees.`,
            conflicts: holders,
            capacity: { kind, reserved, limit },
            ...where,
          });
          continue;
        }
      }

      reservedByNode.set(key(node.id, kind), reserved + 1);
      if (needsLease) writingInFlight.add(retryKey);
      started += 1;
      dispatched.add(step.id);
      actions.push({
        type: "resume_step",
        stepId: step.id,
        sessionId: session.id,
        ...(exceptionId ? { exceptionId } : {}),
      });
      continue;
    }

    if (started >= parallelBudget) {
      budgetExhausted = true;
      break;
    }
    const chosen = choosePlacement(step, {
      run,
      placements: input.placements,
      nodeById,
      reservedFor,
      writingInFlight,
      hasWritingStep,
      ...(input.repositoryCapabilities
        ? { repositoryCapabilities: input.repositoryCapabilities }
        : {}),
    });
    if ("reason" in chosen) {
      hold(step, { code: "no_placement", detail: chosen.reason });
      continue;
    }
    const placementId = chosen.placementId;

    const placement = placementById.get(placementId)!;
    const startedKind: SessionKind = isReadOnlyCategory(step.category)
      ? "read-only"
      : "writing";
    reservedByNode.set(
      key(placement.nodeId, startedKind),
      reservedFor(placement.nodeId, startedKind) + 1,
    );
    if (requiresCheckoutLease(run, step.category, nodeById.get(placement.nodeId))) {
      writingInFlight.add(
        step.executionBinding?.checkoutKey ?? executionKey(run, placementId),
      );
    }
    settled.set(step.id, "starting");
    started += 1;
    dispatched.add(step.id);
    actions.push({
      type: "start_step",
      stepId: step.id,
      placementId,
      // `start_session` carries the first prompt itself; a second command would
      // race the agent's own first turn.
      prompt: step.prompt,
    });
  }
  if (budgetExhausted && input.holds) {
    for (const step of steps) {
      if (
        effectiveState(step) === "pending" &&
        !dispatched.has(step.id) &&
        !input.holds.has(step.id)
      )
        hold(step, budgetHold());
    }
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

/** Capacity label only. Shell-capable reviewers still require a checkout lease. */
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
   * The machine the orchestrator named, if it named one.
   *
   * Distinct from `workspace`, which says *what* to work on. This says *where*,
   * and exists because the Host's own ranking — most free slots first — knows
   * about capacity and nothing else. It cannot know that one machine has the
   * toolchain, the credentials or the hardware a step needs, and the
   * orchestrator sometimes does.
   */
  node?: string | undefined;
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
  repositoryCapabilities?: readonly PlacementRepositoryCapability[];
};

/**
 * The machine an orchestrator meant, or a sentence saying why it is not one.
 *
 * Exact name first, then a unique substring, because the orchestrator reads
 * these names out of `fleet_list_nodes` and re-types them: "weili" should reach
 * `WEILI-MS-SP`. Two matches are refused rather than guessed between — picking
 * one would send work to a machine nobody chose, which is the whole thing
 * naming a machine was meant to prevent.
 */
export function resolveNode(
  wanted: string,
  nodes: readonly FleetNode[],
): FleetNode | string {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return "Node name was empty. Omit `node` to let the Host choose.";

  const exact = nodes.filter((node) => node.name.toLowerCase() === needle);
  const matches =
    exact.length > 0
      ? exact
      : nodes.filter((node) => node.name.toLowerCase().includes(needle));

  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    return `No node is called "${wanted}". Call fleet_list_nodes to see the machines that exist.`;
  }
  return `"${wanted}" matches ${matches.length} nodes: ${matches
    .map((node) => node.name)
    .join(", ")}. Name one of them exactly.`;
}

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
 *
 * Naming a machine is a narrower request and is treated as one: it filters the
 * candidates rather than releasing the pin. Where this run's changes live is a
 * fact, not a preference, so a step that has to see them is refused with the
 * machine that holds them named — silently honouring the request would send a
 * review to a tree with none of the work in it.
 *
 * Chats is the one destination that is not a checkout. It is a home directory
 * on each machine, and work sent there is a question rather than a change — so
 * anything that writes, or that has to read what a previous step wrote, is
 * refused rather than quietly sent to a directory with none of it in.
 */
export function decidePlacement(request: PlacementRequest): Placement | string {
  const { run, placements, nodeById, reservedFor, writingInFlight } = request;
  const writes = isWritingCategory(request.category);
  const kind: SessionKind = writes ? "writing" : "read-only";
  if (run.workspaceBinding?.effectiveMode === "managed") {
    const binding = run.workspaceBinding;
    const capabilities = new Map(
      (request.repositoryCapabilities ?? []).map((entry) => [
        `${entry.placementId}:${entry.repositoryIdentity.id}:${entry.baseSha}`,
        entry,
      ]),
    );
    const matching = placements.filter((placement) => {
      if (placement.workspaceId !== run.workspaceId) return false;
      const capability = capabilities.get(
        `${placement.id}:${binding.repositoryIdentity}:${binding.baseSha}`,
      );
      return (
        placement.id === binding.originatingPlacementId ||
        Boolean(
          (capability?.baseAvailable || capability?.baseMaterializable) &&
          capability.nodeId === placement.nodeId &&
          capability.localPath === placement.localPath &&
          Date.now() - Date.parse(capability.verifiedAt) <=
            REPOSITORY_CAPABILITY_MAX_AGE_MS &&
          capability.baseSha === binding.baseSha &&
          capability.repositoryIdentity.id === binding.repositoryIdentity &&
          capability.repositoryIdentity.objectFormat === binding.repositoryObjectFormat,
        )
      );
    });
    if (!matching.length)
      return "The managed task's pinned source placement is unavailable. Reconcile it; no fallback is permitted.";
    let candidates = matching;
    if (request.node?.trim()) {
      const resolved = resolveNode(request.node, [...nodeById.values()]);
      if (typeof resolved === "string") return resolved;
      candidates = candidates.filter((placement) => placement.nodeId === resolved.id);
      if (!candidates.length)
        return `${resolved.name} has no verified matching copy of this logical repository and pinned base.`;
    }
    const ranked = candidates
      .flatMap((placement) => {
        const node = nodeById.get(placement.nodeId);
        if (!usable(node, run)) return [];
        const capability = capabilities.get(
          `${placement.id}:${binding.repositoryIdentity}:${binding.baseSha}`,
        );
        if (
          placement.id !== binding.originatingPlacementId &&
          (!node!.capabilities.includes(PORTABLE_WORKTREE_RESULTS_CAPABILITY) ||
            capability?.portableResultsSupported === false)
        )
          return [];
        return [
          {
            placement,
            free: remainingCapacity(node!, reservedFor(node!.id, kind), kind),
          },
        ];
      })
      .sort(
        (a, b) =>
          b.free - a.free ||
          Number(b.placement.id === binding.originatingPlacementId) -
            Number(a.placement.id === binding.originatingPlacementId) ||
          a.placement.id.localeCompare(b.placement.id),
      );
    for (const candidate of ranked) {
      if (candidate.free < 1) continue;
      if (writingInFlight.has(executionKey(run, candidate.placement.id))) continue;
      return candidate.placement;
    }
    return "No online Node has a verified matching logical repository and pinned base with free capacity.";
  }
  const pinned =
    run.placementId && request.hasWritingStep
      ? placements.find((placement) => placement.id === run.placementId)
      : undefined;
  const wanted = request.workspace?.trim().toLowerCase();

  let onlyNode: FleetNode | undefined;
  if (request.node?.trim()) {
    const resolved = resolveNode(request.node, [...nodeById.values()]);
    if (typeof resolved === "string") return resolved;
    onlyNode = resolved;
  }

  /*
   * A review of changes it cannot see is worthless, so the pin wins here even
   * if a workspace was named — that combination is a mistake, not a request.
   */
  const mustSeeChanges = pinned && (isReviewCategory(request.category) || !wanted);
  if (mustSeeChanges) {
    const why = isReviewCategory(request.category)
      ? "holds the changes to review"
      : "holds this run's changes";
    if (onlyNode && onlyNode.id !== pinned!.nodeId) {
      return `${pinned!.nodeName} ${why}, so this cannot run on ${onlyNode.name}. Send it to ${pinned!.nodeName}, or name a workspace if this is unrelated work.`;
    }
    if (
      requiresCheckoutLease(run, request.category, nodeById.get(pinned!.nodeId)) &&
      writingInFlight.has(pinned!.id)
    ) {
      return `Another session holds the checkout on ${pinned!.nodeName}, which ${why}. Wait for process quiescence; read-only labels do not grant filesystem isolation.`;
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

  const inWorkspace = placements.filter((placement) =>
    wanted
      ? (placement.workspaceName ?? "").toLowerCase().includes(wanted)
      : placement.workspaceId === run.workspaceId,
  );
  if (inWorkspace.length === 0) {
    return wanted
      ? `No checkout matches "${request.workspace}". Call fleet_list_nodes to see which workspaces exist.`
      : "This run's workspace has no checkout on any node. Ask a human to add one.";
  }

  /*
   * A machine is asked for by name, so being told it simply has no copy of the
   * repository is more use than being ranked past it in silence.
   */
  let candidates = inWorkspace;
  if (onlyNode) {
    candidates = inWorkspace.filter((placement) => placement.nodeId === onlyNode.id);
    if (candidates.length === 0) {
      const which = wanted ? `"${request.workspace}"` : "this task's workspace";
      return `${onlyNode.name} has no checkout of ${which}. Call fleet_list_nodes to see what is on it, or omit \`node\` to let the Host choose.`;
    }
  }

  /*
   * Chats holds no repository, so a step that writes has nothing to write to
   * and a review has nothing to review. Dropped here rather than refused at the
   * far end: a writing step that reached a home directory would take the run's
   * pin with it, and every later step — the review above all — would be sent to
   * a directory that has never held the work.
   */
  const eligible =
    writes || isReviewCategory(request.category)
      ? candidates.filter((placement) => !isChatsWorkspace(placement.workspaceId))
      : candidates;
  if (eligible.length === 0) {
    return "Chats has no checkout, so nothing can be changed or reviewed there. Send questions and research to Chats, and name a workspace for work on a repository.";
  }

  let blockedByWriter = false;
  let full = false;
  const ranked = eligible
    .flatMap((placement) => {
      const node = nodeById.get(placement.nodeId);
      if (!usable(node, run)) return [];
      return [
        { placement, free: remainingCapacity(node!, reservedFor(node!.id, kind), kind) },
      ];
    })
    .sort((a, b) => b.free - a.free);

  for (const { placement, free } of ranked) {
    if (
      requiresCheckoutLease(run, request.category, nodeById.get(placement.nodeId)) &&
      writingInFlight.has(placement.id)
    ) {
      blockedByWriter = true;
      continue;
    }
    if (free < 1) {
      full = true;
      continue;
    }
    return placement;
  }

  /*
   * A machine asked for by name gets its own answers. "Every node with that
   * checkout is full" is true but useless when the orchestrator named exactly
   * one — it reads as though the fleet is saturated, and the next thing it
   * does is give up on work another machine could have taken.
   */
  if (onlyNode) {
    if (full) {
      return `${onlyNode.name} has no free slot. Wait for a step to settle, or omit \`node\` to use whichever machine is free.`;
    }
    if (blockedByWriter) {
      return `Another step is already writing to the checkout on ${onlyNode.name}. Only one writer at a time; a review or an explore can go there now.`;
    }
    return `${onlyNode.name} is offline${run.policy.yolo ? " or too old to run unattended" : ""}. Wait for it, or omit \`node\` to use another machine.`;
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
): { placementId: string } | { reason: string } {
  if (
    context.run.workspaceBinding?.effectiveMode === "managed" &&
    step.executionBinding
  ) {
    const source = context.placements.find(
      (placement) => placement.id === step.executionBinding!.sourcePlacementId,
    );
    const node = source ? context.nodeById.get(source.nodeId) : undefined;
    if (!source || !usable(node, context.run))
      return {
        reason: "The step's pinned source checkout or its Node is not available.",
      };
    const kind: SessionKind = isReadOnlyCategory(step.category) ? "read-only" : "writing";
    if (remainingCapacity(node!, context.reservedFor(node!.id, kind), kind) < 1)
      return { reason: `${node!.name} has no free slot for ${kind} work.` };
    if (
      requiresCheckoutLease(context.run, step.category, node) &&
      context.writingInFlight.has(step.executionBinding.checkoutKey)
    )
      return { reason: "Another session is writing to this step's checkout." };
    return { placementId: source.id };
  }
  /*
   * A step that already names a checkout keeps it. The orchestrator tools
   * resolve one up front so they can answer the model with a real path, and
   * deciding again here is how that answer used to become a lie — including
   * losing the workspace the model asked for, which the step itself does not
   * carry.
   */
  if (step.placementId) {
    const chosen = context.placements.find((p) => p.id === step.placementId);
    if (!chosen) return { reason: "The step's checkout was removed." };
    const node = context.nodeById.get(chosen.nodeId);
    if (!usable(node, context.run))
      return { reason: `${chosen.nodeName} is offline or cannot run this task.` };
    if (
      requiresCheckoutLease(context.run, step.category, node) &&
      context.writingInFlight.has(executionKey(context.run, chosen.id))
    ) {
      return {
        reason: `Another session is writing to ${chosen.localPath} on ${chosen.nodeName}; one writer per checkout.`,
      };
    }
    const kind: SessionKind = isReadOnlyCategory(step.category) ? "read-only" : "writing";
    if (remainingCapacity(node!, context.reservedFor(node!.id, kind), kind) < 1) {
      return { reason: `${chosen.nodeName} has no free slot for ${kind} work.` };
    }
    return { placementId: chosen.id };
  }

  const decided = decidePlacement({ ...context, category: step.category });
  return typeof decided === "string" ? { reason: decided } : { placementId: decided.id };
}

function usable(node: FleetNode | undefined, run: Run): boolean {
  if (!node?.online) return false;
  if (
    run.workspaceBinding?.effectiveMode === "managed" &&
    !node.capabilities.includes(MANAGED_WORKTREES_CAPABILITY)
  )
    return false;
  // Refused rather than downgraded: an older agent ignores the flag and runs
  // with prompts on, which is not the unattended execution the run authorised.
  if (run.policy.yolo && !node.capabilities.includes(HOST_YOLO_CAPABILITY)) return false;
  return true;
}

export function executionKey(run: Run, placementId: string): string {
  const binding = run.workspaceBinding;
  return binding?.effectiveMode === "managed"
    ? binding.checkoutKey || `managed:${binding.managedWorktreeId}:${binding.generation}`
    : placementId;
}

function requiresCheckoutLease(
  run: Run,
  category: string,
  node: FleetNode | undefined,
): boolean {
  return (
    run.workspaceBinding?.effectiveMode === "managed" ||
    Boolean(node?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY)) ||
    isWritingCategory(category)
  );
}
