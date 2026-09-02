import type { FleetSession, NodeToHostMessage } from "@fleet/protocol";

type SessionLookup = (sessionId: string) => FleetSession | undefined;

export type NodeMessageOwnership = "unscoped" | "owned" | "missing" | "foreign";

export function nodeMessageOwnership(
  nodeId: string,
  message: NodeToHostMessage,
  getSession: SessionLookup,
): NodeMessageOwnership {
  const sessionId =
    message.type === "event"
      ? message.event.sessionId
      : message.type === "command_result"
        ? message.sessionId
        : undefined;
  if (!sessionId) return "unscoped";
  const session = getSession(sessionId);
  if (!session) return "missing";
  return session.nodeId === nodeId ? "owned" : "foreign";
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
