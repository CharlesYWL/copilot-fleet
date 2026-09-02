import type { FleetService } from "../fleet-service.js";

/** Retention is maintenance, not a streaming-event hot path. */
export const NOTIFICATION_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Runs one startup sweep, then keeps the durable history within policy. */
export function startNotificationRetentionMonitor(
  service: FleetService,
  intervalMs = NOTIFICATION_RETENTION_SWEEP_INTERVAL_MS,
): NodeJS.Timeout {
  service.pruneNotifications();
  const timer = setInterval(() => service.pruneNotifications(), intervalMs);
  timer.unref();
  return timer;
}
