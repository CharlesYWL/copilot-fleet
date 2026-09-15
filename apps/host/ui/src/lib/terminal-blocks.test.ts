import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@fleet/protocol";
import { statusCheckEnvelope, wakeEnvelope } from "../../../src/orchestrator/briefing";
import { reopenPrompt } from "../../../src/orchestrator/review";
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

  it("keeps a task completion response through the status-only final update", () => {
    const blocks = toTerminalBlocks([
      event("tool", {
        toolCallId: "done",
        title: "task_complete",
        response: "The branch is main.",
        status: "pending",
      }),
      event("tool", { toolCallId: "done", status: "completed" }),
    ]);

    expect(blocks[0]).toMatchObject({
      text: "task_complete",
      status: "completed",
      body: "The branch is main.",
    });
  });

  it("keeps the failure reason on a failed tool row", () => {
    const blocks = toTerminalBlocks([
      event("tool", {
        toolCallId: "fleet",
        title: "fleet-fleet_list_work",
        status: "pending",
      }),
      event("tool", {
        toolCallId: "fleet",
        status: "failed",
        error: "MCP server 'fleet': Tool does not exist.",
      }),
    ]);

    expect(blocks[0]).toMatchObject({
      text: "fleet-fleet_list_work",
      status: "failed",
      body: "MCP server 'fleet': Tool does not exist.",
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

  it("recognises current wake envelopes with stable task and worker IDs", () => {
    const prompt = wakeEnvelope({
      runId: "task-1",
      task: 'Fix the "banner"',
      phase: "Verify",
      phaseNumber: 1,
      phaseCount: 1,
      isLastPhase: true,
      wakes: 2,
      maxWakes: 12,
      settled: [
        {
          title: "Verify the fix",
          category: "test",
          state: "succeeded",
          output: "The regression passed.",
          sessionId: "worker-1",
        },
      ],
      running: [],
    });
    const source = event("system", { text: `User: ${prompt}` });

    expect(toTerminalBlocks([source])).toEqual([
      {
        key: source.eventId,
        kind: "wake",
        text: "1 worker finished",
        detail: 'Fix the "banner" · Verify (1/1) · Verify the fix: succeeded · wake 2/12',
        body: prompt,
        createdAt: source.createdAt,
      },
    ]);
  });

  it.each([
    {
      // sendBackPrompt in apps/host/src/orchestrator/review.ts.
      prompt: [
        '<fleet-review task="Fix query acceleration teaching banner 5476738" verdict="changes requested">',
        "https://github.com/example/repo/pull/42",
        "The teaching banner still covers the query.",
        "</fleet-review>",
        "",
        "Act on this: dispatch the work it calls for, then end your turn.",
        "Call fleet_submit_task again once it is addressed.",
      ].join("\n"),
      title: "Changes requested",
      detail: "Fix query acceleration teaching banner 5476738",
    },
    {
      prompt: reopenPrompt('Fix the "banner" in C:\\repo', "The regression is back."),
      title: "Task reopened",
      detail: 'Fix the "banner" in C:\\repo',
    },
    {
      // taskBrief in apps/host/src/routes/orchestrators.ts.
      prompt: [
        '<fleet-task name="Fix the banner" workspace="C:\\\\repo">',
        "Keep the query visible.",
        "</fleet-task>",
        "",
        'Plan this with fleet_plan_task using the task name "Fix the banner", then dispatch the',
        "work for its first phase and end your turn.",
      ].join("\n"),
      title: "Task received",
      detail: "Fix the banner · C:\\repo",
    },
    {
      prompt: statusCheckEnvelope([
        {
          name: "Fix the banner",
          state: "running",
          phase: "phase 1/1: Verify",
          openSteps: 1,
          dispatchedSteps: 1,
        },
      ]),
      title: "Status check",
      detail: "30m interval",
    },
  ])(
    "folds $title with the full payload, timestamp and key intact",
    ({ prompt, title, detail }) => {
      const source = event("system", { text: `User: ${prompt}` });

      expect(toTerminalBlocks([source])).toEqual([
        {
          key: source.eventId,
          kind: "wake",
          text: title,
          detail,
          body: prompt,
          createdAt: source.createdAt,
        },
      ]);
    },
  );

  it.each([
    'Explain <fleet-review task="Fix" verdict="reopened"> and <fleet-wake>.',
    'Inspect this:\n<fleet-review task="Fix" verdict="reopened">\nnote\n</fleet-review>',
    '```xml\n<fleet-review task="Fix" verdict="reopened">\nnote\n</fleet-review>\n```',
    "<fleet-review>\nWhat does this tag do?\n</fleet-review>",
    '<fleet-review task="Fix" verdict="reopened">\nWhat does this header mean?',
    '<fleet-review task="Fix" verdict="reopened">\nnote\n</fleet-task>',
    '<fleet-task name="Fix">\nAn example, not a task brief.\n</fleet-task>',
    "<fleet-status-check>\nWhat is this?\n</fleet-status-check>",
    "Fix the banner.\n\n<fleet-workspace>\nUse the bound checkout.\n</fleet-workspace>",
  ])(
    "keeps literal tag mentions and incomplete frames as human prompts: %s",
    (prompt) => {
      const source = event("system", {
        text: `User: ${prompt}`,
        attachments: [{ name: "banner.png", mimeType: "image/png", bytes: 128 }],
      });

      expect(toTerminalBlocks([source])).toEqual([
        {
          key: source.eventId,
          kind: "user",
          text: prompt,
          createdAt: source.createdAt,
          attachments: source.payload.attachments,
        },
      ]);
    },
  );

  it("only folds the prompt channel, preserving streaming merges and tool responses", () => {
    const prompt = reopenPrompt("Fix the banner", "The regression is back.");
    const first = event("agent_text", { text: "Before " });
    const thought = event("agent_thought", { text: "Considering " });
    const tool = event("tool", {
      toolCallId: "t1",
      title: "Read review",
      response: prompt,
      status: "pending",
    });
    const blocks = toTerminalBlocks([
      first,
      event("agent_text", { text: "the review." }),
      event("system", { text: `User: ${prompt}` }),
      thought,
      event("agent_thought", { text: "the fix." }),
      tool,
      event("tool", { toolCallId: "t1", status: "completed" }),
      event("agent_text", { text: prompt }),
      event("system", { text: prompt }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      "agent",
      "wake",
      "thought",
      "tool",
      "agent",
      "system",
    ]);
    expect(blocks[0]).toMatchObject({
      key: first.eventId,
      text: "Before the review.",
      createdAt: first.createdAt,
    });
    expect(blocks[2]).toMatchObject({
      key: thought.eventId,
      text: "Considering the fix.",
      createdAt: thought.createdAt,
    });
    expect(blocks[3]).toMatchObject({
      key: tool.eventId,
      body: prompt,
      status: "completed",
      createdAt: tool.createdAt,
    });
    expect(blocks[4]?.text).toBe(prompt);
    expect(blocks[5]?.text).toBe(prompt);
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
