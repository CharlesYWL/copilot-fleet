import type { FleetSession, NodeToHostMessage } from "@fleet/protocol";

type SessionLookup = (sessionId: string) => FleetSession | undefined;

export function nodeMessageBelongsTo(
  nodeId: string,
  message: NodeToHostMessage,
  getSession: SessionLookup,
): boolean {
  const sessionId =
    message.type === "event"
      ? message.event.sessionId
      : message.type === "command_result"
        ? message.sessionId
        : undefined;
  if (!sessionId) return true;
  return getSession(sessionId)?.nodeId === nodeId;
}

export function heartbeatSessionsBelongTo(
  nodeId: string,
  sessionIds: readonly string[],
  getSession: SessionLookup,
): boolean {
  return sessionIds.every((sessionId) => getSession(sessionId)?.nodeId === nodeId);
}

export function isHeartbeatStale(
  lastHeartbeat: string,
  now: number,
  timeoutMs: number,
): boolean {
  return now - Date.parse(lastHeartbeat) > timeoutMs;
}
