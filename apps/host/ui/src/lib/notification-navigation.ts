import type { FleetSession, Notification, Run, RunStep } from "@fleet/protocol";

export type NotificationTarget =
  | { kind: "fleet" }
  | { kind: "node"; nodeId: string }
  | { kind: "orchestrator" }
  | { kind: "session"; sessionId: string; returnRunId?: string }
  | { kind: "run"; runId: string };

/**
 * Resolves durable identifiers to the closest destination the current snapshot
 * can still open. A cleared worker falls back to its task rather than leading
 * to a dead transcript.
 */
export function notificationTarget(
  notification: Notification,
  stepsByRunId: Readonly<Record<string, RunStep[]>>,
  sessions: readonly FleetSession[],
  reachableRuns: readonly Pick<Run, "id">[],
): NotificationTarget {
  const navigationType: string = notification.navigation.type;
  const nodeId =
    typeof notification.data.nodeId === "string" ? notification.data.nodeId : undefined;
  const hasRun = (runId: string) => reachableRuns.some((run) => run.id === runId);
  if (navigationType === "node" && nodeId) return { kind: "node", nodeId };

  if (
    notification.navigation.type === "session" ||
    notification.navigation.type === "permission_request"
  ) {
    const sessionId = notification.navigation.sessionId;
    if (sessionId && sessions.some((session) => session.id === sessionId)) {
      return { kind: "session", sessionId };
    }
    const runId =
      notification.navigation.runId ||
      (typeof notification.data.runId === "string" ? notification.data.runId : undefined);
    if (runId && hasRun(runId)) return { kind: "run", runId };
    if (nodeId) return { kind: "node", nodeId };
    if (runId) return { kind: "orchestrator" };
    return { kind: "fleet" };
  }

  if (notification.navigation.type === "run") {
    return notification.navigation.runId && hasRun(notification.navigation.runId)
      ? { kind: "run", runId: notification.navigation.runId }
      : { kind: "orchestrator" };
  }

  if (notification.navigation.type === "run_step") {
    const runId = notification.navigation.runId;
    if (!runId) return { kind: "fleet" };
    if (!hasRun(runId)) return { kind: "orchestrator" };
    const step = stepsByRunId[runId]?.find(
      (candidate) => candidate.id === notification.navigation.stepId,
    );
    const sessionId = notification.navigation.sessionId || step?.sessionId;
    if (sessionId && sessions.some((session) => session.id === sessionId)) {
      return { kind: "session", sessionId, returnRunId: runId };
    }
    return { kind: "run", runId };
  }

  if (nodeId) return { kind: "node", nodeId };
  return { kind: "fleet" };
}
