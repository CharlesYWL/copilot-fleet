export const MCP_RECOVERY_DELAYS_MS = [5_000, 30_000, 120_000] as const;
export const MCP_CONNECTION_STABLE_MS = 5_000;

export function recoveryDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Recovery may start only after authentication and buffered-event reconciliation. */
export class McpRecoveryConnection {
  private available = true;
  private readyAt = 0;
  private readonly waiters = new Set<() => void>();

  setAvailable(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    this.readyAt = available ? Date.now() + MCP_CONNECTION_STABLE_MS : 0;
    for (const notify of this.waiters) notify();
  }

  async wait(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (!this.available) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            this.waiters.delete(changed);
            signal.removeEventListener("abort", abort);
          };
          const changed = () => {
            finish();
            resolve();
          };
          const abort = () => {
            finish();
            reject(signal.reason);
          };
          this.waiters.add(changed);
          signal.addEventListener("abort", abort, { once: true });
        });
        continue;
      }
      const remaining = this.readyAt - Date.now();
      if (remaining <= 0) return;
      await recoveryDelay(remaining, signal);
    }
  }
}
