import { execFile } from "node:child_process";
import type { HostConnectionProblem } from "./host-connection-problem.js";

/**
 * Why a Node behind `devtunnel connect` cannot reach its Host.
 *
 * The forward is a local listener, so a stopped Host looks the same to the
 * WebSocket as a tunnel that is still rebuilding. The Dev Tunnels service
 * knows whether any Host is attached to the tunnel, so it is asked directly.
 */
export type DevTunnelCheck =
  | { status: "hosted"; hostConnections: number }
  | { status: "not-hosted" }
  | { status: "unknown"; detail: string };

/** Runs the Dev Tunnels CLI and resolves with what it printed on stdout. */
export type DevTunnelRunner = (args: string[], timeoutMs: number) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 15_000;

const runDevTunnelCli: DevTunnelRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      "devtunnel",
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const said = `${stderr}\n${stdout}`.trim().split(/\r?\n/).at(-1)?.trim();
          reject(new Error(said || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });

/** Reads `hostConnections` out of `devtunnel show --json`. */
export const parseDevTunnelShow = (output: string): DevTunnelCheck => {
  // The CLI can print a banner before the JSON, so parse from the first brace.
  const start = output.indexOf("{");
  if (start < 0) return { status: "unknown", detail: "devtunnel show printed no JSON" };
  try {
    const parsed = JSON.parse(output.slice(start)) as {
      tunnel?: { hostConnections?: unknown };
    };
    const hostConnections = parsed.tunnel?.hostConnections;
    if (typeof hostConnections !== "number")
      return {
        status: "unknown",
        detail: "devtunnel show did not report hostConnections",
      };
    return hostConnections > 0
      ? { status: "hosted", hostConnections }
      : { status: "not-hosted" };
  } catch {
    return { status: "unknown", detail: "devtunnel show printed unreadable JSON" };
  }
};

export const checkDevTunnelHosting = async (
  tunnelId: string,
  options: { run?: DevTunnelRunner; timeoutMs?: number } = {},
): Promise<DevTunnelCheck> => {
  const run = options.run ?? runDevTunnelCli;
  try {
    return parseDevTunnelShow(
      await run(["show", tunnelId, "--json"], options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

/** The sentence an operator reads on the Node config page. */
export const describeDevTunnelCheck = (
  tunnelId: string,
  check: DevTunnelCheck,
): Pick<HostConnectionProblem, "kind" | "summary" | "message"> => {
  switch (check.status) {
    case "not-hosted":
      return {
        kind: "tunnel-not-hosted",
        summary: "Host is not running",
        message: `No Host is attached to dev tunnel ${tunnelId}. Start the Fleet Host and make sure it is hosting this tunnel (Host settings, Dev Tunnels). This Node keeps retrying and connects as soon as the Host is back.`,
      };
    case "hosted":
      return {
        kind: "tunnel-not-answering",
        summary: "Host is not answering",
        message: `Dev tunnel ${tunnelId} has a Host attached, but Fleet does not answer through it. The Host may still be starting, or this Node's local forward is being rebuilt. Use "Rebuild tunnel" under Diagnostics if this persists.`,
      };
    case "unknown":
      return {
        kind: "tunnel-check-failed",
        summary: "Cannot reach the Host",
        message: `This Node cannot reach the Host through dev tunnel ${tunnelId}, and could not ask the Dev Tunnels service why: ${check.detail}. Check that this machine is signed in with \`devtunnel user login\` and can see the tunnel in \`devtunnel list\`.`,
      };
  }
};

/** Runs the check and shapes it for the Node's status. */
export const checkDevTunnelHost = async (
  tunnelId: string,
  options?: { run?: DevTunnelRunner; timeoutMs?: number },
): Promise<HostConnectionProblem> => ({
  ...describeDevTunnelCheck(tunnelId, await checkDevTunnelHosting(tunnelId, options)),
  checkedAt: new Date().toISOString(),
});
