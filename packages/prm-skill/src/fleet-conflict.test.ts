import { describe, expect, it } from "vitest";
import { fleetSettlement, fleetWorkOrder, workReportProblems } from "./fleet.js";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const published = "c".repeat(40);
const source = { id: "thread-1", revision: "r1", groupKey: "g", evidence: "Fix it." };
const record = {
  id: "job",
  generation: 1,
  identity: {
    host: "github.com",
    repository: "example/repo",
    prNumber: 7,
    headRepository: "example/repo",
    headRef: "refs/heads/fix",
    baseRef: "refs/heads/main",
  },
  authorization: {
    scope: {
      baseline: "Keep the design.",
      verification: "npm test",
      publicationAuthorized: true,
      replies: true,
      resolveThreads: true,
    },
    budgets: { repairBatches: 30, answerBatches: 30, mutationAttempts: 100 },
  },
  counters: { repairBatches: 0, answerBatches: 0, mutationAttempts: 0 },
  observation: { headSha, baseSha },
  findings: [],
};
const order = (conflictResolution: boolean) =>
  fleetWorkOrder({
    record,
    sources: [source],
    createdAt: new Date(0).toISOString(),
    plan: {
      batchId: "b1",
      summary: "Resolve it.",
      conflictResolution,
      reservedMutations: 2,
      findings: [
        {
          sourceId: source.id,
          revision: source.revision,
          task: "repair",
          instructions: "x",
        },
      ],
    },
  });
const report = (effect: Record<string, unknown>) => ({
  schema: "prm.work-report/1" as const,
  batchId: "b1",
  summary: "Rebased and pushed.",
  mutationAttempts: 1,
  findings: [
    {
      sourceId: source.id,
      revision: source.revision,
      outcome: "addressed" as const,
      stage: "published" as const,
      verifiedHeadSha: published,
      publishedCommit: published,
      responseIds: [],
      evidence: ["tests pass"],
    },
  ],
  effects: [
    { kind: "push" as const, state: "known" as const, commit: published, ...effect },
  ],
});

describe("Fleet conflict rebase contract", () => {
  it("tells the worker to rebase and push with a lease on the exact PR head", () => {
    const { workOrder, batch } = order(true);
    expect(workOrder.conflictResolution).toBe(true);
    expect(batch).toMatchObject({ conflictResolution: true, baseSha });
    const rules = workOrder.rules.join("\n");
    expect(rules).toContain("rebase the PR head branch");
    expect(rules).toContain("--force-with-lease=<headRef>:<pr.headSha>");
    expect(rules).toMatch(/Stop without pushing and report needs_human/);
    expect(rules).toContain("Never merge the PR");
    // Ordinary orders still forbid history rewrites.
    expect(order(false).workOrder.rules.join("\n")).toContain(
      "Never force-push, rebase or reset the PR branch (except the conflict-resolution procedure",
    );
  });

  it("passes every push's replaced head through and leaves the authorization call to Fleet", () => {
    const leased = report({ force: true, expectedRemoteSha: headSha });
    expect(workReportProblems(order(true).workOrder, leased)).toEqual([]);
    const settlement = fleetSettlement({
      batch: order(true).batch,
      workOrder: order(true).workOrder,
      report: leased,
      workerActor: "worker",
    });
    expect(settlement).toMatchObject({ state: "succeeded", published: true });
    expect(settlement.effects[0]).toMatchObject({
      kind: "push",
      force: true,
      expectedRemoteSha: headSha,
    });
    // A wrong lease or a forced push outside a conflict order is a fact Fleet
    // records and holds on; the report itself is still settled.
    for (const [conflict, effect] of [
      [true, { force: true, expectedRemoteSha: "d".repeat(40) }],
      [false, { force: true, expectedRemoteSha: headSha }],
    ] as const)
      expect(workReportProblems(order(conflict).workOrder, report(effect))).toEqual([]);
    const normal = fleetSettlement({
      batch: order(false).batch,
      workOrder: order(false).workOrder,
      report: report({ expectedRemoteSha: headSha }),
      workerActor: "worker",
    });
    expect(normal.effects[0]).toMatchObject({ kind: "push", expectedRemoteSha: headSha });
    expect(normal.effects[0]).not.toHaveProperty("force");
  });

  it("accepts a push without the replaced head; Fleet records it as unverified", () => {
    expect(workReportProblems(order(false).workOrder, report({}))).toEqual([]);
    expect(
      fleetSettlement({
        batch: order(false).batch,
        workOrder: order(false).workOrder,
        report: report({}),
        workerActor: "worker",
      }).effects[0],
    ).not.toHaveProperty("expectedRemoteSha");
    expect(
      workReportProblems(order(false).workOrder, report({ state: "not_performed" })),
    ).toEqual([]);
  });
});
