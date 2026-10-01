import { randomUUID } from "node:crypto";
import {
  DEFAULT_SESSION_RETENTION_DAYS,
  SESSION_RETENTION_CAPABILITY,
  SessionRetentionDaysSchema,
  prMaintenanceProviderLabel,
  sessionRetentionCutoff,
  terminalSessionStates,
  type FleetSession,
  type NodeToHostMessage,
} from "@fleet/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { FleetService } from "./fleet-service.js";
import type { SessionCleanupRequest } from "./store.js";

export const SESSION_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const SESSION_CLEANUP_ACK_TIMEOUT_MS = 5 * 60 * 1000;

type CleanupResult = Extract<NodeToHostMessage, { type: "session_cleanup_result" }>;

/**
 * The Host owns retention policy; a Node owns the final activity check and deletion.
 * Keep the Fleet row locked until that Node confirms, including across restarts.
 */
export class SessionRetention {
  private readonly readyNodes = new Set<string>();
  readonly days: number;

  constructor(
    private readonly service: FleetService,
    private readonly log: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
    days = DEFAULT_SESSION_RETENTION_DAYS,
  ) {
    this.days = SessionRetentionDaysSchema.parse(days);
  }

  nodeDisconnected(nodeId: string): void {
    this.readyNodes.delete(nodeId);
  }

  nodeReconciled(nodeId: string): void {
    if (this.readyNodes.has(nodeId)) return;
    this.readyNodes.add(nodeId);
    this.sweep(nodeId, Date.now(), true);
  }

  shouldExpire(session: FleetSession, now = Date.now()): boolean {
    if (session.cleanupRequested) return true;
    const cutoff = sessionRetentionCutoff(now, this.days);
    return cutoff !== undefined && this.eligible(session, cutoff);
  }

  private eligible(session: FleetSession, cutoff: number): boolean {
    const activity = Math.max(
      Date.parse(session.createdAt),
      Date.parse(session.lastActivityAt ?? session.updatedAt),
    );
    return (
      session.agentParams?.kind !== "hermes" &&
      (session.state === "idle" || terminalSessionStates.has(session.state)) &&
      !session.favorite &&
      !session.stopRequested &&
      Number.isFinite(activity) &&
      activity <= cutoff &&
      !this.service.store.hasSessionRetentionBlockers(
        session.id,
        new Date(cutoff).toISOString(),
      )
    );
  }

  sweep(nodeId?: string, now = Date.now(), reconnect = false): number {
    const { store } = this.service;
    const notices: ReturnType<typeof store.insertNotification>[] = [];
    store.prMaintenance.notifyLongPauses(new Date(now).toISOString(), (record) => {
      notices.push(
        store.insertNotification({
          sourceKey: `pr-maintenance:${record.id}:paused:${record.renewedAt}`,
          category: "orchestration",
          kind: "pr_maintenance_attention",
          severity: "warning",
          title: "Resume or release PR maintenance",
          body:
            `${prMaintenanceProviderLabel(record.identity)} ${record.identity.repository}#${record.identity.prNumber} has been paused for 30 days. ` +
            "Continuity is still retained. Resume with authorization, or release after all accepted work and effects settle.",
          subject: { type: "run", id: record.taskId, label: "PR maintenance" },
          navigation: { type: "run", runId: record.taskId },
          data: { maintenanceRecordId: record.id, purpose: "maintenance_retention" },
          createdAt: new Date(now).toISOString(),
        }),
      );
    });
    for (const notice of notices) {
      if (notice.created) this.service.publishNotification(notice.notification);
    }
    const requests = store.listSessionCleanupRequests();
    const busyNodes = new Set<string>();
    let requested = 0;

    // A lost acknowledgement must be retried even if retention was since disabled.
    for (const request of requests) {
      if (!request.inFlight || (nodeId && request.nodeId !== nodeId)) continue;
      busyNodes.add(request.nodeId);
      if (
        (reconnect ||
          now - Date.parse(request.requestedAt) >= SESSION_CLEANUP_ACK_TIMEOUT_MS) &&
        this.available(request.nodeId)
      ) {
        this.send({ ...request, requestedAt: new Date(now).toISOString() });
        requested += 1;
      }
    }

    const cutoff = sessionRetentionCutoff(now, this.days);
    if (cutoff === undefined) return requested;
    const inactiveBefore = new Date(cutoff).toISOString();
    const previous = new Map(requests.map((request) => [request.sessionId, request]));
    const unsupported = new Set<string>();
    for (const session of store.listInactiveSessions(inactiveBefore)) {
      if (
        (nodeId && session.nodeId !== nodeId) ||
        busyNodes.has(session.nodeId) ||
        !this.available(session.nodeId)
      ) {
        continue;
      }
      const last = previous.get(session.id);
      if (
        last &&
        now - Date.parse(last.requestedAt) < SESSION_RETENTION_SWEEP_INTERVAL_MS
      ) {
        continue;
      }
      if (!this.eligible(session, cutoff)) continue;
      const node = store.getNode(session.nodeId)!;
      if (!node.capabilities.includes(SESSION_RETENTION_CAPABILITY)) {
        if (!unsupported.has(node.id)) {
          this.log.warn(
            { nodeId: node.id },
            "Inactive session cleanup deferred: update this Node to support session retention",
          );
          unsupported.add(node.id);
        }
        continue;
      }
      this.send({
        sessionId: session.id,
        nodeId: session.nodeId,
        commandId: randomUUID(),
        inactiveBefore,
        retentionDays: this.days,
        requestedAt: new Date(now).toISOString(),
        inFlight: true,
      });
      busyNodes.add(session.nodeId);
      requested += 1;
    }
    return requested;
  }

