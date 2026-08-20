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

/**
 * How long a freshly spawned client is left alone to finish its handshake.
 *
 * {@link DevTunnelConnection.recycle} is driven by the node failing to reach the
 * Host, and those failures do not stop while a rebuild is in progress — a
 * refused loopback port is refused in about a millisecond, so the node reaches
 * its recycle threshold every six seconds for as long as the forward is down.
 * Without this window the retry loop killed each new client two to six seconds
 * in, which is less time than a relay handshake takes: restarting the Host
 * changes its tunnel host key, and the client answers that by tearing the
 * session down and refreshing it, the slowest path it has. The client therefore
 * never reached the point of printing a port, `attempt` never reset, and the
 * node sat in a loop that could only be broken by hand — the tunnel was not
 * failing to come up, it was being killed on the way.
 *
 * Bounded rather than indefinite: a client that has genuinely wedged still has
 * to be rebuilt, so protection expires and the loop takes over again.
 */
export const RECYCLE_GRACE_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
}

/** The tail of the CLI's output, which is where it says what went wrong. */
export function lastLines(output: string, count = 3): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(" / ");
}

/**
 * Why a failed connect will not be helped by trying again, when that is knowable.
 *
 * Retrying is the default, deliberately: a node that has just rebooted races its
 * own network, and the failure that costs a machine its whole session is the one
 * treated as permanent when it was merely early. So only conditions that cannot
 * improve on their own are named here, and each is recognised by what the CLI
 * said rather than by its exit code alone — a code is reused across causes, and
 * an unfamiliar message simply falls through to the retry loop, which is the
 * safe way to be wrong.
 */
export function fatalConnectReason(
  code: number | null | undefined,
  said: string,
): string | undefined {
  if (code === 3 || /login required/i.test(said)) {
    return "This machine is not signed in to Dev Tunnels: run `devtunnel user login` here, then start the node again.";
  }
  if (/tunnel not found/i.test(said)) {
    return "A private tunnel is visible only to the account that owns it, so this is either a tunnel that no longer exists or a machine signed in as a different account. Compare `devtunnel list` on this machine against the tunnel id the Host reports.";
  }
  return undefined;
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
  /**
   * Rebuilds immediately, abandoning any backoff already counting down.
   *
   * {@link recycle} is the retry loop talking, and it defers to a rebuild
   * already queued — asking twice would only reset the backoff and hammer a
   * tunnel that is probably still dead. An operator pressing a button is not
   * that loop. They have already watched it fail, they know something changed
   * on the other end, and the wait they are trying to skip is a timer they
   * cannot see and did not choose. Deferring to it here would make the button
   * do nothing at the one moment it is worth pressing.
   */
  rebuildNow: () => void;
  stop: () => void;
};

