import type { SessionEvent } from "@fleet/protocol";

export const HISTORY_FIXTURE_VERSION = 1;
export const EVENTS_PER_TURN = 200;

const startedAt = Date.UTC(2026, 0, 1);
const chunks = ["Inspect fixtures. ", "Check invariants. ", "Trace data flow. "];
const commands = Array.from({ length: 24 }, (_, index) => ({
  name: `synthetic-command-${index}`,
  description: "Synthetic command documentation. ".repeat(6),
}));
const config = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "synthetic",
    options: [{ value: "synthetic", name: "Synthetic model" }],
  },
];

/** 170 small chunks and 30 other events per turn, folding into ten blocks. */
export function* historyEvents(
  sessionId: string,
  sessionIndex: number,
  count: number,
): Generator<SessionEvent> {
  for (let index = 0; index < count; index++) {
    const turn = Math.floor(index / EVENTS_PER_TURN);
    const slot = index % EVENTS_PER_TURN;
    const readId = `${sessionId}:read:${turn}`;
    const editId = `${sessionId}:edit:${turn}`;
    const doneId = `${sessionId}:done:${turn}`;
    const requestId = `${sessionId}:permission:${turn}`;
    let type: SessionEvent["type"];
    let payload: SessionEvent["payload"];
    if (slot === 0) {
      type = "system";
      payload = {
        text:
          turn % 20 === 19
            ? 'User: <fleet-status-check interval="30m">\nSynthetic check\n</fleet-status-check>'
            : `User: Inspect synthetic example ${turn}.`,
      };
    } else if (slot === 1) {
      type = "state";
      payload = { state: "running", activity: "Synthetic work" };
    } else if (slot === 2) {
      type = "commands";
      payload = { commands };
    } else if (slot === 3) {
      type = "config";
      payload = { options: config };
    } else if (slot === 4) {
      type = "agent_session";
      payload = { agentSessionId: `synthetic-${sessionId}` };
    } else if (slot <= 106 || (slot >= 113 && slot <= 180)) {
      type = slot <= 38 ? "agent_thought" : "agent_text";
      payload = { text: chunks[index % chunks.length]! };
    } else if (slot === 107) {
      type = "permission";
      payload = { requestId, toolCallId: readId, title: "Inspect synthetic input" };
    } else if (slot === 108 || slot === 109) {
      type = "tool";
      payload = {
        toolCallId: slot === 108 ? readId : editId,
        title: slot === 108 ? "Read fixture" : "Edit fixture",
        kind: slot === 108 ? "read" : "edit",
        detail: "synthetic.ts",
        status: "pending",
      };
    } else if (slot === 110) {
      type = "permission_result";
      payload = { requestId, outcome: "allow_once" };
    } else if (slot === 111 || slot === 112) {
      type = "tool";
      payload = {
        toolCallId: slot === 111 ? editId : readId,
        status: "completed",
      };
    } else if (slot === 181 || slot === 182) {
      type = "tool";
      payload = {
        toolCallId: doneId,
        title: "task_complete",
        status: slot === 181 ? "pending" : "completed",
        ...(slot === 182
          ? {
              response:
                "## Synthetic result\n\n| Item | Status |\n| --- | --- |\n| Fixture | Ready |\n\n" +
                "```ts\nconst label = '\u03bb';\n```\n" +
                (turn === 0 ? "Large synthetic tool output.\n".repeat(2400) : ""),
            }
          : {}),
      };
    } else if (slot === 199) {
      type = "turn_complete";
      payload = { stopReason: "end_turn" };
    } else {
      type = "usage";
      payload = { aiCredits: (turn + 1) / 100 };
    }
    yield {
      eventId: `${sessionIndex.toString(16).padStart(8, "0")}-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      sessionId,
      sequence: index + 1,
      type,
      payload,
      createdAt: new Date(startedAt + index * 20).toISOString(),
    };
  }
}

export function incomingEvents(
  sessionId: string,
  sequence: number,
): Record<string, SessionEvent> {
  const event = (type: SessionEvent["type"], payload: SessionEvent["payload"]) => ({
    eventId: `incoming:${sessionId}:${type}`,
    sessionId,
    sequence,
    type,
    payload,
    createdAt: new Date(startedAt + sequence * 20).toISOString(),
  });
  return {
    text: event("agent_text", { text: "Another fragment. " }),
    thought: event("agent_thought", { text: "Check the result. " }),
    olderTool: event("tool", {
      toolCallId: `${sessionId}:read:0`,
      status: "failed",
      error: "Synthetic late tool failure",
    }),
    permission: event("permission", {
      requestId: `${sessionId}:new-permission`,
      title: "Review synthetic operation",
    }),
  };
}
