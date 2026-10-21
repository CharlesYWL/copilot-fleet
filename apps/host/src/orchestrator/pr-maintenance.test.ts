import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import {
  HostToNodeMessageSchema,
  ORCHESTRATOR_STOP_REASON,
  PrMaintenanceObservationSchema,
} from "@fleet/protocol";
import { fleet } from "./fleet-harness.js";
import { OrchestratorEngine } from "./engine.js";
import { FleetTools, GetPrMaintenanceSchema, SetPrMaintenanceSchema } from "./tools.js";
import { transferRun } from "./lifecycle.js";
import { SessionCleanupPendingError } from "../store.js";

describe("PR maintenance orchestration", () => {
  let world: ReturnType<typeof fleet>;
  let tools: FleetTools;
  let temporaryDirectory: string | undefined;
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
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
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
          checksComplete: true,
          reviewsComplete: true,
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
    // Claiming a review updates the record; hand back its current version.
    return {
      run,
      worker,
      step,
      record: world.store.prMaintenance.get(observed.id) ?? observed,
    };
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

  it("requires operational review to own its outermost transaction", () => {
    const { record, run } = setup(false, "azure-devops", false);
    world.store.updateRun(run.id, { state: "completed" });
    const before = world.store.getRun(run.id);
    const notes = world.store.listRunNotes(run.id);
    const broadcast = vi.spyOn(world.service, "broadcast");
    world.store.writeAtomically(() => {
      expect(() =>
        world.service.requestRunReview({
          runId: run.id,
          note: "Nested operational review must not publish before commit.",
          reason: "blocked",
          operationalMaintenance: {
            recordId: record.id,
            leadSessionId: world.leadId,
            expectedVersion: record.version,
          },
        }),
      ).toThrow("Operational maintenance review must own the outermost transaction.");
    });
    expect(world.store.getRun(run.id)).toEqual(before);
    expect(world.store.listRunNotes(run.id)).toEqual(notes);
    expect(world.store.getNotificationBySourceKey(`review:${run.id}:1`)).toBeUndefined();
    expect(world.store.prMaintenance.get(record.id)).toEqual(record);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([
    "observed",
    "foreign-lead",
    "wrong-task",
    "stale",
    "released",
    "pending",
    "pending-review",
    "cancelled",
    "nonmutable",
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
      if (invalid === "pending") {
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
        );
        world.store.updateRun(run.id, { state: "awaiting_human" });
      } else
        world.store.updateRun(run.id, {
          state:
            invalid === "cancelled"
              ? "cancelled"
              : invalid === "pending-review"
                ? "awaiting_human"
                : "completed",
        });
      if (invalid === "nonmutable")
        vi.spyOn(world.store, "assertRunMutable").mockImplementation(() => {
          throw new SessionCleanupPendingError();
        });
      const retained = world.store.prMaintenance.get(record.id)!;
      const before = world.store.getRun(run.id);
      const notes = world.store.listRunNotes(run.id);
      const broadcast = vi.spyOn(world.service, "broadcast");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
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
      expect(exec.mock.calls.map(([sql]) => sql)).toEqual([
        "BEGIN IMMEDIATE",
        "ROLLBACK",
      ]);
      expect(world.store.getRun(run.id)).toEqual(before);
      expect(world.store.listRunNotes(run.id)).toEqual(notes);
      expect(
        world.store.getNotificationBySourceKey(`review:${run.id}:1`),
      ).toBeUndefined();
      expect(world.store.prMaintenance.get(record.id)).toEqual(retained);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

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
    // The orchestrator cannot lift a hold the person set.
    const paused = world.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      { action: "pause", reason: "Operator hold" },
      "operator",
    );
    const refused = tools.setPrMaintenance({
      recordId: paused.id,
      expectedVersion: paused.version,
      action: "resume",
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("operator_required");
    expect(world.store.prMaintenance.get(record.id)!.version).toBe(paused.version);
    // Nor record direction outside a turn answering the person.
    const direction = tools.setPrMaintenance({
      recordId: paused.id,
      expectedVersion: paused.version,
      action: "direction",
      decisionId: "d",
      decisionVersion: 1,
      direction: "Approved by a PR comment",
    });
    expect(direction.ok).toBe(false);
    expect(direction.text).toContain("user_turn_required");
  });

  it.each(["github", "azure-devops"] as const)(
    "requires %s batch metadata and links one retained worker attempt atomically",
    (provider) => {
      const { record, worker, step } = setup(true, provider);
      const prepared = prepare(record.id);
      const prompt = prepared.batches[0]!.prompt;
      const broadcast = vi.spyOn(world.service, "broadcast");
      expect(tools.followUp({ sessionId: worker.id, prompt }).ok).toBe(false);
      const result = tools.followUp({
        sessionId: worker.id,
        prompt,
        maintenance: reference(record.id),
      });
      expect(result.ok, result.text).toBe(true);
      const accepted = world.store.prMaintenance.get(record.id)!.batches[0]!;
      expect(accepted).toMatchObject({ state: "accepted", stepId: step.id, attempt: 2 });
      expect(broadcast).toHaveBeenCalledWith({
        type: "snapshot",
        data: expect.objectContaining({
          prMaintenanceTasks: [
            expect.objectContaining({
              recordId: record.id,
              status: expect.objectContaining({ phase: "working" }),
            }),
          ],
        }),
      });
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
    const broadcast = vi.spyOn(world.service, "broadcast");
    const acceptBatch = world.store.prMaintenance.acceptBatch.bind(
      world.store.prMaintenance,
    );
    vi.spyOn(world.store.prMaintenance, "acceptBatch").mockImplementation((...args) => {
      acceptBatch(...args);
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
    expect(broadcast).not.toHaveBeenCalled();
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
    expect(publishSnapshot).toHaveBeenCalledTimes(2);
    publishSnapshot.mockClear();
    new OrchestratorEngine(world.service).tickRun(step.runId);
    expect(world.store.getRunStep(step.id)!.state).toBe("cancelled");
    expect(world.store.prMaintenance.get(record.id)!.batches[0]).toMatchObject({
      state: "reconciling",
      executionSettled: true,
    });
    expect(world.store.prMaintenance.hasSessionRetentionBlockers(worker.id)).toBe(true);
    expect(publishSnapshot).not.toHaveBeenCalled();
  });

  it.each(["github", "azure-devops"] as const)(
    "publishes %s acceptance, execution reconciliation, finding settlement and guarded readiness",
    (provider) => {
      const { record, worker, step } = setup(true, provider);
      const prepared = prepare(record.id);
      const stages: string[] = [];
      vi.spyOn(world.service, "broadcast").mockImplementation((message) => {
        if (message.type !== "snapshot") return;
        expect(message.data.prMaintenanceTasks).toEqual(
          world.service.snapshot().prMaintenanceTasks,
        );
        const status = message.data.prMaintenanceTasks?.find(
          (entry) => entry.recordId === record.id,
        );
        expect(status?.status).toEqual(
          world.store.prMaintenance.status(world.store.prMaintenance.get(record.id)!),
        );
        if (status) stages.push(status.status.hold ?? status.status.phase);
      });
      expect(
        tools.followUp({
          sessionId: worker.id,
          prompt: prepared.batches[0]!.prompt,
          maintenance: reference(record.id),
        }).ok,
      ).toBe(true);
      expect(stages).toEqual(["working"]);
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
      expect(stages).toEqual(["working", "reconciling"]);
      expect(() => prepare(record.id)).not.toThrow();
      expect(tools.followUp({ sessionId: worker.id, prompt: "New repair" }).ok).toBe(
        false,
      );
      const checkpoint = (
        update: Parameters<FleetTools["checkpointPrMaintenance"]>[0]["checkpoint"],
      ) =>
        tools.checkpointPrMaintenance({
          recordId: record.id,
          expectedVersion: world.store.prMaintenance.get(record.id)!.version,
          checkpoint: update,
        });
      const ready = {
        kind: "ready" as const,
        fingerprint: "actionable-1",
        evidence: "Complete current-HEAD findings, checks and reviews.",
      };
      expect(checkpoint(ready).ok).toBe(false);
      const settlement = checkpoint({
        kind: "batch",
        batchId: batch.id,
        generation: record.generation,
        state: "succeeded",
        executionSettled: true,
        published: false,
        usedMutations: 0,
        effects: [],
        findings: [
          {
            source,
            outcome: "already_satisfied",
            stage: "verified",
            verifiedHeadSha: headSha,
            evidence: ["Existing repair verified on current HEAD."],
            responseRequired: false,
            responseIds: [],
            progress: true,
          },
        ],
        evidence: "Correlated terminal execution and known effects.",
      });
      expect(settlement.ok, settlement.text).toBe(true);
      expect(stages.at(-1)).toBe("reviewing");
      const readiness = checkpoint(ready);
      expect(readiness.ok, readiness.text).toBe(true);
      expect(stages).toEqual(["working", "reconciling", "reviewing", "reviewing"]);
      expect(world.store.prMaintenance.get(record.id)!.readyFingerprint).toBe(
        "actionable-1",
      );
      expect(world.store.prMaintenance.get(record.id)!.observation!.sources).toEqual([
        source,
      ]);
    },
  );

  it("rolls back execution settlement without publishing an uncommitted maintenance summary", () => {
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
    const before = world.store.prMaintenance.get(record.id);
    const broadcast = vi.spyOn(world.service, "broadcast");
    vi.spyOn(world.store, "recordRunSettle").mockImplementation(() => {
      throw new Error("simulated settlement failure");
    });
    expect(() =>
      world.service.settleOrchestrationStep({
        runId: step.runId,
        stepId: step.id,
        state: "succeeded",
        output: "Worker turn complete",
      }),
    ).toThrow("simulated settlement failure");
    expect(world.store.prMaintenance.get(record.id)).toEqual(before);
    expect(world.store.getRunStep(step.id)!.state).toBe("running");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("publishes maintenance reconciliation when a stopped attempt returns a late result", () => {
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
    world.store.cancelRunWithUnfinishedSteps(step.runId, ORCHESTRATOR_STOP_REASON, true);
    completionReceipt(worker.id);
    const broadcast = vi.spyOn(world.service, "broadcast");
    const lateResult = {
      runId: step.runId,
      stepId: step.id,
      state: "succeeded" as const,
      output: "Completed before Stop",
    };
    expect(world.service.reconcileStoppedOrchestrationStep(lateResult)).toBe(true);
    expect(broadcast).toHaveBeenCalledWith({
      type: "snapshot",
      data: expect.objectContaining({
        prMaintenanceTasks: [
          expect.objectContaining({
            recordId: record.id,
            // Stop wins in the status; the batch itself is reconciling.
            status: expect.objectContaining({ hold: "stopped" }),
          }),
        ],
      }),
    });
    expect(world.store.prMaintenance.get(record.id)!.batches[0]).toMatchObject({
      state: "reconciling",
      executionSettled: true,
    });
    broadcast.mockClear();
    expect(world.service.reconcileStoppedOrchestrationStep(lateResult)).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
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
    const publishSnapshot = vi.spyOn(world.service, "publishSnapshot");
    world.service.reconcilePrMaintenanceExecution(worker.id);
    const settled = world.store.prMaintenance.get(record.id)!;
    expect(settled.batches[0]).toMatchObject({
      state: "reconciling",
      executionSettled: true,
    });
    expect(settled.ownershipReleasedAt).toBeUndefined();
    // Settled execution re-enters review; its effects are still reconciled.
    expect(settled.lifecycle).toBe("active");
    expect(settled.review?.source).toBe("worker_result");
    expect(publishSnapshot).toHaveBeenCalledTimes(1);
    world.service.reconcilePrMaintenanceExecution(worker.id);
    expect(publishSnapshot).toHaveBeenCalledTimes(1);
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
  it("retains an offline accepted attempt and dispatches the same worker and immutable prompt once after reconnect", () => {
    const { record, worker } = setup();
    world.store.appendEvent({
      eventId: "retained-native",
      sessionId: worker.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "native-worker" },
      createdAt: new Date().toISOString(),
    });
    const prepared = prepare(record.id);
    world.store.transitionSession(worker.id, "offline");
    world.store.setNodeOnline(worker.nodeId, false, 0);
    const dispatch = vi.spyOn(world.service, "dispatch");
    const followUp = () =>
      tools.followUp({
        sessionId: worker.id,
        prompt: prepared.batches[0]!.prompt,
        maintenance: reference(record.id),
      });
    const first = followUp();
    expect(first.ok, first.text).toBe(true);
    const accepted = world.store.prMaintenance.get(record.id)!;
    const batch = accepted.batches[0]!;
    expect(batch.state).toBe("accepted");
    expect(world.store.prMaintenance.status(accepted).phase).toBe("working");
    expect(followUp().ok).toBe(true);
    expect(world.store.prMaintenance.get(record.id)!.batches[0]).toEqual(batch);
    expect(dispatch).not.toHaveBeenCalled();
    world.store.setNodeOnline(worker.nodeId, true, 0);
    // Reconnect inventory proves the retained native conversation is unloaded.
    world.store.transitionSession(worker.id, "stopped");
    world.engine.tick();
    world.store.transitionSession(worker.id, "idle");
    world.engine.tick();
    world.engine.tick();
    expect(
      dispatch.mock.calls.filter(
        ([, message]) =>
          message.type === "resume_session" && message.sessionId === worker.id,
      ),
    ).toHaveLength(1);
    const sends = dispatch.mock.calls.filter(
      ([, message]) => message.type === "prompt" && message.sessionId === worker.id,
    );
    expect(sends).toHaveLength(1);
    expect(world.store.getRunStep(batch.stepId!)?.prompt).toBe(batch.prompt);
    expect(world.store.getRunStep(batch.stepId!)?.attempts).toBe(batch.attempt);
    expect(world.store.prMaintenance.get(record.id)!.counters).toEqual(accepted.counters);
    const projected = JSON.parse(tools.getPrMaintenance({ recordId: record.id }).text);
    expect(projected.status).toEqual(
      world.store.prMaintenance.status(world.store.prMaintenance.get(record.id)!),
    );
  });

  describe("prm work-order wrapper", () => {
    const sourceId = source.id;
    const plan = (
      overrides: Record<string, unknown> = {},
    ): Parameters<FleetTools["checkpointPrMaintenance"]>[0]["checkpoint"] =>
      ({
        kind: "prepare_work_order",
        plan: {
          batchId: "wo-1",
          summary: "Add the missing null check.",
          conflictResolution: false,
          reservedMutations: 3,
          findings: [
            {
              sourceId,
              revision: source.revision,
              task: "repair",
              instructions: "Return early on null input and add a regression test.",
            },
          ],
          ...overrides,
        },
      }) as Parameters<FleetTools["checkpointPrMaintenance"]>[0]["checkpoint"];
    const checkpoint = (
      recordId: string,
      update: Parameters<FleetTools["checkpointPrMaintenance"]>[0]["checkpoint"],
    ) =>
      tools.checkpointPrMaintenance({
        recordId,
        expectedVersion: world.store.prMaintenance.get(recordId)!.version,
        checkpoint: update,
      });
    const workerSays = (sessionId: string, text: string) => {
      const sequence = world.store.maxEventSequence(sessionId) + 1;
      world.store.appendEvent({
        eventId: `report-${sequence}`,
        sessionId,
        sequence,
        type: "agent_text",
        payload: { text },
        createdAt: new Date().toISOString(),
      });
    };
    const report = (overrides: Record<string, unknown> = {}) => ({
      schema: "prm.work-report/1",
      batchId: "wo-1",
      summary: "Verified the existing guard covers the null input.",
      mutationAttempts: 0,
      findings: [
        {
          sourceId,
          revision: source.revision,
          outcome: "already_satisfied",
          stage: "verified",
          verifiedHeadSha: headSha,
          evidence: ["Regression suite passed at the current head."],
        },
      ],
      effects: [],
      ...overrides,
    });
    const dispatchAndComplete = (recordId: string, workerId: string, stepId: string) => {
      const sent = tools.followUp({
        sessionId: workerId,
        maintenance: { recordId, generation: 1, batchId: "wo-1" },
      });
      expect(sent.ok, sent.text).toBe(true);
      world.store.updateRunStep(stepId, { state: "running" });
    };
    const settleStep = (stepId: string, runId: string, workerId: string) => {
      completionReceipt(workerId);
      world.service.settleOrchestrationStep({
        runId,
        stepId,
        state: "succeeded",
        output: "Worker turn complete.",
      });
    };

    it("renders the immutable worker prompt from current sources and the grant", () => {
      const { record, worker } = setup();
      const prepared = checkpoint(record.id, plan());
      expect(prepared.ok, prepared.text).toBe(true);
      const batch = world.store.prMaintenance.get(record.id)!.batches[0]!;
      expect(batch).toMatchObject({
        id: "wo-1",
        kind: "repair",
        sources: [source],
        headSha,
        reservedMutations: 3,
        workOrder: {
          schema: "prm.work-order/1",
          batchId: "wo-1",
          permissions: {
            modifyCode: true,
            push: true,
            reply: false,
            resolveThreads: false,
          },
          baseline: record.authorization.scope.baseline,
          verification: [record.authorization.scope.verification],
        },
      });
      expect(batch.prompt).toContain("prm.work-order/1");
      expect(batch.prompt).toContain("<prm-work-report>");
      expect(batch.prompt).toContain(source.evidence);
      // Retrying the same plan is idempotent; the stored prompt is never rebuilt.
      expect(checkpoint(record.id, plan()).ok).toBe(true);
      expect(world.store.prMaintenance.get(record.id)!.batches).toHaveLength(1);
      const sent = tools.followUp({
        sessionId: worker.id,
        maintenance: {
          recordId: record.id,
          generation: record.generation,
          batchId: "wo-1",
        },
      });
      expect(sent.ok, sent.text).toBe(true);
      expect(world.store.prMaintenance.get(record.id)!.batches[0]!.state).toBe(
        "accepted",
      );
      expect(world.store.getRunStepBySession(worker.id)!.prompt).toBe(batch.prompt);
    });

    it("refuses plans that invent sources or exceed the grant", () => {
      const { record } = setup();
      const invented = checkpoint(
        record.id,
        plan({
          findings: [
            {
              sourceId: "thread-9",
              revision: "rev-9",
              task: "repair",
              instructions: "x",
            },
          ],
        }),
      );
      expect(invented.ok).toBe(false);
      expect(invented.text).toContain("source_mismatch");
      const answer = checkpoint(
        record.id,
        plan({
          findings: [
            {
              sourceId,
              revision: source.revision,
              task: "answer",
              instructions: "Reply.",
            },
          ],
        }),
      );
      expect(answer.ok).toBe(false);
      expect(answer.text).toContain("reply_not_authorized");
      expect(world.store.prMaintenance.get(record.id)!.batches).toEqual([]);
    });

    it("still requires a prompt for ordinary follow-ups", () => {
      const { worker } = setup();
      const result = tools.followUp({ sessionId: worker.id });
      expect(result.ok).toBe(false);
    });

    it("settles from the worker's tagged report through the existing guards", () => {
      const { record, worker, step } = setup();
      expect(checkpoint(record.id, plan()).ok).toBe(true);
      dispatchAndComplete(record.id, worker.id, step.id);
      const early = checkpoint(record.id, {
        kind: "work_report",
        batchId: "wo-1",
        generation: 1,
        report: report(),
      });
      expect(early.ok).toBe(false);
      expect(early.text).toContain("execution_unsettled");
      workerSays(
        worker.id,
        `Done.\n<prm-work-report>\n${JSON.stringify(report())}\n</prm-work-report>\n`,
      );
      settleStep(step.id, step.runId, worker.id);
      const settled = checkpoint(record.id, {
        kind: "work_report",
        batchId: "wo-1",
        generation: 1,
      });
      expect(settled.ok, settled.text).toBe(true);
      const batch = world.store.prMaintenance.get(record.id)!.batches[0]!;
      expect(batch).toMatchObject({
        state: "succeeded",
        executionSettled: true,
        published: false,
        findings: [
          {
            source,
            outcome: "already_satisfied",
            stage: "verified",
            verifiedHeadSha: headSha,
            responseRequired: false,
          },
        ],
      });
      expect(
        checkpoint(record.id, {
          kind: "ready",
          fingerprint: "actionable-1",
          evidence: "ok",
        }).ok,
      ).toBe(true);
    });

    it("rejects reports that do not match the work order", () => {
      const { record, worker, step } = setup();
      expect(checkpoint(record.id, plan()).ok).toBe(true);
      dispatchAndComplete(record.id, worker.id, step.id);
      settleStep(step.id, step.runId, worker.id);
      const before = world.store.prMaintenance.get(record.id)!.batches[0];
      const missing = checkpoint(record.id, {
        kind: "work_report",
        batchId: "wo-1",
        generation: 1,
      });
      expect(missing.ok).toBe(false);
      expect(missing.text).toContain("report_missing");
      const wrongRevision = checkpoint(record.id, {
        kind: "work_report",
        batchId: "wo-1",
        generation: 1,
        report: report({
          findings: [
            {
              sourceId,
              revision: "other",
              outcome: "already_satisfied",
              stage: "verified",
              verifiedHeadSha: headSha,
            },
          ],
        }),
      });
      expect(wrongRevision.ok).toBe(false);
      expect(wrongRevision.text).toContain("invalid_report");
      const unpublished = checkpoint(record.id, {
        kind: "work_report",
        batchId: "wo-1",
        generation: 1,
        report: report({
          findings: [
            {
              sourceId,
              revision: source.revision,
              outcome: "addressed",
              stage: "verified",
              verifiedHeadSha: headSha,
            },
          ],
        }),
      });
      expect(unpublished.ok).toBe(false);
      expect(unpublished.text).toContain("published");
      expect(world.store.prMaintenance.get(record.id)!.batches[0]).toEqual(before);
    });

    it("keeps an unconfirmed push uncertain instead of settling it", () => {
      const { record, worker, step } = setup();
      expect(checkpoint(record.id, plan()).ok).toBe(true);
      dispatchAndComplete(record.id, worker.id, step.id);
      settleStep(step.id, step.runId, worker.id);
      const uncertain = checkpoint(record.id, {
        kind: "work_report",
        batchId: "wo-1",
        generation: 1,
        report: report({
          mutationAttempts: 1,
          findings: [
            {
              sourceId,
              revision: source.revision,
              outcome: "incomplete",
              stage: "committed",
              verifiedHeadSha: headSha,
              nextAction: "Confirm whether the push reached the PR head.",
            },
          ],
          effects: [{ kind: "push", state: "uncertain" }],
        }),
      });
      expect(uncertain.ok, uncertain.text).toBe(true);
      const batch = world.store.prMaintenance.get(record.id)!.batches[0]!;
      expect(batch.state).toBe("uncertain");
      expect(batch.effects).toMatchObject([{ kind: "push", state: "uncertain" }]);
      expect(
        tools.checkpointPrMaintenance({
          recordId: record.id,
          expectedVersion: world.store.prMaintenance.get(record.id)!.version,
          checkpoint: plan({ batchId: "wo-2" }),
        }).ok,
      ).toBe(false);
    });

    it("leaves hand-written prepare_batch batches on their existing settlement path", () => {
      const { record } = setup();
      prepare(record.id);
      const result = checkpoint(record.id, {
        kind: "work_report",
        batchId: "batch-1",
        generation: 1,
        report: report({ batchId: "batch-1" }),
      });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("not_a_work_order");
    });
  });

  it("moves the PR heartbeat with a transferred task", () => {
    const { run, record } = setup(false, "github", false);
    const lead = world.store.getSession(world.leadId)!;
    const next = world.store.createSession(
      world.store.getPlacement(lead.placementId)!,
      "orchestrate",
      true,
      "Relief",
      { runRole: "lead" },
    );
    world.store.transitionSession(next.id, "starting");
    world.store.transitionSession(next.id, "idle");

    transferRun(world.service, run.id, next.id, { source: "operator" });

    expect(world.store.prMaintenance.get(record.id)!.leadSessionId).toBe(next.id);
    expect(
      world.store.prMaintenance.pendingReviewWakes().map((entry) => entry.leadSessionId),
    ).not.toContain(world.leadId);
    const previous = tools.getPrMaintenance({ taskId: run.id });
    expect(previous.ok).toBe(false);
    expect(previous.text).toContain("ownership");
    const receiving = new FleetTools(world.service, next.id).getPrMaintenance({
      taskId: run.id,
    });
    expect(receiving.ok, receiving.text).toBe(true);
    expect(
      JSON.parse(receiving.text).records.map((entry: { id: string }) => entry.id),
    ).toEqual([record.id]);
    // The retained worker is still bound: the new owner can continue it.
    expect(
      world.store.prMaintenance.admission({
        action: "discover",
        taskId: run.id,
        leadSessionId: next.id,
      }).allowed,
    ).toBe(true);
  });
});
