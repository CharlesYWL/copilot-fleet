import { eventPayload, type SessionEvent } from "@fleet/protocol";

export {
  toTerminalBlocks,
  type TerminalBlock,
  type TerminalBlockKind,
} from "@fleet/protocol";

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
