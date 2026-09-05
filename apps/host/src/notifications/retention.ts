import type { FleetService } from "../fleet-service.js";

/** Retention is maintenance, not a streaming-event hot path. */
export const NOTIFICATION_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

type NotificationRetentionService = Pick<FleetService, "pruneNotifications">;
type NotificationRetentionLogger = {
  error: (bindings: { error: unknown }, message: string) => void;
};

/** Runs one startup sweep, then keeps the durable history within policy. */
export function startNotificationRetentionMonitor(
  service: NotificationRetentionService,
  log: NotificationRetentionLogger,
  intervalMs = NOTIFICATION_RETENTION_SWEEP_INTERVAL_MS,
): NodeJS.Timeout {
  service.pruneNotifications();
  const timer = setInterval(() => {
    try {
      service.pruneNotifications();
    } catch (error) {
      log.error({ error }, "Failed periodic notification retention sweep");
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
