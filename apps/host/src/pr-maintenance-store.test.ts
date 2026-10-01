import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_LIMITS,
  CommandExecutionSchema,
  CommandReceiptSchema,
  PreparedCommandSchema,
  commandDigestPayload,
  PrMaintenanceObservationSchema,
  PrMaintenanceEnableSchema,
  PrMaintenanceManualCommandSchema,
  HostBackupSchema,
  PR_MAINTENANCE_RECOVERY_LIMITS,
  nextHeartbeat,
  parseHeartbeatSchedule,
  prMaintenanceProgress,
  prMaintenanceTaskStatuses,
  type PrMaintenanceCheckpoint,
  type PrMaintenanceObservation,
  type PrMaintenanceRegistration,
} from "@fleet/protocol";
import { FleetStore } from "./store.js";
import { FleetService } from "./fleet-service.js";
import Fastify from "fastify";
import { PrMaintenanceError, prMaintenanceUnsettled } from "./pr-maintenance-store.js";
import v1Conflicts from "./fixtures/pr-maintenance-v1-conflicts.json" with { type: "json" };

const stores: FleetStore[] = [];
const paths: string[] = [];
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const at = "2026-09-18T00:00:00.000Z";
const source = {
  id: "thread-1",
  revision: "revision-1",
  groupKey: "null-boundary",
  evidence: "github:thread-1",
};
const scope = {
  baseline: "Preserve the approved API and existing null invariant.",
  verification: "Run the existing unit tests.",
  publicationAuthorized: true as const,
  replies: true,
  resolveThreads: true,
};
const identity = {
  host: "github.com",
  repositoryId: "R_MAIN",
  repository: "Example/Main",
  prNumber: 1,
  headRepositoryId: "R_FORK",
  headRepository: "Example/Fork",
  headRef: "refs/heads/Repair",
  baseRepositoryId: "R_MAIN",
  baseRepository: "Example/Main",
  baseRef: "refs/heads/main",
};
const adoIdentity = {
  ...identity,
  provider: "azure-devops" as const,
  host: "dev.azure.com" as const,
  organization: "sample-org",
  project: "Sample Project",
  projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  repositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  repository: "Sample Project/Repo",
  headRepositoryId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  headRepository: "Sample Project/Fork",
  baseRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  baseRepository: "Sample Project/Repo",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
});

describe("prepared maintenance observation recovery", () => {
  function receipt(
    f: ReturnType<typeof setup>,
    record: PrMaintenanceRegistration,
    overrides: Partial<PrMaintenanceObservation> = {},
    /** Runs while the claimed helper command is out, before its result lands. */
    whileRunning?: () => void,
  ) {
    const now = new Date().toISOString();
    const nodeTime = new Date(Date.now() + 10_000).toISOString();
    const wakeId = randomUUID();
    f.store.setSessionDispatchAttempt(f.lead.id, {
      commandId: wakeId,
      eventSeqFrom: 0,
      attempt: wakeId,
    });
    f.store.prMaintenance.beginWake(f.lead.id, wakeId);
    expect(f.store.prMaintenance.takeDue(f.lead.id, wakeId)?.id).toBe(record.id);
    const { deadlineAt, ...maintenanceObservation } =
      f.store.prMaintenance.reserveObservation(f.lead.id, wakeId, record.id, 8);
    let execution = CommandExecutionSchema.parse({
      id: randomUUID(),
      attemptId: randomUUID(),
      version: 0,
      hostId: "test-host",
      nodeId: f.node.id,
      nodeName: f.node.name,
      leadSessionId: f.lead.id,
      target: { placementId: f.placement.id },
      requestedPath: f.placement.localPath,
      command: "node snapshot.mjs",
      shell: "windows-powershell-5.1",
      reason: "Fresh complete PR observation",
      requestKey: randomUUID(),
      requestDigest: "a".repeat(64),
      maintenanceObservation,
      state: "running",
      ownership: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: deadlineAt,
      approvedAt: now,
    });
    const physical = {
      key: "checkout",
      path: f.placement.localPath,
      machineId: "test-machine",
      volume: "test-volume",
      fileId: "test-file",
    };
    const descriptor = PreparedCommandSchema.strip().parse({
      ...execution,
      executionId: execution.id,
      hostTime: now,
      observationBudget: { deadlineAt, requests: 8 },
      prepared: {
        cwd: f.placement.localPath,
        checkout: physical,
        repository: physical,
        shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        admissionVersion: 1,
        preparedAt: nodeTime,
        hostClockOffsetMs: -10_000,
        clockUncertaintyMs: COMMAND_LIMITS.clockUncertaintyMs,
      },
      digest: "a".repeat(64),
    });
    descriptor.digest = createHash("sha256")
      .update(commandDigestPayload(descriptor))
      .digest("hex");
    execution.descriptor = descriptor;
    f.store.commands.insert(execution);
    f.store.prMaintenance.bindObservationExecution(execution);
    f.store.commands.recordPreparationSend(execution.id, now);
    f.store.commands.acceptPreparationClock(execution.id, now, now, 0);
    f.store.commands.markStart(execution);
    whileRunning?.();
    const observation = PrMaintenanceObservationSchema.parse({
      ...record.observation,
      attemptedAt: nodeTime,
      snapshotId: `snapshot-${wakeId}`,
      fingerprint: `snapshot-${wakeId}`,
      draft: false,
      requestsConsumed: 1,
      elapsedMs: 100,
      ...overrides,
    });
    const { prNumber, ...snapshotIdentity } = record.identity;
    const output = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        complete: true,
        requestsConsumed: observation.requestsConsumed,
        elapsedMs: observation.elapsedMs,
        observation,
        snapshot: {
          generation: record.generation,
          identity: {
            ...snapshotIdentity,
            number: prNumber,
            prId: "PR_MAIN",
            url: `https://${record.identity.host}/${record.identity.repository}/pull/${prNumber}`,
          },
          headSha: observation.headSha,
          baseSha: observation.baseSha,
          state: observation.state,
          isDraft: observation.draft,
          actionableFingerprint: observation.snapshotId,
        },
      }),
    );
    execution = f.store.commands.appendOutput(execution, {
      executionId: execution.id,
      attemptId: execution.attemptId,
      sequence: 1,
      stream: "stdout",
      data: output.toString("base64"),
      at: nodeTime,
    }).execution;
    vi.setSystemTime(Date.now() + 100);
    f.store.commands.recordReceipt(
      execution.id,
      JSON.stringify(
        CommandReceiptSchema.parse({
          executionId: execution.id,
          attemptId: execution.attemptId,
          digest: descriptor.digest,
          state: "succeeded",
          ownership: "quiescent",
          exitCode: 0,
          reason: "completed",
          outcomeKnown: true,
          descendantCleanupForced: false,
          settledAt: new Date(Date.parse(nodeTime) + 100).toISOString(),
          finalOutputSeq: 1,
          gaps: [],
        }),
      ),
    );
    f.store.commands.update(execution.id, execution.version, {
      state: "succeeded",
      ownership: "quiescent",
      exitCode: 0,
      outcomeKnown: true,
      outputComplete: true,
      finalOutputSeq: 1,
      settledAt: new Date().toISOString(),
    });
    const saved = f.store.prMaintenance.checkpointObservationReceipt(
      f.lead.id,
      record.id,
      f.store.prMaintenance.get(record.id)!.version,
      execution.id,
      observation,
    );
    return { saved, observation, hostAt: now };
  }

  function agedPreparation() {
    const f = setup();
    const record = prepare(
      f,
      observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
    );
    // Past the evidence window, and at the routine check the heartbeat schedules.
    vi.setSystemTime(
      Math.max(Date.parse(at) + 31 * 60_000, Date.parse(record.nextCheckAt)),
    );
    return { f, record };
  }

  function dispatch(f: ReturnType<typeof setup>, record: PrMaintenanceRegistration) {
    return f.store.prMaintenance.admission({
      action: "dispatch",
      taskId: f.task.id,
      sessionId: f.worker.id,
      recordId: record.id,
      generation: record.generation,
      batchId: record.batches.at(-1)!.id,
    });
  }

  it("promotes a fresh claim-bound receipt for an aged prepared batch, but not accepted work", () => {
    const { f, record } = agedPreparation();
    expect(dispatch(f, record).reason).toBe("stale_observation");
    const fresh = receipt(f, record);
    expect(fresh.saved.observation).toEqual(fresh.observation);
    expect(fresh.saved.observationHostAt).toBe(fresh.hostAt);
    expect(fresh.saved.batches).toEqual(record.batches);
    expect(dispatch(f, fresh.saved)).toEqual({ allowed: true });
    vi.setSystemTime(Date.now() + 1_000);
    // A read claimed before the batch was accepted finishes after it.
    let accepted: PrMaintenanceRegistration | undefined;
    const late = receipt(f, fresh.saved, {}, () => {
      accepted = accept(f, fresh.saved);
    });
    expect(late.saved.lastAttempt).toEqual(late.observation);
    expect(late.saved.observation).toEqual(fresh.observation);
    expect(late.saved.observationHostAt).toBe(fresh.hostAt);
    expect(late.saved.batches).toEqual(accepted!.batches);
    expect(dispatch(f, late.saved).allowed).toBe(false);
  });

  it("does not claim a PR while its retained worker is still on an accepted batch", () => {
    const { f, record } = agedPreparation();
    const fresh = receipt(f, record);
    accept(f, fresh.saved);
    const wake = randomUUID();
    f.store.prMaintenance.beginWake(f.lead.id, wake);
    expect(f.store.prMaintenance.takeDue(f.lead.id, wake)).toBeUndefined();
    // Once the repair turn settles, the job is claimable again for reconciliation.
    f.store.updateRunStep(f.store.prMaintenance.get(record.id)!.batches[0]!.stepId!, {
      state: "succeeded",
    });
    expect(f.store.prMaintenance.takeDue(f.lead.id, wake)?.id).toBe(record.id);
  });

  it.each(["receipt", "checkpoint"] as const)(
    "refreshes prepared work via %s and refunds changed-head preparation without human action",
    (path) => {
      const { f, record } = agedPreparation();
      const refresh = (current: PrMaintenanceRegistration, headSha = sha) =>
        path === "receipt"
          ? receipt(f, current, { headSha }).saved
          : observe(f, current, {
              attemptedAt: new Date().toISOString(),
              snapshotId: `snapshot-${Date.now()}`,
              headSha,
            });
      const fresh = refresh(record);
      expect(fresh.observation?.snapshotId).not.toBe(record.observation?.snapshotId);
      expect(fresh.batches).toEqual(record.batches);
      expect(dispatch(f, fresh)).toEqual({ allowed: true });
      vi.setSystemTime(Date.now() + 31 * 60_000);
      const changed = refresh(fresh, otherSha);
      expect(changed.observation?.headSha).toBe(otherSha);
      expect(changed.batches[0]).toMatchObject({
        state: "superseded",
        executionSettled: true,
        usedMutations: 0,
      });
      expect(changed.counters.repairBatches).toBe(0);
      expect(changed.counters.mutationAttempts).toBe(0);
      expect(dispatch(f, changed).allowed).toBe(false);
      expect(changed.lifecycle).toBe("active");
      const replacement = prepare(f, changed, "new-head", "repair", otherSha);
      expect(dispatch(f, replacement)).toEqual({ allowed: true });
    },
  );

  it.each(["draft", "conflict", "incident", "stale"] as const)(
    "keeps the %s refusal after refreshing an aged prepared batch",
    (reason) => {
      const { f, record } = agedPreparation();
      const fresh = receipt(f, record, {
        draft: reason === "draft",
        mergeability: reason === "conflict" ? "conflicting" : "mergeable",
      });
      expect(fresh.saved.observation).toEqual(fresh.observation);
      let current = fresh.saved;
      if (reason === "incident") {
        vi.setSystemTime(Date.now() + 10_000);
        current = observe(f, current, {
          attemptedAt: new Date().toISOString(),
          complete: false,
          failure: "permission",
        });
        expect(current.incidents.some((incident) => !incident.resolvedAt)).toBe(true);
      }
      if (reason === "stale") vi.setSystemTime(Date.now() + 31 * 60_000);
      expect(dispatch(f, current)).toMatchObject({
        allowed: false,
        reason: {
          draft: "draft",
          conflict: "merge_conflict",
          incident: "paused",
          stale: "stale_observation",
        }[reason],
      });
    },
  );

  it("recovers a capability incident while an undispatched batch remains prepared", () => {
    const { f, record } = agedPreparation();
    const failed = observe(f, record, {
      attemptedAt: new Date().toISOString(),
      complete: false,
      failure: "network",
    });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const fresh = receipt(f, failed);
    expect(fresh.saved.observation).toEqual(fresh.observation);
    expect(fresh.saved.incidents[0]?.resolution).toBe("observation");
    expect(fresh.saved.batches).toEqual(record.batches);
    expect(dispatch(f, fresh.saved)).toEqual({ allowed: true });
  });

  it("waits for the orchestrator's next heartbeat instead of a fixed half hour", () => {
    const f = setup();
    f.store.setOrchestratorHeartbeatSchedule("0 */3 * * *");
    const record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "operator"),
    );
    const due = nextHeartbeat(parseHeartbeatSchedule("0 */3 * * *"), Date.parse(at))!;
    expect(record.nextCheckAt).toBe(new Date(due).toISOString());
    expect(new Date(due).getHours() % 3).toBe(0);
    expect(due - Date.parse(at)).toBeGreaterThanOrEqual(30 * 60_000);
    const early = new Date(due - 60_000).toISOString();
    f.store.prMaintenance.beginWake(f.lead.id, "early", early);
    expect(f.store.prMaintenance.takeDue(f.lead.id, "early", early)).toBeUndefined();
    const onTime = new Date(due).toISOString();
    f.store.prMaintenance.beginWake(f.lead.id, "on-time", onTime);
    expect(f.store.prMaintenance.takeDue(f.lead.id, "on-time", onTime)?.id).toBe(
      record.id,
    );
  });

  it("charges the full five-minute wake without changing request or visit limits", () => {
    const f = setup();
    f.store.prMaintenance.beginWake(f.lead.id, "five-minute-wake");
    expect(
      f.store.prMaintenance.chargeWake(f.lead.id, "five-minute-wake", {
        requests: 1,
        milliseconds: 150_000,
      }),
    ).toEqual({ requests: 39, visits: 5, milliseconds: 150_000 });
    expect(
      f.store.prMaintenance.chargeWake(f.lead.id, "five-minute-wake", {
        requests: 1,
        milliseconds: 150_000,
      }),
    ).toEqual({ requests: 38, visits: 5, milliseconds: 0 });
    expect(() =>
      f.store.prMaintenance.chargeWake(f.lead.id, "five-minute-wake", {
        requests: 0,
        milliseconds: 0,
      }),
    ).toThrow(/End this maintenance pass/);
  });
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.useRealTimers();
});

function storeAt(path = ":memory:") {
  const store = new FleetStore(path, { secureFiles: () => {} });
  stores.push(store);
  return store;
}
function setup(store = storeAt(), name = randomUUID()) {
  const { node } = store.registerNode({
    name,
    os: "win32",
    arch: "x64",
    version: "0.1.0",
    capabilities: ["copilot-acp"],
    maxSessions: 20,
  });
  const workspace = store.createWorkspace(name, "");
  const placement = store.createPlacement(workspace.id, node.id, `C:\\repo\\${name}`);
  const task = store.createRun({
    workspaceId: workspace.id,
    name: "Repair",
    objective: "Keep the approved contract",
  });
  const lead = store.createSession(placement, "Lead", false, "", { runRole: "lead" });
  const worker = store.createSession(placement, "Worker", false, "", {
    runId: task.id,
    runRole: "worker",
  });
  store.transitionSession(worker.id, "starting");
  store.transitionSession(worker.id, "idle");
  store.updateRun(task.id, {
    leadSessionId: lead.id,
    placementId: placement.id,
    state: "running",
  });
  const step = store.upsertRunStep(task.id, {
    stepKey: "implementation",
    title: "Repair",
    prompt: "Original work",
    category: "implement",
  });
  store.updateRunStep(step.id, {
    sessionId: worker.id,
    placementId: placement.id,
    state: "succeeded",
  });
  const input = PrMaintenanceEnableSchema.parse({
    taskId: task.id,
    workerSessionId: worker.id,
    identity,
    scope,
    headSha: sha,
    eligibilityEvidence:
      "Authenticated operator inspected remote HEAD, mutable checkout and supported helper.",
  });
  return { store, node, workspace, placement, task, lead, worker, step, input };
}
function observe(
  f: ReturnType<typeof setup>,
  record: PrMaintenanceRegistration,
  overrides = {},
) {
  return f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
    kind: "observation",
    observation: {
      attemptedAt: at,
      complete: true,
      identity: record.identity,
      snapshotId: "snapshot-1",
      headSha: sha,
      baseSha: otherSha,
      state: "open",
      fingerprint: "fingerprint-1",
      sources: [source],
      evidence: "github:bounded-complete-snapshot",
      ...overrides,
    },
  });
}

function restoreLegacy(f: ReturnType<typeof setup>) {
  const record = f.store.prMaintenance.enableFromOperator(f.input, "legacy-operator");
  const backup = f.store.prMaintenance.exportBackup();
  const legacy = backup.registrations.find((entry) => entry.id === record.id)!;
  Object.assign(legacy.authorization.scope, {
    publicationAuthorized: false,
    replies: false,
    resolveThreads: false,
  });
  f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
  return f.store.prMaintenance.get(record.id)!;
}
function prepare(
  f: ReturnType<typeof setup>,
  record: PrMaintenanceRegistration,
  id = "batch-1",
  kind: "repair" | "answer" = "repair",
  headSha = sha,
) {
  return f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
    kind: "prepare_batch",
    batch: {
      id,
      kind,
      sources: [source],
      headSha,
      prompt: "Repair the null boundary; verify, publish, and reply.",
      scope: "Existing null invariant only.",
      reservedMutations: 3,
    },
  });
}
function accept(
  f: ReturnType<typeof setup>,
  record: PrMaintenanceRegistration,
  batchId = "batch-1",
) {
  const batch = record.batches.find((entry) => entry.id === batchId)!;
  return f.store.writeAtomically(() => {
    const step = f.store.retryRunStepInSession(
      f.task.id,
      {
        stepKey: "implementation",
        title: "Repair",
        prompt: batch.prompt,
        placementId: f.placement.id,
      },
      f.worker.id,
      0,
    );
    return f.store.prMaintenance.acceptBatch(
      f.lead.id,
      record.id,
      record.generation,
      batchId,
      step.id,
      step.attempts,
      batch.prompt,
    );
  });
}
function result(
  record: PrMaintenanceRegistration,
  state: "reconciling" | "succeeded" | "partial" | "uncertain" = "reconciling",
): PrMaintenanceCheckpoint {
  return {
    kind: "batch",
    batchId: record.batches.at(-1)!.id,
    generation: record.generation,
    state,
    findings: [
      {
        source,
        outcome: "addressed",
        stage: "replied",
        evidence: ["tests:passed", "github:response-1"],
        responseRequired: true,
        responseIds: ["response-1"],
        progress: true,
        ...(record.batches.at(-1)!.kind === "repair" ? { publishedCommit: sha } : {}),
      },
    ],
    effects: [],
    executionSettled: true,
    evidence: "Correlated settled RunStep and provider receipts.",
    usedMutations: 1,
    published: true,
  };
}

