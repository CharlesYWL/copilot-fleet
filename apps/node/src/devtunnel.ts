import { spawn, type ChildProcess } from "node:child_process";

/**
 * The local address `devtunnel connect` is forwarding to the Host.
 *
 * The CLI binds the same port number as the remote when it is free and quietly
 * picks another when it is not, so the port is read back from its output rather
 * than assumed. Guessing produces a node that dials a port nothing is listening
 * on, which looks identical to the Host being down.
 */
const FORWARDING_RE = /Forwarding from 127\.0\.0\.1:(\d+)/i;

/** Long enough to cover an interactive relay handshake on a cold start. */
const READY_TIMEOUT_MS = 60_000;

/** Backoff for respawning a connect that died; caps so it stops hammering. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export function reconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
}

export type DevTunnelConnection = {
  /** Loopback URL the node should dial; changes if a respawn lands elsewhere. */
  readonly url: string;
  /**
   * Tears the current tunnel down so the supervisor rebuilds it.
   *
   * Needed because a dead tunnel does not always announce itself. The forwarded
   * port is a local listener owned by the client process, so it keeps accepting
   * connections after the far end is gone: the process does not exit, nothing
   * is logged, and a port probe still succeeds. The only trustworthy evidence
   * is the node failing to reach the Host through it, which only the node has.
   */
  recycle: () => void;
  stop: () => void;
};

export type ConnectOptions = {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  log?: (message: string) => void;
  /**
   * Called when a respawned tunnel comes back on a different port, so the node
   * can move its dial address instead of retrying one nothing is listening on.
   */
  onUrlChanged?: (url: string) => void;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

/**
 * Holds a `devtunnel connect` for the lifetime of the node.
 *
 * A private Dev Tunnel cannot be dialed directly: the node has no browser
 * cookie and no way to attach a tunnel header, so it reaches the Host through
 * this forwarded loopback port instead, authenticated by the CLI's own login.
 * Running it here rather than in a second terminal keeps the node a single
 * command, and means the forwarded port is discovered rather than transcribed.
 *
 * The child is supervised for the whole run, not only until it first reports a
 * port. Restarting the Host replaces its tunnel host and with it the SSH host
 * key, which the client can only answer by tearing the session down and
 * refreshing it:
 *
 *   reconnection failed: The server host key is different
 *   Connection to client tunnel relay closed. Protocol error.
 *   Refreshing tunnel.
 *
 * Usually it recovers on its own. When it does not, an unsupervised child left
 * the node dialing a dead port forever — indistinguishable from the Host being
 * down, and the reason the node had to be restarted by hand.
 */
export function connectDevTunnel(
  tunnelId: string,
  options: ConnectOptions = {},
): Promise<DevTunnelConnection> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));

  let child: ChildProcess | undefined;
  let currentUrl: string | undefined;
  let stopped = false;
  let attempt = 0;
  let respawnTimer: NodeJS.Timeout | undefined;
  /** Assigned once the supervisor below is built; see `recycle`. */
  let requestRespawn: (code?: number | null) => void = () => {};

  const connection: DevTunnelConnection = {
    get url() {
      return currentUrl ?? "";
    },
    recycle: () => {
      // A rebuild is already queued; asking again would only reset the backoff.
      if (stopped || respawnTimer) return;
      const doomed = child;
      child = undefined;
      if (doomed && !doomed.killed) {
        log(`devtunnel connect ${tunnelId} is not reaching the Host; rebuilding it`);
        // Clearing `child` first means the exit handler's `child !== active`
        // guard ignores this kill, so the respawn is scheduled here instead of
        // twice.
        doomed.kill();
      }
      requestRespawn();
    },
    stop: () => {
      stopped = true;
      if (respawnTimer) clearTimer(respawnTimer);
      respawnTimer = undefined;
      if (child && !child.killed) child.kill();
    },
  };

  return new Promise<DevTunnelConnection>((resolve, reject) => {
    let settled = false;

    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      outcome();
    };

    const timer = setTimer(() => {
      settle(() => {
        connection.stop();
        reject(
          new Error(
            `devtunnel connect ${tunnelId} did not report a forwarded port within ${Math.round(
              timeoutMs / 1000,
            )}s. Run \`devtunnel user login\` on this machine and try again.`,
          ),
        );
      });
    }, timeoutMs);

    const scheduleRespawn = (code?: number | null): void => {
      // Nothing to recover once the first attempt has already been rejected —
      // that failure is reported to the caller, which decides what to do.
      if (stopped || !settled || currentUrl === undefined) return;
      const delay = reconnectDelay(attempt);
      attempt += 1;
      log(
        `devtunnel connect ${tunnelId} ended (code=${
          code ?? "null"
        }); restarting in ${Math.round(delay / 1000)}s`,
      );
      respawnTimer = setTimer(() => {
        respawnTimer = undefined;
        if (!stopped) start();
      }, delay);
    };
    requestRespawn = scheduleRespawn;

    const start = (): void => {
      const active = spawnProcess("devtunnel", ["connect", tunnelId], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child = active;
      let buffer = "";
      // Reset per spawn: a respawn may land on a different port, and noticing
      // that is the whole point of watching.
      let reportedThisRun: string | undefined;

      const onChunk = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
        const match = buffer.match(FORWARDING_RE);
        if (!match) return;
        const url = `http://127.0.0.1:${match[1]}`;
        if (url === reportedThisRun) return;
        reportedThisRun = url;
        attempt = 0;
        const moved = currentUrl !== undefined && currentUrl !== url;
        currentUrl = url;
        settle(() => {
          log(`devtunnel connect ${tunnelId} forwarding ${url}`);
          resolve(connection);
        });
        if (moved) {
          log(`devtunnel connect ${tunnelId} moved to ${url}`);
          options.onUrlChanged?.(url);
        }
      };

      active.stdout?.on("data", onChunk);
      active.stderr?.on("data", onChunk);

      active.on("error", (error) => {
        if (child !== active) return;
        child = undefined;
        settle(() =>
          reject(
            new Error(
              `Could not start devtunnel: ${error.message}. Install it with \`winget install Microsoft.devtunnel\`.`,
            ),
          ),
        );
        scheduleRespawn();
      });

      // A connect that exits before forwarding is almost always a signed-out CLI
      // or a tunnel this account cannot see; either way the node cannot proceed.
      active.on("exit", (code) => {
        if (child !== active) return;
        child = undefined;
        settle(() =>
          reject(
            new Error(
              `devtunnel connect ${tunnelId} exited (code=${code ?? "null"}) before forwarding a port. Check \`devtunnel user login\` and that this account can reach the tunnel.`,
            ),
          ),
        );
        scheduleRespawn(code);
      });
    };

    start();
  });
}

export type { ChildProcess };
