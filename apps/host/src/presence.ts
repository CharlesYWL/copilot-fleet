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

/**
 * Starts the sweep; the returned handle must be cleared on shutdown.
 *
 * A tick that arrives more than a whole interval late means the Host's own
 * event loop was frozen — a slow synchronous disk write, say. The heartbeats
 * the Nodes sent meanwhile are still unread in their sockets, and timers run
 * before pending reads, so sweeping then would drop every Node for the Host's
 * stall. That tick is skipped instead; the next one judges after the reads.
 * With the default 15 s timeout and 5 s beats only a stall over 10 s can make a
 * live Node look stale, and any stall that long leaves the tick over 5 s late.
 */
export function startPresenceMonitor(
  service: FleetService,
  timeoutMs: number,
  onStall?: (stalledMs: number) => void,
): NodeJS.Timeout {
  const interval = sweepInterval(timeoutMs);
  let lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const stalledMs = now - lastTick - interval;
    lastTick = now;
    if (stalledMs > interval) {
      onStall?.(stalledMs);
      return;
    }
    sweepStaleNodes(service, timeoutMs, now);
  }, interval);
  timer.unref();
  return timer;
}