function publishedRepair(f: ReturnType<typeof setup>) {
  let record = accept(
    f,
    prepare(
      f,
      observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator"), {
        mergeability: "mergeable",
        checksComplete: true,
        reviewsComplete: true,
        checks: [{ key: "unit", state: "passed", headSha: sha, evidence: "ci:A passed" }],
        reviews: [
          {
            key: "review",
            reviewer: "owner",
            state: "approved",
            headSha: sha,
            revision: "review-A",
            evidence: "github:A approved",
          },
        ],
      }),
    ),
  );
  f.store.updateRunStep(f.step.id, { state: "succeeded" });
  const receipt = result(record);
  if (receipt.kind !== "batch") throw new Error("fixture");
  receipt.findings[0]!.publishedCommit = otherSha;
  record = f.store.prMaintenance.checkpoint(
    f.lead.id,
    record.id,
    record.version,
    receipt,
  );
  return f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
    ...receipt,
    state: "succeeded",
  });
}

function expectLeadResumeRefused(
  f: ReturnType<typeof setup>,
  record: PrMaintenanceRegistration,
  code: string,
  leadSessionId = f.lead.id,
) {
  const before = f.store.prMaintenance.get(record.id)!;
  try {
    f.store.prMaintenance.set(leadSessionId, {
      id: record.id,
      expectedVersion: before.version,
      action: "resume",
    });
    throw new Error("Expected lead resume to be refused.");
  } catch (error) {
    expect(error).toBeInstanceOf(PrMaintenanceError);
    expect((error as PrMaintenanceError).code).toBe(code);
  }
  expect(f.store.prMaintenance.get(record.id)).toEqual(before);
}

describe("bounded alternate PR observations", () => {
  const error = "gh auth status failed:\n  local credential helper is signed out\n";
  const provenance = {
    source: "github.com",
    method: "read-only provider API",
    evidenceRef: "https://github.com/example/main/pull/1",
  };
  function fallback(f: ReturnType<typeof setup>, failure = "capability" as const) {
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    return f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "fallback",
      error,
      observation: {
        attemptedAt: new Date().toISOString(),
        complete: false,
        failure,
        evidence: "The local helper could not supply provider evidence.",
      },
    });
  }
  function visit(
    f: ReturnType<typeof setup>,
    record: PrMaintenanceRegistration,
    wakeId = "wake",
  ) {
    f.store.writeAtomically(() =>
      f.store.prMaintenance.markRecoveryWake(record.id, record.incidents[0]!.id),
    );
    f.store.prMaintenance.beginWake(f.lead.id, wakeId);
    expect(f.store.prMaintenance.takeDue(f.lead.id, wakeId)?.id).toBe(record.id);
    return f.store.prMaintenance.get(record.id)!;
  }
  function reserve(
    f: ReturnType<typeof setup>,
    record: PrMaintenanceRegistration,
    resolutionId = "alternate-1",
    requests = 2,
  ) {
    return f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      {
        kind: "alternate_attempt",
        incidentId: record.incidents[0]!.id,
        resolutionId,
        provenance,
        requests,
      },
      "wake",
    );
  }
  function alternate(
    f: ReturnType<typeof setup>,
    record: PrMaintenanceRegistration,
    overrides = {},
    resolutionId = "alternate-1",
  ) {
    return f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "alternate_observation",
      incidentId: record.incidents[0]!.id,
      resolutionId,
      observation: {
        attemptedAt: new Date().toISOString(),
        identity: record.identity,
        complete: true,
        snapshotId: "alternate-snapshot",
        headSha: sha,
        state: "open",
        fingerprint: "alternate-fingerprint",
        mergeability: "mergeable",
        checksComplete: true,
        reviewsComplete: true,
        sources: [source],
        evidence: "Fresh read-only provider evidence.",
        ...overrides,
      },
    });
  }

  it("deduplicates a failed helper and one wake, preserving exact original error after recovery", () => {
    const f = setup();
    let record = fallback(f);
    const first = record;
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "fallback",
      error,
      observation: record.lastAttempt!,
    });
    expect(record).toEqual(first);
    expect(f.store.prMaintenance.pendingRecoveryWakes()).toHaveLength(1);
    record = visit(f, record);
    expect(f.store.prMaintenance.pendingRecoveryWakes()).toEqual([]);
    const authorization = record.authorization;
    const counters = record.counters;
    record = reserve(f, record);
    const reserved = record;
    expect(reserve(f, record)).toEqual(reserved);
    expect(f.store.prMaintenance.remainingWake(f.lead.id, "wake").requests).toBe(38);
    record = alternate(f, record);
    expect(record.lastError).toBe(error);
    expect(record.incidents[0]).toMatchObject({
      error,
      lastError: error,
      resolution: "alternate_observation",
      attempts: [{ state: "resolved", provenance, requests: 2 }],
    });
    expect(record.incidents[0]!.resolvedAt).toBeDefined();
    expect(record.authorization).toEqual(authorization);
    expect(record.counters).toEqual(counters);
    expect(prMaintenanceProgress(record).stage).toBe("triage");
    expect(alternate(f, record)).toEqual(record);
    expect(record.batches).toEqual([]);
  });

  it.each([
    ["local_auth_unavailable", "capability"],
    ["cli_unavailable", "capability"],
    ["gh_unavailable", "capability"],
    ["malformed_response", "capability"],
    ["unsupported_pagination", "capability"],
    ["scope_changed", "identity"],
    ["auth_required", "provider_denial"],
    ["permission_denied", "provider_denial"],
    ["ambiguous_effect", "effects"],
  ] as const)(
    "retains normalized %s errors and classifies them as %s without weakening holds",
    (code, kind) => {
      const f = setup();
      let record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
      const normalized = { code, message: "Exact normalized helper message.\n" };
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "observation",
        observation: {
          attemptedAt: at,
          complete: false,
          failure: "incomplete",
          helperState: {
            error: normalized,
            resume: { nextPage: "2" },
            previousThreads: [],
          },
          evidence: "Synthetic helper boundary.",
        },
      });
      expect(record.incidents[0]).toMatchObject({
        kind,
        helperError: normalized,
        error: normalized.message,
      });
      expect(record.lastError).toBe(normalized.message);
      expect(record.lastAttempt!.helperState).toMatchObject({
        resume: { nextPage: "2" },
      });
      if (kind === "capability") {
        record = alternate(f, reserve(f, visit(f, record)));
        expect(record.incidents[0]).toMatchObject({
          kind,
          helperError: normalized,
          error: normalized.message,
          resolution: "alternate_observation",
        });
        expect(record.lastError).toBe(normalized.message);
      } else {
        expect(f.store.prMaintenance.pendingRecoveryWakes()).toEqual([]);
        expect(record.lifecycle).toBe("paused");
        expect(() => reserve(f, record)).toThrow(/Recovery cannot/);
      }
      if (kind === "effects") {
        expect(prMaintenanceUnsettled(record)).toBe(true);
        expect(prMaintenanceProgress(record).stage).toBe("reconciling");
        expect(() =>
          f.store.prMaintenance.operatorAction(
            record.id,
            record.version,
            { action: "resume" },
            "operator",
          ),
        ).toThrow(/ambiguous effects/);
        expect(() =>
          f.store.prMaintenance.operatorAction(
            record.id,
            record.version,
            { action: "release", reason: "Cannot abandon unknown effects." },
            "operator",
          ),
        ).toThrow(/Reconcile accepted execution/);
        record = observe(f, record, {
          state: "closed",
          knownSelfEffectIds: ["unrelated-receipt"],
        });
        expect(record.incidents[0]!.resolvedAt).toBeUndefined();
        expect(record.ownershipReleasedAt).toBeUndefined();
      }
    },
  );

  it("requires all pinned typed reply receipts, not alternate evidence or unrelated keys, to settle ambiguity", () => {
    const f = setup();
    let record = accept(
      f,
      prepare(
        f,
        observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
      ),
    );
    f.store.updateRunStep(f.step.id, { state: "succeeded", dispatchedAt: at });
    const receipt = result(record);
    if (receipt.kind !== "batch") throw new Error("fixture");
    receipt.effects = [
      {
        key: "reply-1",
        kind: "reply",
        state: "known",
        headSha: sha,
        actor: "worker",
        actionIdentity: source.id,
        attempts: 1,
        providerId: "public-comment-1",
        evidence: "Correlated provider comment receipt.",
      },
    ];
    receipt.effects.push({
      ...receipt.effects[0]!,
      key: "reply-2",
      actionIdentity: `${source.id}:follow-up`,
      providerId: "public-comment-2",
    });
    receipt.usedMutations = 2;
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      receipt,
    );
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      ...receipt,
      state: "succeeded",
    });
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "observation",
      observation: {
        attemptedAt: at,
        complete: false,
        failure: "incomplete",
        helperState: {
          error: { code: "ambiguous_effect", message: "Receipt matching is ambiguous." },
        },
        evidence: "Provider marker match was not unique.",
      },
    });
    expect(record.incidents[0]!.effectKeys).toEqual(["reply-1", "reply-2"]);
    record = observe(f, record, { knownSelfEffectIds: ["reply-1", "unrelated"] });
    expect(record.incidents[0]!.resolvedAt).toBeUndefined();
    expect(() =>
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "resume" },
        "operator",
      ),
    ).toThrow(/ambiguous effects/);
    record = observe(f, record, { knownSelfEffectIds: ["reply-1", "reply-2"] });
    expect(record.incidents[0]!.resolution).toBe("observation");
    expect(record.lifecycle).toBe("paused");
    expect(prMaintenanceUnsettled(record)).toBe(false);
    expect(
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "resume" },
        "operator",
      ).lifecycle,
    ).toBe("active");
  });

  it("persists reservation limits across restart and portable restore without inventing authority", () => {
    const path = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
    mkdirSync(path, { recursive: true });
    paths.push(path);
    const database = join(path, "host.sqlite");
    const f = setup(storeAt(database));
    let record = visit(f, fallback(f));
    for (let i = 0; i < PR_MAINTENANCE_RECOVERY_LIMITS.attempts; i++)
      record = reserve(f, record, `alternate-${i}`);
    expect(() => reserve(f, record, "one-too-many")).toThrow(/exhausted/);
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    f.store = storeAt(database);
    expect(f.store.prMaintenance.get(record.id)).toEqual(record);
    expect(() => reserve(f, record, "after-restart")).toThrow(/exhausted/);
    const restored = storeAt();
    restored.replaceHostBackup(f.store.exportHostBackup({ enrollmentToken: "" }));
    const imported = restored.prMaintenance.get(record.id)!;
    expect(imported.incidents).toEqual(record.incidents);
    expect(imported.incidentCursor).toBe(record.incidentCursor);
    expect(imported.lifecycle).toBe("paused");
    expect(imported.lastError).toBe(error);
    expect(restored.prMaintenance.pendingRecoveryWakes()).toEqual([]);
  });

  it("can claim capability recovery on an existing new wake before the engine queues it", () => {
    const f = setup();
    const initial = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    f.store.prMaintenance.beginWake(f.lead.id, "original");
    expect(f.store.prMaintenance.takeDue(f.lead.id, "original")?.id).toBe(initial.id);
    const failed = fallback(f);
    expect(failed.nextCheckAt > at).toBe(true);
    expect(f.store.prMaintenance.takeDue(f.lead.id, "original")).toBeUndefined();
    f.store.prMaintenance.beginWake(f.lead.id, "wake");
    expect(f.store.prMaintenance.takeDue(f.lead.id, "wake")?.id).toBe(failed.id);
    expect(f.store.prMaintenance.takeDue(f.lead.id, "wake")).toBeUndefined();
    const reserved = reserve(f, failed);
    expect(reserved.incidents[0]!.attempts).toHaveLength(1);
    expect(f.store.prMaintenance.remainingWake(f.lead.id, "wake")).toMatchObject({
      visits: 4,
      requests: 38,
    });
  });

  it.each([
    { name: "stale", attemptedAt: "2026-09-17T00:00:00.000Z" },
    { name: "future", attemptedAt: "2026-09-19T00:00:00.000Z" },
    { name: "unbound", identity: undefined, complete: false },
    { name: "requests", requestsConsumed: 3 },
  ])(
    "retains a consumed rejected receipt for $name alternate evidence",
    ({ name: _name, ...overrides }) => {
      const f = setup();
      let record = reserve(f, visit(f, fallback(f)));
      record = alternate(f, record, overrides);
      expect(record.incidents[0]!.attempts[0]!.state).toBe("rejected");
      expect(record.incidents[0]!.resolvedAt).toBeUndefined();
      expect(record.lastAttempt?.complete).toBe(false);
      expect(record.observation).toBeUndefined();
      expect(record.lastError).toBe(error);
      expect(alternate(f, record, overrides)).toEqual(record);
      expect(() => alternate(f, record)).toThrow(/immutable/);
    },
  );

  it("keeps partial observations incomplete, then allows triage without readiness", () => {
    const f = setup();
    let record = reserve(f, visit(f, fallback(f)));
    record = alternate(f, record, {
      complete: false,
      failure: "incomplete",
      cursor: "page-two",
      checksComplete: false,
      evidence: "Only the first feedback page was returned.",
    });
    expect(record.lastAttempt?.complete).toBe(false);
    expect(record.observation).toBeUndefined();
    expect(record.incidents[0]!.attempts[0]!.state).toBe("incomplete");
    expect(() => prepare(f, record)).toThrow(/complete/);
    record = reserve(f, record, "alternate-2");
    record = alternate(
      f,
      record,
      { checksComplete: false, reviewsComplete: false },
      "alternate-2",
    );
    expect(record.incidents[0]!.resolvedAt).toBeDefined();
    expect(prMaintenanceProgress(record).stage).toBe("triage");
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "ready",
        fingerprint: "alternate-fingerprint",
        evidence: "Not actually ready.",
      }),
    ).toThrow(/Readiness/);
    expect(prepare(f, record).batches).toHaveLength(1);
  });

  it.each(["auth", "permission"] as const)(
    "does not recover actual provider %s rejection without an operator",
    (failure) => {
      const f = setup();
      let record = fallback(f);
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "fallback",
        error: "Provider rejected the authenticated request.",
        observation: {
          attemptedAt: at,
          complete: false,
          failure,
          evidence: "Provider denial receipt.",
        },
      });
      expect(record.lifecycle).toBe("paused");
      expect(record.incidents.at(-1)?.kind).toBe("provider_denial");
      expect(f.store.prMaintenance.pendingRecoveryWakes()).toEqual([]);
      expect(() => reserve(f, record)).toThrow(/Recovery cannot/);
      record = observe(f, record);
      expect(record.lifecycle).toBe("paused");
      expect(record.incidents.at(-1)?.resolvedAt).toBeUndefined();
      record = f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "resume" },
        "operator",
      );
      expect(record.incidents.at(-1)?.resolution).toBe("operator_resume");
    },
  );

  it.each(["pause", "stop", "human", "uncertain"] as const)(
    "cannot use in-flight alternate evidence to clear %s",
    (hold) => {
      const f = setup();
      let record = reserve(f, visit(f, fallback(f)));
      if (hold === "pause")
        record = f.store.prMaintenance.operatorAction(
          record.id,
          record.version,
          { action: "pause", reason: "Operator hold." },
          "operator",
        );
      if (hold === "stop") f.store.updateRun(f.task.id, { state: "cancelled" });
      if (hold === "human") {
        record = f.store.prMaintenance.holdForDecision(
          f.lead.id,
          record.id,
          record.version,
          {
            id: "design-choice",
            version: 1,
            proposal: "Change the public contract?",
            headSha: sha,
            scope: "API design",
          },
          () => f.store.updateRun(f.task.id, { state: "awaiting_human" }),
        );
      }
      if (hold === "uncertain") {
        // An independent accepted attempt becoming uncertain must close recovery admission.
        f.store.updateRun(f.task.id, { state: "blocked" });
      }
      const before = structuredClone(record);
      record = alternate(f, record, { state: "merged" });
      expect(record.incidents[0]!.attempts[0]).toMatchObject({
        state: "rejected",
        error: "recovery_held",
      });
      expect(record.incidents[0]!.resolvedAt).toBeUndefined();
      expect(record.lifecycle).toBe(before.lifecycle);
      expect(record.decision).toEqual(before.decision);
      expect(record.authorization).toEqual(before.authorization);
      expect(record.counters).toEqual(before.counters);
      expect(record.ownershipReleasedAt).toBeUndefined();
    },
  );

  it("records identity drift separately without rebinding or recovering", () => {
    const f = setup();
    let record = reserve(f, visit(f, fallback(f)));
    record = alternate(f, record, {
      identity: { ...record.identity, headRef: "refs/heads/other" },
    });
    expect(record.pauseReason).toBe("remote_identity_changed");
    expect(record.incidents.at(-1)?.kind).toBe("identity");
    expect(record.identity.headRef).toBe("refs/heads/Repair");
    expect(record.incidents[0]!.resolvedAt).toBeUndefined();
  });

  it("does not settle unknown execution/effects or release terminal ownership through alternate evidence", () => {
    const f = setup();
    let record = reserve(f, visit(f, fallback(f)));
    record = alternate(f, record, { state: "merged" });
    expect(record.incidents[0]!.resolvedAt).toBeDefined();
    expect(record.lifecycle).toBe("active");
    expect(record.ownershipReleasedAt).toBeUndefined();
    expect(() => prepare(f, record)).toThrow(/complete/);
    record = observe(f, record, { state: "merged" });
    expect(record.ownershipReleasedAt).toBeDefined();
    const next = f.store.prMaintenance.enableFromOperator(
      {
        ...f.input,
        identity: { ...f.input.identity, prNumber: 2, headRef: "refs/heads/next" },
      },
      "operator",
    );
    expect(f.store.prMaintenance.list({ taskId: f.task.id }).records).toHaveLength(2);
    expect(f.store.prMaintenance.get(record.id)?.ownershipReleasedAt).toBeDefined();
    expect(next.ownershipReleasedAt).toBeUndefined();

    let pending = accept(f, prepare(f, observe(f, next)));
    pending = f.store.prMaintenance.checkpoint(f.lead.id, pending.id, pending.version, {
      kind: "batch",
      batchId: "batch-1",
      generation: pending.generation,
      state: "uncertain",
      executionSettled: false,
      findings: [],
      effects: [
        {
          key: "push-unknown",
          kind: "push",
          state: "uncertain",
          headSha: sha,
          actor: "worker",
          actionIdentity: "publish-head",
          attempts: 1,
        },
      ],
      evidence: "Execution and provider acknowledgement unavailable.",
    });
    pending = f.store.prMaintenance.checkpoint(f.lead.id, pending.id, pending.version, {
      kind: "fallback",
      error,
      observation: {
        attemptedAt: at,
        complete: false,
        failure: "capability",
        evidence: "Helper unavailable.",
      },
    });
    expect(() => reserve(f, pending)).toThrow(/Recovery cannot/);
    expect(prMaintenanceProgress(pending).stage).toBe("reconciling");
    expect(pending.batches[0]!.executionSettled).toBe(false);
    expect(pending.batches[0]!.effects[0]!.state).toBe("uncertain");
  });

  it("requires a claimed wake and respects request/time budgets before reserving I/O", () => {
    const f = setup();
    let record = fallback(f);
    expect(() => reserve(f, record)).toThrow(/wake/);
    record = visit(f, record);
    f.store.prMaintenance.chargeWake(f.lead.id, "wake", {
      requests: 39,
      milliseconds: 0,
    });
    expect(() => reserve(f, record)).toThrow(/End this maintenance pass/);
    expect(f.store.prMaintenance.get(record.id)!.incidents[0]!.attempts).toHaveLength(0);
    vi.setSystemTime(Date.parse(at) + 300_001);
    expect(() => reserve(f, record, "timed-out", 1)).toThrow(/End this maintenance pass/);
  });

  it.each(["2026-09-17T23:29:59.999Z", "2026-09-18T00:00:00.001Z"])(
    "rejects stale/future standard terminal evidence at %s without releasing",
    (attemptedAt) => {
      const f = setup();
      const record = observe(
        f,
        f.store.prMaintenance.enableFromOperator(f.input, "operator"),
      );
      expect(() => observe(f, record, { attemptedAt, state: "merged" })).toThrow(
        /future-dated/,
      );
      expect(f.store.prMaintenance.get(record.id)).toEqual(record);
      expect(record.ownershipReleasedAt).toBeUndefined();
    },
  );

  it.each(["headSha", "snapshotId"] as const)(
    "does not admit readiness or mutations from inconsistent restored %s evidence",
    (field) => {
      const f = setup();
      const record = observe(
        f,
        f.store.prMaintenance.enableFromOperator(f.input, "operator"),
        {
          sources: [],
          checksComplete: true,
          reviewsComplete: true,
          mergeability: "mergeable",
        },
      );
      const backup = f.store.exportHostBackup({ enrollmentToken: "" });
      backup.prMaintenance!.registrations[0]!.lastAttempt![field] = otherSha;
      const restored = storeAt();
      restored.replaceHostBackup(backup);
      const imported = restored.prMaintenance.get(record.id)!;
      const resumed = restored.prMaintenance.operatorAction(
        imported.id,
        imported.version,
        { action: "resume" },
        "operator",
      );
      expect(() =>
        restored.prMaintenance.checkpoint(f.lead.id, resumed.id, resumed.version, {
          kind: "ready",
          fingerprint: "fingerprint-1",
          evidence: "Historical success is not current readiness.",
        }),
      ).toThrow(/Readiness/);
      expect(() => prepare({ ...f, store: restored }, resumed)).toThrow(/complete/);
      expect(() =>
        restored.prMaintenance.checkpoint(f.lead.id, resumed.id, resumed.version, {
          kind: "action",
          effect: {
            key: "notice",
            kind: "notification",
            state: "reserved",
            headSha: sha,
            actor: "lead",
            actionIdentity: "notify-ready",
          },
        }),
      ).toThrow(/current-HEAD/);
    },
  );

  it("bounds resolved history and preserves a monotonic incident cursor", () => {
    const f = setup();
    let record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    for (let i = 0; i < 24; i++) {
      vi.setSystemTime(Date.parse(at) + i);
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "fallback",
        error: `Exact failure ${i}\n`,
        observation: {
          attemptedAt: new Date().toISOString(),
          complete: false,
          failure: "incomplete",
          evidence: "Helper unavailable.",
        },
      });
      record = observe(f, record, { attemptedAt: new Date().toISOString() });
    }
    expect(record.incidents).toHaveLength(PR_MAINTENANCE_RECOVERY_LIMITS.incidents);
    expect(record.incidentCursor).toBe(24);
    expect(record.incidents[0]?.sequence).toBe(5);
    expect(record.incidents.at(-1)?.error).toBe("Exact failure 23\n");
    expect(record.lastError).toBe("Exact failure 23\n");
  });

  it.each([{ draft: true }, { mergeability: "conflicting" }])(
    "blocks repair/publication/readiness for %j",
    (gate) => {
      const f = setup();
      let record = observe(
        f,
        f.store.prMaintenance.enableFromOperator(f.input, "operator"),
      );
      record = prepare(f, record);
      record = accept(f, record);
      record = observe(f, record, gate);
      expect(
        f.store.prMaintenance.admission({
          action: "publish",
          recordId: record.id,
          generation: record.generation,
          batchId: "batch-1",
        }).allowed,
      ).toBe(false);
      expect(() =>
        f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
          kind: "ready",
          fingerprint: "fingerprint-1",
          evidence: "No gate bypass.",
        }),
      ).toThrow(/Readiness/);
      expect(prMaintenanceProgress(record).stage).toBe("blocked");
      const other = setup(f.store);
      const gated = observe(
        other,
        other.store.prMaintenance.enableFromOperator(
          {
            ...other.input,
            identity: {
              ...other.input.identity,
              prNumber: 2,
              headRef: "refs/heads/other",
            },
          },
          "operator",
        ),
        gate,
      );
      expect(() => prepare(other, gated)).toThrow(/Drafts, merge conflicts/);
    },
  );

  it("counts executed settled batches, not reservations or cancelled-before-dispatch attempts", () => {
    const f = setup();
    let record = prepare(
      f,
      observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
    );
    expect(prMaintenanceProgress(record).completedIterations).toBe(0);
    record = accept(f, record);
    f.store.updateRunStep(f.step.id, { state: "succeeded", dispatchedAt: at });
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      result(record),
    );
    expect(prMaintenanceProgress(record).completedIterations).toBe(0);
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      result(record, "succeeded"),
    );
    expect(prMaintenanceProgress(record).completedIterations).toBe(1);
    record = observe(f, record, { headSha: otherSha, fingerprint: "next-head" });
    record = accept(f, prepare(f, record, "batch-2", "repair", otherSha), "batch-2");
    f.store.updateRunStep(f.step.id, { state: "cancelled", dispatchedAt: "" });
    const cancelled = result(record);
    if (cancelled.kind !== "batch") throw new Error("fixture");
    cancelled.findings = [
      {
        source,
        outcome: "incomplete",
        stage: "not_attempted",
        evidence: [],
        responseRequired: true,
        responseIds: [],
        progress: false,
      },
    ];
    cancelled.effects = [];
    cancelled.published = false;
    cancelled.usedMutations = 0;
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      cancelled,
    );
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      ...cancelled,
      state: "cancelled",
    });
    expect(record.batches[1]?.executionNotDispatched).toBe(true);
    expect(prMaintenanceProgress(record).completedIterations).toBe(1);
  });
});