  handleResult(nodeId: string, result: CleanupResult): void {
    const { store } = this.service;
    const request = store
      .listSessionCleanupRequests()
      .find(
        (entry) =>
          entry.inFlight &&
          entry.nodeId === nodeId &&
          entry.sessionId === result.sessionId &&
          entry.commandId === result.commandId,
      );
    if (!request) {
      this.log.warn(
        { nodeId, sessionId: result.sessionId, commandId: result.commandId },
        "Ignored uncorrelated session cleanup result",
      );
      return;
    }
    if (!result.ok) {
      store.failSessionCleanup(request.commandId, new Date().toISOString());
      this.service.publishSession(store.getSession(request.sessionId)!);
      this.log.warn(
        { nodeId, sessionId: request.sessionId, error: result.error },
        "Inactive session cleanup deferred by Node; session retained for retry",
      );
    } else {
      this.service.resolveSessionPermissionRequests(request.sessionId);
      if (!store.completeSessionCleanup(request.commandId)) {
        throw new Error("Session cleanup request changed before its acknowledgement");
      }
      this.service.broadcast({ type: "snapshot", data: this.service.snapshot() });
      this.log.info(
        { nodeId, sessionId: request.sessionId, retentionDays: request.retentionDays },
        "Deleted inactive session from Host and Node",
      );
    }
    // One operation per Node at a time, without waiting six hours for each row.
    this.sweep(nodeId);
  }

  private available(nodeId: string): boolean {
    const socket = this.service.nodeSocket(nodeId);
    return (
      this.readyNodes.has(nodeId) &&
      this.service.store.getNode(nodeId)?.online === true &&
      socket !== undefined &&
      socket.readyState === socket.OPEN
    );
  }

  private send(request: SessionCleanupRequest): void {
    const { store } = this.service;
    const session = store.getSession(request.sessionId)!;
    store.requestSessionCleanup(request);
    this.service.publishSession(store.getSession(request.sessionId)!);
    this.service.send(this.service.nodeSocket(request.nodeId)!, {
      type: "command",
      command: {
        type: "delete_session",
        commandId: request.commandId,
        sessionId: request.sessionId,
        agentSessionId: session.agentSessionId,
        ...(session.agentParams ? { agentParams: session.agentParams } : {}),
        inactiveBefore: request.inactiveBefore,
        retentionDays: request.retentionDays,
      },
    });
  }
}

export function startSessionRetentionMonitor(
  retention: Pick<SessionRetention, "sweep">,
  log: Pick<FastifyBaseLogger, "error">,
  intervalMs = SESSION_RETENTION_SWEEP_INTERVAL_MS,
): NodeJS.Timeout {
  retention.sweep();
  const timer = setInterval(() => {
    try {
      retention.sweep();
    } catch (error) {
      log.error({ error }, "Failed periodic session retention sweep");
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
