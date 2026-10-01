import { describe, expect, it } from "vitest";
import {
  TranscriptProjector,
  changedBlock,
  toTerminalBlocks,
  type SessionEvent,
  type TerminalBlock,
} from "./index.js";

let sequence = 0;
const event = (
  type: SessionEvent["type"],
  payload: Record<string, unknown>,
): SessionEvent => ({
  eventId: `e${++sequence}`,
  sessionId: "s1",
  sequence,
  type,
  payload,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
});

function history(): SessionEvent[] {
  sequence = 0;
  return [
    event("system", { text: "Agency startup" }),
    event("system", { text: "Resolving Copilot CLI..." }),
    event("agent_session", { agentSessionId: "agent" }),
    event("commands", { commands: [] }),
    event("system", { text: "User: inspect the retry helper" }),
    event("state", { state: "running", activity: "Working" }),
    event("agent_thought", { text: "Look at " }),
    event("agent_thought", { text: "the helper." }),
    event("tool", {
      toolCallId: "read",
      title: "Read file",
      kind: "read",
      status: "pending",
    }),
    event("agent_text", { text: "" }),
    event("agent_text", { text: "It retries " }),
    event("usage", { aiCredits: 1 }),
    event("tool", {
      toolCallId: "edit",
      title: "Edit file",
      kind: "edit",
      status: "pending",
    }),
    event("permission", { requestId: "p1", title: "Edit retry.ts" }),
    event("permission_result", { requestId: "p1", outcome: "allow_once" }),
    event("tool", { toolCallId: "edit", status: "completed", detail: "retry.ts" }),
    event("tool", { toolCallId: "read", status: "completed" }),
    event("tool", { toolCallId: "read" }),
    event("agent_text", { text: "three times." }),
    event("turn_complete", { stopReason: "end_turn" }),
    event("system", {
      text: 'User: <fleet-wake task="Fix" wakes=1/12>\nJust finished:\n- Fix: succeeded\n</fleet-wake>',
    }),
    event("state", { state: "failed", activity: "Copilot exited" }),
    event("error", { message: "Copilot did not become ready" }),
    event("system", {
      text: "User: now ship it",
      attachments: [{ name: "a.png", mimeType: "image/png", bytes: 3 }],
    }),
    // A late update to a tool that is no longer the newest block.
    event("tool", { toolCallId: "read", status: "failed", error: "Read again later" }),
    event("tool", { title: "Untracked tool" }),
    event("agent_text", { text: "Shipping." }),
  ];
}

const freeze = (blocks: readonly TerminalBlock[]) =>
  blocks.map((block) => Object.freeze({ ...block }));

describe("TranscriptProjector", () => {
  it("matches the whole-history fold after every event when its changes are replayed", () => {
    const events = history();
    const projector = new TranscriptProjector();
    let reader: TerminalBlock[] = [];
    events.forEach((item, position) => {
      const change = projector.apply(item);
      if (change) {
        const next = changedBlock(reader[change.index], change);
        expect(next).toBeDefined();
        expect(change.index).toBeLessThanOrEqual(reader.length);
        reader = reader.slice();
        reader[change.index] = next!;
      }
      const expected = toTerminalBlocks(events.slice(0, position + 1));
      expect(reader).toEqual(expected);
      expect(projector.blocks).toEqual(expected);
    });
  });

  it("replaces only the changed block and never edits one already handed out", () => {
    const events = history();
    const projector = new TranscriptProjector();
    for (const item of events.slice(0, 7)) projector.apply(item);
    const before = freeze(projector.blocks);
    projector.blocks.splice(0, projector.blocks.length, ...before);
    const snapshot = structuredClone(before);

    const growth = projector.apply(events[7]!);
    expect(growth).toEqual({ index: before.length - 1, append: "the helper." });

    expect(before).toEqual(snapshot);
    projector.blocks.forEach((block, index) => {
      if (index === growth!.index) expect(block).not.toBe(before[index]);
      else expect(block).toBe(before[index]);
    });
  });

  it("updates an older tool block in place and reports its position", () => {
    const events = history();
    const projector = new TranscriptProjector();
    for (const item of events.slice(0, -3)) projector.apply(item);
    const readIndex = projector.blocks.findIndex((block) => block.text === "Read file");
    const previous = projector.blocks[readIndex];
    const change = projector.apply(events.at(-3)!);
    expect(change).toEqual({
      index: readIndex,
      block: { ...previous, status: "failed", body: "Read again later" },
    });
    expect(readIndex).toBeLessThan(projector.blocks.length - 1);
  });

  it("reports nothing for events that leave the transcript unchanged", () => {
    sequence = 0;
    const projector = new TranscriptProjector();
    expect(projector.apply(event("usage", { aiCredits: 1 }))).toBeUndefined();
    expect(projector.apply(event("agent_text", { text: "" }))).toBeUndefined();
    expect(projector.apply(event("state", { state: "running" }))).toBeUndefined();
    projector.apply(event("tool", { toolCallId: "t", title: "Read" }));
    expect(projector.apply(event("tool", { toolCallId: "t" }))).toBeUndefined();
    expect(changedBlock(undefined, { index: 0, append: "x" })).toBeUndefined();
  });

  it("indexes operator prompts but not Fleet control envelopes", () => {
    const projector = new TranscriptProjector();
    for (const item of history()) projector.apply(item);
    expect(projector.prompts.map(({ index, label }) => [index, label])).toEqual([
      [1, "inspect the retry helper"],
      [
        projector.blocks.findIndex((block) => block.text === "now ship it"),
        "now ship it",
      ],
    ]);
    for (const prompt of projector.prompts) {
      expect(projector.blocks[prompt.index]).toMatchObject({
        kind: "user",
        key: prompt.key,
      });
    }
  });
});