describe("durable PR maintenance registry", () => {
  it.each(v1Conflicts.cases)(
    "opens authentic v1 $conflict/$state conflicts without losing claims or blocking unrelated work",
    (fixture) => {
      const path = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
      mkdirSync(path, { recursive: true });
      paths.push(path);
      const dbPath = join(path, "host.sqlite");
      const f = setup(storeAt(dbPath));
      let first = f.store.prMaintenance.enableFromOperator(f.input, "operator");
      first = f.store.prMaintenance.operatorAction(
        first.id,
        first.version,
        {
          action: "release",
          reason: "Settled",
        },
        "operator",
      );
      const second = f.store.prMaintenance.enableFromOperator(f.input, "operator");
      const backup = f.store.exportHostBackup({ enrollmentToken: "" });
      // Preserve the captured session/key identity while relocating the surrounding fixture.
      f.store.replaceHostBackup(
        HostBackupSchema.parse(
          JSON.parse(JSON.stringify(backup).replaceAll(f.worker.id, fixture.workerId)),
        ),
      );
      f.store.setSessionDispatchAttempt(fixture.workerId, {
        commandId: fixture.second.id,
        eventSeqFrom: fixture.second.eventSeqFrom,
        attempt: `manual:${fixture.second.id}`,
      });
      const legacyRecords = f.store.prMaintenance.exportBackup().registrations;
      for (const [recordId, command] of [
        [first.id, fixture.first],
        [second.id, fixture.second],
      ] as const) {
        const record = legacyRecords.find((entry) => entry.id === recordId)!;
        record.manualControl = {
          operatorId: command.operatorId,
          takenAt: command.createdAt,
          commands: [PrMaintenanceManualCommandSchema.parse(command)],
        };
      }
      f.store.close();
      stores.splice(stores.indexOf(f.store), 1);
      const db = new DatabaseSync(dbPath);
      db.exec(
        "DROP TABLE pr_maintenance_manual_commands; UPDATE pr_maintenance_schema SET version=1;",
      );
      for (const record of legacyRecords)
        db.prepare("UPDATE pr_maintenance SET data=? WHERE id=?").run(
          JSON.stringify(record),
          record.id,
        );
      db.close();
      const reopened = storeAt(dbPath);
      expect(reopened.prMaintenance.get(first.id)?.manualControl?.commands).toEqual([
        fixture.first,
      ]);
      expect(reopened.prMaintenance.get(second.id)?.manualControl?.commands).toEqual([
        fixture.second,
      ]);
      const service = new FleetService(reopened, Fastify().log);
      expect(() =>
        service.promptSession(
          fixture.workerId,
          {
            prompt: "Explain",
            attachments: [],
            operationId: fixture.operationId,
          },
          "actor-a",
        ),
      ).toThrow(/ambiguous|quarantined/);
      expect(reopened.getSessionDispatchAttempt(fixture.workerId)?.commandId).toBe(
        fixture.second.id,
      );
      const claims = reopened.prMaintenance.manualConflicts(
        fixture.workerId,
        fixture.first.id,
      );
      expect(claims).toHaveLength(2);
      expect(claims).toEqual(expect.arrayContaining([fixture.first, fixture.second]));
      expect(
        reopened.prMaintenance.manualCommand(fixture.workerId, fixture.first.id),
      ).toBeUndefined();
      expect(
        reopened.prMaintenance.recordManualReceipt(
          fixture.workerId,
          fixture.first.id,
          "settled",
        ),
      ).toBe(false);
      expect(reopened.prMaintenance.hasPendingManualExecution(fixture.workerId)).toBe(
        fixture.state === "unknown",
      );
      if (fixture.state === "unknown") {
        expect(() =>
          reopened.prMaintenance.assertManualAvailable(fixture.workerId),
        ).toThrow(/receipts|uncertain/);
        expect(() =>
          reopened.prMaintenance.assertTaskCleanupAllowed(f.task.id),
        ).toThrow();
        expect(() => reopened.deletePlacement(f.placement.id)).toThrow(/retains/);
        expect(() => reopened.deleteRun(f.task.id)).toThrow(/receipts/);
      } else
        expect(() =>
          reopened.prMaintenance.assertManualAvailable(fixture.workerId),
        ).not.toThrow();
      const unrelated = setup(reopened);
      unrelated.input.identity = {
        ...unrelated.input.identity,
        prNumber: 2,
        headRef: "refs/heads/other",
      };
      reopened.prMaintenance.enableFromOperator(unrelated.input, "operator");
      const ordinary = new FleetService(reopened, Fastify().log);
      const sent: string[] = [];
      ordinary.attachNode(unrelated.node.id, {
        OPEN: 1,
        readyState: 1,
        send(raw) {
          sent.push(String(raw));
        },
        close() {},
      });
      expect(
        ordinary.promptSession(
          unrelated.worker.id,
          {
            prompt: "Explain",
            attachments: [],
            operationId: fixture.operationId,
          },
          "actor-a",
        ),
      ).toEqual({ ok: true });
      const delivered = reopened.getSessionDispatchAttempt(unrelated.worker.id)!;
      reopened.prMaintenance.recordManualReceipt(
        unrelated.worker.id,
        delivered.commandId,
        "settled",
      );
      expect(
        ordinary.promptSession(
          unrelated.worker.id,
          {
            prompt: "Explain",
            attachments: [],
            operationId: fixture.operationId,
          },
          "actor-a",
        ),
      ).toEqual({ ok: true });
      expect(sent).toHaveLength(1);
      expect(() =>
        ordinary.promptSession(
          unrelated.worker.id,
          {
            prompt: "Different",
            attachments: [],
            operationId: fixture.operationId,
          },
          "actor-a",
        ),
      ).toThrow(/different manual input/);
      expect(
        ordinary.promptSession(
          unrelated.worker.id,
          {
            prompt: "New intent",
            attachments: [],
            operationId: randomUUID(),
          },
          "actor-a",
        ),
      ).toEqual({ ok: true });
      expect(sent).toHaveLength(2);

      const portable = reopened.exportHostBackup({ enrollmentToken: "" });
      reopened.close();
      stores.splice(stores.indexOf(reopened), 1);
      const reopenedAgain = storeAt(dbPath);
      expect(
        reopenedAgain.prMaintenance.manualConflicts(fixture.workerId, fixture.first.id),
      ).toEqual(claims);
      const versionDb = new DatabaseSync(dbPath);
      expect(
        versionDb.prepare("SELECT version FROM pr_maintenance_schema").get()?.version,
      ).toBe(3);
      versionDb.close();
      const restored = storeAt();
      restored.replaceHostBackup(portable);
      expect(
        restored.prMaintenance.manualConflicts(fixture.workerId, fixture.first.id),
      ).toEqual(claims);
      expect(restored.prMaintenance.hasPendingManualExecution(fixture.workerId)).toBe(
        fixture.state === "unknown",
      );
      expect(() =>
        restored.prMaintenance.assertManualOperationUnambiguous(
          fixture.workerId,
          fixture.first.id,
        ),
      ).toThrow(/quarantined/);
      const legacyPortable = HostBackupSchema.parse({
        ...portable,
        prMaintenance: {
          ...portable.prMaintenance,
          registrations: legacyRecords,
          manualCommands: [],
          manualConflicts: [],
          manualOwners: [],
        },
      });
      restored.replaceHostBackup(legacyPortable);
      expect(
        restored.prMaintenance.manualConflicts(fixture.workerId, fixture.first.id),
      ).toEqual(claims);
      if (fixture.state === "settled") {
        restored.prMaintenance.beginManualControl(
          fixture.workerId,
          {
            id: "genuine-new-operation",
            digest: "new",
            kind: "prompt",
            operatorId: "actor-a",
          },
          10,
        );
        expect(restored.prMaintenance.hasPendingManualExecution(fixture.workerId)).toBe(
          true,
        );
      } else {
        expect(() =>
          restored.prMaintenance.beginManualControl(
            fixture.workerId,
            {
              id: "genuine-new-operation",
              digest: "new",
              kind: "prompt",
              operatorId: "actor-a",
            },
            10,
          ),
        ).toThrow(/receipts/);
      }
    },
  );

  it.each([false, true])(
    "retains orphaned indexed execution ownership across v2 migration and restore (accepted=%s)",
    (accepted) => {
      const path = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
      mkdirSync(path, { recursive: true });
      paths.push(path);
      const dbPath = join(path, "host.sqlite");
      const f = setup(storeAt(dbPath));
      const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
      f.store.prMaintenance.beginManualControl(
        f.worker.id,
        {
          id: "settled",
          digest: "settled",
          kind: "prompt",
          operatorId: "operator",
        },
        0,
      );
      f.store.prMaintenance.recordManualReceipt(f.worker.id, "settled", "settled");
      const settled = f.store.prMaintenance.get(record.id)!;
      f.store.prMaintenance.operatorAction(
        record.id,
        settled.version,
        {
          action: "release",
          reason: "Settled",
        },
        "operator",
      );
      f.store.prMaintenance.beginManualControl(
        f.worker.id,
        {
          id: "pending",
          digest: "pending",
          kind: "prompt",
          operatorId: "operator",
        },
        4,
      );
      if (accepted)
        f.store.prMaintenance.recordManualReceipt(f.worker.id, "pending", "accepted");
      const staleCleanup = new DatabaseSync(dbPath);
      staleCleanup
        .prepare(
          `INSERT INTO session_cleanup_requests
         (session_id,command_id,inactive_before,retention_days,requested_at,in_flight)
         VALUES (?,?,?,?,?,1)`,
        )
        .run(f.worker.id, "stale-cleanup", at, 30, at);
      staleCleanup.close();
      expect(() => f.store.completeSessionCleanup("stale-cleanup")).toThrow(/continuity/);
      expect(f.store.getSession(f.worker.id)).toBeDefined();
      expect(f.store.getRunStep(f.step.id)?.sessionId).toBe(f.worker.id);
      f.store.failSessionCleanup("stale-cleanup", at);
      f.store.close();
      stores.splice(stores.indexOf(f.store), 1);
      const db = new DatabaseSync(dbPath);
      // Emulate the reviewed v2 bulk-delete loss, leaving the indexed receipt and
      // released registration. Attribution must not depend on the deleted session.
      db.exec(
        "DROP TABLE pr_maintenance_manual_owners; UPDATE pr_maintenance_schema SET version=2;",
      );
      db.prepare("DELETE FROM sessions WHERE id=?").run(f.worker.id);
      db.close();
      const reopened = storeAt(dbPath);
      const assertHeld = (store: FleetStore) => {
        expect(store.getSession(f.worker.id)).toBeUndefined();
        expect(store.prMaintenance.hasPendingManualExecution(f.worker.id)).toBe(true);
        expect(() => store.deleteRun(f.task.id)).toThrow(/receipts/);
        expect(() => store.replaceRunSteps(f.task.id, [])).toThrow(/receipts/);
        expect(() => store.assertWorktreePurgeAllowed(f.task.id)).toThrow(/receipts/);
        expect(() => store.deletePlacement(f.placement.id)).toThrow(/retains.*checkout/);
        expect(() => store.deleteWorkspace(f.workspace.id)).toThrow(/retains.*checkout/);
        expect(() => store.deleteNode(f.node.id)).toThrow(/retains.*checkout/);
        expect(store.getRun(f.task.id)).toBeDefined();
        expect(store.getPlacement(f.placement.id)).toBeDefined();
      };
      assertHeld(reopened);
      const portable = reopened.exportHostBackup({ enrollmentToken: "" });
      const restored = storeAt();
      restored.replaceHostBackup(portable);
      assertHeld(restored);
      // Durable ownership survives independently of even the old registration.
      restored.replaceHostBackup(
        HostBackupSchema.parse({
          ...portable,
          prMaintenance: { ...portable.prMaintenance, registrations: [] },
        }),
      );
      assertHeld(restored);
      restored.prMaintenance.recordManualReceipt(f.worker.id, "pending", "settled");
      expect(() =>
        restored.prMaintenance.assertTaskCleanupAllowed(f.task.id),
      ).not.toThrow();
      expect(restored.deleteRun(f.task.id)).toBe(true);
    },
  );

  it("retains every conflicting claim when earlier same-input histories were coalesced", () => {
    const f = setup();
    const fixture = v1Conflicts.cases[1]!;
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const backup = f.store.prMaintenance.exportBackup();
    const unknown = {
      ...fixture.first,
      state: "unknown" as const,
      createdAt: "2026-09-22T05:25:43.844Z",
    };
    backup.manualCommands = [
      fixture.first,
      unknown,
      { ...fixture.second, state: "settled" },
    ].map((command) => ({
      sessionId: f.worker.id,
      command: PrMaintenanceManualCommandSchema.parse(command),
    }));
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
    expect(
      f.store.prMaintenance.manualConflicts(f.worker.id, fixture.first.id),
    ).toHaveLength(3);
    expect(f.store.prMaintenance.hasPendingManualExecution(f.worker.id)).toBe(true);
    expect(() =>
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        {
          action: "release",
          reason: "Cannot erase ambiguity",
        },
        "operator",
      ),
    ).toThrow(/receipt/);
    expect(f.store.prMaintenance.exportBackup().manualConflicts).toHaveLength(3);
  });

  it("preserves an explicit quarantine when portable evidence contains only one remaining claim", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const backup = f.store.prMaintenance.exportBackup();
    const command = PrMaintenanceManualCommandSchema.parse(v1Conflicts.cases[1]!.second);
    backup.manualConflicts = [{ sessionId: f.worker.id, command }];
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
    expect(() =>
      f.store.prMaintenance.assertManualOperationUnambiguous(f.worker.id, command.id),
    ).toThrow(/quarantined/);
    expect(f.store.prMaintenance.hasPendingManualExecution(f.worker.id)).toBe(true);
    expect(f.store.prMaintenance.get(record.id)).toBeDefined();
    expect(f.store.prMaintenance.exportBackup().manualConflicts).toEqual(
      backup.manualConflicts,
    );
  });

  it("migrates v1 inline receipts into durable bounded history without losing unknown or retry evidence", () => {
    const path = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
    mkdirSync(path, { recursive: true });
    paths.push(path);
    const dbPath = join(path, "host.sqlite");
    const f = setup(storeAt(dbPath));
    const record = f.store.prMaintenance.enableFromOperator(f.input, "original");
    const operationId = randomUUID();
    const input = { prompt: "Explain", attachments: [] };
    const command = {
      id: createHash("sha256")
        .update(JSON.stringify([f.worker.id, operationId]))
        .digest("hex"),
      digest: createHash("sha256")
        .update(JSON.stringify({ kind: "prompt", ...input }))
        .digest("hex"),
      kind: "prompt" as const,
      operatorId: "supervisor",
    };
    f.store.prMaintenance.beginManualControl(f.worker.id, command, 12);
    f.store.prMaintenance.recordManualReceipt(f.worker.id, command.id, "settled");
    f.store.prMaintenance.beginManualControl(
      f.worker.id,
      {
        ...command,
        id: "unknown-command",
        digest: "unknown-input",
      },
      20,
    );
    const legacy = f.store.prMaintenance.get(record.id)!;
    const [settled, unknown] = legacy.manualControl!.commands;
    legacy.manualControl!.commands = [
      settled!,
      ...Array.from({ length: 998 }, (_, index) => ({
        ...settled!,
        id: `historical-${index}`,
        digest: `input-${index}`,
        state: index === 0 ? ("rejected" as const) : ("settled" as const),
      })),
      unknown!,
    ];
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const db = new DatabaseSync(dbPath);
    db.exec(
      "DROP TABLE pr_maintenance_manual_commands; UPDATE pr_maintenance_schema SET version=1;",
    );
    db.prepare("UPDATE pr_maintenance SET data=? WHERE id=?").run(
      JSON.stringify(legacy),
      record.id,
    );
    db.close();

    const reopened = storeAt(dbPath);
    expect(reopened.prMaintenance.get(record.id)?.manualControl?.commands).toHaveLength(
      33,
    );
    expect(reopened.prMaintenance.exportBackup().manualCommands).toHaveLength(1_000);
    expect(reopened.prMaintenance.manualCommand(f.worker.id, command.id)).toEqual(
      settled,
    );
    expect(reopened.prMaintenance.manualCommand(f.worker.id, "historical-0")?.state).toBe(
      "rejected",
    );
    expect(reopened.prMaintenance.pendingManualCommands(f.worker.id)).toEqual([unknown]);
    expect(() => reopened.prMaintenance.assertManualAvailable(f.worker.id)).toThrow(
      /receipts/,
    );
    reopened.prMaintenance.recordManualReceipt(f.worker.id, unknown!.id, "accepted");
    expect(() => reopened.prMaintenance.assertManualAvailable(f.worker.id)).toThrow(
      /receipts/,
    );
    reopened.prMaintenance.recordManualReceipt(f.worker.id, unknown!.id, "settled");
    expect(reopened.prMaintenance.get(record.id)?.manualControl?.commands).toHaveLength(
      32,
    );
    const release = reopened.prMaintenance.get(record.id)!;
    reopened.prMaintenance.operatorAction(
      record.id,
      release.version,
      {
        action: "release",
        reason: "Settled",
      },
      "operator",
    );
    const portable = reopened.exportHostBackup({ enrollmentToken: "" });
    reopened.close();
    stores.splice(stores.indexOf(reopened), 1);

    const restarted = storeAt(dbPath);
    const service = new FleetService(restarted, Fastify().log);
    expect(
      service.promptSession(f.worker.id, { ...input, operationId }, "supervisor"),
    ).toEqual({ ok: true });
    expect(() =>
      service.promptSession(
        f.worker.id,
        {
          ...input,
          operationId,
          prompt: "Changed",
        },
        "supervisor",
      ),
    ).toThrow(/different manual input/);
    expect(() =>
      service.promptSession(
        f.worker.id,
        {
          ...input,
          operationId,
        },
        "other",
      ),
    ).toThrow(/different manual input/);
    expect(restarted.prMaintenance.exportBackup().manualCommands).toHaveLength(1_000);
    expect(restarted.prMaintenance.get(record.id)?.manualControl?.commands).toHaveLength(
      32,
    );
    const restored = storeAt();
    restored.replaceHostBackup(portable);
    expect(restored.prMaintenance.manualCommand(f.worker.id, command.id)).toEqual(
      settled,
    );
    expect(restored.prMaintenance.manualCommand(f.worker.id, unknown!.id)?.state).toBe(
      "settled",
    );
    expect(restored.prMaintenance.manualCommand(f.worker.id, "historical-0")?.state).toBe(
      "rejected",
    );
  });

  it("imports legacy portable inline history and keeps correlation after subsequent backup and restore", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const command = {
      id: "pending",
      digest: "input",
      kind: "resume_session" as const,
      operatorId: "operator",
    };
    f.store.prMaintenance.beginManualControl(f.worker.id, command, 7);
    const backup = f.store.exportHostBackup({ enrollmentToken: "" });
    const legacy = HostBackupSchema.parse({
      ...backup,
      prMaintenance: { ...backup.prMaintenance, manualCommands: undefined },
    });
    const restored = storeAt();
    restored.replaceHostBackup(legacy);
    expect(restored.prMaintenance.manualCommand(f.worker.id, command.id)).toMatchObject({
      ...command,
      state: "unknown",
      eventSeqFrom: 7,
    });
    restored.prMaintenance.recordManualReceipt(f.worker.id, command.id, "settled");
    const again = storeAt();
    again.replaceHostBackup(restored.exportHostBackup({ enrollmentToken: "" }));
    expect(again.prMaintenance.manualCommand(f.worker.id, command.id)?.state).toBe(
      "settled",
    );
    expect(again.prMaintenance.get(record.id)?.manualControl?.commands).toHaveLength(1);
  });

  it("normalizes pre-index Release/re-enable duplicates to the original receipt regardless of backup order", () => {
    const f = setup();
    const first = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const command = {
      id: "same-operation",
      digest: "input",
      kind: "prompt" as const,
      operatorId: "operator",
    };
    f.store.prMaintenance.beginManualControl(f.worker.id, command, 4);
    f.store.prMaintenance.recordManualReceipt(f.worker.id, command.id, "settled");
    const settled = f.store.prMaintenance.manualCommand(f.worker.id, command.id)!;
    const current = f.store.prMaintenance.get(first.id)!;
    f.store.prMaintenance.operatorAction(
      first.id,
      current.version,
      {
        action: "release",
        reason: "Settled",
      },
      "operator",
    );
    const second = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const backup = f.store.prMaintenance.exportBackup();
    const active = backup.registrations.find((record) => record.id === second.id)!;
    active.lifecycle = "paused";
    active.manualControl = {
      operatorId: "operator",
      takenAt: at,
      commands: [{ ...settled, state: "accepted", eventSeqFrom: 20 }],
    };
    backup.registrations = [
      active,
      backup.registrations.find((record) => record.id === first.id)!,
    ];
    backup.manualCommands = [];
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
    expect(f.store.prMaintenance.manualCommand(f.worker.id, command.id)).toEqual(settled);
    expect(f.store.prMaintenance.get(second.id)?.manualControl?.commands).toEqual([
      settled,
    ]);
    expect(() => f.store.prMaintenance.assertManualAvailable(f.worker.id)).not.toThrow();
    f.store.prMaintenance.beginManualControl(
      f.worker.id,
      { ...command, id: "fresh" },
      21,
    );
    expect(f.store.prMaintenance.pendingManualCommands(f.worker.id)).toMatchObject([
      { id: "fresh" },
    ]);
  });

  it("persists manual provenance and unknown receipts across database reopen without reviving maintenance", () => {
    const path = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
    mkdirSync(path, { recursive: true });
    paths.push(path);
    const db = join(path, "host.sqlite");
    const f = setup(storeAt(db));
    const record = restoreLegacy(f);
    const command = {
      id: randomUUID(),
      digest: "exact-input-digest",
      kind: "prompt" as const,
      operatorId: "supervisor",
    };
    f.store.writeAtomically(() => {
      f.store.prMaintenance.beginManualControl(f.worker.id, command, 12);
      f.store.setSessionDispatchAttempt(f.worker.id, {
        commandId: command.id,
        eventSeqFrom: 12,
        attempt: `manual:${command.id}`,
      });
    });
    const saved = f.store.prMaintenance.get(record.id)!;
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = storeAt(db);
    expect(reopened.prMaintenance.get(record.id)).toEqual(saved);
    expect(reopened.getSessionDispatchAttempt(f.worker.id)?.commandId).toBe(command.id);
    expect(
      reopened.prMaintenance.admission({ sessionId: f.worker.id, action: "execute" })
        .allowed,
    ).toBe(false);
    expect(() => reopened.prMaintenance.assertManualAvailable(f.worker.id)).toThrow(
      /receipts/,
    );
    reopened.prMaintenance.recordManualReceipt(f.worker.id, command.id, "settled");
    expect(() => reopened.prMaintenance.assertManualAvailable(f.worker.id)).not.toThrow();
    expect(reopened.prMaintenance.get(record.id)?.lifecycle).toBe("paused");
    const restored = storeAt();
    restored.replaceHostBackup(reopened.exportHostBackup({ enrollmentToken: "" }));
    expect(restored.prMaintenance.get(record.id)?.manualControl).toEqual(
      reopened.prMaintenance.get(record.id)?.manualControl,
    );
  });

  it("rolls back handoff, queued cancellation and provenance with the dispatch receipt transaction", () => {
    const f = setup();
    const record = accept(
      f,
      prepare(
        f,
        observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
      ),
    );
    const before = f.store.getRunStep(f.step.id);
    const commandId = randomUUID();
    expect(() =>
      f.store.writeAtomically(() => {
        f.store.prMaintenance.beginManualControl(
          f.worker.id,
          {
            id: commandId,
            digest: "input",
            kind: "prompt",
            operatorId: "supervisor",
          },
          0,
        );
        throw new Error("dispatch receipt write failed");
      }),
    ).toThrow(/dispatch receipt/);
    expect(f.store.prMaintenance.get(record.id)).toEqual(record);
    expect(f.store.getRunStep(f.step.id)).toEqual(before);
    expect(f.store.prMaintenance.manualCommand(f.worker.id, commandId)).toBeUndefined();
    expect(f.store.prMaintenance.hasManualHistory(f.worker.id)).toBe(false);
  });

  it("does not clear a manual receipt through maintenance renewal or release", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "original");
    f.store.prMaintenance.beginManualControl(
      f.worker.id,
      {
        id: randomUUID(),
        digest: "input",
        kind: "prompt",
        operatorId: "supervisor",
      },
      0,
    );
    const saved = f.store.prMaintenance.get(record.id)!;
    for (const action of [
      { action: "resume" as const },
      { action: "release" as const, reason: "Unknown cannot release" },
      { action: "renew" as const },
    ])
      expect(() =>
        f.store.prMaintenance.operatorAction(
          record.id,
          saved.version,
          action,
          "operator",
        ),
      ).toThrow(/manual command receipt/);
    expect(f.store.prMaintenance.get(record.id)).toEqual(saved);
  });

  it("requires explicit maintenance resume after manual completion and retains the deduplication history", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "original");
    const command = {
      id: randomUUID(),
      digest: "input",
      kind: "prompt" as const,
      operatorId: "supervisor",
    };
    f.store.prMaintenance.beginManualControl(f.worker.id, command, 0);
    f.store.prMaintenance.recordManualReceipt(f.worker.id, command.id, "settled");
    const saved = f.store.prMaintenance.get(record.id)!;
    expect(saved.lifecycle).toBe("paused");
    const resumed = f.store.prMaintenance.operatorAction(
      record.id,
      saved.version,
      { action: "resume" },
      "operator",
    );
    expect(resumed.lifecycle).toBe("active");
    expect(resumed.manualControl?.endedAt).toBeDefined();
    expect(resumed.manualControl?.commands).toEqual(saved.manualControl?.commands);
    expect(resumed.authorization).toEqual(record.authorization);
    expect(resumed.resumeHistory.at(-1)).toMatchObject({
      actor: "operator",
      actorId: "operator",
      pauseReason: "manual_control",
      pauseOrigin: { actor: "operator", actorId: "supervisor" },
    });
  });
  it.each(["omitted", "false"] as const)(
    "rejects new read-only %s authority instead of silently granting repairs",
    (permission) => {
      const f = setup();
      const input = {
        ...f.input,
        scope: {
          baseline: "Read-only verification; NO repair or publication.",
          verification: "Inspect provider metadata only.",
          ...(permission === "false" ? { publicationAuthorized: false } : {}),
        },
      };
      expect(() =>
        f.store.prMaintenance.propose(f.lead.id, PrMaintenanceEnableSchema.parse(input)),
      ).toThrow();
      expect(() =>
        f.store.prMaintenance.enableFromOperator(
          PrMaintenanceEnableSchema.parse(input),
          "operator",
        ),
      ).toThrow();
      expect(f.store.prMaintenance.list().records).toEqual([]);
      expect(f.store.prMaintenance.getProposal(f.task.id)).toBeUndefined();
    },
  );

  it("preserves legacy history without enrollment, scheduling, readiness or writes and requires pinned reauthorization", () => {
    const f = setup();
    let record = restoreLegacy(f);
    const originalAuthorization = record.authorization;
    expect(prMaintenanceProgress(record).stage).toBe("authorization_required");
    f.store.prMaintenance.beginWake(f.lead.id, "legacy");
    expect(f.store.prMaintenance.takeDue(f.lead.id, "legacy")).toBeUndefined();
    expect(f.store.prMaintenance.wakeEligibleLeadIds()).toEqual([]);
    for (const action of [
      { action: "resume" as const },
      { action: "renew" as const, scope: f.input.scope },
    ])
      expect(() =>
        f.store.prMaintenance.operatorAction(
          record.id,
          record.version,
          action,
          "operator",
        ),
      ).toThrow(/repair proposal/);
    for (const kind of ["repair", "answer"] as const)
      expect(() => prepare(f, record, `${kind}-forbidden`, kind)).toThrow(
        /Read-only maintenance/,
      );
    for (const action of ["dispatch", "execute", "prompt", "resume", "publish"] as const)
      expect(
        f.store.prMaintenance.admission({
          action,
          recordId: record.id,
          taskId: f.task.id,
          sessionId: f.worker.id,
        }),
      ).toMatchObject({ allowed: false });
    for (const kind of [
      "push",
      "reply",
      "resolve",
      "review_request",
      "ci_retry",
      "notification",
    ] as const)
      expect(() =>
        f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
          kind: "action",
          effect: {
            key: `${kind}-forbidden`,
            kind,
            state: "reserved",
            headSha: sha,
            actor: "lead",
            actionIdentity: `${kind}-forbidden`,
          },
        }),
      ).toThrow(/Read-only maintenance/);
    const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
    expect(proposal.reauthorization).toEqual({
      recordId: record.id,
      version: record.version,
      generation: record.generation,
    });
    record = f.store.prMaintenance.authorizeProposal(
      f.task.id,
      proposal.id,
      proposal.version,
      "new-operator",
    );
    expect(record.authorization.scope.publicationAuthorized).toBe(true);
    expect(record.authorizationHistory).toEqual([originalAuthorization]);
    expect(record.lifecycle).toBe("paused");
    expect(record.generation).toBe(1);
    expect(record.ownershipReleasedAt).toBeUndefined();
    expect(f.store.prMaintenance.list().records).toHaveLength(1);
    record = f.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      { action: "resume" },
      "new-operator",
    );
    expect(record.lifecycle).toBe("active");
  });

  it("cannot disguise a provider mutation as an internal notification under a read-only grant", () => {
    const f = setup();
    const record = restoreLegacy(f);
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect: {
          key: "notification-shaped-reply",
          kind: "notification",
          state: "reserved",
          headSha: sha,
          actor: "host",
          actionIdentity: "Post a comment on the provider",
        },
      }),
    ).toThrow(/Read-only maintenance/);
    expect(f.store.prMaintenance.get(record.id)?.actions).toEqual([]);
    expect(f.store.prMaintenance.get(record.id)?.counters.mutationAttempts).toBe(0);
    expect(() => prepare(f, record)).toThrow(/Read-only maintenance/);
  });

  it("reads legacy active records and pending proposals losslessly across restart and backup without upgrading authority", () => {
    const path = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
    mkdirSync(path, { recursive: true });
    paths.push(path);
    const dbPath = join(path, "host.sqlite");
    const f = setup(storeAt(dbPath));
    const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
    const record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "legacy-operator"),
    );
    const legacy = structuredClone(record);
    Object.assign(legacy.authorization.scope, {
      publicationAuthorized: false,
      replies: false,
      resolveThreads: false,
    });
    Object.assign(proposal.registration.scope, {
      publicationAuthorized: false,
      replies: false,
      resolveThreads: false,
    });
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE pr_maintenance SET data=? WHERE id=?").run(
      JSON.stringify(legacy),
      record.id,
    );
    db.prepare("INSERT INTO pr_maintenance_proposals(task_id,data) VALUES (?,?)").run(
      f.task.id,
      JSON.stringify(proposal),
    );
    db.close();
    const reopened = storeAt(dbPath);
    expect(reopened.prMaintenance.get(record.id)).toEqual(legacy);
    expect(reopened.prMaintenance.getProposal(f.task.id)).toEqual(proposal);
    expect(reopened.prMaintenance.listApprovals()).toEqual([]);
    expect(prMaintenanceProgress(reopened.prMaintenance.get(record.id)!).stage).toBe(
      "authorization_required",
    );
    expect(reopened.prMaintenance.wakeEligibleLeadIds()).toEqual([]);
    reopened.prMaintenance.beginWake(f.lead.id, "legacy-active");
    expect(reopened.prMaintenance.takeDue(f.lead.id, "legacy-active")).toBeUndefined();
    expect(() =>
      reopened.prMaintenance.authorizeProposal(
        f.task.id,
        proposal.id,
        proposal.version,
        "operator",
      ),
    ).toThrow(/Observation-only/);
    expect(() =>
      reopened.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "ready",
        fingerprint: "fingerprint-1",
        evidence: "Legacy cannot be ready",
      }),
    ).toThrow();
    const restored = storeAt();
    restored.replaceHostBackup(reopened.exportHostBackup({ enrollmentToken: "" }));
    expect(restored.prMaintenance.get(record.id)?.authorization).toEqual(
      legacy.authorization,
    );
    expect(restored.prMaintenance.get(record.id)?.lastAttempt).toEqual(
      legacy.lastAttempt,
    );
    expect(restored.prMaintenance.getProposal(f.task.id)).toEqual(proposal);
    expect(restored.prMaintenance.listApprovals()).toEqual([]);
    expect(restored.prMaintenance.get(record.id)?.lifecycle).toBe("paused");
    expect(restored.prMaintenance.wakeEligibleLeadIds()).toEqual([]);
    expect(reopened.prMaintenance.get(record.id)).toEqual(legacy);
    expect(() =>
      restored.prMaintenance.propose(f.lead.id, f.input, proposal.version),
    ).toThrow(/Settle existing work/);
    reopened.prMaintenance.propose(f.lead.id, f.input, proposal.version);
    const archived = reopened
      .listRunNotes(f.task.id)
      .find((note) => note.summary?.startsWith("Superseded legacy"));
    expect(archived).toBeDefined();
    expect(JSON.parse(archived!.body)).toEqual(proposal);
  });

  it.each(["terminal", "decision", "manual", "stale"] as const)(
    "does not use repair reauthorization to bypass a legacy %s fence",
    (fence) => {
      const f = setup();
      let record = restoreLegacy(f);
      if (fence === "terminal") {
        const backup = f.store.prMaintenance.exportBackup();
        backup.registrations[0]!.lifecycle = "closed";
        f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
        record = f.store.prMaintenance.get(record.id)!;
      }
      if (fence === "decision")
        record = f.store.prMaintenance.holdForDecision(
          f.lead.id,
          record.id,
          record.version,
          {
            id: "legacy-decision",
            version: 1,
            proposal: "Change contract?",
            scope: "Design",
            headSha: sha,
          },
          () => f.store.updateRun(f.task.id, { state: "awaiting_human" }),
        );
      if (fence === "manual")
        f.store.prMaintenance.beginManualControl(
          f.worker.id,
          {
            id: randomUUID(),
            digest: "legacy-input",
            kind: "prompt",
            operatorId: "human",
          },
          0,
        );
      if (fence === "stale") {
        const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
        record = f.store.prMaintenance.operatorAction(
          record.id,
          record.version,
          { action: "pause", reason: "Changed since review" },
          "human",
        );
        expect(() =>
          f.store.prMaintenance.authorizeProposal(
            f.task.id,
            proposal.id,
            proposal.version,
            "human",
          ),
        ).toThrow(/changed/);
      } else expect(() => f.store.prMaintenance.propose(f.lead.id, f.input)).toThrow();
      expect(
        f.store.prMaintenance.get(record.id)?.authorization.scope.publicationAuthorized,
      ).toBe(false);
      expect(f.store.prMaintenance.get(record.id)?.ownershipReleasedAt).toBeUndefined();
    },
  );

  it("does not let API or advanced proposals upgrade an original read-only worker category", () => {
    const f = setup();
    f.store.upsertRunStep(f.task.id, {
      stepKey: f.step.stepKey,
      title: "Review only",
      prompt: "No writes",
      category: "review",
    });
    f.store.updateRunStep(f.step.id, { sessionId: f.worker.id, state: "succeeded" });
    expect(() => f.store.prMaintenance.propose(f.lead.id, f.input)).toThrow(
      /read-only categories/,
    );
    expect(() => f.store.prMaintenance.enableFromOperator(f.input, "operator")).toThrow(
      /read-only categories/,
    );
    expect(f.store.prMaintenance.list().records).toEqual([]);
  });

  it.each([
    { replies: true },
    { resolveThreads: true },
    { reviewers: ["reviewer"] },
    { retryChecks: true },
  ])("rejects a read-only proposal or grant with provider flags %j", (flags) => {
    const f = setup();
    const input = {
      ...f.input,
      scope: {
        baseline: "Observation only.",
        verification: "Read evidence.",
        publicationAuthorized: false,
        ...flags,
      },
    };
    expect(() => f.store.prMaintenance.propose(f.lead.id, input)).toThrow(
      /Observation-only maintenance/,
    );
    expect(() => f.store.prMaintenance.enableFromOperator(input, "operator")).toThrow(
      /Observation-only maintenance/,
    );
    expect(f.store.prMaintenance.getProposal(f.task.id)).toBeUndefined();
    expect(f.store.prMaintenance.list().records).toEqual([]);
  });

  it("authorizes and restores ADO proposals and records alongside legacy GitHub without minting authority", () => {
    const f = setup();
    const github = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const ado = setup(f.store);
    ado.input.identity = adoIdentity;
    const pending = f.store.prMaintenance.propose(ado.lead.id, ado.input);
    const pendingRestore = storeAt();
    pendingRestore.replaceHostBackup(f.store.exportHostBackup({ enrollmentToken: "" }));
    expect(pendingRestore.prMaintenance.getProposal(ado.task.id)).toEqual(pending);
    expect(pendingRestore.prMaintenance.get(github.id)?.identity).toEqual(
      github.identity,
    );
    expect(pendingRestore.prMaintenance.list().records).toHaveLength(1);
    const record = f.store.prMaintenance.authorizeProposal(
      ado.task.id,
      pending.id,
      pending.version,
      "operator",
    );
    expect(record.identity).toEqual(adoIdentity);
    expect(record.authorization.operatorId).toBe("operator");
    const restored = storeAt();
    restored.replaceHostBackup(f.store.exportHostBackup({ enrollmentToken: "" }));
    expect(restored.prMaintenance.get(record.id)).toMatchObject({
      identity: adoIdentity,
      lifecycle: "paused",
      generation: 1,
    });
    expect(restored.prMaintenance.list().records).toHaveLength(2);
  });

  it("scopes ADO PR and head-ref ownership by organization while preserving retained-ref protection", () => {
    const f = setup();
    f.input.identity = adoIdentity;
    f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const duplicate = setup(f.store);
    duplicate.input.identity = adoIdentity;
    expect(() =>
      f.store.prMaintenance.enableFromOperator(duplicate.input, "operator"),
    ).toThrow(/owns this PR/);
    duplicate.input.identity = { ...adoIdentity, prNumber: 2 };
    expect(() =>
      f.store.prMaintenance.enableFromOperator(duplicate.input, "operator"),
    ).toThrow(/already reserved/);
    duplicate.input.identity = { ...adoIdentity, organization: "other-org" };
    expect(
      f.store.prMaintenance.enableFromOperator(duplicate.input, "operator").generation,
    ).toBe(1);
    const github = setup(f.store);
    github.input.identity = { ...identity, repositoryId: adoIdentity.repositoryId };
    expect(
      f.store.prMaintenance.enableFromOperator(github.input, "operator").generation,
    ).toBe(1);
  });

  it("treats explicit GitHub as legacy GitHub and pauses an ADO identity change", () => {
    const f = setup();
    let record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    expect(
      f.store.prMaintenance.enableFromOperator(
        {
          ...f.input,
          identity: { ...f.input.identity, provider: "github" },
        },
        "operator",
      ).id,
    ).toBe(record.id);
    record = observe(f, record, { identity: { ...record.identity, provider: "github" } });
    expect(record.lifecycle).toBe("active");
    const ado = setup(f.store);
    ado.input.identity = adoIdentity;
    const registered = f.store.prMaintenance.enableFromOperator(ado.input, "operator");
    expect(
      observe(ado, registered, {
        identity: { ...adoIdentity, organization: "other-org" },
      }).pauseReason,
    ).toBe("remote_identity_changed");
  });

  it.each(["merged", "closed"] as const)(
    "settles verified ADO %s without reopening old work",
    (state) => {
      const f = setup();
      f.input.identity = adoIdentity;
      const record = observe(
        f,
        f.store.prMaintenance.enableFromOperator(f.input, "operator"),
        { state },
      );
      expect(record.lifecycle).toBe(state);
      expect(record.ownershipReleasedAt).toBeDefined();
    },
  );

  it("requires complete ADO policy evidence before ready, retaining the existing whole-PR human gate", () => {
    const f = setup();
    f.input.identity = adoIdentity;
    let record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "operator"),
      {
        sources: [],
        checksComplete: false,
        reviewsComplete: true,
        mergeability: "mergeable",
      },
    );
    const ready = {
      kind: "ready" as const,
      fingerprint: "fingerprint-1",
      evidence: "Policy evidence checked.",
    };
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, ready),
    ).toThrow(/Readiness requires/);
    record = observe(f, record, {
      sources: [],
      checksComplete: true,
      reviewsComplete: true,
      mergeability: "mergeable",
    });
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      ready,
    );
    expect(record.readyFingerprint).toBe("fingerprint-1");
    record = f.store.prMaintenance.holdForDecision(
      f.lead.id,
      record.id,
      record.version,
      {
        id: "design",
        version: 1,
        proposal: "Change the API?",
        headSha: sha,
        scope: "Contract change",
      },
      () => {
        f.store.advanceRunToReview(f.task.id);
      },
    );
    expect(record.decision?.state).toBe("pending");
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, ready),
    ).toThrow();
  });

  it("admits bounded ADO feedback repair with unknown policy readiness, never incomplete collection", () => {
    const f = setup();
    f.input.identity = adoIdentity;
    let record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "operator"),
      {
        checksComplete: false,
        reviewsComplete: false,
        checks: [
          {
            key: "build-policy",
            state: "unknown",
            headSha: sha,
            evidence: "Build approval is not current-HEAD proof.",
          },
        ],
        reviews: [
          {
            key: "review-policy",
            state: "required",
            headSha: sha,
            reviewer: "policy",
            revision: "v1",
            evidence: "Reviewer votes are not current-HEAD proof.",
          },
        ],
      },
    );
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "ready",
        fingerprint: "fingerprint-1",
        evidence: "Policy unknown.",
      }),
    ).toThrow(/Readiness requires/);
    record = prepare(f, record);
    expect(record.batches[0]).toMatchObject({ state: "prepared", sources: [source] });
    record = observe(f, record, {
      complete: false,
      failure: "incomplete",
      evidence: "Second-pass feedback changed.",
    });
    expect(
      f.store.prMaintenance.admission({
        action: "dispatch",
        taskId: f.task.id,
        sessionId: f.worker.id,
        recordId: record.id,
        generation: record.generation,
        batchId: record.batches[0]!.id,
        leadSessionId: f.lead.id,
      }),
    ).toMatchObject({ allowed: false, reason: "observation_incomplete" });
  });

  it.each(["checksComplete", "reviewsComplete"] as const)(
    "never lets passing nonempty obligations override %s=false for either provider",
    (flag) => {
      for (const providerIdentity of [identity, adoIdentity]) {
        const f = setup();
        f.input.identity = providerIdentity;
        const record = observe(
          f,
          f.store.prMaintenance.enableFromOperator(f.input, "operator"),
          {
            sources: [],
            mergeability: "mergeable",
            checksComplete: true,
            reviewsComplete: true,
            [flag]: false,
            checks: [
              {
                key: "visible-check",
                state: "passed",
                headSha: sha,
                evidence: "Visible check passed; other requirements unproven.",
              },
            ],
            reviews: [
              {
                key: "visible-review",
                state: "approved",
                headSha: sha,
                reviewer: "reviewer",
                revision: "v1",
                evidence: "Visible review approved; other requirements unproven.",
              },
            ],
          },
        );
        expect(() =>
          f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
            kind: "ready",
            fingerprint: "fingerprint-1",
            evidence: "Partial policy evidence.",
          }),
        ).toThrow(/Readiness requires/);
      }
    },
  );

  it.each(["direct", "proposal"] as const)(
    "preserves proposal and grant evidence through %s enable, renewal, reenrollment and restart",
    (mode) => {
      const path = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
      mkdirSync(path, { recursive: true });
      paths.push(path);
      const dbPath = join(path, "host.sqlite");
      const f = setup(storeAt(dbPath));
      const legacy = f.store.prMaintenance.propose(f.lead.id, {
        ...f.input,
        eligibilityEvidence: "pending-legacy-prerequisites",
      });
      Object.assign(legacy.registration.scope, {
        publicationAuthorized: false,
        replies: false,
        resolveThreads: false,
      });
      const backup = f.store.prMaintenance.exportBackup();
      backup.proposals = [legacy];
      f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
      const input = {
        ...f.input,
        headSha: otherSha,
        eligibilityEvidence: "approved-repair-metadata-and-publication",
      };
      const proposal =
        mode === "proposal"
          ? f.store.prMaintenance.propose(f.lead.id, input, legacy.version)
          : undefined;
      let record = proposal
        ? f.store.prMaintenance.authorizeProposal(
            f.task.id,
            proposal.id,
            proposal.version,
            "operator",
          )
        : f.store.prMaintenance.enableFromOperator(input, "operator");
      expect(record.authorization.eligibilityEvidence).toBe(input.eligibilityEvidence);
      expect(record.authorization.sourceProposal).toEqual(
        proposal ? { id: proposal.id, version: proposal.version } : undefined,
      );
      const notes = f.store.listRunNotes(f.task.id);
      expect(notes.filter((note) => note.body === JSON.stringify(legacy))).toHaveLength(
        1,
      );
      if (proposal)
        expect(
          notes.filter((note) => note.body === JSON.stringify(proposal)),
        ).toHaveLength(1);
      expect(f.store.prMaintenance.enableFromOperator(input, "operator")).toEqual(record);
      for (const drift of [
        { headSha: sha },
        { eligibilityEvidence: "different-approval" },
      ])
        expect(() =>
          f.store.prMaintenance.enableFromOperator({ ...input, ...drift }, "operator"),
        ).toThrow(/cannot adopt, rebind or renew/);
      expect(f.store.listRunNotes(f.task.id)).toEqual(notes);
      const original = record.authorization;
      record = f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "renew" },
        "renewing-operator",
      );
      expect(record.authorizationHistory).toEqual([original]);
      expect(record.authorization.eligibilityEvidence).toBe(input.eligibilityEvidence);
      expect(record.authorization.sourceProposal).toEqual(original.sourceProposal);
      record = f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "release", reason: "Explicit release" },
        "operator",
      );
      const next = f.store.prMaintenance.enableFromOperator(
        {
          ...input,
          eligibilityEvidence: "next-generation-prerequisites",
        },
        "next-operator",
      );
      expect(next.id).not.toBe(record.id);
      expect(next.generation).toBe(record.generation + 1);
      expect(next.authorizationHistory).toEqual([]);
      expect(next.authorization.sourceProposal).toBeUndefined();
      const exported = f.store.exportHostBackup({ enrollmentToken: "" });
      f.store.close();
      stores.splice(stores.indexOf(f.store), 1);
      const reopened = storeAt(dbPath);
      const restored = storeAt();
      restored.replaceHostBackup(exported);
      for (const db of [reopened, restored]) {
        expect(db.prMaintenance.get(record.id)).toEqual(record);
        expect(db.prMaintenance.get(next.id)).toMatchObject({
          generation: next.generation,
          identity: next.identity,
          eligibilityEvidence: "next-generation-prerequisites",
          authorization: next.authorization,
        });
        expect(db.listRunNotes(f.task.id)).toEqual(notes);
        expect(JSON.stringify(db.exportHostBackup({ enrollmentToken: "" }))).toContain(
          "pending-legacy-prerequisites",
        );
      }
      expect(restored.prMaintenance.get(next.id)?.lifecycle).toBe("paused");
    },
  );

  it.each(["propose", "enable", "authorize", "reauthorize"] as const)(
    "rolls back %s evidence consumption atomically and archives once on retry",
    (path) => {
      const f = setup();
      if (path === "reauthorize") restoreLegacy(f);
      const proposal = f.store.prMaintenance.propose(f.lead.id, {
        ...f.input,
        eligibilityEvidence: "atomic-proposal-evidence",
      });
      const before = f.store.prMaintenance.exportBackup();
      const notes = f.store.listRunNotes(f.task.id);
      const action = () =>
        path === "propose"
          ? f.store.prMaintenance.propose(f.lead.id, f.input, proposal.version)
          : path === "enable"
            ? f.store.prMaintenance.enableFromOperator(f.input, "operator")
            : f.store.prMaintenance.authorizeProposal(
                f.task.id,
                proposal.id,
                proposal.version,
                "operator",
              );
      const append = f.store.appendRunNote.bind(f.store);
      const fault = vi
        .spyOn(f.store, "appendRunNote")
        .mockImplementationOnce((...args) => {
          append(...args);
          throw new Error("synthetic archive persistence failure");
        });
      expect(action).toThrow(/archive persistence failure/);
      expect(f.store.prMaintenance.exportBackup()).toEqual(before);
      expect(f.store.listRunNotes(f.task.id)).toEqual(notes);
      fault.mockRestore();
      action();
      expect(
        f.store
          .listRunNotes(f.task.id)
          .filter((note) => note.body === JSON.stringify(proposal)),
      ).toHaveLength(1);
      if (path === "propose" || path === "enable") action();
      else expect(action).toThrow(/already handled/);
      if (path === "enable")
        expect(
          f.store.prMaintenance.list().records[0]!.authorization.sourceProposal,
        ).toBeUndefined();
      expect(
        f.store
          .listRunNotes(f.task.id)
          .filter((note) => note.body === JSON.stringify(proposal)),
      ).toHaveLength(1);
    },
  );

  it.each([
    "owner",
    "head",
    "generation",
    "actor",
    "manual",
    "decision",
    "restore",
    "evidence",
  ] as const)(
    "retains reauthorization evidence without approval after %s drift",
    (drift) => {
      const f = setup();
      const record = restoreLegacy(f);
      const proposal = f.store.prMaintenance.propose(f.lead.id, {
        ...f.input,
        eligibilityEvidence: "unapproved-new-basis",
      });
      if (drift === "owner") {
        const lead = f.store.createSession(f.placement, "New owner", false, "", {
          runRole: "lead",
        });
        f.store.updateRun(f.task.id, { leadSessionId: lead.id });
      } else if (drift === "head") {
        observe(f, record, { headSha: otherSha });
      } else if (drift === "generation") {
        const backup = f.store.prMaintenance.exportBackup();
        backup.registrations[0]!.generation++;
        f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
      } else if (drift === "manual") {
        f.store.prMaintenance.beginManualControl(
          f.worker.id,
          {
            id: randomUUID(),
            digest: "unknown-manual",
            kind: "prompt",
            operatorId: "human",
          },
          0,
        );
      } else if (drift === "decision") {
        f.store.prMaintenance.holdForDecision(
          f.lead.id,
          record.id,
          record.version,
          {
            id: "design-hold",
            version: 1,
            proposal: "Change contract?",
            headSha: sha,
            scope: "Design",
          },
          () => f.store.updateRun(f.task.id, { state: "awaiting_human" }),
        );
      } else if (drift === "restore") {
        f.store.replaceHostBackup(f.store.exportHostBackup({ enrollmentToken: "" }));
      } else if (drift === "evidence") {
        const backup = f.store.prMaintenance.exportBackup();
        backup.registrations[0]!.eligibilityEvidence = "conflicting-record-evidence";
        f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
      }
      const before = f.store.prMaintenance.exportBackup();
      const notes = f.store.listRunNotes(f.task.id);
      expect(() =>
        f.store.prMaintenance.authorizeProposal(
          f.task.id,
          proposal.id,
          proposal.version,
          drift === "actor" ? "" : "operator",
        ),
      ).toThrow();
      expect(f.store.prMaintenance.exportBackup()).toEqual(before);
      expect(f.store.listRunNotes(f.task.id)).toEqual(notes);
      expect(
        f.store.prMaintenance.get(record.id)?.authorization.scope.publicationAuthorized,
      ).toBe(false);
      expect(f.store.prMaintenance.getProposal(f.task.id)).toEqual(proposal);
    },
  );

  it("keeps bounded grant history restorable and refuses count or byte overflow without losing evidence", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(
      {
        ...f.input,
        eligibilityEvidence: "x".repeat(8192),
      },
      "operator",
    );
    const backup = f.store.prMaintenance.exportBackup();
    backup.registrations[0]!.authorizationHistory = Array.from(
      { length: 100 },
      (_, index) => ({
        ...record.authorization,
        id: `history-${index}`,
      }),
    );
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
    const before = f.store.prMaintenance.get(record.id)!;
    expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThan(2 * 1024 * 1024);
    const restored = storeAt();
    restored.replaceHostBackup(f.store.exportHostBackup({ enrollmentToken: "" }));
    expect(restored.prMaintenance.get(record.id)?.authorizationHistory).toEqual(
      before.authorizationHistory,
    );
    expect(() =>
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "renew" },
        "operator",
      ),
    ).toThrow();
    const oversized = f.store.prMaintenance.exportBackup();
    for (const grant of oversized.registrations[0]!.authorizationHistory) {
      grant.scope.baseline = "y".repeat(8192);
      grant.scope.verification = "z".repeat(8192);
    }
    expect(() =>
      f.store.writeAtomically(() => f.store.prMaintenance.importBackup(oversized)),
    ).toThrow(/2 MiB/);
    expect(f.store.prMaintenance.get(record.id)).toEqual(before);
  });

  it("refuses reauthorization history overflow without consuming its approved proposal", () => {
    const f = setup();
    const record = restoreLegacy(f);
    const backup = f.store.prMaintenance.exportBackup();
    backup.registrations[0]!.authorizationHistory = Array.from(
      { length: 100 },
      (_, index) => ({
        ...record.authorization,
        id: `prior-grant-${index}`,
      }),
    );
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
    const proposal = f.store.prMaintenance.propose(f.lead.id, {
      ...f.input,
      eligibilityEvidence: "overflow-must-preserve-new-proposal",
    });
    const before = f.store.prMaintenance.exportBackup();
    const notes = f.store.listRunNotes(f.task.id);
    expect(() =>
      f.store.prMaintenance.authorizeProposal(
        f.task.id,
        proposal.id,
        proposal.version,
        "operator",
      ),
    ).toThrow();
    expect(f.store.prMaintenance.exportBackup()).toEqual(before);
    expect(f.store.listRunNotes(f.task.id)).toEqual(notes);
  });

  it("does not attribute already-lost historical repair prerequisites to a later grant", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const backup = f.store.prMaintenance.exportBackup();
    const imported = backup.registrations[0]!;
    delete imported.authorization.eligibilityEvidence;
    imported.authorizationHistory = [
      {
        ...imported.authorization,
        id: "older-observation-grant",
        scope: {
          ...imported.authorization.scope,
          publicationAuthorized: false,
          replies: false,
          resolveThreads: false,
        },
      },
    ];
    imported.eligibilityEvidence = "historical-text-not-proof-of-later-repair";
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
    const renewed = f.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      { action: "renew" },
      "operator",
    );
    expect(renewed.eligibilityEvidence).toBe(imported.eligibilityEvidence);
    expect(renewed.authorization.eligibilityEvidence).toBeUndefined();
    expect(renewed.authorization.sourceProposal).toBeUndefined();
    expect(
      renewed.authorizationHistory.every(
        (grant) => grant.eligibilityEvidence === undefined,
      ),
    ).toBe(true);
  });

  it("preserves pending proposals in backups without restoring authorization", () => {
    const f = setup();
    const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
    const backup = f.store.exportHostBackup({ enrollmentToken: "fixture-enrollment" });
    const restored = storeAt();
    restored.replaceHostBackup(backup);
    expect(restored.prMaintenance.getProposal(f.task.id)).toEqual(proposal);
    expect(restored.prMaintenance.list().records).toHaveLength(0);
    const { proposals: _proposals, ...legacy } = backup.prMaintenance!;
    restored.replaceHostBackup(
      HostBackupSchema.parse({ ...backup, prMaintenance: legacy }),
    );
    expect(restored.prMaintenance.getProposal(f.task.id)).toBeUndefined();
  });

  it.each(["placement", "checkout", "generation"] as const)(
    "pins proposed %s binding and refuses stale approval until re-prepared",
    (change) => {
      const f = setup();
      const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
      expect(proposal.binding).toEqual({
        placementId: f.placement.id,
        checkoutKey: `placement:${f.placement.id}`,
        bindingGeneration: 0,
      });
      if (change === "placement") {
        f.store.appendEvent({
          eventId: "native-worker",
          sessionId: f.worker.id,
          sequence: 1,
          type: "agent_session",
          payload: { agentSessionId: "existing-conversation" },
          createdAt: at,
        });
        f.store.transitionSession(f.worker.id, "stopped");
        const { node } = f.store.registerNode({
          name: "second-checkout-node",
          os: "win32",
          arch: "x64",
          version: "0.1.0",
          capabilities: ["copilot-acp"],
          maxSessions: 20,
        });
        const placement = f.store.createPlacement(
          f.workspace.id,
          node.id,
          "C:\\repo\\changed",
        );
        f.store.adoptSession(placement, "existing-conversation", []);
      } else {
        f.store.setSessionExecutionBinding(f.worker.id, {
          worktreeId: "",
          generation: change === "generation" ? 1 : 0,
          sourcePlacementId: f.placement.id,
          cwd: "C:\\repo\\changed",
          checkoutKey:
            change === "checkout" ? "checkout:changed" : `placement:${f.placement.id}`,
          accessClass: "shell",
          leaseAttempt: "operator-resume",
          quarantined: false,
        });
      }
      expect(() =>
        f.store.prMaintenance.authorizeProposal(
          f.task.id,
          proposal.id,
          proposal.version,
          "operator",
        ),
      ).toThrow(/changed after preparation/);
      expect(f.store.prMaintenance.list().records).toEqual([]);
      expect(f.store.prMaintenance.getProposal(f.task.id)).toEqual(proposal);
      expect(() => f.store.prMaintenance.propose(f.lead.id, f.input)).toThrow(
        /current proposal/,
      );
      const fresh = f.store.prMaintenance.propose(f.lead.id, f.input, proposal.version);
      expect(fresh.version).toBe(proposal.version + 1);
      expect(fresh.binding).not.toEqual(proposal.binding);
      expect(() =>
        f.store.prMaintenance.authorizeProposal(
          f.task.id,
          fresh.id,
          proposal.version,
          "operator",
        ),
      ).toThrow(/changed/);
      const enabled = f.store.prMaintenance.authorizeProposal(
        f.task.id,
        fresh.id,
        fresh.version,
        "operator",
      );
      expect(enabled).toMatchObject(fresh.binding!);
      expect(enabled.authorization.operatorId).toBe("operator");
    },
  );

  it("requires legacy unpinned proposals to be re-prepared, never adopting current authority", () => {
    const f = setup();
    const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
    const legacy = f.store.prMaintenance.exportBackup();
    delete legacy.proposals[0]!.binding;
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(legacy));
    expect(f.store.prMaintenance.getProposal(f.task.id)?.binding).toBeUndefined();
    expect(() =>
      f.store.prMaintenance.authorizeProposal(
        f.task.id,
        proposal.id,
        proposal.version,
        "operator",
      ),
    ).toThrow(/legacy proposal/);
    expect(f.store.prMaintenance.list().records).toEqual([]);
    const fresh = f.store.prMaintenance.propose(f.lead.id, f.input, proposal.version);
    expect(fresh.binding).toEqual(proposal.binding);
    expect(fresh.version).toBe(proposal.version + 1);
    expect(
      f.store.prMaintenance.authorizeProposal(
        f.task.id,
        fresh.id,
        fresh.version,
        "operator",
      ).authorization.operatorId,
    ).toBe("operator");
  });

  it("fails closed on a restored terminal batch whose execution receipt is still unknown", () => {
    const f = setup();
    let record = publishedRepair(f);
    const backup = f.store.prMaintenance.exportBackup();
    backup.registrations[0]!.batches[0]!.executionSettled = false;
    f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
    const restored = f.store.prMaintenance.get(record.id)!;
    record = f.store.prMaintenance.operatorAction(
      restored.id,
      restored.version,
      { action: "resume" },
      "operator",
    );
    record = observe(f, record, {
      headSha: otherSha,
      sources: [],
      checksComplete: true,
      reviewsComplete: true,
      mergeability: "mergeable",
    });
    expect(prMaintenanceUnsettled(record)).toBe(true);
    expect(prMaintenanceProgress(record)).toEqual({
      stage: "reconciling",
      completedIterations: 0,
    });
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "ready",
        fingerprint: "fingerprint-1",
        evidence: "Cannot infer settlement.",
      }),
    ).toThrow(/Readiness/);
    expect(() => prepare(f, record, "not-another-attempt", "repair", otherSha)).toThrow(
      /Reconcile/,
    );
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect: {
          key: "notice",
          kind: "notification",
          state: "reserved",
          headSha: otherSha,
          actor: "lead",
          actionIdentity: "ready-notice",
        },
      }),
    ).toThrow(/held/);
    expect(() =>
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        {
          action: "release",
          reason: "Unknown execution is not settlement.",
        },
        "operator",
      ),
    ).toThrow(/Reconcile/);
    record = observe(f, record, { state: "closed" });
    expect(record.ownershipReleasedAt).toBeUndefined();
  });

  it("rechecks ownership and binding on proposal authorization, and never clears an existing grant", () => {
    const f = setup();
    const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
    const other = f.store.createSession(f.placement, "Other lead", false, "", {
      runRole: "lead",
    });
    f.store.updateRun(f.task.id, { leadSessionId: other.id });
    expect(() =>
      f.store.prMaintenance.authorizeProposal(
        f.task.id,
        proposal.id,
        proposal.version,
        "operator",
      ),
    ).toThrow(/owner changed/);
    expect(f.store.prMaintenance.list().records).toHaveLength(0);
    f.store.updateRun(f.task.id, { leadSessionId: f.lead.id });
    f.store.updateRunStep(f.step.id, { resultSha: sha });
    const record = f.store.prMaintenance.authorizeProposal(
      f.task.id,
      proposal.id,
      proposal.version,
      "operator",
    );
    expect(record.authorization.operatorId).toBe("operator");
    expect(record).toMatchObject({
      lifecycle: "paused",
      pauseReason: "sealed_managed_result",
    });
    expect(f.store.prMaintenance.getProposal(f.task.id)).toBeUndefined();
    expect(() => f.store.prMaintenance.propose(f.lead.id, f.input)).toThrow(
      /already retains/,
    );
    expect(f.store.prMaintenance.get(record.id)?.authorization).toEqual(
      record.authorization,
    );
  });

  it("invalidates HEAD-A readiness after a known repair publication to HEAD B", () => {
    const f = setup();
    let record = publishedRepair(f);
    expect(prMaintenanceProgress(record).stage).toBe("checking");
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "ready",
        fingerprint: "fingerprint-1",
        evidence: "Reusing the pre-publication checks",
      }),
    ).toThrow(/Readiness/);
    record = observe(f, record, {
      headSha: otherSha,
      fingerprint: "head-B",
      mergeability: "mergeable",
      checksComplete: true,
      reviewsComplete: true,
      checks: [
        { key: "unit", state: "passed", headSha: otherSha, evidence: "ci:B passed" },
      ],
      reviews: [
        {
          key: "review",
          reviewer: "owner",
          state: "approved",
          headSha: otherSha,
          revision: "review-B",
          evidence: "github:B approved",
        },
      ],
    });
    expect(prMaintenanceProgress(record).stage).toBe("checking");
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "ready",
      fingerprint: "head-B",
      evidence: "Fresh HEAD-B evidence",
    });
    expect(record.readyFingerprint).toBe("head-B");
    expect(record.observation!.sources).toEqual([source]);
    expect(prMaintenanceProgress(record).stage).toBe("ready");
    expect(prMaintenanceTaskStatuses([record])[0]?.stage).toBe("ready");
  });

  it("keeps same-HEAD deduplication but allows unchanged feedback to be revalidated on an external HEAD", () => {
    const f = setup();
    let record = observe(f, publishedRepair(f), {
      headSha: otherSha,
      fingerprint: "head-B",
    });
    expect(() => prepare(f, record, "duplicate-B", "repair", otherSha)).toThrow(
      /unchanged/,
    );
    const externalHead = "c".repeat(40);
    record = observe(f, record, {
      headSha: externalHead,
      fingerprint: "external-C",
      mergeability: "mergeable",
      checksComplete: true,
      reviewsComplete: true,
      checks: [
        { key: "unit", state: "passed", headSha: externalHead, evidence: "ci:C passed" },
      ],
      reviews: [
        {
          key: "review",
          reviewer: "owner",
          state: "approved",
          headSha: externalHead,
          revision: "review-C",
          evidence: "github:C approved",
        },
      ],
    });
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "ready",
        fingerprint: "external-C",
        evidence: "The old disposition alone is insufficient",
      }),
    ).toThrow(/Readiness/);
    expect(() =>
      prepare(f, record, "regression-C", "repair", externalHead),
    ).not.toThrow();
  });

  it("revalidates a still-valid finding on HEAD C without treating its historical HEAD-B publication as a new push", () => {
    const f = setup();
    const externalHead = "c".repeat(40);
    let record = observe(f, publishedRepair(f), {
      headSha: externalHead,
      fingerprint: "head-C",
      mergeability: "mergeable",
      checksComplete: true,
      reviewsComplete: true,
      checks: [
        { key: "unit", state: "passed", headSha: externalHead, evidence: "ci:C passed" },
      ],
      reviews: [
        {
          key: "review",
          reviewer: "owner",
          state: "approved",
          headSha: externalHead,
          revision: "review-C",
          evidence: "github:C approved",
        },
      ],
    });
    record = accept(
      f,
      prepare(f, record, "revalidate-C", "answer", externalHead),
      "revalidate-C",
    );
    f.store.updateRunStep(f.step.id, { state: "succeeded" });
    const receipt = result(record);
    if (receipt.kind !== "batch") throw new Error("fixture");
    receipt.published = false;
    receipt.usedMutations = 0;
    receipt.findings[0] = {
      ...receipt.findings[0]!,
      outcome: "already_satisfied",
      publishedCommit: otherSha,
      verifiedHeadSha: externalHead,
    };
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      receipt,
    );
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      ...receipt,
      state: "succeeded",
    });
    expect(record.batches.at(-1)!.published).toBe(false);
    expect(record.findings[0]!.verifiedHeadSha).toBe(externalHead);
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "ready",
      fingerprint: "head-C",
      evidence: "Existing fix verified against current code",
    });
    expect(record.readyFingerprint).toBe("head-C");
    expect(prMaintenanceProgress(record).stage).toBe("ready");
    expect(prMaintenanceTaskStatuses([record])[0]?.stage).toBe("ready");
    expect(() => prepare(f, record, "duplicate-C", "answer", externalHead)).toThrow(
      /unchanged/,
    );
  });

  it.each([0, 1])(
    "permits a new reservation after confirmed review-request nonperformance, retaining %i used attempts",
    (usedAttempts) => {
      const f = setup();
      let record = observe(
        f,
        f.store.prMaintenance.enableFromOperator(
          {
            ...f.input,
            scope: { ...scope, reviewers: ["reviewer"] },
          },
          "operator",
        ),
      );
      const effect = {
        key: "request-before-local-failure",
        kind: "review_request" as const,
        state: "reserved" as const,
        actor: "lead",
        headSha: sha,
        recipient: "reviewer",
        actionIdentity: "same-review-obligation",
        attempts: 1,
      };
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect,
      });
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect: {
          ...effect,
          state: "not_performed",
          usedAttempts,
          evidence:
            usedAttempts === 0
              ? "The local command failed before HTTP."
              : "GitHub rejected the request without adding a reviewer.",
        },
      });
      expect(record.counters.mutationAttempts).toBe(usedAttempts);
      expect(() =>
        f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
          kind: "action",
          effect,
        }),
      ).toThrow(/immutable/);
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect: { ...effect, key: "new-reservation-after-local-fix" },
      });
      expect(record.actions.map((entry) => entry.state)).toEqual([
        "not_performed",
        "reserved",
      ]);
      expect(record.counters.mutationAttempts).toBe(usedAttempts + 1);
    },
  );

  it("rejects a second retained PR for the same task even with an independent worker and checkout", () => {
    const f = setup();
    const secondNode = f.store.registerNode({
      name: "second",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 20,
    }).node;
    const placement = f.store.createPlacement(
      f.workspace.id,
      secondNode.id,
      "C:\\other-checkout",
    );
    const worker = f.store.createSession(placement, "Second worker", false, "", {
      runId: f.task.id,
      runRole: "worker",
    });
    f.store.transitionSession(worker.id, "starting");
    f.store.transitionSession(worker.id, "idle");
    const step = f.store.upsertRunStep(f.task.id, {
      stepKey: "second-worker",
      title: "Second worker",
      prompt: "Independent checkout",
      category: "implement",
    });
    f.store.updateRunStep(step.id, {
      sessionId: worker.id,
      placementId: placement.id,
      state: "succeeded",
    });
    const first = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    expect(() =>
      f.store.prMaintenance.enableFromOperator(
        {
          ...f.input,
          workerSessionId: worker.id,
          identity: { ...identity, prNumber: 2, headRef: "refs/heads/Other" },
        },
        "operator",
      ),
    ).toThrow(/task.*already|one.*task/i);
    expect(f.store.prMaintenance.enableFromOperator(f.input, "operator").id).toBe(
      first.id,
    );
  });

  it("lets the owning lead pause and resume without changing grant or work budgets", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const paused = f.store.prMaintenance.set(f.lead.id, {
      id: record.id,
      expectedVersion: record.version,
      action: "pause",
      reason: "Owning lead is checking the current HEAD.",
    });
    expect(paused.pauseOrigin).toMatchObject({
      actor: "lead",
      actorId: f.lead.id,
    });

    const resumed = f.store.prMaintenance.set(f.lead.id, {
      id: paused.id,
      expectedVersion: paused.version,
      action: "resume",
    });

    expect(resumed).toMatchObject({
      lifecycle: "active",
      pauseReason: "",
      authorization: record.authorization,
      counters: record.counters,
      findingAttempts: record.findingAttempts,
    });
    expect(resumed.pauseOrigin).toBeUndefined();
    expect(resumed.resumeHistory.at(-1)).toMatchObject({
      actor: "lead",
      actorId: f.lead.id,
      pauseReason: "Owning lead is checking the current HEAD.",
      pauseOrigin: { actor: "lead", actorId: f.lead.id },
    });
  });

  it.each(["wait_for_human", "finding_needs_human"] as const)(
    "lets the owning lead resume a directed %s hold",
    (holdReason) => {
      const f = setup();
      const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
      const held = f.store.prMaintenance.holdForDecision(
        f.lead.id,
        record.id,
        record.version,
        {
          id: "design-direction",
          version: 1,
          proposal: "Keep the current API?",
          scope: "Public API",
          headSha: sha,
        },
        () => f.store.setRunState(f.task.id, "awaiting_human"),
      );
      let directed = f.store.prMaintenance.operatorAction(
        held.id,
        held.version,
        {
          action: "direction",
          decisionId: "design-direction",
          decisionVersion: 1,
          direction: "Keep the current API and restore its invariant.",
          resume: holdReason === "finding_needs_human",
        },
        "operator",
        () => f.store.setRunState(f.task.id, "running"),
      );
      if (holdReason === "finding_needs_human") {
        f.store.prMaintenance.pauseForTask(f.task.id, holdReason);
        directed = f.store.prMaintenance.get(record.id)!;
      }
      expect(directed).toMatchObject({
        lifecycle: "paused",
        pauseReason: holdReason,
        pauseOrigin: { actor: "system" },
        decision: { state: "directed" },
      });

      const resumed = f.store.prMaintenance.set(f.lead.id, {
        id: directed.id,
        expectedVersion: directed.version,
        action: "resume",
      });

      expect(resumed.lifecycle).toBe("active");
      expect(resumed.resumeHistory.at(-1)).toMatchObject({
        actor: "lead",
        actorId: f.lead.id,
        pauseReason: holdReason,
      });
    },
  );

  it.each([
    ["a pending decision", "wait_for_human"],
    ["an operator pause", "operator_required"],
    ["a provider access hold", "operator_required"],
    ["an identity hold", "operator_required"],
    ["a no-progress hold", "operator_required"],
    ["exhausted allowance", "budget_exhausted"],
    ["an operator renewal", "operator_required"],
    ["a 30-day pause notice", "operator_required"],
    ["an observation-only grant", "repair_authorization_required"],
    ["a released record", "released"],
    ["a terminal record", "terminal"],
    ["unsettled effects", "unsettled"],
    ["a pending manual command", "execution_uncertain"],
    ["an ineligible binding", "sealed_managed_result"],
    ["a non-owning lead", "ownership"],
  ] as const)(
    "refuses lead resume for %s with %s without changing the record",
    (scenario, code) => {
      const f = setup();
      let record =
        scenario === "an observation-only grant"
          ? restoreLegacy(f)
          : f.store.prMaintenance.enableFromOperator(f.input, "operator");
      let leadSessionId = f.lead.id;
      if (scenario === "a pending decision") {
        record = f.store.prMaintenance.holdForDecision(
          f.lead.id,
          record.id,
          record.version,
          {
            id: "pending-decision",
            version: 1,
            proposal: "Choose the public contract.",
            scope: "Public API",
            headSha: sha,
          },
          () => f.store.setRunState(f.task.id, "awaiting_human"),
        );
      } else if (scenario === "an operator pause") {
        record = f.store.prMaintenance.operatorAction(
          record.id,
          record.version,
          { action: "pause", reason: "Operator pause" },
          "operator",
        );
      } else if (scenario === "a provider access hold") {
        record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
          kind: "observation",
          observation: {
            attemptedAt: at,
            complete: false,
            failure: "auth",
            helperState: {
              error: {
                code: "auth_required",
                message: "Provider authentication is required.",
              },
            },
            evidence: "Provider rejected the authenticated request.",
          },
        });
      } else if (scenario === "an identity hold") {
        record = observe(f, record, {
          identity: { ...record.identity, headRef: "refs/heads/Other" },
        });
      } else if (scenario === "a no-progress hold") {
        f.store.prMaintenance.pauseForTask(f.task.id, "no_progress");
        record = f.store.prMaintenance.get(record.id)!;
      } else if (scenario === "exhausted allowance") {
        const backup = f.store.prMaintenance.exportBackup();
        backup.registrations[0]!.authorization.budgets.repairBatches = 1;
        backup.registrations[0]!.counters.repairBatches = 1;
        f.store.writeAtomically(() => f.store.prMaintenance.importBackup(backup));
        record = f.store.prMaintenance.get(record.id)!;
      } else if (scenario === "an operator renewal") {
        record = f.store.prMaintenance.set(f.lead.id, {
          id: record.id,
          expectedVersion: record.version,
          action: "pause",
        });
        record = f.store.prMaintenance.operatorAction(
          record.id,
          record.version,
          { action: "renew" },
          "operator",
        );
      } else if (scenario === "a 30-day pause notice") {
        record = f.store.prMaintenance.set(f.lead.id, {
          id: record.id,
          expectedVersion: record.version,
          action: "pause",
        });
        const future = new Date(
          Date.parse(record.renewedAt) + 31 * 24 * 60 * 60 * 1_000,
        ).toISOString();
        f.store.prMaintenance.notifyLongPauses(future, () => {});
        record = f.store.prMaintenance.get(record.id)!;
      } else if (scenario === "a released record") {
        record = f.store.prMaintenance.operatorAction(
          record.id,
          record.version,
          { action: "release", reason: "Release maintenance ownership." },
          "operator",
        );
      } else if (scenario === "a terminal record") {
        record = accept(f, prepare(f, observe(f, record)));
        record = observe(f, record, { state: "closed", fingerprint: "closed" });
      } else if (scenario === "unsettled effects") {
        record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
          kind: "observation",
          observation: {
            attemptedAt: at,
            complete: false,
            failure: "incomplete",
            helperState: {
              error: {
                code: "ambiguous_effect",
                message: "Provider effect could not be correlated.",
              },
            },
            evidence: "Provider effect could not be correlated.",
          },
        });
      } else if (scenario === "a pending manual command") {
        f.store.prMaintenance.beginManualControl(
          f.worker.id,
          {
            id: randomUUID(),
            digest: "manual-input",
            kind: "prompt",
            operatorId: "operator",
          },
          0,
        );
        record = f.store.prMaintenance.get(record.id)!;
      } else if (scenario === "an ineligible binding") {
        record = f.store.prMaintenance.set(f.lead.id, {
          id: record.id,
          expectedVersion: record.version,
          action: "pause",
        });
        f.store.updateRunStep(f.step.id, {
          resultSha: sha,
          workspaceState: "completed",
        });
      } else if (scenario === "a non-owning lead") {
        record = f.store.prMaintenance.set(f.lead.id, {
          id: record.id,
          expectedVersion: record.version,
          action: "pause",
        });
        leadSessionId = "different-lead";
      }
      expectLeadResumeRefused(f, record, code, leadSessionId);
    },
  );

  it("treats a legacy pause without origin as operator-only", () => {
    const directory = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
    mkdirSync(directory, { recursive: true });
    paths.push(directory);
    const dbPath = join(directory, "host.sqlite");
    const f = setup(storeAt(dbPath));
    const record = f.store.prMaintenance.operatorAction(
      f.store.prMaintenance.enableFromOperator(f.input, "operator").id,
      1,
      { action: "pause", reason: "Legacy pause" },
      "operator",
    );
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT data FROM pr_maintenance WHERE id=?")
      .get(record.id) as { data: string };
    const legacy = JSON.parse(row.data);
    delete legacy.pauseOrigin;
    db.prepare("UPDATE pr_maintenance SET data=? WHERE id=?").run(
      JSON.stringify(legacy),
      record.id,
    );
    db.close();
    const reopened = storeAt(dbPath);
    const persisted = reopened.prMaintenance.get(record.id)!;
    expect(persisted.pauseOrigin).toBeUndefined();
    expectLeadResumeRefused({ ...f, store: reopened }, persisted, "operator_required");
  });

  it("rejects fabricated approval, mutable identity fields and unbounded checkpoints", () => {
    const f = setup();
    expect(() =>
      f.store.prMaintenance.enableFromOperator(
        { ...f.input, approved: true } as never,
        "operator",
      ),
    ).toThrow();
    expect(() => f.store.prMaintenance.enableFromOperator(f.input, "")).toThrow();
    let record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "reconcile",
        progress: true,
        evidence: "claimed",
        operatorId: "operator",
      } as never),
    ).toThrow();
    expect(() =>
      f.store.prMaintenance.set(f.lead.id, {
        id: record.id,
        expectedVersion: record.version,
        action: "resume",
      }),
    ).toThrow(/own pause|directed/i);
    record = observe(f, record);
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "prepare_batch",
        batch: {
          id: "huge",
          kind: "repair",
          sources: [source],
          headSha: sha,
          prompt: "x".repeat(32_769),
          scope: "baseline",
          reservedMutations: 1,
        },
      }),
    ).toThrow();
  });

  it("keeps idempotent enablement and strict lead/task/worker ownership", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    expect(f.store.prMaintenance.enableFromOperator(f.input, "operator")).toEqual(record);
    expect(record.identity.repositoryId).toBe("R_MAIN");
    expect(record.identity.headRef).toBe("refs/heads/Repair");
    expect(() => f.store.prMaintenance.get(record.id, "impostor")).toThrow(
      /another lead/,
    );
    expect(() =>
      f.store.prMaintenance.enableFromOperator(
        { ...f.input, workerSessionId: f.lead.id },
        "operator",
      ),
    ).toThrow(/existing/);
    expect(f.store.prMaintenance.list({ leadSessionId: "impostor" }).records).toEqual([]);
  });

  it("reserves a paused PR, full head ref and worker; refs remain case-sensitive", () => {
    const first = setup();
    const second = setup(first.store);
    const record = first.store.prMaintenance.enableFromOperator(first.input, "operator");
    first.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      { action: "pause", reason: "Waiting" },
      "operator",
    );
    expect(() =>
      second.store.prMaintenance.enableFromOperator(second.input, "operator"),
    ).toThrow(/PR/);
    expect(() =>
      second.store.prMaintenance.enableFromOperator(
        {
          ...second.input,
          identity: { ...identity, prNumber: 2, baseRef: "refs/heads/release" },
        },
        "operator",
      ),
    ).toThrow(/reserved/);
    expect(() =>
      first.store.prMaintenance.enableFromOperator(
        {
          ...first.input,
          identity: { ...identity, prNumber: 3, headRef: "refs/heads/other" },
        },
        "operator",
      ),
    ).toThrow(/reserved/);
    const other = second.store.prMaintenance.enableFromOperator(
      {
        ...second.input,
        identity: { ...identity, prNumber: 2, headRef: "refs/heads/repair" },
      },
      "operator",
    );
    expect(other.lifecycle).toBe("active");
    expect(first.store.prMaintenance.list({ limit: 1 }).nextCursor).toBeDefined();
  });

  it("preserves exact checkpoint and counters across restart, with optimistic versions", () => {
    const path = join(process.cwd(), ".pr-maintenance-test-work", randomUUID());
    mkdirSync(path, { recursive: true });
    paths.push(path);
    const db = join(path, "host.sqlite");
    const f = setup(storeAt(db));
    let record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "operator"),
    );
    record = prepare(f, record);
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version - 1, {
        kind: "reconcile",
        progress: true,
        evidence: "stale",
      }),
    ).toThrow(/changed/);
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const restored = storeAt(db);
    expect(restored.prMaintenance.get(record.id)).toEqual(record);
    expect(restored.prMaintenance.get(record.id)!.batches[0]!.prompt).toContain(
      "null boundary",
    );
    expect(restored.prMaintenance.get(record.id)!.counters.mutationAttempts).toBe(3);
  });

  it("atomically rolls back follow-up acceptance and deduplicates lost responses", () => {
    const f = setup();
    let record = prepare(
      f,
      observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
    );
    const before = f.store.getRunStep(f.step.id)!;
    expect(() =>
      f.store.writeAtomically(() => {
        accept(f, record);
        throw new Error("lost transaction");
      }),
    ).toThrow("lost transaction");
    expect(f.store.getRunStep(f.step.id)).toEqual(before);
    expect(f.store.prMaintenance.get(record.id)!.batches[0]!.state).toBe("prepared");
    record = accept(f, record);
    const batch = record.batches[0]!;
    expect(
      f.store.prMaintenance.acceptBatch(
        f.lead.id,
        record.id,
        record.generation,
        batch.id,
        batch.stepId!,
        batch.attempt!,
        batch.prompt,
      ),
    ).toEqual(record);
    expect(() =>
      f.store.prMaintenance.acceptBatch(
        f.lead.id,
        record.id,
        record.generation,
        batch.id,
        batch.stepId!,
        batch.attempt!,
        "Different prompt",
      ),
    ).toThrow(/exact/);
    expect(f.store.prMaintenance.referenceForStep(batch.stepId!, batch.attempt)).toEqual({
      recordId: record.id,
      generation: record.generation,
      batchId: batch.id,
    });
  });

  it("enforces one outstanding batch and no dispatch without retained identity", () => {
    const f = setup();
    const record = prepare(
      f,
      observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
    );
    expect(() => prepare(f, record, "second")).toThrow(/outstanding/);
    expect(
      f.store.prMaintenance.admission({ action: "dispatch", taskId: f.task.id }).reason,
    ).toBe("maintenance_batch_required");
    expect(
      f.store.prMaintenance.admission({
        action: "dispatch",
        taskId: "replacement",
        placementId: f.placement.id,
      }).reason,
    ).toBe("resource_reserved");
    expect(
      f.store.prMaintenance.admission({ action: "discover", taskId: "unrelated" })
        .allowed,
    ).toBe(true);
    expect(() =>
      f.store.upsertRunStep(f.task.id, {
        stepKey: "replacement",
        title: "Replacement",
        prompt: "Start over",
      }),
    ).toThrow(/retained/);
  });

  it("holds and existing human review creation commit or roll back together", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const previousNotes = f.store.listRunNotes(f.task.id);
    const decision = {
      id: "design-1",
      version: 1,
      proposal: "Change public null semantics",
      headSha: sha,
      scope: "API contract",
    };
    expect(() =>
      f.store.prMaintenance.holdForDecision(
        f.lead.id,
        record.id,
        record.version,
        decision,
        () => {
          f.store.appendRunNote(f.task.id, 0, "Human question");
          throw new Error("notification unavailable");
        },
      ),
    ).toThrow("notification unavailable");
    expect(f.store.prMaintenance.get(record.id)).toEqual(record);
    expect(f.store.listRunNotes(f.task.id)).toEqual(previousNotes);
    expect(() =>
      f.store.prMaintenance.holdForDecision(
        f.lead.id,
        record.id,
        record.version,
        decision,
        () => {},
      ),
    ).toThrow(/task review/);
    let calls = 0;
    const held = f.store.prMaintenance.holdForDecision(
      f.lead.id,
      record.id,
      record.version,
      decision,
      () => {
        calls++;
        f.store.advanceRunToReview(f.task.id);
        f.store.appendRunNote(f.task.id, 0, "Human question");
      },
    );
    expect(
      f.store.prMaintenance.holdForDecision(
        f.lead.id,
        record.id,
        record.version,
        decision,
        () => {
          calls++;
        },
      ),
    ).toEqual(held);
    expect(calls).toBe(1);
    for (const action of [
      "discover",
      "reopen",
      "dispatch",
      "advance",
      "submit",
      "approve",
      "publish",
      "aggregate",
    ] as const)
      expect(
        f.store.prMaintenance.admission({ action, taskId: f.task.id }),
      ).toMatchObject({
        allowed: false,
        reason: "wait_for_human",
        decisionId: "design-1",
      });
    expect(() => f.store.updateRun(f.task.id, { state: "running" })).toThrow(
      /wait_for_human/,
    );
    expect(() => f.store.updateRun(f.task.id, { state: "completed" })).toThrow(
      /wait_for_human/,
    );
    expect(() =>
      f.store.prMaintenance.operatorAction(
        held.id,
        held.version,
        {
          action: "direction",
          decisionId: "design-1",
          decisionVersion: 2,
          direction: "Keep contract",
        },
        "operator",
      ),
    ).toThrow(/exact/);
    const directed = f.store.prMaintenance.operatorAction(
      held.id,
      held.version,
      {
        action: "direction",
        decisionId: "design-1",
        decisionVersion: 1,
        direction: "Preserve existing API; restore its invariant.",
        resume: true,
      },
      "operator",
      () => {
        f.store.setRunState(f.task.id, "running");
      },
    );
    expect(directed.decision?.state).toBe("directed");
    expect(directed.findings).toEqual([]);
    expect(f.store.getRun(f.task.id)!.state).toBe("running");
  });

  it("requires correlated execution and per-finding receipts, not a worker done message", () => {
    const f = setup();
    let record = accept(
      f,
      prepare(
        f,
        observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
      ),
    );
    expect(() =>
      f.store.prMaintenance.checkpoint(
        f.lead.id,
        record.id,
        record.version,
        result(record, "succeeded"),
      ),
    ).toThrow(/reconcile/);
    expect(() =>
      f.store.prMaintenance.checkpoint(
        f.lead.id,
        record.id,
        record.version,
        result(record),
      ),
    ).toThrow(/RunStep/);
    f.store.updateRunStep(f.step.id, { state: "succeeded" });
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      result(record),
    );
    const incomplete = result(record, "succeeded");
    if (incomplete.kind !== "batch") throw new Error("fixture");
    incomplete.findings[0]!.responseIds = [];
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, incomplete),
    ).toThrow(/response/);
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      result(record, "succeeded"),
    );
    expect(record.counters.repairBatches).toBe(1);
    expect(record.counters.mutationAttempts).toBe(1);
    expect(prMaintenanceUnsettled(record)).toBe(false);
    expect(() => prepare(f, record, "before-refresh")).toThrow(/complete/);
    record = observe(f, record);
    expect(() => prepare(f, record, "duplicate-feedback")).toThrow(/unchanged/);
  });

  it("preserves a pushed fix with failed reply as partial, without refunding unknown usage", () => {
    const f = setup();
    let record = accept(
      f,
      prepare(
        f,
        observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
      ),
    );
    f.store.updateRunStep(f.step.id, { state: "succeeded" });
    const checkpoint: PrMaintenanceCheckpoint = {
      kind: "batch",
      batchId: "batch-1",
      generation: record.generation,
      state: "reconciling",
      findings: [
        {
          source,
          outcome: "incomplete",
          stage: "published",
          publishedCommit: sha,
          evidence: ["github:published"],
          responseRequired: true,
          responseIds: [],
          nextAction: "Reply only; do not reimplement.",
          progress: true,
        },
      ],
      effects: [
        {
          key: "reply",
          kind: "reply",
          state: "uncertain",
          headSha: sha,
          actor: "worker",
          actionIdentity: "thread-1-reply",
          attempts: 1,
        },
      ],
      executionSettled: true,
      evidence: "Published fix; reply response lost.",
      published: true,
    };
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      checkpoint,
    );
    expect(record.counters.mutationAttempts).toBe(3);
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        ...checkpoint,
        state: "partial",
        usedMutations: 2,
      }),
    ).toThrow(/known effects/);
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      ...checkpoint,
      state: "partial",
      usedMutations: 2,
      effects: [
        {
          ...checkpoint.effects[0]!,
          state: "not_performed",
          evidence: "Provider confirms the reply was rejected.",
        },
      ],
    });
    expect(record.batches[0]!.findings[0]!.stage).toBe("published");
    expect(record.counters.mutationAttempts).toBe(2);
  });

  it("terminal closure fences queued execution and retains keys until confirmed settlement", () => {
    const f = setup();
    let record = accept(
      f,
      prepare(
        f,
        observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
      ),
    );
    record = observe(f, record, {
      state: "closed",
      snapshotId: "closed-1",
      fingerprint: "closed",
    });
    expect(record.lifecycle).toBe("closed");
    expect(record.ownershipReleasedAt).toBeUndefined();
    expect(record.batches[0]!.cancellationRequestedAt).toBeDefined();
    expect(
      f.store.prMaintenance.admission({
        action: "execute",
        taskId: f.task.id,
        recordId: record.id,
        generation: record.generation,
        batchId: "batch-1",
      }).allowed,
    ).toBe(false);
    expect(() =>
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "release", reason: "Timed out" },
        "operator",
      ),
    ).toThrow(/Reconcile/);
    expect(f.store.hasSessionRetentionBlockers(f.worker.id, at)).toBe(true);
    f.store.updateRunStep(f.step.id, { state: "cancelled" });
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      result(record),
    );
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      result(record, "succeeded"),
    );
    expect(record.ownershipReleasedAt).toBeDefined();
    const next = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    expect(next.generation).toBe(record.generation + 1);
    expect(next.id).not.toBe(record.id);
    expect(() =>
      f.store.prMaintenance.checkpoint(
        f.lead.id,
        record.id,
        record.version,
        result(record),
      ),
    ).toThrow(/Released/);
    expect(f.store.prMaintenance.get(next.id)).toEqual(next);
  });

  it("does not mistake a Stop request or late running worker for confirmed cancellation", () => {
    const f = setup();
    let record = accept(
      f,
      prepare(
        f,
        observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
      ),
    );
    f.store.transitionSession(f.worker.id, "running");
    f.store.setSessionTransitionIntent(f.worker.id, "stop");
    f.store.setSessionControls(f.worker.id, { stopRequested: true });
    f.store.updateRunStep(f.step.id, { state: "cancelled" });
    record = f.store.prMaintenance.get(record.id)!;
    expect(() =>
      f.store.prMaintenance.checkpoint(
        f.lead.id,
        record.id,
        record.version,
        result(record),
      ),
    ).toThrow(/Stop request/);
    expect(prMaintenanceUnsettled(record)).toBe(true);
    expect(record.ownershipReleasedAt).toBeUndefined();
  });

  it("cancels never-accepted preparation transactionally at terminal observation", () => {
    const f = setup();
    let record = prepare(
      f,
      observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
    );
    record = observe(f, record, { state: "merged", fingerprint: "merged" });
    expect(record.batches[0]!.state).toBe("cancelled");
    expect(record.batches[0]!.findings[0]!.outcome).toBe("incomplete");
    expect(record.counters.repairBatches).toBe(0);
    expect(record.ownershipReleasedAt).toBeDefined();
  });

  it("incomplete reads never replace successful evidence, and cumulative failures survive successful checks", () => {
    const f = setup();
    let record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "operator"),
    );
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(`2026-09-18T0${i + 1}:00:00.000Z`);
      record = observe(f, record, {
        complete: false,
        identity: undefined,
        failure: "network",
        snapshotId: undefined,
        fingerprint: undefined,
        headSha: undefined,
        state: undefined,
        attemptedAt: `2026-09-18T0${i + 1}:00:00.000Z`,
      });
    }
    expect(record.lifecycle).toBe("paused");
    expect(record.lastSuccessAt).toBe(at);
    expect(record.observation!.headSha).toBe(sha);
    expect(record.counters.totalFailures).toBe(3);
    expect(() => prepare(f, record)).toThrow(/held/);
    vi.setSystemTime("2026-09-18T04:00:00.000Z");
    record = observe(f, record, { attemptedAt: "2026-09-18T04:00:00.000Z" });
    expect(record.counters.consecutiveFailures).toBe(0);
    expect(record.counters.totalFailures).toBe(3);
    expect(record.lifecycle).toBe("paused");
  });

  it("auth failures pause immediately, while progressing budget partials do not count as failures", () => {
    const f = setup();
    let record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "operator"),
    );
    record = observe(f, record, {
      complete: false,
      failure: "budget",
      cursor: "page-2",
      revision: "head-A",
    });
    expect(record.counters.totalFailures).toBe(0);
    expect(record.counters.scanStalls).toBe(0);
    expect(record.lifecycle).toBe("active");
    record = observe(f, record, { complete: false, failure: "auth" });
    expect(record.lifecycle).toBe("paused");
    expect(record.pauseReason).toBe("authorization_failed");
  });

  it("rejects managed sealed workers without clearing immutable results", () => {
    const f = setup();
    f.store.updateRunStep(f.step.id, { resultSha: sha, workspaceState: "completed" });
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    expect(record.lifecycle).toBe("paused");
    expect(record.pauseReason).toBe("sealed_managed_result");
    expect(() =>
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "resume" },
        "operator",
      ),
    ).toThrow(/handoff/);
    expect(f.store.getRunStep(f.step.id)!.resultSha).toBe(sha);
  });

  it("retains lead, worker, task and checkout; cleanup reservations serialize against enablement", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    f.store.setRunState(f.task.id, "completed");
    for (const id of [f.lead.id, f.worker.id])
      expect(f.store.hasSessionRetentionBlockers(id, "2099-01-01T00:00:00.000Z")).toBe(
        true,
      );
    const request = {
      sessionId: f.worker.id,
      nodeId: f.node.id,
      commandId: randomUUID(),
      inactiveBefore: "2099-01-01T00:00:00.000Z",
      retentionDays: 30,
      requestedAt: at,
      inFlight: true,
    };
    expect(() => f.store.requestSessionCleanup(request)).toThrow(/retained/);
    expect(() => f.store.deleteRun(f.task.id)).toThrow(/maintenance/);
    expect(() => f.store.assertWorktreePurgeAllowed(f.task.id)).toThrow(/maintenance/);
    f.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      { action: "release", reason: "Operator abandons settled maintenance" },
      "operator",
    );
    f.store.requestSessionCleanup(request);
    expect(() => f.store.prMaintenance.enableFromOperator(f.input, "operator")).toThrow(
      /deleted after inactivity/,
    );
  });

  it("persists 30-day pause notices without refreshing age on polls or expiring roots", () => {
    const f = setup();
    let record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    record = f.store.prMaintenance.operatorAction(
      record.id,
      record.version,
      { action: "pause", reason: "Later" },
      "operator",
    );
    const pausedAt = record.pausedAt;
    record = observe(f, record);
    expect(record.pausedAt).toBe(pausedAt);
    const future = new Date(
      Date.parse(record.renewedAt) + 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    let notices = 0;
    expect(
      f.store.prMaintenance.notifyLongPauses(future, () => {
        notices++;
      }),
    ).toBe(1);
    expect(
      f.store.prMaintenance.notifyLongPauses(future, () => {
        notices++;
      }),
    ).toBe(0);
    expect(notices).toBe(1);
    expect(f.store.prMaintenance.get(record.id)!.ownershipReleasedAt).toBeUndefined();
    expect(f.store.prMaintenance.hasSessionRetentionBlockers(f.worker.id)).toBe(true);
  });

  it("fairly carries unserved records and cannot reset a wake's request/time/visit counters", () => {
    const first = setup();
    const records: PrMaintenanceRegistration[] = [];
    for (let i = 0; i < 8; i++) {
      const f = i === 0 ? first : setup(first.store);
      if (i > 0) f.store.updateRun(f.task.id, { leadSessionId: first.lead.id });
      records.push(
        f.store.prMaintenance.enableFromOperator(
          {
            ...f.input,
            identity: { ...identity, prNumber: i + 1, headRef: `refs/heads/repair-${i}` },
          },
          "operator",
        ),
      );
    }
    const future = "2099-01-01T00:00:00.000Z";
    first.store.prMaintenance.beginWake(first.lead.id, "wake-1", future);
    const visited = Array.from(
      { length: 5 },
      () => first.store.prMaintenance.takeDue(first.lead.id, "wake-1", future)!.id,
    );
    expect(
      first.store.prMaintenance.takeDue(first.lead.id, "wake-1", future),
    ).toBeUndefined();
    expect(
      first.store.prMaintenance.beginWake(first.lead.id, "wake-1", future).visits,
    ).toBe(5);
    first.store.prMaintenance.beginWake(first.lead.id, "wake-2", future);
    const carried = Array.from(
      { length: 3 },
      () => first.store.prMaintenance.takeDue(first.lead.id, "wake-2", future)!.id,
    );
    expect(new Set([...visited, ...carried]).size).toBe(8);
    first.store.prMaintenance.chargeWake(
      first.lead.id,
      "wake-2",
      { requests: 40, milliseconds: 1 },
      future,
    );
    expect(
      first.store.prMaintenance.takeDue(first.lead.id, "wake-2", future),
    ).toBeUndefined();
    expect(() =>
      first.store.prMaintenance.chargeWake(
        first.lead.id,
        "wake-2",
        { requests: 1, milliseconds: 0 },
        future,
      ),
    ).toThrow(/End this/);
    first.store.prMaintenance.beginWake(first.lead.id, "wake-3", future);
    expect(
      first.store.prMaintenance.takeDue(
        first.lead.id,
        "wake-3",
        "2099-01-01T00:05:00.000Z",
      ),
    ).toBeUndefined();
    expect(records).toHaveLength(8);
  });

  it("deduplicates authorized review obligations, bounds CI retries and retains unknown effect allowance", () => {
    const f = setup();
    let record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(
        {
          ...f.input,
          scope: { ...scope, reviewers: ["reviewer"], retryChecks: true },
        },
        "operator",
      ),
    );
    const effect = {
      key: "review-obligation-1",
      kind: "review_request" as const,
      state: "reserved" as const,
      actor: "lead",
      actionIdentity: "requirement-revision-1",
      headSha: sha,
      recipient: "reviewer",
      attempts: 1,
    };
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect: { ...effect, recipient: "unconfigured" },
      }),
    ).toThrow(/configured/);
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "action",
      effect,
    });
    expect(record.counters.mutationAttempts).toBe(1);
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "action",
      effect: { ...effect, state: "uncertain" },
    });
    expect(() =>
      f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "renew" },
        "operator",
      ),
    ).toThrow(/Settle/);
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "action",
      effect: {
        ...effect,
        state: "known",
        providerId: "request-1",
        evidence: "github:requested",
      },
    });
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect: { ...effect, key: "new-key" },
      }),
    ).toThrow(/obligation/);
    const retry = {
      ...effect,
      key: "retry",
      kind: "ci_retry" as const,
      actionIdentity: "check:incident-1",
    };
    const unsentRetry = { ...retry, key: "ci-command-not-started" };
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "action",
      effect: unsentRetry,
    });
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "action",
      effect: {
        ...unsentRetry,
        state: "not_performed",
        usedAttempts: 0,
        evidence: "Local command failed before starting the retry request.",
      },
    });
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "action",
      effect: retry,
    });
    record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
      kind: "action",
      effect: {
        ...retry,
        state: "known",
        providerId: "rerun-1",
        evidence: "github:rerun",
      },
    });
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect: { ...retry, key: "new-attempt" },
      }),
    ).toThrow(/once/);
  });

  it("charges rejected mutation attempts and refunds only explicitly verified unused reservations", () => {
    const f = setup();
    let record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "operator"),
    );
    for (const usedAttempts of [undefined, 0]) {
      const key = usedAttempts === undefined ? "rejected-request" : "never-sent";
      const effect = {
        key,
        kind: "notification" as const,
        state: "reserved" as const,
        actor: "lead",
        actionIdentity: key,
        headSha: sha,
        attempts: 1,
      };
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect,
      });
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "action",
        effect: {
          ...effect,
          state: "not_performed",
          evidence: key,
          ...(usedAttempts === undefined ? {} : { usedAttempts }),
        },
      });
    }
    expect(record.counters.mutationAttempts).toBe(1);
  });

  it.each(["repair", "answer"] as const)(
    "enforces three %s batches across fresh feedback IDs until authenticated renewal",
    (kind) => {
      const f = setup();
      let record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
      for (let i = 0; i < 4; i++) {
        const currentSource = { ...source, id: `thread-${i}`, revision: `rev-${i}` };
        record = observe(f, record, {
          sources: [currentSource],
          fingerprint: `round-${i}`,
        });
        const prepareCheckpoint = {
          kind: "prepare_batch" as const,
          batch: {
            id: `batch-${i}`,
            kind,
            sources: [currentSource],
            headSha: sha,
            prompt: `Address revision ${i}`,
            scope: "Approved invariant",
            reservedMutations: 1,
          },
        };
        if (i === 3) {
          expect(() =>
            f.store.prMaintenance.checkpoint(
              f.lead.id,
              record.id,
              record.version,
              prepareCheckpoint,
            ),
          ).toThrow(/renew/);
          break;
        }
        record = f.store.prMaintenance.checkpoint(
          f.lead.id,
          record.id,
          record.version,
          prepareCheckpoint,
        );
        record = accept(f, record, `batch-${i}`);
        f.store.updateRunStep(f.step.id, { state: "succeeded" });
        const complete = result(record);
        if (complete.kind !== "batch") throw new Error("fixture");
        complete.findings[0]!.source = currentSource;
        complete.published = kind === "repair";
        record = f.store.prMaintenance.checkpoint(
          f.lead.id,
          record.id,
          record.version,
          complete,
        );
        record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
          ...complete,
          state: "succeeded",
        });
      }
      expect(record.counters[kind === "repair" ? "repairBatches" : "answerBatches"]).toBe(
        3,
      );
      const authorization = record.authorization.id;
      record = f.store.prMaintenance.operatorAction(
        record.id,
        record.version,
        { action: "renew" },
        "operator",
      );
      expect(record.counters.repairBatches).toBe(0);
      expect(record.counters.answerBatches).toBe(0);
      expect(record.authorization.id).not.toBe(authorization);
      expect(record.batches).toHaveLength(3);
    },
  );

  it("stops repeated reconciliation claims without new evidence and never expires unknown work", () => {
    const f = setup();
    let record = accept(
      f,
      prepare(
        f,
        observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
      ),
    );
    for (let i = 0; i < 4; i++)
      record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "reconcile",
        progress: true,
        evidence: "Same missing response, no correlated receipt.",
      });
    expect(record.pauseReason).toBe("reconciliation_stalled");
    expect(f.store.prMaintenance.wakeEligibleLeadIds()).not.toContain(f.lead.id);
    expect(prMaintenanceUnsettled(record)).toBe(true);
    expect(record.ownershipReleasedAt).toBeUndefined();
    expect(f.store.prMaintenance.hasSessionRetentionBlockers(f.worker.id)).toBe(true);
  });

  it.each(["no_progress", "contradiction"])(
    "uses underlying finding groups to stop %s despite new comment IDs",
    (mode) => {
      const f = setup();
      let record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
      for (let i = 0; i < (mode === "contradiction" ? 3 : 2); i++) {
        const currentSource = {
          ...source,
          id: `new-thread-${i}`,
          revision: `new-revision-${i}`,
        };
        record = observe(f, record, {
          sources: [currentSource],
          fingerprint: mode === "contradiction" ? ["A", "B", "A"][i] : `attempt-${i}`,
        });
        record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
          kind: "prepare_batch",
          batch: {
            id: `attempt-${i}`,
            kind: "repair",
            sources: [currentSource],
            headSha: sha,
            prompt: `Verify the recurring invariant ${i}`,
            scope: "Same underlying null defect",
            reservedMutations: 1,
          },
        });
        record = accept(f, record, `attempt-${i}`);
        f.store.updateRunStep(f.step.id, { state: "succeeded" });
        const complete = result(record);
        if (complete.kind !== "batch") throw new Error("fixture");
        complete.findings[0]!.source = currentSource;
        complete.findings[0]!.progress = mode === "contradiction";
        record = f.store.prMaintenance.checkpoint(
          f.lead.id,
          record.id,
          record.version,
          complete,
        );
        record = f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
          ...complete,
          state: "succeeded",
        });
      }
      expect(record.lifecycle).toBe("paused");
      expect(record.pauseReason).toBe("no_progress");
      expect(record.findingAttempts).toHaveLength(1);
    },
  );

  it("requires current HEAD check/review evidence for nonterminal readiness", () => {
    const f = setup();
    let record = observe(
      f,
      f.store.prMaintenance.enableFromOperator(f.input, "operator"),
      {
        sources: [],
        mergeability: "mergeable",
        checksComplete: true,
        reviewsComplete: true,
        checks: [{ key: "unit", state: "passed", headSha: sha, evidence: "ci:passed" }],
        reviews: [
          {
            key: "review",
            reviewer: "owner",
            state: "changes_requested",
            headSha: sha,
            revision: "1",
            evidence: "github:review",
          },
        ],
      },
    );
    const ready = {
      kind: "ready" as const,
      fingerprint: "fingerprint-1",
      evidence: "All requirements considered",
    };
    expect(() =>
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, ready),
    ).toThrow(/Readiness/);
    record = observe(f, record, {
      sources: [],
      mergeability: "mergeable",
      checksComplete: true,
      reviewsComplete: true,
      checks: [{ key: "unit", state: "passed", headSha: sha, evidence: "ci:passed" }],
      reviews: [
        {
          key: "review",
          reviewer: "owner",
          state: "approved",
          headSha: sha,
          revision: "2",
          evidence: "github:approval",
        },
      ],
    });
    record = f.store.prMaintenance.checkpoint(
      f.lead.id,
      record.id,
      record.version,
      ready,
    );
    expect(record.lifecycle).toBe("active");
    expect(record.readyFingerprint).toBe("fingerprint-1");
    expect(record.ownershipReleasedAt).toBeUndefined();
    record = observe(f, record, { headSha: otherSha, fingerprint: "different-head" });
    expect(record.readyFingerprint).toBeUndefined();
  });

  it("portable restore preserves an accepted prompt as uncertain rather than a fresh attempt", () => {
    const f = setup();
    const record = accept(
      f,
      prepare(
        f,
        observe(f, f.store.prMaintenance.enableFromOperator(f.input, "operator")),
      ),
    );
    const restored = storeAt();
    restored.replaceHostBackup(f.store.exportHostBackup({ enrollmentToken: "" }));
    const imported = restored.prMaintenance.get(record.id)!;
    expect(imported.lifecycle).toBe("paused");
    expect(imported.batches[0]!.state).toBe("uncertain");
    expect(imported.batches[0]!.stepId).toBe(record.batches[0]!.stepId);
    expect(imported.batches[0]!.prompt).toBe(record.batches[0]!.prompt);
    expect(imported.counters).toEqual(record.counters);
    expect(prMaintenanceUnsettled(imported)).toBe(true);
    expect(() =>
      restored.prMaintenance.operatorAction(
        imported.id,
        imported.version,
        { action: "release", reason: "Old machine is gone" },
        "operator",
      ),
    ).toThrow(/Reconcile/);
  });
});

