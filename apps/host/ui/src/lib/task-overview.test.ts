import { describe, expect, it } from "vitest";
import { RunPolicySchema, RunStepSchema, type Run, type RunNote } from "@fleet/protocol";
import { buildRunViewModels } from "./orchestration-view";
import { blockedReview, latestReviewNote, taskOverview } from "./task-overview";

const at = "2026-09-22T04:14:53.797Z";
const run = (overrides: Partial<Run> = {}): Run => ({
  id: "task",
  workspaceId: "workspace",
  name: "Rollout",
  objective: "Reach PROD",
  state: "running",
  leadSessionId: "lead",
  placementId: "",
  policy: RunPolicySchema.parse({}),
  phases: ["MSIT"],
  phaseIndex: 0,
  successCriteria: [],
  stopWhen: "",
  failureReason: "",
  pendingPrompt: "",
  settleSeq: 0,
  wakeSeq: 0,
  emptyWakeCount: 0,
  reviewSeq: 1,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});
const model = (overrides: Partial<Run> = {}) =>
  buildRunViewModels({
    runs: [run(overrides)],
    stepsByRun: {},
    sessions: [],
  })[0]!;
const note = (overrides: Partial<RunNote> = {}): RunNote => ({
  id: "note",
  runId: "task",
  phaseIndex: 0,
  body: "Original full report",
  createdAt: at,
  ...overrides,
});

describe("task overview", () => {
  it("uses the saved short summary rather than copying the whole report", () => {
    const report = note({
      kind: "blocked",
      source: "orchestrator",
      summary: "Command permission expired; the MSIT PR was not created.",
      body: "Receipts and criteria. ".repeat(100),
    });
    expect(taskOverview(model({ state: "awaiting_human" }), [report], undefined)).toEqual(
      {
        title: "Your decision is needed",
        summary: report.summary,
        attention: true,
      },
    );
  });

  it("keeps an incomplete handover blocked after a late worker result", () => {
    const report = note({ kind: "blocked", summary: "A design decision is required." });
    const notes = [
      report,
      note({ id: "worker-note", kind: "worker", summary: "Worker succeeded" }),
    ];
    expect(latestReviewNote(notes)).toEqual(report);
    expect(blockedReview(latestReviewNote(notes))).toBe(true);
    expect(taskOverview(model({ state: "awaiting_human" }), notes, undefined).title).toBe(
      "Your decision is needed",
    );
  });

  it("keeps legacy reports intact without generating an invented summary", () => {
    const report = note({
      body: "**Escalated \u2014 this task is not finished.**\n\nOriginal blocker.",
    });
    const overview = taskOverview(
      model({ state: "awaiting_human" }),
      [report],
      undefined,
    );
    expect(overview.title).toBe("Your decision is needed");
    expect(overview.summary).toContain("review the original report");
    expect(report.summary).toBeUndefined();
  });

  it.each([
    ["blocked", "Task blocked", true],
    ["aggregating", "Integrating the work", false],
    ["awaiting_approval", "Task not started", false],
    ["completed", "Task completed", false],
    ["failed", "Task failed", true],
    ["cancelled", "Task stopped", false],
  ] as const)("keeps the authoritative %s state visible", (state, title, attention) => {
    expect(taskOverview(model({ state }), [], undefined)).toMatchObject({
      title,
      attention,
    });
  });

  it("does not claim readiness when maintenance cannot be read", () => {
    expect(
      taskOverview(model({ state: "completed" }), [], {
        records: [],
        canAuthorize: false,
        statusError: "Read failed",
      }),
    ).toMatchObject({ title: "PR maintenance status unavailable", attention: true });
  });

  it("does not reuse a progress summary after newer worker activity", () => {
    const work = RunStepSchema.parse({
      id: "step",
      runId: "task",
      stepKey: "work",
      title: "Work",
      prompt: "Implement",
      state: "running",
      createdAt: at,
      updatedAt: "2026-09-22T04:20:00.000Z",
    });
    const current = buildRunViewModels({
      runs: [run()],
      stepsByRun: { task: [work] },
      sessions: [],
    })[0]!;
    const overview = taskOverview(
      current,
      [note({ kind: "progress", summary: "Earlier milestone." })],
      undefined,
    );
    expect(overview.title).toBe("Working on MSIT");
    expect(overview.summary).not.toBe("Earlier milestone.");
  });
});
