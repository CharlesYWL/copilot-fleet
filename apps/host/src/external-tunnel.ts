import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { TunnelProvider } from "@fleet/protocol";
import { TunnelProviderSchema } from "@fleet/protocol";

const StateSchema = z.object({
  provider: TunnelProviderSchema,
  /** Empty while the provider has not printed its URL yet. */
  url: z.string(),
  pid: z.number().int().positive(),
});

export type ExternalTunnel = {
  provider: TunnelProvider;
  url: string | undefined;
};

/**
 * Anchored to the package rather than the working directory: the Host and the
 * tunnel process are launched from different cwds (workspace scripts run inside
 * apps/host), so a relative path had them writing and reading different files.
 * Walking up to package.json keeps source and built output, which sits one
 * directory deeper, resolving to the same file.
 */
export function externalTunnelPath(): string {
  if (process.env.FLEET_TUNNEL_STATE_FILE) return process.env.FLEET_TUNNEL_STATE_FILE;
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return join(directory, "data", "tunnel.json");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the URL published by a separately running tunnel process.
 *
 * The liveness check matters: the file outlives a hard kill, and serving a URL
 * that no longer forwards anywhere is worse than reporting no tunnel at all,
 * because the enrollment command would silently point nodes into the void.
 */
export function readExternalTunnel(
  path = externalTunnelPath(),
  alive: (pid: number) => boolean = isProcessAlive,
): ExternalTunnel | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const state = StateSchema.safeParse(parsed);
  if (!state.success) return undefined;
  if (!alive(state.data.pid)) return undefined;
  return {
    provider: state.data.provider,
    url: state.data.url || undefined,
  };
}

/**
 * Reclaims the ground before a new tunnel starts.
 *
 * A SIGKILLed wrapper cannot clean up after itself, so its provider keeps
 * running with nobody tracking it. Starting a second one anyway would leave two
 * tunnels fighting over the same local port, so the leftover is killed: the URL
 * changes either way, and a predictable restart beats a silent pile-up.
 */
export function adoptOrKillStale(
  path = externalTunnelPath(),
  log: (message: string) => void = () => {},
  alive: (pid: number) => boolean = isProcessAlive,
  kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
): void {
  let pid: number;
  try {
    const state = StateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!state.success) return;
    pid = state.data.pid;
  } catch {
    return;
  }
  if (!alive(pid)) return;
  try {
    kill(pid);
    log(`stopped leftover tunnel (pid ${pid})`);
  } catch {
    // Already gone, or owned by another user; starting fresh is still correct.
  }
}
