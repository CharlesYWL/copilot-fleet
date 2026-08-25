import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@fleet/protocol";
import {
  pendingPermission,
  pendingPermissionRequests,
  toTerminalBlocks,
} from "./terminal-blocks";

let sequence = 0;

function event(
  type: SessionEvent["type"],
  payload: Record<string, unknown>,
): SessionEvent {
  sequence += 1;
  return {
    eventId: `e${sequence}`,
    sessionId: "s1",
    sequence,
    type,
    payload,
    createdAt: "2026-08-06T23:00:00.000Z",
  };
}

describe("toTerminalBlocks", () => {
  it("hides agent_session bookkeeping instead of reporting it as an error", () => {
    const blocks = toTerminalBlocks([
      event("agent_session", { agentSessionId: "copilot-abc" }),
      event("agent_text", { text: "hi" }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(["agent"]);
  });

  it("still renders real errors, falling back when the message is empty", () => {
    const blocks = toTerminalBlocks([
      event("error", { message: "boom" }),
      event("error", {}),
    ]);

    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["error", "boom"],
      ["error", "Unknown error"],
    ]);
  });

  it("merges consecutive streamed chunks into one block", () => {
    const blocks = toTerminalBlocks([
      event("agent_text", { text: "Looking " }),
      event("agent_text", { text: "at auth.ts" }),
      event("agent_thought", { text: "hmm" }),
      event("agent_text", { text: " again" }),
    ]);

    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["agent", "Looking at auth.ts"],
      ["thought", "hmm"],
      ["agent", " again"],
    ]);
  });

  it("collapses repeated tool updates onto the originating line", () => {
    const blocks = toTerminalBlocks([
      event("tool", { toolCallId: "t1", title: "read_file", status: "pending" }),
      event("tool", { toolCallId: "t1", status: "completed" }),
      event("tool", { toolCallId: "t2", title: "write_file", status: "pending" }),
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: "read_file", status: "completed" });
    expect(blocks[1]).toMatchObject({ text: "write_file", status: "pending" });
  });

  it("keeps the icon and detail a later update no longer restates", () => {
    // A completion frame carries a status and nothing else. Copying it wholesale
    // would blank the line the reader has been watching since the call started,
    // leaving a bare title where the command used to be.
    const blocks = toTerminalBlocks([
      event("tool", {
        toolCallId: "t1",
        title: "Run tests",
        kind: "execute",
        detail: "npm test",
        status: "pending",
      }),
      event("tool", { toolCallId: "t1", status: "completed" }),
    ]);

    expect(blocks[0]).toMatchObject({
      text: "Run tests",
      toolKind: "execute",
      detail: "npm test",
      status: "completed",
    });
  });

  it("promotes user prompts and drops raw protocol noise", () => {
    const blocks = toTerminalBlocks([
      event("system", { text: "User: fix the bug" }),
      event("system", { update: { sessionUpdate: "plan" } }),
      event("system", { text: "npm warn something" }),
    ]);

    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["user", "fix the bug"],
      ["system", "npm warn something"],
    ]);
  });

  it("folds an orchestrator wake into a step line instead of a chat bubble", () => {
    const blocks = toTerminalBlocks([
      event("system", {
        text: [
          'User: <fleet-wake task="Migration UI Bugs" phase="Open PR" (1/1) wakes=2/12>',
          "Just finished:",
          "- Open PR for the fix (implement): succeeded",
          "  A very long paragraph of everything the worker did, repeated at length.",
          "</fleet-wake>",
          "",
          "Nothing else is running. Dispatch the next step, or report and stop.",
        ].join("\n"),
      }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "wake",
      text: "1 worker finished",
      detail:
        "Migration UI Bugs · Open PR (1/1) · Open PR for the fix: succeeded · wake 2/12",
    });
    // The envelope is kept whole, because the row is a fold and not a summary
    // the reader has to trust without being able to check it.
    expect(blocks[0]?.body).toContain("repeated at length");
  });

  it("skips a payload that lost its shape instead of printing a blank line", () => {
    const blocks = toTerminalBlocks([
      event("agent_text", { text: 42 }),
      event("state", { state: "elsewhere", activity: "who knows" }),
      event("agent_text", { text: "still here" }),
    ]);

    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["agent", "still here"],
    ]);
  });

  it("hides per-turn state churn but keeps terminal states", () => {
    const blocks = toTerminalBlocks([
      event("state", { state: "starting", activity: "Starting Copilot ACP" }),
      event("state", { state: "running", activity: "Copilot is working" }),
      event("state", { state: "idle", activity: "Ready for follow-up" }),
      event("state", { state: "failed", activity: "Copilot exited (1)" }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "state", text: "Copilot exited (1)" });
  });
});

describe("pendingPermission", () => {
  it("returns only the request that has no matching result", () => {
    const events = [
      event("permission", { requestId: "r1", title: "run tests" }),
      event("permission_result", { requestId: "r1", outcome: "allow_once" }),
      event("permission", { requestId: "r2", title: "delete file" }),
    ];

    expect(pendingPermission(events)?.payload.requestId).toBe("r2");
    expect(pendingPermission(events.slice(0, 2))).toBeUndefined();
  });
});

describe("pendingPermissionRequests", () => {
  it("keeps the request event so alerts can name the tool and session", () => {
    const events = [
      event("permission", { requestId: "r1", title: "run tests" }),
      event("permission_result", { requestId: "r1", outcome: "allow_once" }),
      event("permission", { requestId: "r2", title: "delete file" }),
      event("permission", { requestId: "r3", title: "fetch url" }),
    ];

    expect(pendingPermissionRequests(events).map((item) => item.payload.title)).toEqual([
      "delete file",
      "fetch url",
    ]);
  });
});
