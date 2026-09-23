import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { HostToNodeMessageSchema, PrMaintenanceObservationSchema } from "@fleet/protocol";
import { fleet } from "./fleet-harness.js";
import { OrchestratorEngine } from "./engine.js";
import { FleetTools, GetPrMaintenanceSchema, SetPrMaintenanceSchema } from "./tools.js";
import { LeadTokens } from "./lead-tokens.js";
import { MCP_PATH, mcpRoutes } from "./mcp-routes.js";

describe("PR maintenance orchestration", () => {
  let world: ReturnType<typeof fleet>;
  let tools: FleetTools;
  const headSha = "a".repeat(40);
  const identity = {
    host: "github.com",
    repositoryId: "r1",
    repository: "example/repo",
    prNumber: 42,
    headRepositoryId: "r1",
    headRepository: "example/repo",
    headRef: "refs/heads/fix",
    baseRepositoryId: "r1",
    baseRepository: "example/repo",
    baseRef: "refs/heads/main",
  };
  const source = {
    id: "thread-1",
    revision: "rev-1",
    groupKey: "null-check",
    evidence: "Review thread URL and exact current revision.",
  };

  beforeEach(() => {
    world = fleet();
    tools = new FleetTools(world.service, world.leadId);
    world.store.transitionSession(world.leadId, "starting");
    world.store.transitionSession(world.leadId, "running");
    world.store.transitionSession(world.leadId, "idle");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    world.store.close();
  });

  const setup = (
    claimVisit = true,
    provider: "github" | "azure-devops" = "github",
    withObservation = true,
  ) => {
    const providerIdentity =
      provider === "azure-devops"
        ? {
            ...identity,
            provider,
            host: "dev.azure.com" as const,
            organization: "sample-org",
            project: "Project",
            projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            repositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            repository: "Project/Repo",
            headRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            headRepository: "Project/Repo",
            baseRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            baseRepository: "Project/Repo",
          }
        : identity;
    const lead = world.store.getSession(world.leadId)!;
    const placement = world.store.getPlacement(lead.placementId)!;
    const run = world.store.createRun({
      workspaceId: lead.workspaceId,
      name: "Original change",
      objective: "Preserve the existing null-handling contract.",
    });
    world.store.updateRun(run.id, { leadSessionId: lead.id, state: "running" });
    const worker = world.store.createSession(placement, "original brief", true, "Coder", {
      runId: run.id,
      runRole: "worker",
    });
    world.store.transitionSession(worker.id, "starting");
    world.store.transitionSession(worker.id, "running");
    world.store.transitionSession(worker.id, "idle");
    const step = world.store.upsertRunStep(run.id, {
      stepKey: "implement",
      title: "Implement",
      prompt: "original brief",
      category: "implement",
      placementId: placement.id,
    });
    world.store.updateRunStep(step.id, { sessionId: worker.id, state: "succeeded" });
    const record = world.store.prMaintenance.enableFromOperator(
      {
        taskId: run.id,
        workerSessionId: worker.id,
        identity: providerIdentity,
        headSha,
        scope: {
          baseline: "Keep the approved API and storage design unchanged.",
          verification: "Run the focused regression suite.",
          publicationAuthorized: true,
        },
        eligibilityEvidence:
          "Provider helper and authentication checked on the bound Node; branch HEAD verified.",
      },
      "authenticated-operator",
    );
    if (!withObservation) return { run, worker, step, record };
    let observed = world.store.prMaintenance.checkpoint(
      world.leadId,
      record.id,
      record.version,
      {
        kind: "observation",
        observation: PrMaintenanceObservationSchema.parse({
          attemptedAt: new Date().toISOString(),
          complete: true,
          identity: providerIdentity,
          snapshotId: "snapshot-1",
          headSha,
          baseSha: "b".repeat(40),
          state: "open",
          fingerprint: "actionable-1",
          mergeability: "mergeable",
          sources: [source],
          checks: [
            {
              key: "test",
              state: "passed",
              headSha,
              evidence: "Current commit CI passed.",
            },
          ],
          reviews: [
            {
              key: "review",
              reviewer: "reviewer",
              state: "approved",
              headSha,
              revision: "1",
              evidence: "Current commit approved.",
            },
          ],
          evidence: "Complete bounded helper observation.",
        }),
      },
    );
    if (claimVisit) {
      observed = world.store.prMaintenance.checkpoint(
        world.leadId,
        observed.id,
        observed.version,
        {
          kind: "reconcile",
          progress: true,
          immediateCheck: true,
          evidence: "Initial authorized observation.",
        },
      );
      world.service.dispatch(lead.nodeId, {
        type: "prompt",
        sessionId: lead.id,
        prompt: "Maintain registered PRs.",
        attachments: [],
      });
      const claim = tools.getPrMaintenance({ takeDue: true });
      expect(claim.ok, claim.text).toBe(true);
    }
    return { run, worker, step, record: observed };
  };
  const completionReceipt = (sessionId: string) => {
    const sequence = world.store.maxEventSequence(sessionId) + 1;
    world.store.appendEvent({
      eventId: `completion-${sequence}`,
      sessionId,
      sequence,
      type: "turn_complete",
      payload: {},
      createdAt: new Date().toISOString(),
    });
    world.store.appendEvent({
      eventId: `idle-${sequence + 1}`,
      sessionId,
      sequence: sequence + 1,
      type: "state",
      payload: { state: "idle" },
      createdAt: new Date().toISOString(),
    });
  };
  const prepare = (recordId: string) => {
    const record = world.store.prMaintenance.get(recordId)!;
    return world.store.prMaintenance.checkpoint(world.leadId, record.id, record.version, {
      kind: "prepare_batch",
      batch: {
        id: "batch-1",
        kind: "repair",
        sources: [source],
        headSha,
        prompt:
          "Repair only the missing null check, run the regression suite, and report exact effects.",
        scope: record.authorization.scope.baseline,
        reservedMutations: 3,
      },
    });
  };
  const reference = (recordId: string) => {
    const record = world.store.prMaintenance.get(recordId)!;
    return { recordId, generation: record.generation, batchId: "batch-1" };
  };
  const hold = (recordId: string) =>
    tools.escalate({
      task: world.store.prMaintenance.get(recordId)!.taskId,
      reason:
        "The proposed null fix would alter the public response contract. Keep the current contract or authorize a bounded redesign.",
      maintenance: {
        recordId,
        expectedVersion: world.store.prMaintenance.get(recordId)!.version,
        decisionId: "decision-1",
      },
    });

  it.each(["running", "completed"] as const)(
    "fleet_escalate requests blocked review without an observation on a %s maintenance task",
    async (state) => {
      const { record, run, worker } = setup(false, "azure-devops", false);
      world.store.updateRun(run.id, { state });
      const review = vi.spyOn(world.service, "requestRunReview");
      const app = Fastify();
      const tokens = new LeadTokens(world.store);
      await app.register(mcpRoutes, { service: world.service, tokens });
      try {
        const response = await app.inject({
          method: "POST",
          url: MCP_PATH,
          headers: {
            authorization: `Bearer ${tokens.mint(world.leadSubject)}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "fleet_escalate",
              arguments: {
                task: run.id,
                reason: "The read-only helper failed before any complete PR observation.",
              },
            },
          },
        });
        const result = response.json();
        expect(result.error).toBeUndefined();
        expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
        expect(review).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ runId: run.id, reason: "blocked" }),
        );
        const reviewed = world.store.getRun(run.id)!;
        expect(reviewed.state).toBe("awaiting_human");
        expect(
          world.store.getNotificationBySourceKey(
            `review:${run.id}:${reviewed.reviewSeq}`,
          ),
        ).toMatchObject({ status: "active", data: { reason: "blocked" } });
        expect(world.store.prMaintenance.get(record.id)).toEqual(record);
        expect(record.observation).toBeUndefined();
        expect(record.decision).toBeUndefined();
        expect(tools.followUp({ sessionId: worker.id, prompt: "Try a repair" }).ok).toBe(
          false,
        );
        expect(
          tools.reopenTask({ task: run.id, reason: "Try to bypass review" }).ok,
        ).toBe(false);
        expect(() =>
          world.service.worktrees.approvePublication(run.id, "approval", "human"),
        ).toThrow();
        expect(world.store.prMaintenance.get(record.id)).toEqual(record);
      } finally {
        await app.close();
      }
    },
  );

  it.each(
    (["running", "completed", "failed"] as const).flatMap((state) =>
      (["auth", "permission", "paused"] as const).map((gate) => ({ state, gate })),
    ),
  )(
    "operational escalation preserves the existing $gate maintenance hold without a head on a $state task",
    ({ state, gate }) => {
      const { record, run } = setup(false, "azure-devops", false);
      world.store.updateRun(run.id, { state });
      const held =
        gate === "paused"
          ? world.store.prMaintenance.set(world.leadId, {
              id: record.id,
              expectedVersion: record.version,
              action: "pause",
              reason: "Operator pause",
            })
          : world.store.prMaintenance.checkpoint(
              world.leadId,
              record.id,
              record.version,
              {
                kind: "fallback",
                error: `${gate}: provider rejected read`,
                observation: {
                  attemptedAt: new Date().toISOString(),
                  complete: false,
                  failure: gate,
                  evidence: "Synthetic provider access failure.",
                },
              },
            );
      expect(held.observation?.headSha).toBeUndefined();
      const update = vi.spyOn(world.store, "updateRun");
      const dispatch = vi.spyOn(world.service, "dispatch");
      expect(
        tools.escalate({
          task: run.id,
          reason: "Operator reconciliation is needed before observation can proceed.",
          maintenance: {
            recordId: held.id,
            expectedVersion: held.version,
            decisionId: "not-a-design-grant",
          },
        }).ok,
      ).toBe(true);
      expect(world.store.getRun(run.id)).toMatchObject({
        state: "awaiting_human",
        reviewSeq: 1,
      });
      expect(update).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(world.store.getNotificationBySourceKey(`review:${run.id}:1`)).toMatchObject({
        status: "active",
        data: { reason: "blocked" },
      });
      expect(world.store.prMaintenance.get(record.id)).toEqual(held);
      expect(() => world.store.updateRun(run.id, { state: "running" })).toThrow(
        "PR maintenance blocks reopen",
      );
      expect(
        tools.followUp({ sessionId: held.workerSessionId, prompt: "Repair" }).ok,
      ).toBe(false);
      expect(() =>
        world.service.worktrees.approvePublication(run.id, "approval", "human"),
      ).toThrow();
      const again = tools.escalate({
        task: run.id,
        reason: "Try to overwrite the existing review.",
      });
      expect(again.ok).toBe(false);
      expect(world.store.prMaintenance.get(record.id)).toEqual(held);
    },
  );

  it("refuses stale, stopped and pending-decision operational escalation without changing holds", () => {
    const { record, run } = setup(false, "azure-devops", false);
    const review = vi.spyOn(world.service, "requestRunReview");
    expect(
      tools.escalate({
        task: run.id,
        reason: "The helper has no usable observation yet.",
        maintenance: {
          recordId: record.id,
          expectedVersion: record.version + 1,
          decisionId: "stale",
        },
      }).ok,
    ).toBe(false);
    world.store.updateRun(run.id, { state: "cancelled" });
    expect(
      tools.escalate({ task: run.id, reason: "Try to reopen a stopped task." }).ok,
    ).toBe(false);
    expect(world.store.getRun(run.id)!.state).toBe("cancelled");
    expect(world.store.prMaintenance.get(record.id)).toEqual(record);
    world.store.updateRun(run.id, { state: "running" });
    const held = world.store.prMaintenance.holdForDecision(
      world.leadId,
      record.id,
      record.version,
      {
        id: "existing",
        version: 1,
        proposal: "Existing question",
        scope: "API",
        headSha,
      },
      () => world.store.updateRun(run.id, { state: "awaiting_human" }),
    );
    expect(
      tools.escalate({
        task: run.id,
        reason: "Try to replace a pending design decision.",
      }).ok,
    ).toBe(false);
    expect(world.store.prMaintenance.get(record.id)).toEqual(held);
    expect(review).not.toHaveBeenCalled();
  });

  it("leaves the terminal task unchanged when operational review cannot be recorded", () => {
    const { record, run } = setup(false, "azure-devops", false);
    world.store.updateRun(run.id, { state: "completed" });
    vi.spyOn(world.service, "requestRunReview").mockReturnValue(undefined);
    expect(
      tools.escalate({
        task: run.id,
        reason: "The helper cannot collect a complete observation.",
      }).ok,
    ).toBe(false);
    expect(world.store.getRun(run.id)!.state).toBe("completed");
    expect(world.store.prMaintenance.get(record.id)).toEqual(record);
  });

  it.each([
    "observed",
    "foreign-lead",
    "wrong-task",
    "stale",
    "released",
    "pending",
    "cancelled",
    "completed-review",
  ] as const)(
    "guards the store review-only transition against %s requests",
    (invalid) => {
      const { record, run } = setup(false, "azure-devops", invalid === "observed");
      if (invalid === "released")
        world.store.prMaintenance.operatorAction(
          record.id,
          record.version,
          { action: "release", reason: "Explicit operator release" },
          "authenticated-operator",
        );
      if (invalid === "pending")
        world.store.prMaintenance.holdForDecision(
          world.leadId,
          record.id,
          record.version,
          {
            id: "pending",
            version: 1,
            proposal: "Existing decision",
            headSha,
            scope: "API",
          },
          () => world.store.updateRun(run.id, { state: "awaiting_human" }),
        );
      else
        world.store.updateRun(run.id, {
          state: invalid === "cancelled" ? "cancelled" : "completed",
        });
      const retained = world.store.prMaintenance.get(record.id)!;
      const before = world.store.getRun(run.id);
      const notes = world.store.listRunNotes(run.id);
      const broadcast = vi.spyOn(world.service, "broadcast");
      expect(() =>
        world.service.requestRunReview({
          runId: invalid === "wrong-task" ? "another-task" : run.id,
          note: "Must not be recorded.",
          reason: invalid === "completed-review" ? "completed" : "blocked",
          operationalMaintenance: {
            recordId: record.id,
            leadSessionId: invalid === "foreign-lead" ? "another-lead" : world.leadId,
            expectedVersion: retained.version + (invalid === "stale" ? 1 : 0),
          },
        }),
      ).toThrow();
      expect(world.store.getRun(run.id)).toEqual(before);
      expect(world.store.listRunNotes(run.id)).toEqual(notes);
      expect(
        world.store.getNotificationBySourceKey(`review:${run.id}:1`),
      ).toBeUndefined();
      expect(world.store.prMaintenance.get(record.id)).toEqual(retained);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("publishes no operational review when the real outer SQLite COMMIT fails", () => {
    const { record, run } = setup(false, "azure-devops", false);
    world.store.updateRun(run.id, { state: "completed" });
    const before = world.store.getRun(run.id);
    const notes = world.store.listRunNotes(run.id);
    const broadcast = vi.spyOn(world.service, "broadcast");
    const exec = DatabaseSync.prototype.exec;
    let commits = 0;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql === "COMMIT") {
        commits += 1;
        expect(world.store.getRun(run.id)).toMatchObject({
          state: "awaiting_human",
          reviewSeq: 1,
        });
        expect(world.store.listRunNotes(run.id)).toHaveLength(notes.length + 1);
        expect(
          world.store.getNotificationBySourceKey(`review:${run.id}:1`),
        ).toBeDefined();
        exec.call(
          this,
          "CREATE TABLE review_commit_failure (run_id TEXT REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO review_commit_failure VALUES ('missing-run')",
        );
      }
      return exec.call(this, sql);
    });
    expect(() =>
      tools.escalate({
        task: run.id,
        reason: "The helper cannot collect a complete observation.",
      }),
    ).toThrow("FOREIGN KEY constraint failed");
    expect(commits).toBe(1);
    expect(world.store.getRun(run.id)).toEqual(before);
    expect(world.store.listRunNotes(run.id)).toEqual(notes);
    expect(world.store.getNotificationBySourceKey(`review:${run.id}:1`)).toBeUndefined();
    expect(world.store.notificationUnreadCount()).toBe(0);
    expect(world.store.prMaintenance.get(record.id)).toEqual(record);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("queues one durable recovery wake across ticks and engine reconstruction without replaying work", () => {
    const { record, run, worker } = setup(false);
    world.store.updateRun(run.id, { state: "completed" });
    const failed = world.store.prMaintenance.checkpoint(
      world.leadId,
      record.id,
      record.version,
      {
        kind: "fallback",
        error: "local gh credential helper is signed out\n",
        observation: {
          attemptedAt: new Date().toISOString(),
          complete: false,
          failure: "capability",
          evidence: "Local helper failure, not provider rejection.",
        },
      },
    );
    vi.spyOn(world.service.commands, "durableLead").mockReturnValue(true);
    const queue = vi.spyOn(world.service.commands, "queueLeadPrompt");
    const pump = vi
      .spyOn(world.service.commands, "pumpLead")
      .mockImplementation(() => {});
    const dispatch = vi.spyOn(world.service, "dispatch");
    new OrchestratorEngine(world.service).tick();
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0]![2]).toBe(
      `pr-maintenance-recovery:${failed.incidents[0]!.id}`,
    );
    expect(queue.mock.calls[0]![1]).toContain("alternate_attempt");
    expect(pump).toHaveBeenCalledWith(world.leadId);
    expect(world.store.commands.prompts(world.leadId)).toHaveLength(1);
    const claimed = world.store.prMaintenance.get(record.id)!;
    expect(claimed.incidents[0]!.wakeQueuedAt).toBeDefined();
    new OrchestratorEngine(world.service).tick(Date.now() + 60 * 60_000);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(
      dispatch.mock.calls.some(([, command]) => command.sessionId === worker.id),
    ).toBe(false);
    expect(world.store.getRun(run.id)!.state).toBe("completed");
    expect(claimed.authorization).toEqual(failed.authorization);
    expect(claimed.counters).toEqual(failed.counters);
    expect(claimed.batches).toEqual([]);
  });

  it("rolls back the wake claim if durable enqueue fails, then retries the same key once", () => {
    const { record, run } = setup(false);
    world.store.updateRun(run.id, { state: "completed" });
    world.store.prMaintenance.checkpoint(world.leadId, record.id, record.version, {
      kind: "fallback",
      error: "helper unavailable",
      observation: {
        attemptedAt: new Date().toISOString(),
        complete: false,
        failure: "capability",
        evidence: "Cannot start helper.",
      },
    });
    vi.spyOn(world.service.commands, "durableLead").mockReturnValue(true);
    const queue = vi
      .spyOn(world.service.commands, "queueLeadPrompt")
      .mockImplementationOnce(() => {
        throw new Error("queue write failed");
      });
    vi.spyOn(world.service.commands, "pumpLead").mockImplementation(() => {});
    expect(() => new OrchestratorEngine(world.service).tick()).toThrow(
      "queue write failed",
    );
    expect(
      world.store.prMaintenance.get(record.id)!.incidents[0]!.wakeQueuedAt,
    ).toBeUndefined();
    expect(world.store.commands.prompts(world.leadId)).toHaveLength(0);
    new OrchestratorEngine(world.service).tick();
    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls[0]![2]).toBe(queue.mock.calls[1]![2]);
    expect(world.store.commands.prompts(world.leadId)).toHaveLength(1);
  });

  it.each(["auth", "permission", "stop", "human"] as const)(
    "never schedules capability recovery through %s",
    (gate) => {
      const { record, run } = setup(false);
      world.store.updateRun(run.id, { state: "completed" });
      let current = world.store.prMaintenance.checkpoint(
        world.leadId,
        record.id,
        record.version,
        {
          kind: "fallback",
          error: "Failure requiring the appropriate authority.",
          observation: {
            attemptedAt: new Date().toISOString(),
            complete: false,
            failure: gate === "auth" || gate === "permission" ? gate : "capability",
            evidence: "Synthetic failure.",
          },
        },
      );
      if (gate === "stop") world.store.updateRun(run.id, { state: "cancelled" });
      if (gate === "human")
        current = world.store.prMaintenance.holdForDecision(
          world.leadId,
          current.id,
          current.version,
          {
            id: "design-hold",
            version: 1,
            proposal: "Change the approved contract?",
            scope: "API",
            headSha,
          },
          () => world.store.updateRun(run.id, { state: "awaiting_human" }),
        );
      vi.spyOn(world.service.commands, "durableLead").mockReturnValue(true);
      const queue = vi.spyOn(world.service.commands, "queueLeadPrompt");
      vi.spyOn(world.service.commands, "pumpLead").mockImplementation(() => {});
      new OrchestratorEngine(world.service).tick();
      expect(queue).not.toHaveBeenCalled();
      expect(
        world.store.prMaintenance.get(record.id)!.incidents[0]!.wakeQueuedAt,
      ).toBeUndefined();
      expect(world.store.prMaintenance.get(record.id)!.authorization).toEqual(
        current.authorization,
      );
    },
  );

  it("exposes the durable registry after conversation context is discarded", () => {
    const { record, worker, run } = setup();
    const replacementFacade = new FleetTools(world.service, world.leadId);
    const summary = replacementFacade.getPrMaintenance();
    expect(summary.ok).toBe(true);
    expect(summary.text).toContain(record.id);
    const restored = JSON.parse(
      replacementFacade.getPrMaintenance({ recordId: record.id }).text,
    );
    expect(restored).toMatchObject({ taskId: run.id, workerSessionId: worker.id });
    expect(restored.observation.sources).toEqual([source]);
  });

  it("never accepts fabricated operator approval or an input wake ID", () => {
    expect(
      SetPrMaintenanceSchema.safeParse({
        recordId: "x",
        expectedVersion: 1,
        action: "enable",
        approved: true,
        actor: "human",
      }).success,
    ).toBe(false);
    expect(
      GetPrMaintenanceSchema.safeParse({ takeDue: true, wakeId: "reset-budget" }).success,
    ).toBe(false);
    const { record } = setup();
    expect(
      tools.setPrMaintenance({
        recordId: record.id,
        expectedVersion: record.version,
        action: "resume",
      }).ok,
    ).toBe(false);
  });

  it.each(["github", "azure-devops"] as const)(
    "requires %s batch metadata and links one retained worker attempt atomically",
    (provider) => {
      const { record, worker, step } = setup(true, provider);
      const prepared = prepare(record.id);
      const prompt = prepared.batches[0]!.prompt;
      expect(tools.followUp({ sessionId: worker.id, prompt }).ok).toBe(false);
      const result = tools.followUp({
        sessionId: worker.id,
        prompt,
        maintenance: reference(record.id),
      });
      expect(result.ok, result.text).toBe(true);
      const accepted = world.store.prMaintenance.get(record.id)!.batches[0]!;
      expect(accepted).toMatchObject({ state: "accepted", stepId: step.id, attempt: 2 });
      expect(
        world.store.listSessions().filter((session) => session.runRole === "worker"),
      ).toHaveLength(1);
      const retry = tools.followUp({
        sessionId: worker.id,
        prompt,
        maintenance: reference(record.id),
      });
      expect(retry.ok, retry.text).toBe(true);
      expect(world.store.getRunStep(step.id)?.attempts).toBe(2);
      expect(
        tools.followUp({
          sessionId: worker.id,
          prompt: "A different prompt",
          maintenance: reference(record.id),
        }).ok,
      ).toBe(false);
    },
  );

  it("rolls back step retry when atomic maintenance acceptance fails", () => {
    const { record, worker, step } = setup();
    const prepared = prepare(record.id);
    vi.spyOn(world.store.prMaintenance, "acceptBatch").mockImplementation(() => {
      throw new Error("simulated database failure");
    });
    expect(() =>
      tools.followUp({
        sessionId: worker.id,
        prompt: prepared.batches[0]!.prompt,
        maintenance: reference(record.id),
      }),
    ).toThrow("simulated database failure");
    expect(world.store.getRunStep(step.id)).toMatchObject({
      state: "succeeded",
      attempts: 1,
      prompt: "original brief",
    });
    expect(world.store.prMaintenance.get(record.id)!.batches[0]!.state).toBe("prepared");
  });

  it.each(["github", "azure-devops"] as const)(
    "preserves the whole-%s-PR human hold across discovery and alternate mutations",
    (provider) => {
      const { record, run, worker } = setup(true, provider);
      expect(hold(record.id).ok).toBe(true);
      expect(tools.getTask({ task: run.id }).text).toContain("wait_for_human");
      const reviewSeq = world.store.getRun(run.id)!.reviewSeq;
      expect(
        tools.reopenTask({
          task: run.id,
          reason: "Try to resume without operator direction.",
        }).ok,
      ).toBe(false);
      expect(tools.advanceTask({ task: run.id, note: "Try another phase" }).ok).toBe(
        false,
      );
      expect(tools.followUp({ sessionId: worker.id, prompt: "Continue anyway" }).ok).toBe(
        false,
      );
      expect(() =>
        world.service.dispatch(worker.nodeId, {
          type: "prompt",
          sessionId: worker.id,
          prompt: "Bypass MCP",
          attachments: [],
        }),
      ).toThrow("wait_for_human");
      const replacement = world.service.createAndStartSession({
        placement: world.store.getPlacement(worker.placementId)!,
        prompt: "Replacement coder",
        yolo: true,
      });
      expect(replacement.ok).toBe(false);
      expect(world.store.getRun(run.id)).toMatchObject({
        state: "awaiting_human",
        reviewSeq,
      });
      expect(
        world.store.getNotificationBySourceKey(`review:${run.id}:${reviewSeq}`)?.status,
      ).toBe("active");
      const second = hold(record.id);
      expect(second.ok, second.text).toBe(true);
      expect(world.store.getRun(run.id)!.reviewSeq).toBe(reviewSeq);
    },
  );

  it("blocks managed finalization and cleanup under the same maintenance hold", async () => {
    const { record, run } = setup();
    expect(hold(record.id).ok).toBe(true);
    expect(() => world.service.worktrees.beginAggregation(run.id)).toThrow(
      "wait_for_human",
    );
    expect(() =>
      world.service.worktrees.approvePublication(run.id, "approval", "human"),
    ).toThrow("wait_for_human");
    expect(() => world.store.prMaintenance.assertTaskCleanupAllowed(run.id)).toThrow(
      "Release settled maintenance",
    );
  });

  it("keeps unrelated placements available while the bound PR is held", () => {
    const { record, worker } = setup();
    expect(hold(record.id).ok).toBe(true);
    const other = world.store
      .listPlacements()
      .find(
        (placement) =>
          placement.id !== worker.placementId && placement.workspaceName === "Beta",
      )!;
    const result = world.service.createAndStartSession({
      placement: other,
      prompt: "Unrelated task",
      yolo: false,
    });
    expect(result.ok).toBe(true);
  });

  it("prevents a paused queued batch from starting and retains reconciliation", () => {
    const { record, worker, step } = setup();
    const prepared = prepare(record.id);
    vi.spyOn(world.service, "tickRun").mockImplementation(() => {});
    expect(
      tools.followUp({
        sessionId: worker.id,
        prompt: prepared.batches[0]!.prompt,
        maintenance: reference(record.id),
      }).ok,
    ).toBe(true);
    const accepted = world.store.prMaintenance.get(record.id)!;
    const publishSnapshot = vi.spyOn(world.service, "publishSnapshot");
    expect(
      tools.setPrMaintenance({
        recordId: record.id,
        expectedVersion: accepted.version,
        action: "pause",
        reason: "Operator pause",
      }).ok,
    ).toBe(true);
    expect(publishSnapshot).toHaveBeenCalled();
    new OrchestratorEngine(world.service).tickRun(step.runId);
    expect(world.store.getRunStep(step.id)!.state).toBe("cancelled");
    expect(world.store.prMaintenance.get(record.id)!.batches[0]).toMatchObject({
      state: "reconciling",
      executionSettled: true,
    });
    expect(world.store.prMaintenance.hasSessionRetentionBlockers(worker.id)).toBe(true);
  });

  it("does not treat a completed repair turn as verified finding/effect completion", () => {
    const { record, worker, step } = setup();
    const prepared = prepare(record.id);
    expect(
      tools.followUp({
        sessionId: worker.id,
        prompt: prepared.batches[0]!.prompt,
        maintenance: reference(record.id),
      }).ok,
    ).toBe(true);
    world.store.updateRunStep(step.id, { state: "running" });
    completionReceipt(worker.id);
    world.service.settleOrchestrationStep({
      runId: step.runId,
      stepId: step.id,
      state: "succeeded",
      output: "Worker says done.",
    });
    const batch = world.store.prMaintenance.get(record.id)!.batches[0]!;
    expect(batch).toMatchObject({
      state: "reconciling",
      executionSettled: true,
      findings: [],
    });
    expect(() => prepare(record.id)).not.toThrow();
    expect(tools.followUp({ sessionId: worker.id, prompt: "New repair" }).ok).toBe(false);
  });

  it("wakes a lead whose only task is completed without reopening the task", () => {
    const { record, run } = setup();
    world.store.setRunState(run.id, "completed");
    const sent = vi.spyOn(world.service, "dispatch");
    const now = Date.parse(world.store.getSession(world.leadId)!.updatedAt) + 30 * 60_000;
    new OrchestratorEngine(world.service).tick(now);
    const prompt = sent.mock.calls.find(([, command]) => command.type === "prompt")?.[1];
    expect(prompt).toMatchObject({ type: "prompt", sessionId: world.leadId });
    if (prompt?.type === "prompt") expect(prompt.prompt).toContain(record.id);
    expect(world.store.getRun(run.id)!.state).toBe("completed");
  });

  it("binds request reservations to the persisted lead turn", () => {
    const { record } = setup();
    world.store.prMaintenance.checkpoint(world.leadId, record.id, record.version, {
      kind: "reconcile",
      progress: true,
      evidence: "Current worker result is ready for reobservation.",
      immediateCheck: true,
    });
    world.service.dispatch(world.store.getSession(world.leadId)!.nodeId, {
      type: "prompt",
      sessionId: world.leadId,
      prompt: "Check due PRs.",
      attachments: [],
    });
    const first = JSON.parse(
      tools.getPrMaintenance({ takeDue: true, reserveRequests: 40 }).text,
    );
    expect(first.observationAllowance.requests).toBe(40);
    expect(first.allowance.requests).toBe(0);
    const compacted = new FleetTools(world.service, world.leadId);
    const second = JSON.parse(compacted.getPrMaintenance({ takeDue: true }).text);
    expect(second.record).toBeNull();
    expect(second.allowance.requests).toBe(0);
  });

  it("refuses observation checkpoints without a claimed Host-recorded visit", () => {
    const { record } = setup(false);
    const input = {
      recordId: record.id,
      expectedVersion: record.version,
      checkpoint: { kind: "observation" as const, observation: record.observation! },
    };
    expect(tools.checkpointPrMaintenance(input)).toMatchObject({ ok: false });
    world.service.dispatch(world.store.getSession(world.leadId)!.nodeId, {
      type: "prompt",
      sessionId: world.leadId,
      prompt: "A normal lead turn.",
      attachments: [],
    });
    const refused = tools.checkpointPrMaintenance(input);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("visit_required");
    expect(world.store.prMaintenance.get(record.id)!.version).toBe(record.version);
  });

  it("adds registry recovery to ordinary lead turns without another prompt producer", () => {
    const { record } = setup();
    const node = world.store.getSession(world.leadId)!.nodeId;
    const sent = vi.spyOn(world.service, "send");
    world.service.dispatch(node, {
      type: "prompt",
      sessionId: world.leadId,
      prompt: "Unrelated user question.",
      attachments: [],
    });
    expect(sent).toHaveBeenCalledTimes(1);
    const envelope = HostToNodeMessageSchema.parse(sent.mock.calls[0]![1]);
    expect(envelope).toMatchObject({
      type: "command",
      command: { type: "prompt", sessionId: world.leadId },
    });
    if (envelope.type === "command" && envelope.command.type === "prompt") {
      expect(envelope.command.prompt).toContain("Unrelated user question.");
      expect(envelope.command.prompt).toContain("fleet_get_pr_maintenance");
    }
    expect(world.store.prMaintenance.get(record.id)!.lifecycle).toBe("active");
  });

  it("refuses initial registration while the original untracked attempt is running", () => {
    const { record, worker, step, run } = setup();
    world.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      {
        action: "release",
        reason: "Release settled registration for a fresh enablement test.",
      },
      "operator",
    );
    world.store.transitionSession(worker.id, "running");
    world.store.updateRunStep(step.id, { state: "running" });
    expect(() =>
      world.store.prMaintenance.enableFromOperator(
        {
          taskId: run.id,
          workerSessionId: worker.id,
          identity,
          headSha,
          scope: record.authorization.scope,
          eligibilityEvidence: "The original attempt is still running.",
        },
        "operator",
      ),
    ).toThrow("existing worker attempt");
    expect(world.store.prMaintenance.list({ retainedOnly: true }).records).toHaveLength(
      0,
    );
  });

  it("keeps a dispatch timeout uncertain until correlated Node receipts arrive", () => {
    const { record, worker, step } = setup();
    const prepared = prepare(record.id);
    expect(
      tools.followUp({
        sessionId: worker.id,
        prompt: prepared.batches[0]!.prompt,
        maintenance: reference(record.id),
      }).ok,
    ).toBe(true);
    world.service.settleOrchestrationStep({
      runId: step.runId,
      stepId: step.id,
      state: "failed",
      output: "Dispatch acknowledgement timed out.",
    });
    expect(world.store.prMaintenance.get(record.id)!.batches[0]).toMatchObject({
      state: "uncertain",
      executionSettled: false,
    });
    completionReceipt(worker.id);
    world.service.reconcilePrMaintenanceExecution(worker.id);
    const settled = world.store.prMaintenance.get(record.id)!;
    expect(settled.batches[0]).toMatchObject({
      state: "reconciling",
      executionSettled: true,
    });
    expect(settled.ownershipReleasedAt).toBeUndefined();
    expect(settled.lifecycle).toBe("paused");
  });

  it("accepts an explicitly resumed stopped worker with a retained native conversation", () => {
    const { record, worker } = setup();
    const paused = world.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      {
        action: "pause",
        reason: "Pause before stopping the retained worker.",
      },
      "operator",
    );
    world.store.appendEvent({
      eventId: "native",
      sessionId: worker.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "native-worker" },
      createdAt: new Date().toISOString(),
    });
    world.store.transitionSession(worker.id, "stopped");
    world.store.prMaintenance.operatorAction(
      paused.id,
      paused.version,
      { action: "resume" },
      "operator",
    );
    const prepared = prepare(record.id);
    const result = tools.followUp({
      sessionId: worker.id,
      prompt: prepared.batches[0]!.prompt,
      maintenance: reference(record.id),
    });
    expect(result.ok, result.text).toBe(true);
    expect(world.store.prMaintenance.get(record.id)!.batches[0]!.state).toBe("accepted");
    expect(world.store.getSession(worker.id)!.state).toBe("starting");
  });

  it("makes stalled work discoverable after explicit operator resume without losing effects", () => {
    const { record } = setup();
    let current = record;
    for (let i = 0; i < 3; i++) {
      current = world.store.prMaintenance.checkpoint(
        world.leadId,
        current.id,
        current.version,
        {
          kind: "observation",
          observation: {
            attemptedAt: new Date().toISOString(),
            complete: false,
            failure: "incomplete",
            evidence: "No additional page or receipt was available.",
          },
        },
      );
    }
    expect(world.store.prMaintenance.wakeEligibleLeadIds()).not.toContain(world.leadId);
    const resumed = world.store.prMaintenance.operatorAction(
      current.id,
      current.version,
      { action: "resume" },
      "operator",
    );
    expect(resumed.counters.scanStalls).toBe(0);
    expect(world.store.prMaintenance.wakeEligibleLeadIds()).toContain(world.leadId);
  });

  it.each(["requests", "time"] as const)(
    "blocks prepared work after the %s wake allowance is exhausted",
    (limit) => {
      const { record, worker } = setup();
      const prepared = prepare(record.id);
      const wakeId = world.store.getSessionDispatchAttempt(world.leadId)!.commandId;
      if (limit === "requests") {
        world.store.prMaintenance.chargeWake(world.leadId, wakeId, {
          requests: world.store.prMaintenance.remainingWake(world.leadId, wakeId)
            .requests,
          milliseconds: 0,
        });
      } else {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 120_001);
      }
      const result = tools.followUp({
        sessionId: worker.id,
        prompt: prepared.batches[0]!.prompt,
        maintenance: reference(record.id),
      });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("wake_exhausted");
      const checkpoint = tools.checkpointPrMaintenance({
        recordId: prepared.id,
        expectedVersion: prepared.version,
        checkpoint: {
          kind: "prepare_batch",
          batch: {
            id: "new-batch",
            kind: "answer",
            sources: [source],
            headSha,
            prompt: "Answer only.",
            scope: "Existing baseline.",
            reservedMutations: 1,
          },
        },
      });
      expect(checkpoint.ok).toBe(false);
      expect(checkpoint.text).toContain("wake_exhausted");
    },
  );
});
