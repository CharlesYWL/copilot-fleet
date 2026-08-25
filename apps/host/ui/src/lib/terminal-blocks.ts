import { eventPayload, type AttachmentSummary, type SessionEvent } from "@fleet/protocol";
import { parseWake, wakeDetail, wakeTitle } from "./fleet-wake";

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
  | "system"
  | "wake";

export type TerminalBlock = {
  key: string;
  kind: TerminalBlockKind;
  text: string;
  createdAt: string;
  status?: string;
  /** ACP tool category (`read`, `edit`, `execute`, …), which picks the icon. */
  toolKind?: string;
  /** One-line summary of a tool's input, shown dimmed after its title. */
  detail?: string;
  /** Full text a summarised block folds away, kept for whoever expands it. */
  body?: string;
  /** Files that went with this message, by name; their bytes are never kept. */
  attachments?: AttachmentSummary[];
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
      const toolKind = payload?.kind ?? "";
      const detail = payload?.detail ?? "";
      const existing = toolCallId ? toolBlockIndex.get(toolCallId) : undefined;
      const previous = existing === undefined ? undefined : blocks[existing];
      if (previous) {
        // Only what an update actually restates is taken from it: a completion
        // frame carries a status and nothing else, and must not blank the line
        // the reader has been looking at since the call started.
        if (title) previous.text = title;
        if (status) previous.status = status;
        if (toolKind) previous.toolKind = toolKind;
        if (detail) previous.detail = detail;
        continue;
      }
      blocks.push({
        key: event.eventId,
        kind: "tool",
        text: title || "Tool call",
        createdAt: event.createdAt,
        ...(status ? { status } : {}),
        ...(toolKind ? { toolKind } : {}),
        ...(detail ? { detail } : {}),
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
      const payload = eventPayload(event, "system");
      const text = payload?.text ?? "";
      if (!text) continue;
      const isUser = text.startsWith(USER_PREFIX);
      const prompt = isUser ? text.slice(USER_PREFIX.length) : text;

      /*
       * A wake is delivered down the prompt channel because that is the only
       * way to hand a running agent something to read, but nobody typed it —
       * so it gets a folded step line rather than the operator's own column.
       */
      const wake = isUser ? parseWake(prompt) : undefined;
      if (wake) {
        blocks.push({
          key: event.eventId,
          kind: "wake",
          text: wakeTitle(wake),
          detail: wakeDetail(wake),
          body: prompt,
          createdAt: event.createdAt,
        });
        continue;
      }

      blocks.push({
        key: event.eventId,
        kind: isUser ? "user" : "system",
        text: prompt,
        createdAt: event.createdAt,
        // The bytes are never stored, so this list is the only trace a prompt
        // carried files at all. Without it a transcript reads as though the
        // agent answered a question about a screenshot nobody sent.
        ...(payload?.attachments?.length ? { attachments: payload.attachments } : {}),
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
