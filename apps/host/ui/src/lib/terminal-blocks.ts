import { eventPayload, type SessionEvent } from "@fleet/protocol";

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
      const text = eventPayload(event, event.type)?.text ?? "";
      if (text) {
        appendMerged(event.type === "agent_text" ? "agent" : "thought", event, text);
      }
      continue;
    }

    if (event.type === "tool") {
      const payload = eventPayload(event, "tool");
      const toolCallId = payload?.toolCallId ?? "";
      const status = payload?.status ?? "";
      const title = payload?.title ?? "";
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
      const payload = eventPayload(event, "state");
      const state = payload?.state ?? "";
      if (!state || noisyStates.has(state)) continue;
      blocks.push({
        key: event.eventId,
        kind: "state",
        text: payload?.activity || state,
        createdAt: event.createdAt,
        status: state,
      });
      continue;
    }

    if (event.type === "system") {
      const text = eventPayload(event, "system")?.text ?? "";
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
        text: eventPayload(event, "permission")?.title || "Tool permission requested",
        createdAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "permission_result") {
      blocks.push({
        key: event.eventId,
        kind: "permission_result",
        text: `Permission ${eventPayload(event, "permission_result")?.outcome || "resolved"}`,
        createdAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "turn_complete") {
      blocks.push({
        key: event.eventId,
        kind: "turn",
        text: eventPayload(event, "turn_complete")?.stopReason || "end_turn",
        createdAt: event.createdAt,
      });
      continue;
    }

    // Bookkeeping for resume; it carries no text worth showing in the stream.
    if (event.type === "agent_session") continue;

    if (event.type === "error") {
      blocks.push({
        key: event.eventId,
        kind: "error",
        text: eventPayload(event, "error")?.message || "Unknown error",
        createdAt: event.createdAt,
      });
    }
  }

  return blocks;
}

/** The permission request still waiting on a browser decision, if any. */
export function pendingPermission(events: SessionEvent[]): SessionEvent | undefined {
  const pending = pendingPermissionRequests(events);
  return pending[pending.length - 1];
}

/** Every permission request, across any session, still awaiting a decision. */
export function pendingPermissionRequests(events: SessionEvent[]): SessionEvent[] {
  const pending = new Map<string, SessionEvent>();
  for (const event of events) {
    const requestId =
      eventPayload(event, "permission")?.requestId ??
      eventPayload(event, "permission_result")?.requestId;
    if (!requestId) continue;
    if (event.type === "permission") pending.set(requestId, event);
    if (event.type === "permission_result") pending.delete(requestId);
  }
  return [...pending.values()];
}

export function pendingPermissionCount(events: SessionEvent[]): number {
  return pendingPermissionRequests(events).length;
}

/** Human-readable summary of what the agent is asking to do. */
export function permissionTitle(event: SessionEvent): string {
  return eventPayload(event, "permission")?.title || "Tool request";
}

/** Id a decision must be posted against, absent on a malformed request. */
export function permissionRequestId(event: SessionEvent): string | undefined {
  return eventPayload(event, "permission")?.requestId || undefined;
}

/** The agent's own "allow once" choice, when it offered one. */
export function allowOnceOptionId(event: SessionEvent): string | undefined {
  const options = eventPayload(event, "permission")?.options ?? [];
  return options.find((option) => option.kind === "allow_once")?.optionId;
}