describe("moving maintenance with its task", () => {
  /** What the task transfer does to the two tables, in its one transaction. */
  const handOver = (f: ReturnType<typeof setup>) => {
    const next = f.store.createSession(f.placement, "Next lead", false, "", {
      runRole: "lead",
    });
    f.store.writeAtomically(() => {
      f.store.updateRun(f.task.id, { leadSessionId: next.id });
      f.store.prMaintenance.transferTask(f.task.id, next.id);
    });
    return next;
  };

  it("hands the registration, its heartbeat and its history to the new lead", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    const next = handOver(f);

    const moved = f.store.prMaintenance.get(record.id)!;
    expect(moved.leadSessionId).toBe(next.id);
    expect(moved.version).toBe(record.version + 1);
    expect(
      f.store.prMaintenance.list({ leadSessionId: next.id }).records.map(({ id }) => id),
    ).toEqual([record.id]);
    expect(f.store.prMaintenance.list({ leadSessionId: f.lead.id }).records).toEqual([]);
    expect(f.store.prMaintenance.wakeEligibleLeadIds()).toEqual([next.id]);
    expect(() => f.store.prMaintenance.get(record.id, f.lead.id)).toThrow(/another lead/);

    // Only the new owner's heartbeat claims it now.
    f.store.prMaintenance.beginWake(f.lead.id, "previous-wake");
    expect(f.store.prMaintenance.takeDue(f.lead.id, "previous-wake")).toBeUndefined();
    f.store.prMaintenance.beginWake(next.id, "next-wake");
    expect(f.store.prMaintenance.takeDue(next.id, "next-wake")?.id).toBe(record.id);
  });

  it("leaves a task already owned by the lead untouched", () => {
    const f = setup();
    const record = f.store.prMaintenance.enableFromOperator(f.input, "operator");
    expect(f.store.prMaintenance.transferTask(f.task.id, f.lead.id)).toEqual([]);
    expect(f.store.prMaintenance.get(record.id)).toEqual(record);
  });

  it("lets the new owner lift the previous owner's own pause, and nobody else's", () => {
    const own = setup();
    let record = own.store.prMaintenance.enableFromOperator(own.input, "operator");
    record = own.store.prMaintenance.set(own.lead.id, {
      id: record.id,
      expectedVersion: record.version,
      action: "pause",
      reason: "Waiting for CI capacity",
    });
    const next = handOver(own);
    expect(own.store.prMaintenance.get(record.id)!.pauseOrigin).toMatchObject({
      actor: "lead",
      actorId: next.id,
    });

    const held = setup();
    let paused = held.store.prMaintenance.enableFromOperator(held.input, "operator");
    paused = held.store.prMaintenance.operatorAction(
      paused.id,
      paused.version,
      { action: "pause", reason: "Hold for release freeze" },
      "operator",
    );
    handOver(held);
    expect(held.store.prMaintenance.get(paused.id)!.pauseOrigin).toMatchObject({
      actor: "operator",
      actorId: "operator",
    });
  });

  it("keeps a pending proposal authorizable, now owned by the new lead", () => {
    const f = setup();
    const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
    const next = handOver(f);

    expect(f.store.prMaintenance.getProposal(f.task.id)).toMatchObject({
      id: proposal.id,
      version: proposal.version,
      leadSessionId: next.id,
    });
    expect(f.store.prMaintenance.listApprovals()[0]?.leadSessionId).toBe(next.id);
    const record = f.store.prMaintenance.authorizeProposal(
      f.task.id,
      proposal.id,
      proposal.version,
      "operator",
    );
    expect(record.leadSessionId).toBe(next.id);
  });

  it("keeps a reauthorization pinned to the record the transfer re-versioned", () => {
    const f = setup();
    const legacy = restoreLegacy(f);
    const proposal = f.store.prMaintenance.propose(f.lead.id, f.input);
    const next = handOver(f);

    const moved = f.store.prMaintenance.get(legacy.id)!;
    expect(f.store.prMaintenance.getProposal(f.task.id)?.reauthorization).toEqual({
      recordId: legacy.id,
      version: moved.version,
      generation: legacy.generation,
    });
    const record = f.store.prMaintenance.authorizeProposal(
      f.task.id,
      proposal.id,
      proposal.version,
      "operator",
    );
    expect(record).toMatchObject({ id: legacy.id, leadSessionId: next.id });
    expect(record.authorization.scope.publicationAuthorized).toBe(true);
  });
});
