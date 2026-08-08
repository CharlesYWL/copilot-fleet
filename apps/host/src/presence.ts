import type { FleetNode } from "@fleet/protocol";
import { isHeartbeatStale } from "./node-messages.js";
import type { FleetService } from "./fleet-service.js";

/** How often the sweep runs; never longer than the timeout it enforces. */
export function sweepInterval(timeoutMs: number): number {
  return Math.max(1_000, Math.min(5_000, timeoutMs));
}

/**
 * Drops nodes that stopped beating.
 *
 * Split out as a plain function so the timeout rule can be tested without
 * waiting on a real interval: closing the socket is the preferred route because
 * the close handler already knows how to settle the sessions, and the direct
 * disconnect only covers a node whose socket vanished without one.
 */
export function sweepStaleNodes(
  service: FleetService,
  timeoutMs: number,
  now = Date.now(),
): FleetNode[] {
  const dropped: FleetNode[] = [];
  for (const node of service.store.listNodes()) {
    if (!node.online || !isHeartbeatStale(node.lastHeartbeat, now, timeoutMs)) {
      continue;
    }
    dropped.push(node);
    const socket = service.nodeSocket(node.id);
    if (socket) socket.close(4000, "Heartbeat timeout");
    else service.disconnectNode(node.id, "Execution stopped after heartbeat timeout");
  }
  return dropped;
}

/** Starts the sweep; the returned handle must be cleared on shutdown. */
export function startPresenceMonitor(
  service: FleetService,
  timeoutMs: number,
): NodeJS.Timeout {
  const timer = setInterval(
    () => sweepStaleNodes(service, timeoutMs),
    sweepInterval(timeoutMs),
  );
  timer.unref();
  return timer;
}