export type ConnectOptions = {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  log?: (message: string) => void;
  /**
   * Where the tunnel's failures go, when that is somewhere different.
   *
   * A tunnel that keeps failing to come up is the thing being debugged, so it
   * must not arrive at the same level as "forwarding 127.0.0.1:8790" — a
   * diagnostics view filtered to problems would hide the one sequence worth
   * reading. Defaults to `log`, so a caller that does not separate the two
   * still sees everything.
   */
  warn?: (message: string) => void;
  /**
   * Called when a respawned tunnel comes back on a different port, so the node
   * can move its dial address instead of retrying one nothing is listening on.
   */
  onUrlChanged?: (url: string) => void;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** How long a new client is protected from {@link RECYCLE_GRACE_MS}. */
  recycleGraceMs?: number;
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
  const warn = options.warn ?? log;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const recycleGraceMs = options.recycleGraceMs ?? RECYCLE_GRACE_MS;

  let child: ChildProcess | undefined;
  let currentUrl: string | undefined;
  let stopped = false;
  let attempt = 0;
  let respawnTimer: NodeJS.Timeout | undefined;
  /** Set while the current child is still coming up; see {@link RECYCLE_GRACE_MS}. */
  let graceTimer: NodeJS.Timeout | undefined;
  /**
   * Invalidates a grace callback that outlived the window it was armed for.
   *
   * `clearTimer` is not enough on its own: a callback already queued would
   * still run and clear the handle of the *next* child's window, handing the
   * recycler a client that had only just been spawned.
   */
  let graceToken = 0;
  /** Assigned once the supervisor below is built; see `recycle`. */
  let requestRespawn: (code?: number | null) => void = () => {};
  /** Assigned once `start` exists; see `rebuildNow`. */
  let startNow: () => void = () => {};

  const endGrace = (): void => {
    if (!graceTimer) return;
    graceToken += 1;
    clearTimer(graceTimer);
    graceTimer = undefined;
  };

  const armGrace = (): void => {
    endGrace();
    const token = graceToken;
    graceTimer = setTimer(() => {
      if (token === graceToken) graceTimer = undefined;
    }, recycleGraceMs);
  };

  const connection: DevTunnelConnection = {
    get url() {
      return currentUrl ?? "";
    },
    recycle: () => {
      // A rebuild is already queued; asking again would only reset the backoff.
      if (stopped || respawnTimer) return;
      // A client that has not reported a port yet is still handshaking. The
      // node cannot tell that apart from a dead tunnel — both refuse its dials
      // — so without this the rebuild it asks for kills the rebuild it already
      // got, forever.
      if (graceTimer) return;
      const doomed = child;
      child = undefined;
      if (doomed && !doomed.killed) {
        warn(`devtunnel connect ${tunnelId} is not reaching the Host; rebuilding it`);
        // Clearing `child` first means the exit handler's `child !== active`
        // guard ignores this kill, so the respawn is scheduled here instead of
        // twice.
        doomed.kill();
      }
      requestRespawn();
    },
    rebuildNow: () => {
      if (stopped) return;
      // Unlike `recycle`, a queued rebuild is cancelled rather than deferred to:
      // the backoff is there to pace an automatic retry, and this is not one.
      if (respawnTimer) {
        clearTimer(respawnTimer);
        respawnTimer = undefined;
      }
      const doomed = child;
      child = undefined;
      if (doomed && !doomed.killed) doomed.kill();
      // Clearing `child` first means the exit handler ignores this kill, so the
      // spawn below is the only one; resetting the count gives the new tunnel
      // the full backoff ladder rather than the tail of the old one's.
      attempt = 0;
      log(`devtunnel connect ${tunnelId} rebuilding now`);
      startNow();
    },
    stop: () => {
      stopped = true;
      if (respawnTimer) clearTimer(respawnTimer);
      respawnTimer = undefined;
      endGrace();
      if (child && !child.killed) child.kill();
    },
  };

  return new Promise<DevTunnelConnection>((resolve, reject) => {
    let settled = false;
    /**
     * The last thing the CLI said, kept across respawns.
     *
     * Every failure below used to be reported as an exit code and a guess, while
     * the one line that actually explained it — `Tunnel not found`, `Login
     * required` — was read into a buffer and dropped on the floor. The guess was
     * not merely unhelpful, it was wrong often enough to send an operator to
     * `devtunnel user login` on a machine that was already signed in.
     */
    let said = "";

    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      outcome();
    };

    /** The CLI's own words, ready to append to a message. */
    const detail = () => (said ? `: ${said}` : " with no output");

    const timer = setTimer(() => {
      settle(() => {
        connection.stop();
        reject(
          new Error(
            `devtunnel connect ${tunnelId} did not report a forwarded port within ${Math.round(
              timeoutMs / 1000,
            )}s${detail()}. Run \`devtunnel user login\` on this machine and check that this account can reach the tunnel.`,
          ),
        );
      });
    }, timeoutMs);

    const scheduleRespawn = (code?: number | null): void => {
      // A rejected attempt has already been reported to the caller, and the
      // rejection paths stop the connection, so `stopped` is what ends the loop.
      if (stopped) return;
      const delay = reconnectDelay(attempt);
      attempt += 1;
      warn(
        `devtunnel connect ${tunnelId} ended (code=${
          code ?? "null"
        })${detail()}; restarting in ${Math.round(delay / 1000)}s`,
      );
      respawnTimer = setTimer(() => {
        // A rebuild that overtook this timer has already cleared the handle.
        // Checking it here rather than trusting `clearTimer` alone is what
        // stops a late callback spawning a second client that would fight the
        // first one for the forwarded port.
        if (respawnTimer === undefined) return;
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
      // Armed before any output can arrive: the window this protects is the one
      // between spawning and the first "Forwarding from" line, which is exactly
      // when the node is dialing a port that does not exist yet.
      armGrace();
      let buffer = "";
      // Reset per spawn: a respawn may land on a different port, and noticing
      // that is the whole point of watching.
      let reportedThisRun: string | undefined;

      const onChunk = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
        said = lastLines(buffer);
        const match = buffer.match(FORWARDING_RE);
        if (!match) return;
        const url = `http://127.0.0.1:${match[1]}`;
        if (url === reportedThisRun) return;
        reportedThisRun = url;
        attempt = 0;
        // Up and serving: from here a failure to reach the Host really is
        // evidence about the tunnel, so the recycler is handed back its job.
        endGrace();
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
        endGrace();
        // A binary that cannot be spawned at all will not appear by being asked
        // again, so this ends the first attempt rather than looping on it. Once
        // a tunnel has worked, the same failure is treated as any other death
        // and goes back through the backoff.
        if (!settled) {
          settle(() => {
            connection.stop();
            reject(
              new Error(
                `Could not start devtunnel: ${error.message}. Install it with \`winget install Microsoft.devtunnel\`.`,
              ),
            );
          });
          return;
        }
        scheduleRespawn();
      });

      // A connect that exits before forwarding is a node with no way to reach
      // its Host, and until this point there is no working tunnel to fall back
      // on — so the CLI's own words are the whole diagnosis.
      active.on("exit", (code) => {
        if (child !== active) return;
        child = undefined;
        // The window belonged to this child; a dead one must not go on
        // protecting whatever the loop does next.
        endGrace();
        if (!settled) {
          const fatal = fatalConnectReason(code, said);
          // Anything that could be a machine still finding its network after a
          // reboot is retried instead. One failed attempt used to end the node
          // outright, which is why a rebooted box never came back while its
          // already-connected neighbours carried on.
          if (fatal) {
            settle(() => {
              connection.stop();
              reject(
                new Error(
                  `devtunnel connect ${tunnelId} exited (code=${code ?? "null"})${detail()}. ${fatal}`,
                ),
              );
            });
            return;
          }
        }
        scheduleRespawn(code);
      });
    };

    startNow = start;
    start();
  });
}

export type { ChildProcess };
