import {
  canTransitionRun,
  canTransitionRunStep,
  eventPayload,
  isWritingCategory,
  ORCHESTRATOR_STOP_REASON,
  terminalRunStates,
  terminalRunStepStates,
  terminalSessionStates,
  type Run,
  type RunStep,
  type SessionEvent,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import {
  notificationAttemptKey,
  notificationAttemptKeyForStep,
} from "../notifications/service.js";
import { statusCheckEnvelope, wakeEnvelope } from "./briefing.js";
import { ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS } from "./deadlines.js";
import { isReadOnlyCategory, planNextActions, type ScheduleAction } from "./schedule.js";

/**
 * Turns the scheduler's decisions into writes and commands.
 *
 * The split is deliberate: everything hard to reason about lives in
 * `planNextActions`, which is pure and unit-tested, and this class only carries
 * the results out. A bug that needs a running fleet to reproduce is a bug in
 * the wrong file.
 */
export class OrchestratorEngine {
  /** Sessions whose current turn has ended, per §"completion is two facts". */
  private readonly turnComplete = new Map<string, string>();
  /** When each run was last woken, so an envelope only carries what is new. */
  private readonly wakeWatermarks = new Map<string, number>();
  /**
   * Leads already sent a prompt during the tick in progress.
   *
   * A tick walks every run and re-reads sessions each time, but a lead that
   * was just prompted is still recorded as `idle` — its `running` state only
   * arrives back from the Node afterwards. Without this, two tasks sharing one
   * orchestrator both see an idle lead in the same pass and both send, and the
   * second is refused and silently lost.
   */
  private readonly promptedThisTick = new Set<string>();

  constructor(private readonly service: FleetService) {}

  private get store() {
    return this.service.store;
  }

  /**
   * Records the two facts a step's success depends on.
   *
   * `turn_complete` alone is not success — the session must then go idle — and
   * an idle session that never completed a turn never started one. Keeping the
   * flag here rather than re-reading the log keeps the tick cheap.
   */
  handleSessionEvent(event: SessionEvent): void {
    if (event.type === "turn_complete") {
      const completion = this.store.getSessionTurnCompletion(event.sessionId);
      if (completion) {
        this.turnComplete.set(event.sessionId, completion.attempt);
      } else {
        const session = this.store.getSession(event.sessionId);
        const step = this.store.getRunStepBySession(event.sessionId);
        if (session && step) {
          this.turnComplete.set(
            event.sessionId,
            notificationAttemptKey(session, {
              step,
              run: this.store.getRun(step.runId),
            }),
          );
        }
      }
      this.reconcileStoppedAttempt(event.sessionId);
      this.tick();
      return;
    }
    if (event.type === "state") {
      const state = eventPayload(event, "state")?.state;
      if (!state) return;
      // A new launch or turn invalidates the previous one's completion. A
      // resumed session reaches `starting`, then `idle`, before its queued
      // follow-up starts; clearing here prevents that idle event from settling
      // the new attempt with the previous turn's receipt.
      if (state === "starting" || state === "running") {
        this.turnComplete.delete(event.sessionId);
      }
      this.reconcileStoppedAttempt(event.sessionId);
      this.tick();
    }
  }

  /**
   * Applies a late, authoritative outcome without reopening a cancelled run.
   *
   * Stop wins over new dispatch, but an attempt that genuinely completed at
   * the same time keeps its success, and a host-reported failure stays failed.
   * The event-log lookup also reconstructs the completion receipt after a Host
   * restart instead of depending only on the in-memory set.
   */
  private reconcileStoppedAttempt(sessionId: string): void {
    const step = this.store
      .listRuns()
      .filter(
        (run) =>
          run.state === "cancelled" && run.failureReason === ORCHESTRATOR_STOP_REASON,
      )
      .flatMap((run) => this.store.listRunSteps(run.id))
      .find(
        (candidate) =>
          candidate.sessionId === sessionId && candidate.stoppedByOrchestrator,
      );
    if (!step) return;
    const session = this.store.getSession(sessionId);
    if (!session) return;

    if (session.state === "failed") {
      this.store.updateRunStep(step.id, {
        state: "failed",
        output: session.currentActivity,
        stoppedByOrchestrator: false,
      });
      this.service.publishRunSteps(step.runId, this.store.listRunSteps(step.runId));
      return;
    }

    const attempt = notificationAttemptKey(session, {
      step,
      run: this.store.getRun(step.runId),
    });
    const completedTurn =
      this.turnComplete.get(sessionId) === attempt ||
      this.store
        .listEvents(sessionId)
        .some(
          (event) => event.type === "turn_complete" && event.sequence > step.eventSeqFrom,
        );
    if (
      completedTurn &&
      (session.state === "idle" ||
        session.state === "completed" ||
        session.state === "stopped")
    ) {
      const output = this.store
        .listEvents(sessionId)
        .filter(
          (event) => event.type === "agent_text" && event.sequence > step.eventSeqFrom,
        )
        .map((event) => eventPayload(event, "agent_text")?.text ?? "")
        .join("");
      this.store.updateRunStep(step.id, {
        state: "succeeded",
        output,
        stoppedByOrchestrator: false,
      });
      this.service.publishRunSteps(step.runId, this.store.listRunSteps(step.runId));
    }
  }

  /** Advances every run that is not already finished. */
  tick(nowMs = Date.now()): void {
    this.promptedThisTick.clear();
    for (const run of this.store.listRuns()) {
      if (terminalRunStates.has(run.state)) continue;
      this.tickRun(run.id, nowMs);
    }
    this.remindIdleLeads(nowMs);
  }

  tickRun(runId: string, nowMs = Date.now()): void {
    const run = this.store.getRun(runId);
    if (!run || terminalRunStates.has(run.state)) return;

    const steps = this.store.listRunSteps(runId);
    const sessions = this.store.listSessions();
    const completedTurns = new Set<string>();
    for (const session of sessions) {
      if (
        (session.runId && session.runId !== runId) ||
        (session.runRole !== "worker" && session.runRole !== "reviewer")
      ) {
        continue;
      }
      const step = this.store.getRunStepBySession(session.id);
      if (!step || step.runId !== runId) continue;
      const completion = this.store.getSessionTurnCompletion(session.id);
      const attempt = notificationAttemptKey(session, {
        step,
        run,
      });
      if (
        completion?.attempt === attempt ||
        this.turnComplete.get(session.id) === attempt
      ) {
        completedTurns.add(session.id);
      }
    }
    const actions = planNextActions({
      run,
      steps,
      sessions,
      nodes: this.store.listNodes(),
      placements: this.store.listPlacements(),
      turnCompleteSessionIds: completedTurns,
      stepOutputs: this.collectOutputs(steps, run.policy.maxOutputChars),
      nowMs,
    });
    if (actions.length === 0) return;

    let touched = false;
    for (const action of actions) touched = this.execute(run, action, nowMs) || touched;
    if (touched) this.publish(runId);
  }

  private execute(run: Run, action: ScheduleAction, nowMs: number): boolean {
    switch (action.type) {
      case "start_step":
        return this.startStep(run, action);
      case "resume_step":
        return this.resumeStep(run, action);
      case "prompt_step":
        return this.promptStep(run, action);
      case "advance_step":
        return Boolean(this.store.updateRunStep(action.stepId, { state: "running" }));
      case "settle_step":
        return this.settleStep(run, action);
      case "skip_step":
        return Boolean(
          this.store.updateRunStep(action.stepId, {
            state: "skipped",
            output: action.reason,
          }),
        );
      case "stop_session":
        this.stopSession(action.sessionId);
        return false;
      case "deliver_prompt":
        return this.deliverPrompt(run, action.prompt, nowMs);
      case "wake_lead":
        return this.wakeLead(run, nowMs);
      case "finish_run":
        return this.finishRun(run, action.state, action.reason);
    }
  }

  /**
   * Writes the receipt, then sends the command.
   *
   * A database transaction cannot hold a socket send, so there is no ordering
   * where both happen atomically — only orderings where the crash window is
   * survivable. This one is: a step recorded as `starting` that never went out
   * comes back to `pending`, whereas a command sent before its receipt would
   * leave an agent running that no run knows about.
   */
  private startStep(
    run: Run,
    action: Extract<ScheduleAction, { type: "start_step" }>,
  ): boolean {
    const placement = this.store.getPlacement(action.placementId);
    const step = this.store.getRunStep(action.stepId);
    if (!placement || !step) return false;
    if (!canTransitionRunStep(step.state, "starting")) return false;

    const starting = this.store.updateRunStep(step.id, {
      state: "starting",
      placementId: placement.id,
      dispatchedAt: new Date().toISOString(),
    });
    if (!starting) return false;

    const result = this.service.createAndStartSession({
      placement,
      prompt: action.prompt,
      yolo: run.policy.yolo,
      name: step.title,
      runId: run.id,
      runRole: step.category.startsWith("review") ? "reviewer" : "worker",
      // Decided here because the step knows the category and the session does
      // not; capacity is read from sessions long after this point.
      readOnly: isReadOnlyCategory(step.category),
      dispatchAttempt: notificationAttemptKeyForStep(run, starting),
    });

    if (!result.ok) {
      // Nothing is running, so the step goes back in the queue rather than
      // being blamed for a failure that happened before it started.
      this.store.updateRunStep(step.id, { state: "pending", dispatchedAt: "" });
      return true;
    }

    this.store.updateRunStep(step.id, {
      sessionId: result.session.id,
      // Output collected from here on belongs to this step; a session that is
      // prompted again must not replay the previous turn.
      eventSeqFrom: this.store.maxEventSequence(result.session.id),
    });

    /*
     * Only work that changes the tree decides where the run's changes live.
     * The comment here already said "side-effecting", but the code pinned on
     * any step at all — so a single read-only explore was enough to freeze an
     * orchestrator onto that checkout for good.
     */
    if (!run.placementId && isWritingCategory(step.category)) {
      this.store.updateRun(run.id, { placementId: placement.id });
    }
    if (run.state === "planning" || run.state === "awaiting_lead") {
      if (canTransitionRun(run.state, "running")) {
        this.store.setRunState(run.id, "running");
      }
    }
    return true;
  }

  /** Re-attaches a settled worker; its persisted retry prompt is sent once idle. */
  private resumeStep(
    run: Run,
    action: Extract<ScheduleAction, { type: "resume_step" }>,
  ): boolean {
    const step = this.store.getRunStep(action.stepId);
    const session = this.store.getSession(action.sessionId);
    if (!step || step.state !== "pending" || !session) return false;
    if (!terminalSessionStates.has(session.state)) return false;
    this.store.updateRunStep(step.id, { dispatchedAt: new Date().toISOString() });
    const resumed = this.service.resumeSession(
      session.id,
      "Resuming for orchestrator follow-up",
    );
    if (resumed.ok) return true;

    return this.failStep(
      run,
      step,
      `Could not resume the same worker session: ${resumed.error}`,
      { dispatchedAt: "" },
    );
  }

  /** Sends the retry only after session/load has restored the same conversation. */
  private promptStep(
    run: Run,
    action: Extract<ScheduleAction, { type: "prompt_step" }>,
  ): boolean {
    const step = this.store.getRunStep(action.stepId);
    const session = this.store.getSession(action.sessionId);
    if (!step || step.state !== "pending" || session?.state !== "idle") return false;

    this.store.updateRunStep(step.id, {
      state: "starting",
      eventSeqFrom: this.store.maxEventSequence(session.id),
      dispatchedAt: new Date().toISOString(),
    });
    const sent = this.service.dispatch(session.nodeId, {
      type: "prompt",
      sessionId: session.id,
      prompt: action.prompt,
      attachments: [],
    });
    if (!sent.sent) {
      this.store.updateRunStep(step.id, { state: "pending", dispatchedAt: "" });
      return true;
    }
    if (run.state === "planning" || run.state === "awaiting_lead") {
      if (canTransitionRun(run.state, "running")) {
        this.store.setRunState(run.id, "running");
      }
    }
    return true;
  }

  private settleStep(
    run: Run,
    action: Extract<ScheduleAction, { type: "settle_step" }>,
  ): boolean {
    const step = this.store.getRunStep(action.stepId);
    if (!step || !canTransitionRunStep(step.state, action.state)) return false;
    if (action.state === "failed") {
      return this.failStep(run, step, action.output);
    }
    const settled = this.service.settleOrchestrationStep({
      runId: run.id,
      stepId: step.id,
      state: action.state,
      output: action.output,
    });
    if (settled && step.sessionId) this.turnComplete.delete(step.sessionId);
    return settled;
  }

  private failStep(
    run: Run,
    step: RunStep,
    output: string,
    patch: Pick<RunStep, "dispatchedAt"> | undefined = undefined,
  ): boolean {
    if (step.state === "failed" || !canTransitionRunStep(step.state, "failed")) {
      return false;
    }
    const settled = this.service.settleOrchestrationStep({
      runId: run.id,
      stepId: step.id,
      state: "failed",
      output,
      ...(patch ? { patch } : {}),
    });
    if (settled && step.sessionId) this.turnComplete.delete(step.sessionId);
    return settled;
  }

  private stopSession(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session || terminalSessionStates.has(session.state)) return;
    // Stop, not cancel: cancel ends the turn and leaves the process holding a
    // slot on its node.
    this.service.dispatch(session.nodeId, { type: "stop", sessionId });
  }

  /**
   * Hands over a message the run has been holding, once.
   *
   * The column is cleared before the send, for the same reason the wake counter
   * moves first: a send that fails costs one message rather than risking a loop
   * that repeats it on every tick forever.
   */
  private deliverPrompt(run: Run, prompt: string, nowMs: number): boolean {
    const lead = run.leadSessionId ? this.store.getSession(run.leadSessionId) : undefined;
    if (!lead || lead.state !== "idle") return false;
    if (this.promptedThisTick.has(lead.id)) return false;
    this.promptedThisTick.add(lead.id);
    if (
      !this.store.recordRunPromptDelivery(
        run.id,
        lead.id,
        prompt,
        new Date(nowMs).toISOString(),
      )
    ) {
      this.promptedThisTick.delete(lead.id);
      return false;
    }
    this.service.dispatch(lead.nodeId, {
      type: "prompt",
      sessionId: lead.id,
      prompt,
      attachments: [],
    });
    return true;
  }

  /**
   * Delivers one wake, and only one.
   *
   * The counter moves before the prompt is sent, so a send that fails costs a
   * wake rather than risking a loop that sends forever.
   */
  private wakeLead(run: Run, nowMs: number): boolean {
    const lead = run.leadSessionId ? this.store.getSession(run.leadSessionId) : undefined;
    if (!lead || lead.state !== "idle") return false;
    if (this.promptedThisTick.has(lead.id)) return false;
    this.promptedThisTick.add(lead.id);
    if (!this.store.recordRunWakePrompt(run.id, lead.id, new Date(nowMs).toISOString())) {
      this.promptedThisTick.delete(lead.id);
      return false;
    }
    this.service.dispatch(lead.nodeId, {
      type: "prompt",
      sessionId: lead.id,
      prompt: this.wakeEnvelope(run),
      attachments: [],
    });
    return true;
  }

  /**
   * Gives each idle Lead one read-only status check for its own active tasks.
   *
   * This runs after ordinary task briefs and settle wakes, so those prompts win.
   * It only ever addresses the Lead session; dispatched workers are neither
   * prompted nor stopped by this path.
   */
  private remindIdleLeads(nowMs: number): void {
    const sessions = this.store.listSessions();
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const activeByLead = new Map<string, Run[]>();

    for (const run of this.store.listRuns()) {
      if (!run.leadSessionId) continue;
      if (
        terminalRunStates.has(run.state) ||
        run.state === "awaiting_approval" ||
        run.state === "awaiting_human"
      ) {
        continue;
      }
      const owned = activeByLead.get(run.leadSessionId) ?? [];
      owned.push(run);
      activeByLead.set(run.leadSessionId, owned);
    }

    for (const [leadSessionId, runs] of activeByLead) {
      const lead = sessionById.get(leadSessionId);
      if (!lead || lead.runRole !== "lead" || lead.state !== "idle") continue;
      if (this.promptedThisTick.has(lead.id)) continue;

      const lastAutomatedPrompt = Date.parse(
        this.store.lastOrchestratorPromptAt(lead.id),
      );
      const lastActivity = Date.parse(lead.updatedAt);
      const baseline = Math.max(
        Number.isFinite(lastAutomatedPrompt) ? lastAutomatedPrompt : 0,
        Number.isFinite(lastActivity) ? lastActivity : Date.parse(lead.createdAt),
      );
      if (nowMs - baseline < ORCHESTRATOR_STATUS_CHECK_INTERVAL_MS) continue;

      const tasks = runs.map((run) => {
        const steps = this.store.listRunSteps(run.id);
        const open = steps.filter((step) => !terminalRunStepStates.has(step.state));
        const dispatched = open.filter(
          (step) => step.state === "starting" || step.state === "running",
        );
        const phase =
          run.phases.length > 0
            ? `phase ${run.phaseIndex + 1}/${run.phases.length}: ${
                run.phases[run.phaseIndex] ?? "done"
              }`
            : "no phases";
        return {
          name: run.name,
          state: run.state,
          phase,
          openSteps: open.length,
          dispatchedSteps: dispatched.length,
        };
      });

      this.promptedThisTick.add(lead.id);
      this.store.recordOrchestratorPrompt(lead.id, new Date(nowMs).toISOString());
      this.service.dispatch(lead.nodeId, {
        type: "prompt",
        sessionId: lead.id,
        prompt: statusCheckEnvelope(tasks),
        attachments: [],
      });
    }
  }

  /** The bounded summary a woken Lead reads instead of the whole fleet. */
  private wakeEnvelope(run: Run): string {
    const steps = this.store.listRunSteps(run.id);
    const done = steps.filter(
      (step) => step.state === "succeeded" || step.state === "failed",
    );
    /*
     * Only what settled since the last wake. An orchestrator re-reading every
     * step it ever finished spends its context on work it already acted on,
     * and starts deciding about it a second time. The first wake has no
     * watermark, so it sees everything, which is correct.
     */
    const since = this.wakeWatermarks.get(run.id) ?? 0;
    const fresh = done.filter((step) => Date.parse(step.updatedAt) > since);
    const running = steps.filter(
      (step) => step.state === "running" || step.state === "starting",
    );
    this.wakeWatermarks.set(run.id, Date.now());
    return wakeEnvelope({
      runId: run.id,
      task: run.name,
      ...(run.phases.length > 0
        ? {
            phase: run.phases[run.phaseIndex] ?? "",
            phaseNumber: run.phaseIndex + 1,
            phaseCount: run.phases.length,
            isLastPhase: run.phaseIndex >= run.phases.length - 1,
          }
        : {}),
      wakes: run.wakeSeq + 1,
      maxWakes: run.policy.maxWakes,
      settled: (fresh.length > 0 ? fresh : done).map((step) => ({
        title: step.title,
        category: step.category || "step",
        state: step.state,
        output: step.output,
        sessionId: step.sessionId,
      })),
      running: running.map((step) => ({
        title: step.title,
        category: step.category || "step",
        sessionId: step.sessionId,
      })),
    });
  }

  private finishRun(run: Run, state: Run["state"], reason: string): boolean {
    if (!canTransitionRun(run.state, state)) return false;
    this.store.setRunState(run.id, state, reason);
    return true;
  }

  /**
   * This step's share of its session's transcript.
   *
   * Bounded from both ends: a failure's most useful line is the last one, so a
   * plain head-truncation reliably discards the reason the step failed.
   */
  private collectOutputs(
    steps: readonly RunStep[],
    maxChars: number,
  ): Map<string, string> {
    const outputs = new Map<string, string>();
    for (const step of steps) {
      if (!step.sessionId) continue;
      if (step.state !== "running" && step.state !== "starting") continue;
      const text = this.store
        .listEvents(step.sessionId)
        .filter(
          (event) => event.type === "agent_text" && event.sequence > step.eventSeqFrom,
        )
        .map((event) => eventPayload(event, "agent_text")?.text ?? "")
        .join("");
      outputs.set(step.id, truncateMiddle(text, maxChars));
    }
    return outputs;
  }

  private publish(runId: string): void {
    const run = this.store.getRun(runId);
    if (run) this.service.publishRun(run);
    this.service.publishRunSteps(runId, this.store.listRunSteps(runId));
  }
}

/** Keeps the head for context and the tail for the error that ended it. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const elided = text.length - maxChars;
  return `${text.slice(0, head)}\n… ${elided} characters elided …\n${text.slice(-tail)}`;
}
