import { describe, expect, it } from "vitest";
import { RunPolicySchema, type Run } from "@fleet/protocol";
import {
  maintenanceDirectionPrompt,
  reopenPrompt,
  reviewOutcome,
  sendBackPrompt,
} from "./review.js";

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
  reviewSeq: 0,
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

  it("never treats task approval as permission for a maintenance design change", () => {
    expect(reviewOutcome(run(), { approved: true }, true)).toEqual({
      kind: "maintenance_direction_required",
    });
    expect(reviewOutcome(run(), { approved: false, note: " " }, true).kind).toBe(
      "needs_reason",
    );
    const prompt = maintenanceDirectionPrompt("Ship it", "decision-1", "Keep the API");
    expect(prompt).toContain('decision="decision-1"');
    expect(prompt).toContain("Keep the API");
    expect(prompt).toContain("Preserve unresolved findings");
    expect(prompt).not.toContain("Call fleet_submit_task");
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
    expect(outcome.prompt).toContain("dispatch a worker or fixer");
    expect(outcome.prompt).toContain("it does not edit the repository");
    expect(outcome.prompt).toContain("authorized writing worker may commit");
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

/*
 * Reopening is the same event as a send-back from the orchestrator's side — a
 * person saying the work is not finished — with one difference worth spelling
 * out in the prompt: the task's own notes and criteria describe work it already
 * did, and will read as complete.
 */
describe("reopening a finished task", () => {
  it("tells the orchestrator its own history is stale", () => {
    const prompt = reopenPrompt("Ship it", "the migration is still missing");

    expect(prompt).toContain('<fleet-review task="Ship it" verdict="reopened">');
    expect(prompt).toContain("the migration is still missing");
    expect(prompt).toContain("was finished and has been reopened");
    expect(prompt).toContain("Read them before deciding anything");
  });

  it("asks for the same closing move as any other review", () => {
    // So the orchestrator does not have to learn a second protocol for what is
    // the same situation: act, end the turn, submit again.
    expect(reopenPrompt("Ship it", "not done")).toContain("fleet_submit_task");
    expect(reopenPrompt("Ship it", "not done")).toContain("end your turn");
    expect(reopenPrompt("Ship it", "not done")).toContain(
      "only when the whole task is ready",
    );
  });
});

describe.each([
  ["send back", sendBackPrompt],
  ["reopen", reopenPrompt],
] as const)("%s delivery contract", (_label, promptFor) => {
  it("delegates requested publication without making submission its prerequisite", () => {
    const prompt = promptFor("Series", "Publish the ready slice as a draft PR.");
    expect(prompt).toContain("Publish the ready slice as a draft PR.");
    expect(prompt).toContain("fleet_follow_up for the retained worker");
    expect(prompt).toContain("does not prohibit authorized writing workers");
    expect(prompt).toContain("create a source branch, push, and create/update the PR");
    expect(prompt).toContain("actual checkout/provider permissions");
    expect(prompt).toContain("fleet_submit_task is not a prerequisite");
    expect(prompt).toContain("Record partial results and continue the parent");
    expect(prompt).toContain("never mark unmet criteria met");
    expect(prompt).toContain("provider-observed source/head and base identities");
    expect(prompt).toContain("verification results and limitations");
    expect(prompt).toContain("report the exact denial");
    expect(prompt).not.toContain("The Host owns integration");
    expect(prompt).not.toContain("so Fleet creates");
  });

  it("preserves restricted modes, worker autonomy and the normal completion wake", () => {
    const prompt = promptFor("Series", "Continue.");
    expect(prompt).toContain("Read-only work grants no publication authority");
    expect(prompt).toContain("sealed-result and explicit approval gates");
    expect(prompt).toContain("Registered PR maintenance still requires authenticated");
    expect(prompt).toContain("retained-worker binding and prepared batch");
    expect(prompt).toContain("The worker chooses the investigation");
    expect(prompt).toContain("Distinguish historical facts from current observations");
    expect(prompt).toContain("normal turn response");
    expect(prompt).toContain("wakes the orchestrator automatically");
    expect(prompt).toContain("Do not poll");
  });
});
