import { createHash, randomUUID } from "node:crypto";
import {
  activeWorkerResumeRequestStates,
  checkoutLockKey,
  isChatsWorkspace,
  queuedStepAdmissionCodes,
  terminalRunStepStates,
  terminalSessionStates,
  WORKER_RESUME_LIMITS,
  WorkerResumeDecisionSchema,
  type FleetNode,
  type FleetSession,
  type Run,
  type RunStep,
  type StepAdmission,
  type StepAdmissionConflict,
  type WorkerResumeOutcome,
  type WorkerResumeRequest,
  type WorkerResumeRequestState,
  type WorkerResumeSession,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { capacityFor, type SessionKind } from "../session-policy.js";
import { WorkerResumeConflict } from "../worker-resume-store.js";
import {
  executionKey,
  remainingCapacity,
  type ScheduleException,
  type StepHold,
} from "./schedule.js";

/** Who asked. An orchestrator may ask; only an authenticated person may approve. */
export type ResumeActor = { kind: "operator" | "orchestrator"; id: string };

/** What the resume service needs from the engine that owns scheduling. */
export type ResumeScheduler = {
  holds(runId: string): ReadonlyMap<string, StepHold> | undefined;
  tickRun(runId: string): void;
};

/** Everything an exceptional resume is bound to, recomputed from live state. */
type Binding = {
  run: Run;
  step: RunStep;
  session: FleetSession;
  node: FleetNode;
  placementId: string;
  localPath: string;
  checkoutKey: string;
  kind: SessionKind;
  reserved: number;
  limit: number;
  holders: FleetSession[];
  promptDigest: string;
  fingerprint: string;
};

const RUNNABLE_TASK_STATES: ReadonlySet<Run["state"]> = new Set([
  "planning",
  "running",
  "awaiting_lead",
]);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const bounded = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

function normalizedPath(path: string, os: string): string {
  const windows = os === "win32" || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
  const unified = windows ? path.replace(/\//g, "\\") : path;
  const trimmed = unified.replace(windows ? /\\+$/ : /\/+$/, "") || unified;
  return windows ? trimmed.toLowerCase() : trimmed;
}

/** The same directory, or one inside the other: either way they share files. */
function sharesTree(left: string, right: string, os: string): boolean {
  const a = normalizedPath(left, os);
  const b = normalizedPath(right, os);
  const separator = a.includes("\\") || b.includes("\\") ? "\\" : "/";
  return a === b || a.startsWith(`${b}${separator}`) || b.startsWith(`${a}${separator}`);
}

/**
 * "Resume now" for a queued follow-up in a retained worker.
 *
 * Ordinary scheduling stays automatic: asking first runs a normal scheduling
 * pass, and only a follow-up held back by the Node's reserved scheduling slot
 * becomes an approval request. Everything else is explained, not overridden.
 *
 * An approval is a durable, versioned request bound to one step attempt, one
 * conversation, one Node and checkout, the queued prompt's digest and the
 * sessions that held the Node's slots when it was asked for. The scheduler
 * spends it at most once, and only while that binding still holds.
 */
export class WorkerResumeService {
  private lastPrunedAt = 0;

  constructor(
    private readonly service: FleetService,
    private readonly scheduler: ResumeScheduler,
  ) {}

  private get store() {
    return this.service.store;
  }

  /** Steps decorated with what they are waiting on, for browsers and REST reads. */
  decorate(runId: string, steps: readonly RunStep[]): RunStep[] {
    const run = this.store.getRun(runId);
    if (!run) return [...steps];
    const holds = this.scheduler.holds(runId);
    return steps.map((step) => {
      const admission = this.admissionFor(run, step, holds);
      return admission ? { ...step, admission } : step;
    });
  }

  admission(runId: string, stepId: string): StepAdmission | undefined {
    const run = this.store.getRun(runId);
    const step = this.store.getRunStep(stepId);
    return run && step && step.runId === run.id
      ? this.admissionFor(run, step, this.scheduler.holds(runId))
      : undefined;
  }

  private admissionFor(
    run: Run,
    step: RunStep,
    holds: ReadonlyMap<string, StepHold> | undefined,
  ): StepAdmission | undefined {
    if (terminalRunStepStates.has(step.state)) return undefined;
    const session = step.sessionId ? this.store.getSession(step.sessionId) : undefined;
    const placement = this.store.getPlacement(
      step.placementId || session?.placementId || "",
    );
    const node = this.store.getNode(placement?.nodeId ?? session?.nodeId ?? "");
    const base = {
      nodeId: node?.id ?? "",
      nodeName: node?.name ?? "",
      localPath: step.executionBinding?.cwd ?? placement?.localPath ?? "",
      conflicts: [] as StepAdmissionConflict[],
      resumable: Boolean(step.sessionId && session),
    };
    if (step.state === "running")
      return {
        ...base,
        state: "running",
        code: "running",
        detail: "The Node acknowledged this turn; the worker is running it.",
      };
    if (step.state === "starting")
      return {
        ...base,
        state: "starting",
        code: "dispatched",
        detail:
          step.attempts > 1 && step.sessionId
            ? "The queued follow-up was sent; waiting for the Node to acknowledge it."
            : "The worker was dispatched; waiting for the Node to start it.",
      };
    const request = this.store.resumeRequests.active(step.id);
    if (request?.state === "awaiting_approval")
      return {
        ...base,
        state: "awaiting_approval",
        code: "resume_approval",
        detail: `Waiting for an authenticated operator to approve once or cancel: ${request.restrictionDetail}`,
        exception: request.restriction,
        requestId: request.id,
      };
    const hold = holds?.get(step.id);
    const live = Boolean(session && !terminalSessionStates.has(session.state));
    if (request && !live)
      return {
        ...base,
        state: "starting",
        code: "resuming",
        detail: request.outcome || "Approved once; Fleet is resuming the worker.",
        requestId: request.id,
      };
    // A restored conversation that is idle but still held says why its prompt waits.
    if (live && (request || step.dispatchedAt) && !(session!.state === "idle" && hold))
      return {
        ...base,
        state: "starting",
        code: "resuming",
        detail:
          request?.outcome ||
          `Restoring the worker's conversation on ${base.nodeName || "its Node"}; the queued follow-up is sent once it is ready.`,
        ...(request ? { requestId: request.id } : {}),
      };
    if (!hold)
      return {
        ...base,
        state: "queued",
        code: "scheduling",
        detail: "Waiting for the next scheduling pass.",
      };
    const exception =
      hold.code === "node_headroom" &&
      base.resumable &&
      session &&
      terminalSessionStates.has(session.state)
        ? ("node_headroom" as const)
        : undefined;
    const blocked = !queuedStepAdmissionCodes.has(hold.code);
    return {
      ...base,
      state: blocked ? "blocked" : "queued",
      code: hold.code,
      detail: [
        hold.detail,
        ...(exception
          ? [
              "Resume now can ask an authenticated operator to spend that reserved slot once.",
            ]
          : []),
        ...(hold.code === "checkout_busy" && base.resumable
          ? [
              "No approval overrides checkout exclusivity, and a retained worker cannot move to another checkout without leaving its conversation and uncommitted work behind.",
            ]
          : []),
      ].join(" "),
      conflicts: (hold.conflicts ?? []).map((id) => this.conflict(id, run)),
      ...(exception ? { exception } : {}),
      ...(request ? { requestId: request.id } : {}),
    };
  }

  private conflict(sessionId: string, run: Run): StepAdmissionConflict {
    const session = this.store.getSession(sessionId);
    const owner = session?.runId ? this.store.getRun(session.runId) : undefined;
    return {
      sessionId,
      name: session?.name ?? "",
      state: session?.state ?? "",
      runId: session?.runId ?? "",
      taskName: owner?.name ?? "",
      role: session?.runRole ?? "",
      sameTask: Boolean(session?.runId && session.runId === run.id),
    };
  }

  /**
   * Handles "Resume now" from a person or an orchestrator.
   *
   * Ordinary scheduling gets the first word. Only a follow-up it holds back
   * solely because of the Node's reserved scheduling slot becomes an approval
   * request; every other reason is returned as the answer.
   */
  request(
    input: {
      stepId?: string | undefined;
      sessionId?: string | undefined;
      reason?: string;
    },
    actor: ResumeActor,
    nowMs = Date.now(),
  ): WorkerResumeOutcome {
    const found = input.stepId
      ? this.store.getRunStep(input.stepId)
      : this.store.getRunStepBySession(input.sessionId ?? "");
    if (!found)
      throw new WorkerResumeConflict(
        "step_not_found",
        "No queued follow-up belongs to that worker.",
      );
    if (input.sessionId && found.sessionId !== input.sessionId)
      throw new WorkerResumeConflict(
        "step_not_found",
        "That session does not own this step's queued follow-up.",
      );
    const run = this.store.getRun(found.runId);
    if (!run)
      throw new WorkerResumeConflict("step_not_found", "That task no longer exists.");
    if (actor.kind === "orchestrator" && run.leadSessionId !== actor.id)
      throw new WorkerResumeConflict(
        "not_owner",
        "That worker belongs to another orchestrator's task.",
      );
    if (!found.sessionId || terminalRunStepStates.has(found.state))
      throw new WorkerResumeConflict(
        "nothing_queued",
        "This worker has no queued follow-up to resume. Queue the next turn with fleet_follow_up first.",
      );

    // Ordinary scheduling first: whatever it can start now needs no exception.
    if (found.state === "pending") this.scheduler.tickRun(run.id);
    const step = this.store.getRunStep(found.id)!;
    if (terminalRunStepStates.has(step.state))
      return {
        status: "blocked",
        message:
          `The queued follow-up is no longer waiting: its step ended ${step.state}. ${bounded(step.output, 400)}`.trim(),
      };
    const admission = this.admission(run.id, step.id)!;
    const current = this.store.resumeRequests.active(step.id);
    if (
      step.state === "running" ||
      step.state === "starting" ||
      admission.state === "starting"
    ) {
      return {
        status: step.state === "running" ? "running" : "starting",
        admission,
        ...(current ? { request: current } : {}),
        message:
          step.state === "running"
            ? "The worker is already running this follow-up; the Node acknowledged it."
            : current
              ? current.outcome || "An approved resume for this follow-up is under way."
              : "Ordinary scheduling is already resuming this worker; no approval was needed. It reports running once the Node acknowledges the follow-up.",
      };
    }
    if (current?.state === "awaiting_approval") {
      const binding = this.bind(run, step);
      if (typeof binding !== "string" && binding.fingerprint === current.fingerprint)
        return {
          status: "awaiting_approval",
          admission,
          request: current,
          message:
            "An approval request for this follow-up is already waiting. It was not duplicated.",
        };
      this.settle(
        current,
        "stale",
        "Replaced: the Node, checkout or queued work changed before anyone decided.",
      );
    }
    const fresh = this.admission(run.id, step.id)!;
    if (fresh.exception !== "node_headroom")
      return {
        status: fresh.state === "blocked" ? "blocked" : "queued",
        admission: fresh,
        message:
          fresh.state === "blocked"
            ? `Blocked: ${fresh.detail} No approval can override this.`
            : `Queued: ${fresh.detail} Fleet starts it by itself; no approval is needed or available.`,
      };
    if (actor.kind === "orchestrator") {
      const prior = this.store.resumeRequests.latestFromOrchestrator(
        step.id,
        step.attempts,
      );
      if (
        prior &&
        (prior.state === "cancelled" || prior.state === "expired") &&
        nowMs - Date.parse(prior.updatedAt) < WORKER_RESUME_LIMITS.requesterCooldownMs
      )
        return {
          status: "queued",
          admission: fresh,
          request: prior,
          message: `An operator ${prior.state === "cancelled" ? "cancelled" : "did not answer"} the last request for this follow-up (${prior.updatedAt}). Do not ask again; it stays queued and ordinary scheduling continues.`,
        };
    }
    const binding = this.bind(run, step);
    if (typeof binding === "string")
      return {
        status: "blocked",
        admission: fresh,
        message: `Blocked: ${binding} No approval was requested.`,
      };
    const created = this.create(binding, actor, input.reason ?? "", nowMs);
    return {
      status: "awaiting_approval",
      admission: this.admission(run.id, step.id)!,
      request: created,
      message:
        "Approval requested. An authenticated operator must choose Approve once or Cancel in Fleet; nothing launches until then.",
    };
  }

  /**
   * Recomputes what an exceptional resume would bind to, or why it cannot.
   *
   * Everything checked here is checked again by the scheduler and by the resume
   * path itself; this is what makes a stale approval fail rather than launch.
   */
  private bind(run: Run, step: RunStep): Binding | string {
    if (!RUNNABLE_TASK_STATES.has(run.state))
      return run.state === "awaiting_human"
        ? "The task is waiting for a person's review."
        : `The task is ${run.state}.`;
    if (step.state !== "pending" || !step.sessionId)
      return "This step has no queued follow-up waiting to resume.";
    if (step.dispatchedAt) return "The worker is already being resumed.";
    const session = this.store.getSession(step.sessionId);
    if (!session || session.runId !== run.id)
      return "The step's retained worker session is no longer available.";
    if (!terminalSessionStates.has(session.state))
      return `The worker is ${session.state}, so there is nothing to resume.`;
    if (!session.agentSessionId)
      return "The worker has no resumable Copilot conversation.";
    if (session.stopRequested) return "A Stop for this worker has not been acknowledged.";
    if (session.dismissed) return "The worker session is dismissed.";
    if (session.cleanupRequested) return "The worker session is being deleted.";
    const placementId = step.placementId || session.placementId;
    const placement = this.store.getPlacement(placementId);
    const node = this.store.getNode(session.nodeId);
    if (!placement || !node || placement.nodeId !== node.id)
      return "The worker's original checkout or Node was removed; a retained worker never moves.";
    if (!node.online) return `${node.name} is offline.`;
    const hostUpdate = this.service.nodeWorkBlocked(node.id);
    if (hostUpdate) return hostUpdate;
    const fence = this.store.commands.fence(run.id);
    if (fence && ["executing", "observation_required"].includes(fence.state))
      return "A command is still settling on this task's checkout.";
    if (
      this.store.prMaintenance
        .list({ taskId: run.id, retainedOnly: true })
        .records.some((record) => record.manualControl && !record.manualControl.endedAt)
    )
      return "A person has manual control of this task's PR-maintenance worker.";
    const checkoutKey =
      step.executionBinding?.checkoutKey ?? executionKey(run, placementId);
    const reference = this.store.prMaintenance.referenceForStep(step.id, step.attempts);
    for (const action of ["resume", "execute"] as const) {
      const maintenance = this.store.prMaintenance.admission({
        action,
        taskId: run.id,
        sessionId: session.id,
        placementId: session.placementId,
        ...(session.executionBinding
          ? { checkoutKey: session.executionBinding.checkoutKey }
          : {}),
        ...(reference ?? {}),
      });
      if (!maintenance.allowed)
        return `PR maintenance holds this worker: ${maintenance.reason}.`;
    }
    const sessions = this.store.listSessions();
    const localPath = step.executionBinding?.cwd ?? placement.localPath;
    const sharing = sessions.filter((candidate) => {
      if (
        candidate.id === session.id ||
        candidate.nodeId !== node.id ||
        candidate.runRole === "lead" ||
        terminalSessionStates.has(candidate.state)
      )
        return false;
      if (checkoutLockKey(candidate) === checkoutKey) return true;
      // A home-directory conversation contains every checkout beneath it; only
      // an actual placement of the same tree counts as sharing it.
      if (isChatsWorkspace(candidate.workspaceId)) return false;
      const path =
        candidate.executionBinding?.cwd ??
        this.store.getPlacement(candidate.placementId)?.localPath;
      return Boolean(path && sharesTree(path, localPath, node.os));
    });
    if (sharing.length)
      return `${localPath} on ${node.name} is in use by ${sharing
        .map((candidate) => candidate.name || candidate.id)
        .join(", ")}; two writers never share one checkout.`;
    const kind: SessionKind = session.readOnly ? "read-only" : "writing";
    const holders = sessions.filter(
      (candidate) =>
        candidate.nodeId === node.id &&
        !terminalSessionStates.has(candidate.state) &&
        Boolean(candidate.readOnly) === (kind === "read-only"),
    );
    const reserved = holders.length;
    const limit = capacityFor(node, kind);
    if (reserved >= limit)
      return `${node.name} is at its hard limit for ${kind} work (${reserved} of ${limit}).`;
    if (remainingCapacity(node, reserved, kind) > 0)
      return `${node.name} has a free ${kind} slot, so ordinary scheduling applies.`;
    const promptDigest = sha256(step.prompt);
    return {
      run,
      step,
      session,
      node,
      placementId,
      localPath,
      checkoutKey,
      kind,
      reserved,
      limit,
      holders,
      promptDigest,
      fingerprint: sha256(
        JSON.stringify({
          v: 1,
          restriction: "node_headroom",
          runId: run.id,
          stepId: step.id,
          attempt: step.attempts,
          sessionId: session.id,
          agentSessionId: session.agentSessionId,
          nodeId: node.id,
          kind,
          limit,
          placementId,
          localPath,
          checkoutKey,
          promptDigest,
          holders: holders.map((holder) => holder.id).sort(),
        }),
      ),
    };
  }

  private create(
    binding: Binding,
    actor: ResumeActor,
    reason: string,
    nowMs: number,
  ): WorkerResumeRequest {
    const { run, step, session, node } = binding;
    const at = new Date(nowMs).toISOString();
    const activeSessions: WorkerResumeSession[] = this.store
      .listSessions()
      .filter(
        (candidate) =>
          candidate.nodeId === node.id &&
          candidate.id !== session.id &&
          !terminalSessionStates.has(candidate.state),
      )
      .map((candidate) => ({
        sessionId: candidate.id,
        name: candidate.name,
        state: candidate.state,
        runId: candidate.runId,
        taskName: candidate.runId ? (this.store.getRun(candidate.runId)?.name ?? "") : "",
        role: candidate.runRole,
        localPath:
          candidate.executionBinding?.cwd ??
          this.store.getPlacement(candidate.placementId)?.localPath ??
          "",
        readOnly: Boolean(candidate.readOnly),
      }));
    const request = this.service.notifications.commitAtomically(
      () => {
        const inserted = this.store.resumeRequests.insert({
          id: randomUUID(),
          version: 1,
          state: "awaiting_approval",
          runId: run.id,
          taskName: run.name,
          stepId: step.id,
          stepKey: step.stepKey,
          stepTitle: step.title,
          stepAttempt: step.attempts,
          sessionId: session.id,
          sessionName: session.name,
          agentSessionId: session.agentSessionId,
          nodeId: node.id,
          nodeName: node.name,
          placementId: binding.placementId,
          localPath: binding.localPath,
          checkoutKey: binding.checkoutKey,
          queuedPrompt: bounded(step.prompt, WORKER_RESUME_LIMITS.promptPreviewChars),
          promptDigest: binding.promptDigest,
          restriction: "node_headroom",
          restrictionDetail: `${node.name} is at Fleet's scheduling limit for ${binding.kind} work: ${binding.reserved} of ${binding.limit} slots are held, and Fleet keeps the last slot free on a multi-slot Node so ordinary dispatch never fills it.`,
          risk: `Approving spends that reserved slot once: ${node.name} will run ${binding.reserved + 1} of ${binding.limit} ${binding.kind} sessions, its hard limit, and other work for ${node.name} waits until a slot frees. Checkout exclusivity is unchanged — no other live session uses ${binding.localPath} — and so are task budgets, human holds and PR-maintenance restrictions.`,
          capacity: {
            kind: binding.kind,
            reserved: binding.reserved,
            limit: binding.limit,
          },
          activeSessions,
          fingerprint: binding.fingerprint,
          reason: bounded(reason.trim(), WORKER_RESUME_LIMITS.reasonChars),
          requestedBy: actor,
          requestedAt: at,
          expiresAt: new Date(nowMs + WORKER_RESUME_LIMITS.approvalMs).toISOString(),
          decidedBy: "",
          decidedAt: "",
          launchBy: "",
          launchedAt: "",
          acknowledgedAt: "",
          outcome: "Waiting for an authenticated operator to approve once or cancel.",
          updatedAt: at,
        });
        this.service.notifications.syncWorkerResumeRequest(inserted);
        this.audit(
          inserted,
          "worker_resume_requested",
          actor.kind === "orchestrator"
            ? { kind: "lead", id: actor.id }
            : { kind: "operator", id: actor.id },
          "requested",
        );
        return inserted;
      },
      (inserted) => this.publish(inserted),
    );
    return request;
  }

  /**
   * An authenticated operator's decision on one request.
   *
   * The decision names the version and fingerprint the dialog displayed. The
   * binding is recomputed from live state after a fresh scheduling pass: a
   * request whose facts moved becomes `stale` instead of launching, and one
   * that ordinary scheduling no longer needs is not spent.
   */
  decide(
    requestId: string,
    input: unknown,
    operatorId: string,
    nowMs = Date.now(),
  ): WorkerResumeRequest {
    const decision = WorkerResumeDecisionSchema.parse(input);
    const shown = this.store.resumeRequests.get(requestId);
    if (!shown)
      throw new WorkerResumeConflict("request_not_found", "That resume request is gone.");
    if (
      shown.state !== "awaiting_approval" ||
      shown.version !== decision.expectedVersion ||
      shown.fingerprint !== decision.fingerprint
    )
      throw new WorkerResumeConflict(
        "approval_conflict",
        shown.state === "awaiting_approval"
          ? "This request changed after it was shown. Review it again before deciding."
          : `This request is already ${shown.state}; nothing was changed.`,
        shown,
      );
    if (decision.decision === "approve_once" && nowMs < Date.parse(shown.expiresAt))
      this.scheduler.tickRun(shown.runId);
    let launch = false;
    const result = this.service.notifications.commitAtomically(
      () => {
        const current = this.store.resumeRequests.get(requestId)!;
        if (current.version !== shown.version)
          return {
            request: current,
            error: new WorkerResumeConflict(
              "approval_conflict",
              `This request is already ${current.state}: ${current.outcome}`,
              current,
            ),
          };
        if (nowMs >= Date.parse(current.expiresAt))
          return {
            request: this.finish(
              current,
              "expired",
              "Nobody decided before the approval window closed. The follow-up stays queued and ordinary scheduling continues.",
            ),
            error: new WorkerResumeConflict(
              "expired",
              "This request expired before the decision arrived. Nothing was launched; request Resume now again if it is still needed.",
            ),
          };
        if (decision.decision === "cancel") {
          const cancelled = this.finish(
            current,
            "cancelled",
            `Cancelled by ${operatorId}. The follow-up stays queued; ordinary scheduling continues.`,
            { decidedBy: operatorId, decidedAt: new Date(nowMs).toISOString() },
          );
          this.audit(
            cancelled,
            "worker_resume_decision",
            { kind: "operator", id: operatorId },
            "cancelled",
          );
          this.note(
            cancelled,
            `Resume-now request cancelled by ${operatorId}. The queued follow-up stays queued.`,
            "operator",
          );
          return { request: cancelled };
        }
        const run = this.store.getRun(current.runId);
        const step = this.store.getRunStep(current.stepId);
        const reason =
          !run || !step
            ? "The task or its step no longer exists."
            : this.revalidate(current, run, step, true);
        if (reason) {
          const stale = this.finish(
            current,
            "stale",
            `Not approved: ${reason} Nothing was launched.`,
            { decidedBy: operatorId, decidedAt: new Date(nowMs).toISOString() },
          );
          this.audit(
            stale,
            "worker_resume_decision",
            { kind: "operator", id: operatorId },
            "stale",
          );
          return {
            request: stale,
            error: new WorkerResumeConflict(
              "stale",
              `${reason} Nothing was launched; request Resume now again if it is still needed.`,
              stale,
            ),
          };
        }
        const approved = this.store.resumeRequests.update(current.id, current.version, {
          state: "approved",
          decidedBy: operatorId,
          decidedAt: new Date(nowMs).toISOString(),
          launchBy: new Date(nowMs + WORKER_RESUME_LIMITS.launchMs).toISOString(),
          outcome: `Approved once by ${operatorId}; Fleet is resuming the worker.`,
        });
        this.service.notifications.syncWorkerResumeRequest(approved);
        this.audit(
          approved,
          "worker_resume_decision",
          { kind: "operator", id: operatorId },
          "approved",
        );
        this.note(
          approved,
          `Resume-now exception approved once by ${operatorId}: ${approved.nodeName}'s reserved scheduling slot may be used to resume worker ${approved.sessionId} for attempt ${approved.stepAttempt} in ${approved.localPath}.`,
          "operator",
        );
        launch = true;
        return { request: approved };
      },
      (outcome) => this.publish(outcome.request),
    );
    if (result.error) throw result.error;
    if (launch) this.scheduler.tickRun(result.request.runId);
    return this.store.resumeRequests.get(requestId) ?? result.request;
  }

  /**
   * Why a request can no longer be applied, or nothing when it still can.
   *
   * `requireHold` additionally insists that the latest scheduling pass held the
   * step back for the reserved slot and nothing else, which is what an approval
   * checks; a launch relies on the scheduler applying the same rules itself.
   */
  private revalidate(
    request: WorkerResumeRequest,
    run: Run,
    step: RunStep,
    requireHold: boolean,
  ): string | undefined {
    if (step.attempts !== request.stepAttempt || step.sessionId !== request.sessionId)
      return "The queued follow-up was replaced.";
    if (terminalRunStepStates.has(step.state))
      return `The queued follow-up is no longer waiting: its step ended ${step.state}.`;
    const session = this.store.getSession(step.sessionId);
    if (step.state !== "pending" || step.dispatchedAt)
      return "Ordinary scheduling already resumed this worker; the exception is not needed.";
    if (session && !terminalSessionStates.has(session.state))
      return `The worker is already ${session.state}; its queued follow-up is sent through ordinary scheduling once it is idle.`;
    const binding = this.bind(run, step);
    if (typeof binding === "string") return binding;
    if (binding.promptDigest !== request.promptDigest)
      return "The queued follow-up's prompt changed.";
    if (binding.fingerprint !== request.fingerprint)
      return "The sessions holding the Node's slots, the checkout or the worker changed since the request.";
    if (requireHold) {
      const hold = this.scheduler.holds(run.id)?.get(step.id);
      if (hold?.code !== "node_headroom")
        return hold
          ? `The follow-up is now held for another reason: ${hold.detail}`
          : "Scheduling has not evaluated this follow-up yet.";
    }
    return undefined;
  }

  /**
   * Approved requests the scheduler may spend in this pass.
   *
   * Lapsed or no-longer-valid approvals are settled here, before planning, so
   * the planner never sees one; it applies the exception only where the
   * reserved slot is the one thing standing in the way.
   */
  exceptionsFor(run: Run, nowMs = Date.now()): Map<string, ScheduleException> {
    const exceptions = new Map<string, ScheduleException>();
    for (const request of this.store.resumeRequests.listActive()) {
      if (request.runId !== run.id || request.state !== "approved") continue;
      if (nowMs > Date.parse(request.launchBy)) {
        this.settle(
          request,
          "expired",
          "The approval lapsed before Fleet could launch it; nothing was launched and the follow-up stays queued.",
        );
        continue;
      }
      const step = this.store.getRunStep(request.stepId);
      const reason = step
        ? this.revalidate(request, run, step, false)
        : "The step no longer exists.";
      if (reason) {
        this.settle(request, "stale", `Not launched: ${reason}`);
        continue;
      }
      exceptions.set(request.stepId, {
        requestId: request.id,
        restriction: "node_headroom",
        sessionId: request.sessionId,
        attempt: request.stepAttempt,
      });
    }
    return exceptions;
  }

  /**
   * Spends an approval, inside the transaction that records the resume.
   *
   * Only an `approved` request for this exact step attempt can be spent, and
   * only once: the version check makes a second claim fail.
   */
  claimLaunch(
    requestId: string,
    step: RunStep,
    nowMs = Date.now(),
  ): WorkerResumeRequest | undefined {
    const request = this.store.resumeRequests.get(requestId);
    if (
      !request ||
      request.state !== "approved" ||
      request.stepId !== step.id ||
      request.stepAttempt !== step.attempts ||
      request.sessionId !== step.sessionId ||
      nowMs > Date.parse(request.launchBy)
    )
      return undefined;
    const launching = this.store.resumeRequests.update(request.id, request.version, {
      state: "launching",
      launchedAt: new Date(nowMs).toISOString(),
      outcome: `Resume sent to ${request.nodeName}; waiting for the Node to restore the conversation.`,
    });
    this.audit(launching, "worker_resume_launch", { kind: "host" }, "sent");
    return launching;
  }

  /** The resume command could not be sent; the step failure carries the reason. */
  failLaunch(requestId: string, reason: string): void {
    const request = this.store.resumeRequests.get(requestId);
    if (request && activeWorkerResumeRequestStates.has(request.state))
      this.settle(request, "failed", `Resume failed: ${reason}`);
  }

  /** Publishes a request written inside someone else's transaction, after it commits. */
  announce(request: WorkerResumeRequest): void {
    this.publish(request);
  }

  stepOf(stepId: string): RunStep | undefined {
    return this.store.getRunStep(stepId);
  }

  /**
   * Moves requests along with the facts they depend on.
   *
   * Launch progress comes only from the step and session records the Node's
   * events maintain, so `launched` means the Node acknowledged the queued
   * follow-up, not that a command was sent.
   */
  reconcile(nowMs = Date.now(), runId?: string): void {
    if (!runId && nowMs - this.lastPrunedAt > 60 * 60_000) {
      this.lastPrunedAt = nowMs;
      this.store.resumeRequests.prune(nowMs);
    }
    for (const request of this.store.resumeRequests.listActive()) {
      if (runId && request.runId !== runId) continue;
      const run = this.store.getRun(request.runId);
      const step = this.store.getRunStep(request.stepId);
      if (request.state === "awaiting_approval") {
        if (nowMs >= Date.parse(request.expiresAt)) {
          this.settle(
            request,
            "expired",
            "Nobody decided before the approval window closed. The follow-up stays queued and ordinary scheduling continues.",
          );
          continue;
        }
        if (!run || !step) {
          this.settle(request, "stale", "The task or its step no longer exists.");
          continue;
        }
        const reason = this.revalidate(request, run, step, false);
        if (reason) this.settle(request, "stale", `No longer applicable: ${reason}`);
        continue;
      }
      if (request.state === "approved") {
        if (nowMs > Date.parse(request.launchBy))
          this.settle(
            request,
            "expired",
            "The approval lapsed before Fleet could launch it; nothing was launched and the follow-up stays queued.",
          );
        continue;
      }
      if (!step || step.attempts !== request.stepAttempt) {
        this.settle(request, "failed", "The resumed step was removed or replaced.");
        continue;
      }
      if (step.state === "running" || step.state === "succeeded") {
        this.settle(
          request,
          "launched",
          `${request.nodeName} restored the same conversation and acknowledged the queued follow-up.`,
          { acknowledgedAt: new Date(nowMs).toISOString() },
        );
        continue;
      }
      if (terminalRunStepStates.has(step.state)) {
        this.settle(
          request,
          "failed",
          `The resumed follow-up ended ${step.state}: ${bounded(step.output || "no reason was recorded", 500)}`,
        );
        continue;
      }
      const session = this.store.getSession(step.sessionId);
      const progress =
        step.state === "starting"
          ? "Queued follow-up sent; waiting for the Node to acknowledge it."
          : session?.state === "idle"
            ? "Conversation restored; the queued follow-up is being sent."
            : request.outcome;
      if (progress !== request.outcome)
        this.publish(
          this.store.resumeRequests.update(request.id, request.version, {
            outcome: progress,
          }),
        );
    }
  }

  list(input: { runId?: string; limit?: number } = {}): WorkerResumeRequest[] {
    return this.store.resumeRequests.list(input);
  }

  get(id: string): WorkerResumeRequest | undefined {
    return this.store.resumeRequests.get(id);
  }

  private settle(
    request: WorkerResumeRequest,
    state: WorkerResumeRequestState,
    outcome: string,
    patch: Partial<WorkerResumeRequest> = {},
  ): WorkerResumeRequest {
    return this.service.notifications.commitAtomically(
      () => {
        const settled = this.finish(request, state, outcome, patch);
        this.audit(
          settled,
          state === "launched" || state === "failed"
            ? "worker_resume_launch"
            : "worker_resume_request",
          { kind: "host" },
          state,
        );
        if (state === "launched" || state === "failed")
          this.note(settled, `Resume-now exception ${state}: ${outcome}`, "system");
        return settled;
      },
      (settled) => this.publish(settled),
    );
  }

  private finish(
    request: WorkerResumeRequest,
    state: WorkerResumeRequestState,
    outcome: string,
    patch: Partial<WorkerResumeRequest> = {},
  ): WorkerResumeRequest {
    const next = this.store.resumeRequests.update(request.id, request.version, {
      ...patch,
      state,
      outcome,
    });
    this.service.notifications.syncWorkerResumeRequest(next);
    return next;
  }

  private audit(
    request: WorkerResumeRequest,
    eventType: string,
    actor: { kind: "operator" | "lead" | "host"; id?: string },
    outcome: string,
  ): void {
    this.store.recordSecurityAudit({
      eventType,
      actorKind: actor.kind,
      actorId: actor.id ?? "",
      targetId: request.id,
      outcome,
      detail: `run=${request.runId} step=${request.stepId} attempt=${request.stepAttempt} session=${request.sessionId} node=${request.nodeId} checkout=${request.localPath} restriction=${request.restriction} fingerprint=${request.fingerprint.slice(0, 16)}`,
    });
  }

  private note(
    request: WorkerResumeRequest,
    body: string,
    source: "operator" | "system",
  ): void {
    const run = this.store.getRun(request.runId);
    if (!run) return;
    try {
      this.store.appendRunNote(run.id, run.phaseIndex, body, {
        summary: bounded(body.replace(/\s+/g, " "), 240),
        kind: "decision",
        source,
        sessionId: request.sessionId,
      });
    } catch {
      // A task being cleaned up keeps the security audit entry instead.
    }
  }

  private publish(request: WorkerResumeRequest): void {
    this.service.broadcast({ type: "worker_resume_request", request });
    this.service.publishRunSteps(request.runId, this.store.listRunSteps(request.runId));
  }
}
