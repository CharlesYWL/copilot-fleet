import { describe, expect, it } from "vitest";
import { RunPolicySchema, type Run } from "@fleet/protocol";
import { reviewOutcome } from "./review.js";

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "r1",
  workspaceId: "w1",
  name: "Ship it",
  objective: "make the change",
  state: "awaiting_human",
  leadSessionId: "lead",
  placementId: "",
  policy: RunPolicySchema.parse({}),
  phases: ["Plan", "Review"],
  phaseIndex: 1,
  successCriteria: [],
  stopWhen: "",
  failureReason: "",
  pendingPrompt: "",
  settleSeq: 0,
  wakeSeq: 0,
  emptyWakeCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("reviewOutcome", () => {
  it("approves a task that was handed over", () => {
    expect(reviewOutcome(run(), { approved: true })).toEqual({
      kind: "approve",
      note: "",
    });
  });

  it("sends a task back with the note as the instruction", () => {
    const outcome = reviewOutcome(run(), {
      approved: false,
      note: "  The migration is missing.  ",
    });

    expect(outcome.kind).toBe("send_back");
    if (outcome.kind !== "send_back") return;
    expect(outcome.note).toBe("The migration is missing.");
    // Shaped like a wake, because that is what the orchestrator acts on.
    expect(outcome.prompt).toContain("<fleet-review");
    expect(outcome.prompt).toContain("The migration is missing.");
    expect(outcome.prompt).toContain("fleet_submit_task");
  });

  it("will not send a task back with nothing to act on", () => {
    expect(reviewOutcome(run(), { approved: false, note: "   " }).kind).toBe(
      "needs_reason",
    );
    expect(reviewOutcome(run(), { approved: false }).kind).toBe("needs_reason");
  });

  it("refuses to answer a task nobody handed over", () => {
    // The person is asked once, at the end; the orchestrator moves the task
    // between phases itself, and answering mid-work would decide something
    // nobody was waiting on.
    expect(reviewOutcome(run({ state: "running" }), { approved: true }).kind).toBe(
      "not_waiting",
    );
    expect(reviewOutcome(run({ state: "completed" }), { approved: true }).kind).toBe(
      "not_waiting",
    );
  });

  it("refuses a task that does not exist", () => {
    expect(reviewOutcome(undefined, { approved: true }).kind).toBe("not_found");
  });
});
