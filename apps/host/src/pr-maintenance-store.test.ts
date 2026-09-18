import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PrMaintenanceEnableSchema,
  type PrMaintenanceCheckpoint,
  type PrMaintenanceRegistration,
} from "@fleet/protocol";
import { FleetStore } from "./store.js";
import { prMaintenanceUnsettled } from "./pr-maintenance-store.js";

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

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
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

describe("durable PR maintenance registry", () => {
  it("invalidates HEAD-A readiness after a known repair publication to HEAD B", () => {
    const f = setup();
    let record = publishedRepair(f);
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
    expect(
      f.store.prMaintenance.checkpoint(f.lead.id, record.id, record.version, {
        kind: "ready",
        fingerprint: "head-B",
        evidence: "Fresh HEAD-B evidence",
      }).readyFingerprint,
    ).toBe("head-B");
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
    ).toThrow(/authenticated/i);
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
    expect(f.store.listRunNotes(f.task.id)).toEqual([]);
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
    for (let i = 0; i < 3; i++)
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
    expect(record.lifecycle).toBe("paused");
    expect(record.lastSuccessAt).toBe(at);
    expect(record.observation!.headSha).toBe(sha);
    expect(record.counters.totalFailures).toBe(3);
    expect(() => prepare(f, record)).toThrow(/held/);
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
        "2099-01-01T00:02:00.000Z",
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
