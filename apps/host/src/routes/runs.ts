import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  RunPolicySchema,
  canTransitionRun,
  terminalRunStates,
  terminalSessionStates,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import type { OrchestratorEngine } from "../orchestrator/engine.js";
import { archiveRun, purgeRun } from "../orchestrator/lifecycle.js";
import { reopenPrompt } from "../orchestrator/review.js";

const CreateRunSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(120),
  objective: z.string().min(1).max(4_000),
  policy: RunPolicySchema.partial().optional(),
});

const PlanStepSchema = z.object({
  stepKey: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, "Step keys are ids, not sentences"),
  title: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8_000),
  category: z.string().max(32).optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
});

const PlanSchema = z.object({ steps: z.array(PlanStepSchema).min(1).max(20) });

const ReopenSchema = z.object({
  /** Why it is not finished after all. The orchestrator is woken to act on it. */
  note: z.string().min(1).max(4_000),
});

export type RunRouteOptions = { service: FleetService; engine: OrchestratorEngine };

/**
 * The operator's side of orchestration.
 *
 * The Lead never comes through here: it uses the MCP facade, which is where run
 * accounting lives. These routes are for a human creating, approving, watching
 * and stopping a run.
 */
export const runRoutes: FastifyPluginAsync<RunRouteOptions> = async (
  app,
  { service, engine },
) => {
  const { store } = service;

  const withSteps = (runId: string) => ({
    run: store.getRun(runId),
    steps: store.listRunSteps(runId),
  });

  app.get("/api/runs", async () => {
    const runs = store.listRuns();
    const stepsByRunId = Object.fromEntries(
      runs.map((run) => [run.id, store.listRunSteps(run.id)]),
    );
    const notesByRunId = Object.fromEntries(
      runs.map((run) => [run.id, store.listRunNotes(run.id)]),
    );
    // Every half in one answer: a refreshed browser should not have to fetch
    // each run separately to draw the list it already has.
    return { runs, stepsByRunId, notesByRunId };
  });

  app.post("/api/runs", async (request, reply) => {
    const input = CreateRunSchema.parse(request.body);
    if (!store.getWorkspace(input.workspaceId)) {
      return reply.code(404).send({ error: "Workspace not found" });
    }
    const run = store.createRun({
      workspaceId: input.workspaceId,
      name: input.name,
      objective: input.objective,
      ...(input.policy ? { policy: input.policy } : {}),
    });
    service.publishRun(run);
    return reply.code(201).send(run);
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = withSteps(id);
    if (!found.run) return reply.code(404).send({ error: "Run not found" });
    return found;
  });

  /**
   * Writes a whole plan up front.
   *
   * This is the fixture path, not how a Lead works: it exists so the engine's
   * mechanics can be exercised end to end without a model in the loop.
   */
  app.post("/api/runs/:id/plan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (run.state !== "awaiting_approval") {
      return reply.code(409).send({ error: "A run can only be planned before approval" });
    }
    const input = PlanSchema.parse(request.body);

    const keys = input.steps.map((step) => step.stepKey);
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
    if (duplicate) {
      return reply.code(400).send({ error: `Duplicate step key "${duplicate}"` });
    }
    const known = new Set(keys);
    for (const step of input.steps) {
      const missing = step.dependsOn.find((key) => !known.has(key));
      if (missing) {
        return reply
          .code(400)
          .send({ error: `Step "${step.stepKey}" depends on unknown step "${missing}"` });
      }
    }
    const cycle = findCycle(input.steps);
    if (cycle.length > 0) {
      return reply
        .code(400)
        .send({ error: `Steps form a cycle: ${cycle.join(" → ")}`, cycle });
    }

    const steps = store.replaceRunSteps(id, input.steps);
    service.publishRunSteps(id, steps);
    return { run: store.getRun(id), steps };
  });

  app.post("/api/runs/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (run.state !== "awaiting_approval") {
      return reply.code(409).send({ error: "This run has already been approved" });
    }
    /*
     * The fixture path goes straight to `running`: there is no Lead, so there
     * is nothing to plan — the plan arrived over REST. A Lead-driven run stops
     * in `planning` until it dispatches its first step.
     */
    const next = run.policy.wakePolicy === "none" ? "running" : "planning";
    if (!canTransitionRun(run.state, next)) {
      return reply.code(409).send({ error: "This run cannot be approved from here" });
    }
    const approved = store.setRunState(id, next)!;
    service.publishRun(approved);
    engine.tickRun(id);
    return withSteps(id);
  });

  app.post("/api/runs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (terminalRunStates.has(run.state)) return withSteps(id);

    archiveRun(service, id, "Cancelled by an operator");
    return withSteps(id);
  });

  /**
   * Ends a task and parks the sessions it started.
   *
   * The mechanics are in `orchestrator/lifecycle`, shared with the tool the
   * orchestrator closes its own tasks through. What is decided here is only the
   * reason, which is the part that differs by who asked.
   */
  app.post("/api/runs/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getRun(id)) return reply.code(404).send({ error: "Run not found" });
    archiveRun(service, id, "Archived by an operator");
    return withSteps(id);
  });

  /**
   * Puts a finished task back to work, with what is still wanted.
   *
   * The counterpart to archiving. A person calls a task done and then finds it
   * was not — or that the next thing to do belongs with this one, next to the
   * criteria it was held to and the notes it collected, rather than in a new
   * task that would start with none of that.
   *
   * A reason is required for the same reason a send-back requires one: the
   * orchestrator is being woken to act, and "do more" is not something anyone
   * can act on.
   */
  app.post("/api/runs/:id/reopen", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = ReopenSchema.parse(request.body);
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!terminalRunStates.has(run.state)) {
      return reply.code(409).send({ error: "That task has not finished" });
    }
    const lead = run.leadSessionId ? store.getSession(run.leadSessionId) : undefined;
    if (!lead || terminalSessionStates.has(lead.state)) {
      return reply.code(409).send({
        error:
          "The conversation that owns this task has ended, so nothing can pick it up",
      });
    }

    const note = input.note.trim();
    store.appendRunNote(id, run.phaseIndex, `Reopened by a person.\n\n${note}`);
    service.resolveRunReview(id);
    /*
     * Queued rather than sent. Copilot refuses a prompt mid-turn and reports it
     * as a transcript notice rather than an error, so a direct dispatch would
     * look like it worked and be lost; the engine delivers this on the first
     * tick where the orchestrator is idle.
     */
    const reopened = store.updateRun(id, {
      state: "running",
      failureReason: "",
      pendingPrompt: reopenPrompt(run.name, note),
    })!;
    service.publishRun(reopened);
    engine.tick();
    return withSteps(id);
  });

  /**
   * Removes a task and everything it started.
   *
   * The other thing to do with a finished task, and the honest opposite of
   * archiving: archiving keeps what the work learned, this keeps nothing.
   */
  app.delete("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!purgeRun(service, id)) return reply.code(404).send({ error: "Run not found" });
    return reply.code(204).send();
  });
};

/**
 * The keys on a dependency cycle, or an empty list.
 *
 * Kahn's algorithm: whatever never reaches in-degree zero is exactly the part
 * that depends on itself, and naming those keys is the difference between a
 * fixable error and "invalid plan".
 */
export function findCycle(
  steps: readonly { stepKey: string; dependsOn: readonly string[] }[],
): string[] {
  const indegree = new Map(steps.map((step) => [step.stepKey, step.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    for (const key of step.dependsOn) {
      dependents.set(key, [...(dependents.get(key) ?? []), step.stepKey]);
    }
  }
  const ready = [...indegree.entries()].filter(([, n]) => n === 0).map(([key]) => key);
  const settled = new Set<string>();
  while (ready.length > 0) {
    const key = ready.pop()!;
    settled.add(key);
    for (const dependent of dependents.get(key) ?? []) {
      const left = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }
  return steps.map((step) => step.stepKey).filter((key) => !settled.has(key));
}
