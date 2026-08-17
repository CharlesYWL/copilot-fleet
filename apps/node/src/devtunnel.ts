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

export type DevTunnelConnection = {
  /** Loopback URL the node should dial. */
  url: string;
  stop: () => void;
};

export type ConnectOptions = {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  log?: (message: string) => void;
};

/**
 * Holds a `devtunnel connect` for the lifetime of the node.
 *
 * A private Dev Tunnel cannot be dialed directly: the node has no browser
 * cookie and no way to attach a tunnel header, so it reaches the Host through
 * this forwarded loopback port instead, authenticated by the CLI's own login.
 * Running it here rather than in a second terminal keeps the node a single
 * command, and means the forwarded port is discovered rather than transcribed.
 */
export function connectDevTunnel(
  tunnelId: string,
  options: ConnectOptions = {},
): Promise<DevTunnelConnection> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const log = options.log ?? (() => {});

  const child = spawnProcess("devtunnel", ["connect", tunnelId], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stop = () => {
    if (!child.killed) child.kill();
  };

  return new Promise<DevTunnelConnection>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };

    const timer = setTimeout(() => {
      finish(() => {
        stop();
        reject(
          new Error(
            `devtunnel connect ${tunnelId} did not report a forwarded port within ${Math.round(
              timeoutMs / 1000,
            )}s. Run \`devtunnel user login\` on this machine and try again.`,
          ),
        );
      });
    }, timeoutMs);

    const onChunk = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
      const match = buffer.match(FORWARDING_RE);
      if (!match) return;
      const url = `http://127.0.0.1:${match[1]}`;
      finish(() => {
        log(`devtunnel connect ${tunnelId} forwarding ${url}`);
        resolve({ url, stop });
      });
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", (error) => {
      finish(() =>
        reject(
          new Error(
            `Could not start devtunnel: ${error.message}. Install it with \`winget install Microsoft.devtunnel\`.`,
          ),
        ),
      );
    });

    // A connect that exits before forwarding is almost always a signed-out CLI
    // or a tunnel this account cannot see; either way the node cannot proceed.
    child.on("exit", (code) => {
      finish(() =>
        reject(
          new Error(
            `devtunnel connect ${tunnelId} exited (code=${code ?? "null"}) before forwarding a port. Check \`devtunnel user login\` and that this account can reach the tunnel.`,
          ),
        ),
      );
    });
  });
}

export type { ChildProcess };
