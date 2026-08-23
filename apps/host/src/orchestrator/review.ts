import type { Run } from "@fleet/protocol";

export type ReviewInput = { approved: boolean; note?: string | undefined };

export type ReviewOutcome =
  | { kind: "not_found" }
  | { kind: "not_waiting" }
  | { kind: "needs_reason" }
  | { kind: "approve"; note: string }
  | { kind: "send_back"; note: string; prompt: string };

/**
 * What a person's answer to a finished task means.
 *
 * Pure, because the interesting part is the decision and not the HTTP around
 * it: a task that nobody handed over cannot be answered, and sending one back
 * without saying why would restart the work with nothing to act on.
 */
export function reviewOutcome(run: Run | undefined, input: ReviewInput): ReviewOutcome {
  if (!run) return { kind: "not_found" };
  if (run.state !== "awaiting_human") return { kind: "not_waiting" };
  if (input.approved) return { kind: "approve", note: input.note?.trim() ?? "" };

  const note = input.note?.trim() ?? "";
  if (!note) return { kind: "needs_reason" };
  return { kind: "send_back", note, prompt: sendBackPrompt(run.name, note) };
}

/**
 * The turn a sent-back task arrives as.
 *
 * Shaped like a wake rather than a chat message: the orchestrator has been
 * treating `<fleet-...>` blocks as facts to act on since its first turn, and a
 * bare sentence from a person reads as something to discuss instead.
 */
function sendBackPrompt(task: string, note: string): string {
  return [
    `<fleet-review task=${JSON.stringify(task)} verdict="changes requested">`,
    note,
    "</fleet-review>",
    "",
    "Act on this: dispatch the work it calls for, then end your turn.",
    "Call fleet_submit_task again once it is addressed.",
  ].join("\n");
}

/**
 * The turn a reopened task arrives as.
 *
 * Same shape as a send-back and deliberately so — from the orchestrator's side
 * these are the same event, a person saying the work is not finished after all.
 * What differs is only that the task had already been closed, which is worth
 * saying because its own history will read as complete.
 */
export function reopenPrompt(task: string, note: string): string {
  return [
    `<fleet-review task=${JSON.stringify(task)} verdict="reopened">`,
    note,
    "</fleet-review>",
    "",
    "This task was finished and has been reopened, so its notes and criteria",
    "describe work you already did. Read them before deciding anything.",
    "Act on the above: dispatch what it calls for, then end your turn.",
    "Call fleet_submit_task again once it is addressed.",
  ].join("\n");
}
