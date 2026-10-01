import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  liveSessionStates,
  ORCHESTRATOR_STOP_REASON,
  StopSessionsSchema,
  terminalRunStates,
  terminalSessionStates,
  WorkspaceModeSchema,
  isChatsWorkspace,
  PrMaintenanceEnableSchema,
  PrMaintenanceOperatorActionSchema,
  parsePrMaintenanceUrl,
  prMaintenanceUrl,
  type PrMaintenanceRegistration,
  agentKindLabels,
  supportsAgentKind,
  type AgentParams,
} from "@fleet/protocol";
import { capacityFor, reservedSessionCount } from "../session-policy.js";
import type { FleetService } from "../fleet-service.js";
import type { OrchestratorEngine } from "../orchestrator/engine.js";
import { FleetTools } from "../orchestrator/tools.js";
import { orchestratorBriefing, owedPrompt } from "../orchestrator/briefing.js";
import { maintenanceDirectionPrompt, reviewOutcome } from "../orchestrator/review.js";
import { PrMaintenanceError, prMaintenanceUnsettled } from "../pr-maintenance-store.js";
import {
  reopenOrchestratorStoppedRun,
  stopSessions,
  taskNeedsOrchestrator,
  transferRun,
} from "../orchestrator/lifecycle.js";

const CreateOrchestratorSchema = z.object({
  /** Where its workers run. The orchestrator itself only talks. */
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  /*
   * No budgets here any more.
   *
   * They used to seed the conversation's "General" task, which every later task
   * then copied its policy from. With no such task there is nothing to seed and
   * nothing to copy: each task takes the defaults. Nobody ever sent this field.
   */
});

const ReviewSchema = z
  .object({
    approved: z.boolean(),
    /** Required when sending back: the orchestrator acts on it verbatim. */
    note: z.string().max(4_000).optional(),
    maintenance: z
      .object({
        recordId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        decisionId: z.string().min(1),
        decisionVersion: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MaintenanceActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prepare"),
      prUrl: z.string().trim().min(1).max(4_096).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("enable"), registration: PrMaintenanceEnableSchema })
    .strict(),
  z
    .object({
      action: z.literal("authorize_proposal"),
      proposalId: z.string().min(1),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      recordId: z.string().min(1),
      expectedVersion: z.number().int().positive(),
      operation: PrMaintenanceOperatorActionSchema,
    })
    .strict(),
]);

function maintenanceOperator(request: FastifyRequest): string | undefined {
  const session = request.fleetSession;
  if (request.fleetNodeId || !session || session.expiresAt <= Date.now())
    return undefined;
  return session.administratorId || `operator:${session.authMethod}`;
}

/** Hands one task to another orchestrator conversation. */
const TransferTaskSchema = z
  .object({
    toSessionId: z.string().min(1),
    /** Delivered with the receiving orchestrator's brief and kept on the task. */
    note: z.string().trim().max(8_000).optional(),
  })
  .strict();

/** Hands several of one orchestrator's tasks to another. */
const TransferTasksSchema = z
  .object({
    toSessionId: z.string().min(1),
    /** Omitted means every task that still needs an orchestrator. */
    runIds: z.array(z.string().min(1)).min(1).max(200).optional(),
    note: z.string().trim().max(8_000).optional(),
  })
  .strict();

/**
 * A refusal the store or the transfer raised, as the words it carries.
 *
 * Every conflict on this path — a checkout command still running, a session
 * being cleaned up, a maintenance invariant — already explains itself, so the
 * route only has to pass it on rather than translate it.
 */
function transferRefusal(
  error: unknown,
): { status: number; code?: string; error: string } | undefined {
  if (!(error instanceof Error) || !("statusCode" in error)) return undefined;
  const status = Number(error.statusCode);
  if (!Number.isInteger(status) || status < 400 || status >= 500) return undefined;
  return {
    status,
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    error: error.message,
  };
}

const CreateRunSchema = z.object({
  operationId: z.string().uuid().optional(),
  workspaceMode: WorkspaceModeSchema.default("auto"),
  sourcePlacementId: z.string().optional(),
  integrationBaseRef: z.string().max(512).optional(),
  integrationBranchRef: z.string().max(512).optional(),
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(80),
  objective: z.string().min(1).max(4_000),
  policy: z
    .object({
      maxParallel: z.number().int().positive().max(10).optional(),
      maxSessions: z.number().int().positive().max(50).optional(),
      maxWakes: z.number().int().positive().max(100).optional(),
    })
    .optional(),
});

/**
 * The turn a new task arrives as.
 *
 * Shaped like the wake envelopes, because that is the form the orchestrator has
 * been treating as "a fact to act on" since its first turn. A bare sentence
 * from a person reads as something to reply to instead.
 */
