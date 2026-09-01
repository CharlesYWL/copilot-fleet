import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  liveSessionStates,
  ORCHESTRATOR_STOP_REASON,
  terminalRunStates,
  terminalSessionStates,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { OrchestratorEngine } from "../orchestrator/engine.js";
import { FleetTools } from "../orchestrator/tools.js";
import { orchestratorBriefing } from "../orchestrator/briefing.js";
import { reviewOutcome } from "../orchestrator/review.js";
import { archiveRun, reopenOrchestratorStoppedRun } from "../orchestrator/lifecycle.js";

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

const ReviewSchema = z.object({
  approved: z.boolean(),
  /** Required when sending back: the orchestrator acts on it verbatim. */
  note: z.string().max(4_000).optional(),
});

const CreateRunSchema = z.object({
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

  const stopOwnedRuns = (leadSessionId: string) => {
    const runs = store
      .listRuns()
      .filter((entry) => entry.leadSessionId === leadSessionId);
    for (const run of runs) {
      archiveRun(service, run.id, ORCHESTRATOR_STOP_REASON, {
        stoppedByOrchestrator: true,
      });
    }
  };

  app.get("/api/orchestrators", async () => ({
    orchestrators: conversations().map(({ session, runs }) => ({
      session,
      // `run` is the first task, kept so an older UI still finds one.
      run: runs[0],
      runs,
      steps: runs.flatMap((run) => store.listRunSteps(run.id)),
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
    const placement = placements[0];
    if (!placement) {
      return reply.code(409).send({
        error: "No online node holds this workspace, so there is nowhere to run it",
      });
    }

    /*
     * The orchestrator runs on a machine that can reach this workspace, which
     * is also where its workers will run. It is given a placement because every
     * session needs a working directory, not because it should edit anything —
     * its instructions tell it to dispatch rather than to write.
     */
    const started = service.createAndStartSession({
      placement,
      /*
       * Which half of the briefing depends on the machine: a Node whose catalog
       * has the orchestrator agent already carries the judgement half, so
       * repeating it here would be the same policy in two places with nothing
       * keeping them in step.
       */
      prompt: orchestratorBriefing(new FleetTools(service, "pending").listNodes().text, {
        hasAgent:
          service.agentFor(
            { runRole: "lead" },
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
    const outcome = reviewOutcome(run, input);

    if (outcome.kind === "not_found") {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (outcome.kind === "not_waiting") {
      return reply.code(409).send({ error: "That task is not waiting for a review" });
    }
    if (outcome.kind === "needs_reason") {
      return reply
        .code(400)
        .send({ error: "Say what needs changing, so the orchestrator can act on it" });
    }

    if (outcome.kind === "approve") {
      if (outcome.note) store.appendRunNote(run!.id, run!.phaseIndex, outcome.note);
      const done = store.setRunState(run!.id, "completed")!;
      service.publishRun(done);
      engine.tick();
      return { ok: true, run: done };
    }

    store.appendRunNote(run!.id, run!.phaseIndex, `Sent back: ${outcome.note}`);
    /*
     * The note is owed rather than sent. Leaving `awaiting_human` is what takes
     * the approve/send-back controls away, so a prompt dropped because the lead
     * was mid-turn would strand the task: no steps left to settle, so no wake
     * could ever be owed, and no control left to try again with.
     */
    const reopened = store.updateRun(run!.id, {
      state: "running",
      pendingPrompt: outcome.prompt,
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
    const created = store.createRun({
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

    service.publishRun(run);
    engine.tick();
    return reply.code(201).send({ run: store.getRun(run.id) ?? run });
  });

  /** Ends an orchestrator and everything it started. */
  app.post("/api/orchestrators/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session || session.runRole !== "lead") {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    stopOwnedRuns(id);
    if (terminalSessionStates.has(session.state)) {
      engine.tick();
      return { ok: true, alreadyTerminal: true };
    }
    if (session.stopRequested) return { ok: true, alreadyStopping: true };
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
    const session = store.getSession(id);
    if (!session || session.runRole !== "lead") {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    if (!terminalSessionStates.has(session.state)) {
      return reply
        .code(409)
        .send({ error: "Stop the orchestrator before dismissing it" });
    }
    if (session.stopRequested) {
      return reply.code(409).send({ error: "The orchestrator is still stopping" });
    }
    const ownedRuns = store.listRuns().filter((run) => run.leadSessionId === id);
    const ownedRunIds = new Set(ownedRuns.map((run) => run.id));
    const liveWorker = store
      .listSessions()
      .some(
        (worker) =>
          ownedRunIds.has(worker.runId) &&
          (worker.stopRequested || !terminalSessionStates.has(worker.state)),
      );
    if (ownedRuns.some((run) => !terminalRunStates.has(run.state)) || liveWorker) {
      return reply
        .code(409)
        .send({ error: "Stop the orchestrator before dismissing it" });
    }

    service.publishSession(store.setSessionControls(id, { dismissed: true }));
    return reply.code(200).send({ ok: true });
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

  app.post("/api/orchestrators/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session || session.runRole !== "lead") {
      return reply.code(404).send({ error: "Orchestrator not found" });
    }
    if (session.dismissed) {
      return reply
        .code(409)
        .send({ error: "Restore the orchestrator before resuming it" });
    }
    const ownedRuns = store.listRuns().filter((run) => run.leadSessionId === id);
    const ownedRunIds = new Set(ownedRuns.map((run) => run.id));
    const resumableRunIds = new Set(
      ownedRuns
        .filter(
          (run) =>
            run.state === "cancelled" && run.failureReason === ORCHESTRATOR_STOP_REASON,
        )
        .map((run) => run.id),
    );
    const unsettledWorker = store
      .listSessions()
      .find(
        (worker) =>
          ownedRunIds.has(worker.runId) &&
          (worker.stopRequested || !terminalSessionStates.has(worker.state)),
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
    for (const run of ownedRuns) reopenOrchestratorStoppedRun(service, run.id);
    engine.tick();
    return reply.code(202).send({
      ok: true,
      recovered: recoveringInterruptedResume,
    });
  });
};
