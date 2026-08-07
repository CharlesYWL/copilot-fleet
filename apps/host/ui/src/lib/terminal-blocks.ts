import type { SessionEvent } from "@fleet/protocol";

export type TerminalBlockKind =
  | "user"
  | "agent"
  | "thought"
  | "tool"
  | "permission"
  | "permission_result"
  | "turn"
  | "state"
  | "error"
  | "system";

export type TerminalBlock = {
  key: string;
  kind: TerminalBlockKind;
  text: string;
  createdAt: string;
  status?: string;
};

const USER_PREFIX = "User: ";

/** States already shown by the session header; repeating them adds only noise. */
const noisyStates = new Set(["queued", "starting", "running", "idle", "cancelling"]);

/**
 * Collapses the raw ACP event stream into terminal lines: streamed text chunks
 * become one flowing block and repeated tool updates collapse onto one line.
 */
export function toTerminalBlocks(events: SessionEvent[]): TerminalBlock[] {
  const blocks: TerminalBlock[] = [];
  const toolBlockIndex = new Map<string, number>();

  const appendMerged = (kind: "agent" | "thought", event: SessionEvent, text: string) => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === kind) {
      last.text += text;
      return;
    }
    blocks.push({ key: event.eventId, kind, text, createdAt: event.createdAt });
  };

  for (const event of events) {
    if (event.type === "agent_text" || event.type === "agent_thought") {
      const text = asText(event.payload.text);
      if (text) {
        appendMerged(event.type === "agent_text" ? "agent" : "thought", event, text);
      }
      continue;
    }

    if (event.type === "tool") {
      const toolCallId = asText(event.payload.toolCallId);
      const status = asText(event.payload.status);
      const title = asText(event.payload.title);
      const existing = toolCallId ? toolBlockIndex.get(toolCallId) : undefined;
      const previous = existing === undefined ? undefined : blocks[existing];
      if (previous) {
        if (title) previous.text = title;
        if (status) previous.status = status;
        continue;
      }
      blocks.push({
        key: event.eventId,
        kind: "tool",
        text: title || "Tool call",
        createdAt: event.createdAt,
        ...(status ? { status } : {}),
      });
      if (toolCallId) toolBlockIndex.set(toolCallId, blocks.length - 1);
      continue;
    }

    if (event.type === "state") {
      const state = asText(event.payload.state);
      if (!state || noisyStates.has(state)) continue;
      blocks.push({
        key: event.eventId,
        kind: "state",
        text: asText(event.payload.activity) || state,
        createdAt: event.createdAt,
        status: state,
      });
      continue;
    }

    if (event.type === "system") {
      const text = asText(event.payload.text);
      if (!text) continue;
      const isUser = text.startsWith(USER_PREFIX);
      blocks.push({
        key: event.eventId,
        kind: isUser ? "user" : "system",
        text: isUser ? text.slice(USER_PREFIX.length) : text,
        createdAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "permission") {
      blocks.push({
        key: event.eventId,
        kind: "permission",
        text: asText(event.payload.title) || "Tool permission requested",
        createdAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "permission_result") {
      blocks.push({
        key: event.eventId,
        kind: "permission_result",
        text: `Permission ${asText(event.payload.outcome) || "resolved"}`,
        createdAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "turn_complete") {
      blocks.push({
        key: event.eventId,
        kind: "turn",
        text: asText(event.payload.stopReason) || "end_turn",
        createdAt: event.createdAt,
      });
      continue;
    }

    blocks.push({
      key: event.eventId,
      kind: "error",
      text: asText(event.payload.message) || "Unknown error",
      createdAt: event.createdAt,
    });
  }

  return blocks;
}

/** The permission request still waiting on a browser decision, if any. */
export function pendingPermission(events: SessionEvent[]): SessionEvent | undefined {
  const handled = new Set(
    events
      .filter((event) => event.type === "permission_result")
      .map((event) => asText(event.payload.requestId)),
  );
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "permission" && !handled.has(asText(event.payload.requestId)),
    );
}

/** Every permission request, across any session, still awaiting a decision. */
export function pendingPermissionRequests(events: SessionEvent[]): SessionEvent[] {
  const pending = new Map<string, SessionEvent>();
  for (const event of events) {
    const requestId = asText(event.payload.requestId);
    if (!requestId) continue;
    if (event.type === "permission") pending.set(requestId, event);
    if (event.type === "permission_result") pending.delete(requestId);
  }
  return [...pending.values()];
}

export function pendingPermissionCount(events: SessionEvent[]): number {
  return pendingPermissionRequests(events).length;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