function taskBrief(name: string, objective: string, workspace: string): string {
  return [
    `<fleet-task name=${JSON.stringify(name)} workspace=${JSON.stringify(workspace)}>`,
    objective,
    "</fleet-task>",
    "",
    `Plan this with fleet_plan_task using the task name "${name}", then dispatch the`,
    "work for its first phase and end your turn.",
  ].join("\n");
}

export type OrchestratorRouteOptions = {
  service: FleetService;
  engine: OrchestratorEngine;
};

/**
 * Creating and finding the orchestrator.
 *
 * There is normally one: a session you talk to, which starts other sessions.
 * It is an ordinary Fleet session in every respect except two — it holds the
 * fleet tools, and it has a run to dispatch into.
 */
export const orchestratorRoutes: FastifyPluginAsync<OrchestratorRouteOptions> = async (
  app,
  { service, engine },
) => {
  const { store } = service;

  const maintenanceForTask = (taskId: string) => {
    const records: PrMaintenanceRegistration[] = [];
    let cursor: string | undefined;
    do {
      const page = store.prMaintenance.list({
        taskId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor);
    return records;
  };

  app.get("/api/runs/:id/pr-maintenance", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Task not found" });
    const records = maintenanceForTask(id);
    const workers = store
      .listSessions()
      .filter((session) => session.runId === id && session.runRole === "worker");
    const unsupportedReason =
      !run.leadSessionId || workers.length === 0
        ? "Maintenance requires an existing Orchestrator-owned task worker; standalone handoff is unsupported."
        : run.workspaceBinding?.effectiveMode === "managed" &&
            (store.listRunSteps(id).some((step) => Boolean(step.resultSha)) ||
              run.workspaceBinding.aggregationState !== "not_started")
          ? "Sealed or published managed results require an explicit supported handoff; v1 cannot continue them."
          : undefined;
    return {
      records,
      proposal: store.prMaintenance.getProposal(id),
      canAuthorize: Boolean(maintenanceOperator(request)),
      ...(unsupportedReason ? { unsupportedReason } : {}),
    };
  });

  app.post("/api/runs/:id/pr-maintenance", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Task not found" });
    const actor = maintenanceOperator(request);
    if (!actor)
      return reply.code(403).send({
        error:
          "An authenticated browser operator must authorize maintenance; Node, MCP and no-login principals cannot.",
      });
    const input = MaintenanceActionSchema.parse(request.body);
    if (input.action === "prepare") {
      let prUrl: string | undefined;
      try {
        prUrl = input.prUrl ? parsePrMaintenanceUrl(input.prUrl).url : undefined;
      } catch {
        return reply
          .code(400)
          .send({ error: "Use an exact Azure DevOps or GitHub HTTPS PR URL." });
      }
      const lead = store.getSession(run.leadSessionId);
      if (
        !lead ||
        lead.runRole !== "lead" ||
        lead.stopRequested ||
        lead.cleanupRequested ||
        !["idle", "running"].includes(lead.state) ||
        !store.getNode(lead.nodeId)?.online
      )
        return reply.code(409).send({
          error:
            "Resume the task's existing Orchestrator on its authorized Node before requesting preparation.",
        });
      const retained = maintenanceForTask(id).find(
        (record) => !record.ownershipReleasedAt,
      );
      if (
        retained &&
        (retained.authorization.scope.publicationAuthorized ||
          !["active", "paused"].includes(retained.lifecycle) ||
          prMaintenanceUnsettled(retained) ||
          retained.decision?.state === "pending")
      )
        return reply.code(409).send({
          error:
            "This task retains maintenance. Settle and release it before preparing another PR.",
        });
      const prompt = [
        `<fleet-maintenance-prepare taskId=${JSON.stringify(id)}>`,
        "Prepare a bounded PR maintenance job for this existing task, not a new task or worker.",
        prUrl
          ? `Requested PR URL: ${JSON.stringify(prUrl)}`
          : "Discover the PR URL from this task's outputs and existing worker evidence. Ask only for the PR URL or an ambiguous choice if needed.",
        "Read fleet_get_task and fleet_get_pr_maintenance. Verify fresh provider metadata using the packaged helper or an already-authorized provider MCP/CLI.",
        "Use fleet_prepare_pr_maintenance for repair-only maintenance with verified existing task/publication authority. Optional remote actions default off. Record prerequisite limitations truthfully; missing repair authority blocks enrollment, not an observation-only default.",
        ...(retained
          ? [
              `Prepare repair reauthorization for the exact retained PR ${prMaintenanceUrl(retained.identity)} and worker ${retained.workerSessionId}. Preserve history, decisions and binding; do not release or replace it. Authorization leaves it paused until explicit Resume.`,
            ]
          : []),
        "This request is NOT publication or maintenance authorization. Present the readable proposal for signed-in operator approval, then end your turn. Do not repair, publish, merge, change credentials or create sessions.",
        "</fleet-maintenance-prepare>",
      ].join("\n");
      if (service.commands.durableLead(lead.id)) {
        store.writeAtomically(() => {
          const key = `maintenance-prepare:${createHash("sha256")
            .update(
              JSON.stringify([
                id,
                prUrl ?? "",
                store.prMaintenance.getProposal(id)?.version ?? 0,
                maintenanceForTask(id)
                  .map((record) => record.id)
                  .sort(),
              ]),
            )
            .digest("hex")}`;
          const prior = store.commands
            .prompts(lead.id)
            .filter((entry) => entry.key.startsWith(`${key}:`));
          if (
            !prior.some((entry) =>
              ["pending", "reserved", "accepted", "rejected_busy", "uncertain"].includes(
                entry.state,
              ),
            )
          )
            service.commands.queueLeadPrompt(lead.id, prompt, `${key}:${randomUUID()}`);
        });
        service.commands.pumpLead(lead.id);
      } else {
        if (lead.state !== "idle")
          return reply.code(409).send({
            error: "Wait for this Orchestrator turn to finish, then request preparation.",
          });
        const sent = service.dispatch(lead.nodeId, {
          type: "prompt",
          sessionId: lead.id,
          prompt,
          attachments: [],
        });
        if (!sent.sent)
          return reply.code(503).send({ error: "The Orchestrator Node disconnected." });
      }
      service.publishSnapshot();
      return reply.code(202).send({ status: "preparation_requested", taskId: id });
    }
    let updated: PrMaintenanceRegistration;
    if (input.action === "enable" || input.action === "authorize_proposal") {
      if (input.action === "enable" && input.registration.taskId !== id)
        return reply
          .code(409)
          .send({ error: "The maintenance proposal names another task." });
      updated = service.notifications.commitAtomically(() => {
        const proposal = store.prMaintenance.getProposal(id);
        const record =
          input.action === "authorize_proposal"
            ? store.prMaintenance.authorizeProposal(
                id,
                input.proposalId,
                input.expectedVersion,
                actor,
              )
            : store.prMaintenance.enableFromOperator(input.registration, actor);
        if (proposal) service.notifications.resolvePrMaintenanceProposal(proposal);
        return record;
      });
      service.publishSnapshot();
    } else {
      const record = store.prMaintenance.get(input.recordId);
      if (!record || record.taskId !== id)
        return reply
          .code(404)
          .send({ error: "Maintenance registration not found for this task." });
      if (input.operation.action === "direction")
        return reply.code(409).send({
          error:
            "Use Send back with instructions to record maintenance direction with its task review.",
        });
      updated = store.prMaintenance.operatorAction(
        record.id,
        input.expectedVersion,
        input.operation,
        actor,
        () => {
          if (input.operation.action !== "release") return;
          store.appendRunNote(
            id,
            run.phaseIndex,
            `Maintenance released by ${actor}: ${input.operation.reason}`,
            {
              summary: "PR maintenance ownership released",
              kind: "decision",
              source: "operator",
            },
          );
          if (record.decision?.state === "pending") service.resolveRunReview(id);
        },
      );
    }
    service.cancelPausedPrMaintenance();
    service.publishRun(store.getRun(id)!);
    engine.tick();
    return updated;
  });

  /**
   * Every orchestrator conversation not explicitly dismissed, newest first.
   *
   * Stopped leads remain part of the conversation history so clients can offer
   * Resume and Dismiss rather than making Stop indistinguishable from Delete.
   */
  const conversations = () =>
    store
      .listSessions()
      .filter((session) => session.runRole === "lead")
      .map((session) => ({
        session,
        runs: store.listRuns().filter((run) => run.leadSessionId === session.id),
      }));

  const dismissalError = (sessionId: string): string | undefined => {
    const session = store.getSession(sessionId);
    if (!session || session.runRole !== "lead") return "Orchestrator not found";
    const maintenance = store.prMaintenance.list({
      leadSessionId: sessionId,
      retainedOnly: true,
      limit: 100,
    });
    if (maintenance.records.some(prMaintenanceUnsettled) || maintenance.nextCursor) {
      return "Reconcile unsettled PR maintenance before dismissing its owning conversation";
    }
    if (!terminalSessionStates.has(session.state)) {
      return "Stop the orchestrator before dismissing it";
    }
    if (session.stopRequested) return "The orchestrator is still stopping";
    const ownedRuns = store.listRuns().filter((run) => run.leadSessionId === sessionId);
    const ownedRunIds = new Set(ownedRuns.map((run) => run.id));
    const liveWorker = store
      .listSessions()
      .some(
        (worker) =>
          ownedRunIds.has(worker.runId) &&
          (worker.stopRequested || !terminalSessionStates.has(worker.state)),
      );
    return ownedRuns.some((run) => !terminalRunStates.has(run.state)) || liveWorker
      ? "Archive or finish this orchestrator's tasks before dismissing it"
      : undefined;
  };

  /**
   * Confirms Stops a person has already asked for on machines that are gone.
   *
   * Requests nothing new: a worker is included only when something else — an
   * archive, a bulk Stop — has already asked it to stop, because a lead's own
   * Stop no longer reaches its workers.
   */
  const settleUnavailableStops = (leadSessionId: string): number => {
    const ownedRunIds = new Set(
      store
        .listRuns()
        .filter((run) => run.leadSessionId === leadSessionId)
        .map((run) => run.id),
    );
    let settled = 0;
    for (const candidate of store.listSessions()) {
      if (candidate.id !== leadSessionId && !ownedRunIds.has(candidate.runId)) continue;
      if (!candidate.stopRequested || candidate.state !== "offline") continue;
      if (store.getNode(candidate.nodeId)?.online) continue;
      if (store.prMaintenance.hasSessionRetentionBlockers(candidate.id)) continue;
      service.settleCommandedSession(
        candidate.id,
        "stopped",
        "Confirmed stopped while node unavailable",
      );
      settled += 1;
    }
    return settled;
  };

  app.get("/api/orchestrators", async () => ({
    orchestrators: conversations().map(({ session, runs }) => ({
      session,
      // `run` is the first task, kept so an older UI still finds one.
      run: runs[0],
      runs,
      steps: runs.flatMap((run) =>
        service.withAdmission(run.id, store.listRunSteps(run.id)),
      ),
      notes: runs.flatMap((run) => store.listRunNotes(run.id)),
    })),
  }));

  app.post("/api/orchestrators", async (request, reply) => {
    const input = CreateOrchestratorSchema.parse(request.body);
    const workspace = store.getWorkspace(input.workspaceId);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    /*
     * A conversation starts with no tasks at all.
     *
     * It used to open with one called "General", so that work could be
     * dispatched without naming a task first. That stopped paying for itself
     * twice over: nothing can be dispatched into an unplanned task any more,
     * since planning is where success criteria are written; and once a fleet
     * could hold several conversations, each contributed an identical empty
     * card to a board whose job is to show what the fleet is doing.
     *
     * So the lead carries no `runId`, and its tasks are found by their own
     * `leadSessionId` — which is what every path here already used to find
     * them.
     */
    const placements = store
      .listPlacements()
      .filter((placement) => placement.workspaceId === input.workspaceId)
      .filter((placement) => store.getNode(placement.nodeId)?.online);
    const preferred = store.getOrchestratorAgent() ?? { kind: "copilot" as const };
    const matching = placements.filter((placement) =>
      supportsAgentKind(store.getNode(placement.nodeId)!, preferred.kind),
    );
    const agentParams: AgentParams =
      matching.length > 0 ? preferred : { kind: "copilot" };
    const candidates =
      matching.length > 0
        ? matching
        : placements.filter((placement) =>
            supportsAgentKind(store.getNode(placement.nodeId)!, "copilot"),
          );
    const placement =
      candidates.find((candidate) => {
        const node = store.getNode(candidate.nodeId)!;
        return (
          !service.agentLaunchProblem(node, agentParams) &&
          reservedSessionCount(store.listSessions(), node.id, "read-only") <
            capacityFor(node, "read-only")
        );
      }) ?? candidates[0];
    if (!placement) {
      return reply.code(409).send({
        error: "No online node holds this workspace, so there is nowhere to run it",
      });
    }
    const administrator = request.fleetSession?.administratorId
      ? store.getAdministrator(request.fleetSession.administratorId)
      : undefined;

    /*
     * The orchestrator runs on a machine that can reach this workspace, which
     * is also where its workers will run. It is given a placement because every
     * session needs a working directory, not because it should edit anything —
     * its instructions tell it to dispatch rather than to write.
     */
    const started = service.createAndStartSession({
      placement,
      agentParams,
      ...(preferred.kind !== agentParams.kind
        ? {
            startupNotice: `Preferred agent ${agentKindLabels[preferred.kind]} is unavailable on the online Nodes holding this workspace. Started with ${agentKindLabels[agentParams.kind]} on ${store.getNode(placement.nodeId)!.name}.`,
          }
        : {}),
      /*
       * Which half of the briefing depends on the machine: a Node whose catalog
       * has the orchestrator agent already carries the judgement half, so
       * repeating it here would be the same policy in two places with nothing
       * keeping them in step.
       */
      prompt: orchestratorBriefing(new FleetTools(service, "pending").listNodes().text, {
        hasAgent:
          service.agentFor(
            { runRole: "lead", agentParams },
            store.getNode(placement.nodeId) ?? { agents: [] },
          ) !== "",
      }),
      /*
       * The orchestrator runs unattended by necessity: it is woken by the
       * engine, often while nobody is watching, and a permission prompt at
       * that moment would stall the whole fleet behind a dialog no one sees.
       * It is also the session with the least reason to touch the disk — its
       * job is to call tools — so the risk this opens is small and the
       * deadlock it avoids is total.
       */
      yolo: true,
      name: input.name ?? "Orchestrator",
      runRole: "lead",
      operatorUsername: administrator?.username ?? "",
      /*
       * Counted against reading rather than writing: an orchestrator's job is
       * to call tools, and it is told in as many words not to touch the
       * checkout. This is capacity accounting, not a sandbox — it has a shell
       * and YOLO, so it *could* write. What it will not do is contend for the
       * tree, which is what the writing budget exists to ration.
       */
      readOnly: true,
    });
    if (!started.ok) {
      return reply.code(started.status).send({ error: started.error });
    }

    return reply.code(201).send({ session: started.session });
  });

  /**
   * The person's answer to a task the orchestrator handed over.
   *
   * The only decision a human makes about a task's progress. Approving closes
   * it; sending it back returns it to the orchestrator as a new turn carrying
   * the note, so the work continues where it left off rather than restarting.
   */
  app.post("/api/runs/:id/review", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = ReviewSchema.parse(request.body);
    const run = store.getRun(id);
    const held = maintenanceForTask(id).find(
      (record) => record.decision?.state === "pending",
    );
    const outcome = reviewOutcome(run, input, Boolean(held));

    if (outcome.kind === "not_found") {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (outcome.kind === "maintenance_direction_required") {
      return reply.code(409).send({
        code: "wait_for_human",
        error:
          "Approve task cannot authorize a maintenance design change. Use Send back with instructions for the exact decision.",
      });
    }
    if (outcome.kind === "not_waiting") {
      return reply.code(409).send({ error: "That task is not waiting for a review" });
    }
    if (outcome.kind === "needs_reason") {
      return reply
        .code(400)
        .send({ error: "Say what needs changing, so the orchestrator can act on it" });
    }

    if (held) {
      const actor = maintenanceOperator(request);
      if (!actor)
        return reply.code(403).send({
          error: "Maintenance direction requires an authenticated browser operator.",
        });
      const reference = input.maintenance;
      if (!reference || reference.recordId !== held.id)
        return reply.code(409).send({
          error:
            "Refresh the task and reference the current maintenance decision and record version.",
        });
      if (outcome.kind !== "send_back")
        throw new PrMaintenanceError(
          "wait_for_human",
          "Maintenance needs bounded direction.",
        );
      const record = store.prMaintenance.operatorAction(
        held.id,
        reference.expectedVersion,
        {
          action: "direction",
          decisionId: reference.decisionId,
          decisionVersion: reference.decisionVersion,
          direction: outcome.note,
          resume: false,
        },
        actor,
        () => {
          store.appendRunNote(
            id,
            run!.phaseIndex,
            `Maintenance direction (${reference.decisionId} v${reference.decisionVersion}) by ${actor}:\n\n${outcome.note}`,
            {
              summary: "Bounded PR design guidance recorded",
              kind: "decision",
              source: "operator",
            },
          );
          service.resolveRunReview(id);
          store.updateRun(id, {
            ...(run!.state === "awaiting_human" ? { state: "running" as const } : {}),
            pendingPrompt: owedPrompt(
              store.getRun(id)?.pendingPrompt ?? "",
              maintenanceDirectionPrompt(run!.name, reference.decisionId, outcome.note),
            ),
          });
        },
      );
      const directed = store.getRun(id)!;
      service.publishRun(directed);
      engine.tick();
      return { ok: true, run: directed, maintenance: record };
    }
    if (input.maintenance)
      return reply.code(409).send({
        error: "The displayed maintenance decision is stale; refresh before acting.",
      });
    store.prMaintenance.assertAdmission({
      taskId: id,
      action: outcome.kind === "approve" ? "approve" : "reopen",
    });

    if (outcome.kind === "approve") {
      store.appendRunNote(
        run!.id,
        run!.phaseIndex,
        outcome.note || "The task result was accepted by a person.",
        { summary: "Task result accepted", kind: "decision", source: "operator" },
      );
      service.resolveRunReview(run!.id);
      const done =
        run!.workspaceBinding?.effectiveMode === "managed"
          ? service.worktrees.beginAggregation(run!.id)
          : store.setRunState(run!.id, "completed")!;
      service.publishRun(done);
      engine.tick();
      return { ok: true, run: done };
    }

    store.appendRunNote(run!.id, run!.phaseIndex, `Sent back: ${outcome.note}`, {
      summary: "Guidance sent to the Orchestrator",
      kind: "decision",
      source: "operator",
    });
    service.resolveRunReview(run!.id);
    /*
     * The note is owed rather than sent. Leaving `awaiting_human` is what takes
     * the approve/send-back controls away, so a prompt dropped because the lead
     * was mid-turn would strand the task: no steps left to settle, so no wake
     * could ever be owed, and no control left to try again with.
     */
    const reopened = store.updateRun(run!.id, {
      state: "running",
      pendingPrompt: owedPrompt(run!.pendingPrompt, outcome.prompt),
    })!;
    service.publishRun(reopened);
    engine.tick();
    return { ok: true, run: reopened };
  });

  /**
   * Opens a task on a running orchestrator.
   *
   * One call rather than two. The alternative — create the run over
   * `POST /api/runs`, then prompt the lead — has a window where the first half
   * succeeds and the second does not, leaving a task in the list that no
   * orchestrator knows about and nothing will ever move.
   */
  app.post("/api/orchestrators/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = CreateRunSchema.parse(request.body);
    const lead = store.getSession(id);
    if (!lead || lead.runRole !== "lead" || terminalSessionStates.has(lead.state)) {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    if (lead.stopRequested) {
      return reply.code(409).send({ error: "The orchestrator is stopping" });
    }
    const workspace = store.getWorkspace(input.workspaceId);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
    if (input.operationId) {
      const replay = store.managedApiReplay(
        `create-task:${id}`,
        input.operationId,
        input,
      ) as { runId: string } | undefined;
      if (replay) return reply.code(201).send({ run: store.getRun(replay.runId) });
    }
    if (
      input.sourcePlacementId &&
      store.getPlacement(input.sourcePlacementId)?.workspaceId !== input.workspaceId
    )
      return reply.code(409).send({
        code: "source_mismatch",
        error: "Select a source placement in this workspace.",
      });
    if (
      !isChatsWorkspace(input.workspaceId) &&
      (input.workspaceMode === "managed" ||
        (input.workspaceMode === "auto" && store.getManagedWorktreesEnabled())) &&
      !input.sourcePlacementId
    ) {
      return reply.code(409).send({
        code: "source_required",
        error: "Select the repository copy that should define this task’s baseline.",
      });
    }
    if (
      !isChatsWorkspace(input.workspaceId) &&
      (input.workspaceMode === "managed" ||
        (input.workspaceMode === "auto" && store.getManagedWorktreesEnabled())) &&
      !input.operationId
    ) {
      return reply.code(409).send({
        code: "idempotency_required",
        error: "Managed task creation requires an operationId.",
      });
    }
    const reachable = store
      .listPlacements()
      .some(
        (placement) =>
          placement.workspaceId === workspace.id &&
          store.getNode(placement.nodeId)?.online,
      );
    if (!reachable) {
      return reply
        .code(409)
        .send({ error: "No online node holds that workspace, so a task cannot run" });
    }

    const template = store.listRuns().find((entry) => entry.leadSessionId === lead.id);
    const administrator = request.fleetSession?.administratorId
      ? store.getAdministrator(request.fleetSession.administratorId)
      : undefined;
    const created = store.writeAtomically(() => {
      const created = store.createRun({
        workspaceMode: input.workspaceMode,
        sourcePlacementId: input.sourcePlacementId,
        integrationBaseRef: input.integrationBaseRef,
        integrationBranchRef: input.integrationBranchRef,
        integrationUsername: administrator?.username,
        accessIntent: isChatsWorkspace(workspace.id) ? "no-checkout" : "checkout",
        workspaceId: workspace.id,
        name: input.name,
        objective: input.objective,
        policy: {
          ...(template ? template.policy : {}),
          ...(input.policy ?? {}),
          wakePolicy: "on_any_settle",
          onStepFailure: "wake",
        },
      });
      if (input.operationId)
        store.recordManagedApiRequest(`create-task:${id}`, input.operationId, input, {
          runId: created.id,
        });
      return created;
    });
    const run = store.updateRun(created.id, {
      leadSessionId: lead.id,
      state: "running",
      /*
       * The brief is owed rather than sent. It goes out on the first tick where
       * the orchestrator is free; an orchestrator running another task is the
       * ordinary case, and a prompt pushed at it mid-turn is refused by the
       * Node and reported only as a transcript notice — so a direct send here
       * would create a task nothing had been told about, and return 201.
       */
      pendingPrompt: taskBrief(created.name, created.objective, workspace.name),
    })!;

    await service.worktrees.prepare(run.id);
    service.publishRun(store.getRun(run.id)!);
    engine.tick();
    return reply.code(201).send({ run: store.getRun(run.id) ?? run });
  });

  /**
   * Reassigns a task to another orchestrator conversation.
   *
   * The way work outlives a conversation: ACP gives an orchestrator one context
   * window, so a long-lived one fills up, and starting a fresh conversation is
   * only useful if the work in flight can follow it. The task keeps everything
   * it has; only who is woken for it, and who runs its PR-maintenance
   * heartbeat, changes.
   */
  app.post("/api/runs/:id/transfer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = TransferTaskSchema.parse(request.body);
    try {
      const result = transferRun(service, id, input.toSessionId, {
        source: "operator",
        note: input.note,
      });
      engine.tick();
      return { ok: true, changed: result.changed, from: result.from, run: result.run };
    } catch (error) {
      const refusal = transferRefusal(error);
      if (!refusal) throw error;
      const { status, ...body } = refusal;
      return reply.code(status).send(body);
    }
  });

  /**
   * Moves an orchestrator's tasks to another, one task at a time.
   *
   * Each task moves on its own: one refused by a command still running on its
   * checkout should not keep the rest on a conversation that cannot take any
   * more. Only tasks still assigned here move, so a list read before another
   * transfer cannot pull a task back from wherever it went since.
   */
  app.post("/api/orchestrators/:id/transfer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = TransferTasksSchema.parse(request.body);
    const source = store.getSession(id);
    if (!source || source.runRole !== "lead") {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    if (input.toSessionId === id) {
      return reply
        .code(409)
        .send({ error: "Choose a different orchestrator to take these tasks" });
    }
    const requested =
      input.runIds ??
      store
        .listRuns()
        .filter((run) => run.leadSessionId === id && taskNeedsOrchestrator(service, run))
        .map((run) => run.id);
    const transferred: string[] = [];
    const failed: { runId: string; error: string; code?: string }[] = [];
    for (const runId of new Set(requested)) {
      const run = store.getRun(runId);
      if (!run || run.leadSessionId !== id) {
        failed.push({
          runId,
          error: run
            ? "That task is no longer assigned to this orchestrator."
            : "Task not found",
        });
        continue;
      }
      try {
        transferRun(service, runId, input.toSessionId, {
          source: "operator",
          note: input.note,
        });
        transferred.push(runId);
      } catch (error) {
        const refusal = transferRefusal(error);
        if (!refusal) throw error;
        failed.push({
          runId,
          error: refusal.error,
          ...(refusal.code ? { code: refusal.code } : {}),
        });
      }
    }
    engine.tick();
    if (transferred.length === 0 && failed.length > 0) {
      return reply.code(409).send({ error: failed[0]!.error, transferred, failed });
    }
    return { ok: true, transferred, failed };
  });

  /**
   * Stops the orchestrator's own conversation, and nothing it started.
   *
   * It used to archive every task the lead owned and stop their workers, so
   * stopping a lead that had wedged — the obvious first thing to try — threw
   * away all of its in-flight work as well. The Host already runs tasks without
   * a live lead: dispatched steps finish, pending ones still dispatch, and what
   * settles is owed to the lead as a wake that Resume delivers. Ending tasks is
   * what Archive and Stop agents are for.
   */
  app.post("/api/orchestrators/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session || session.runRole !== "lead") {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    store.prMaintenance.pauseForSession(id, "Orchestrator Stop requested");
    if (terminalSessionStates.has(session.state)) {
      engine.tick();
      return { ok: true, alreadyTerminal: true };
    }
    if (session.stopRequested) {
      const settled = settleUnavailableStops(id);
      engine.tick();
      return {
        ok: true,
        alreadyStopping: settled === 0,
        confirmedStopped: settled > 0,
      };
    }
    service.publishSession(store.setSessionControls(id, { stopRequested: true }));
    // Stopping the session is the revocation: its token only opens anything
    // while it is still a live orchestrator.
    const dispatched = service.dispatch(session.nodeId, {
      type: "stop",
      sessionId: id,
    });
    engine.tick();
    return reply.code(dispatched.sent ? 202 : 200).send({
      ok: true,
      hostUnavailable: !dispatched.sent,
    });
  });

  /**
   * Hides a stopped conversation without changing execution or deleting history.
   */
  app.delete("/api/orchestrators/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    store.prMaintenance.pauseForSession(id, "Orchestrator dismissed");
    const error = dismissalError(id);
    if (error) {
      return reply.code(error === "Orchestrator not found" ? 404 : 409).send({ error });
    }

    service.resolveSessionPermissionRequests(id);
    service.publishSession(store.setSessionControls(id, { dismissed: true }));
    return reply.code(200).send({ ok: true });
  });

  app.post("/api/orchestrators/cleanup", async (request, reply) => {
    const input = StopSessionsSchema.parse(request.body);
    for (const id of new Set(input.sessionIds))
      store.prMaintenance.pauseForSession(id, "Orchestrator cleanup requested");
    const error = input.sessionIds.map(dismissalError).find(Boolean);
    if (error) return reply.code(409).send({ error });
    for (const id of new Set(input.sessionIds)) {
      service.resolveSessionPermissionRequests(id);
      service.publishSession(store.setSessionControls(id, { dismissed: true }));
    }
    return reply.code(200).send({ ok: true, cleaned: new Set(input.sessionIds).size });
  });

  app.post("/api/orchestrators/:id/restore", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session || session.runRole !== "lead") {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    service.publishSession(store.setSessionControls(id, { dismissed: false }));
    return { ok: true };
  });

  /** Stops every worker and reviewer owned by one orchestrator, but not its lead. */
  app.post("/api/orchestrators/:id/agents/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = StopSessionsSchema.parse(request.body);
    const session = store.getSession(id);
    if (!session || session.runRole !== "lead") {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    const ownedRunIds = new Set(
      store
        .listRuns()
        .filter((run) => run.leadSessionId === id)
        .map((run) => run.id),
    );
    const requestedIds = new Set(input.sessionIds);
    const selected = store
      .listSessions()
      .filter((candidate) => requestedIds.has(candidate.id));
    if (selected.some((candidate) => !ownedRunIds.has(candidate.runId))) {
      return reply
        .code(400)
        .send({ error: "Every selected agent must belong to this orchestrator" });
    }
    const result = stopSessions(service, selected);
    return reply.code(result.requested > 0 ? 202 : 200).send({ ok: true, ...result });
  });

  app.post("/api/orchestrators/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session || session.runRole !== "lead") {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    store.assertOrchestratorMutable(id);
    if (session.dismissed) {
      return reply
        .code(409)
        .send({ error: "Restore the orchestrator before resuming it" });
    }
    const ownedRuns = store.listRuns().filter((run) => run.leadSessionId === id);
    /*
     * Only tasks an older Host cancelled when it stopped this lead are reopened.
     * Stop no longer touches tasks, so their workers carry on while the lead is
     * away — including the scheduler parking settled ones — and none of that
     * is a Stop this Resume has to wait out.
     */
    const resumableRunIds = new Set(
      ownedRuns
        .filter(
          (run) =>
            run.state === "cancelled" && run.failureReason === ORCHESTRATOR_STOP_REASON,
        )
        .map((run) => run.id),
    );
    const blockedRuns = [...resumableRunIds].flatMap((runId) => {
      const admission = store.prMaintenance.admission({
        taskId: runId,
        action: "reopen",
      });
      return admission.allowed
        ? []
        : [{ runId, reason: admission.reason, decisionId: admission.decisionId }];
    });
    const heldRunIds = new Set(blockedRuns.map((entry) => entry.runId));
    const unsettledWorker = store
      .listSessions()
      .find(
        (worker) =>
          resumableRunIds.has(worker.runId) &&
          (worker.stopRequested ||
            (!terminalSessionStates.has(worker.state) && worker.state !== "idle")),
      );
    if (session.stopRequested || unsettledWorker) {
      return reply.code(409).send({
        error: "Wait for every node to acknowledge Stop before resuming",
      });
    }

    /*
     * A retry may arrive after the lead resume command was sent but before the
     * stopped runs were reopened. An already-live lead plus resumable runs is
     * that recovery state; an ordinary Resume on a live lead remains a conflict.
     */
    const recoveringInterruptedResume =
      liveSessionStates.has(session.state) && resumableRunIds.size > 0;
    if (!recoveringInterruptedResume) {
      const resumed = service.resumeSession(id, "Resuming orchestrator");
      if (!resumed.ok) {
        return reply.code(resumed.status).send({ error: resumed.error });
      }
    }
    for (const run of ownedRuns) {
      if (!heldRunIds.has(run.id)) reopenOrchestratorStoppedRun(service, run.id);
    }
    engine.tick();
    return reply.code(202).send({
      ok: true,
      recovered: recoveringInterruptedResume,
      ...(blockedRuns.length ? { blockedRuns } : {}),
    });
  });
};
