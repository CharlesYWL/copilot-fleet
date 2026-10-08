import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LOCAL_AGENT_DEFAULT_PORT } from "@fleet/protocol";
import { externalTunnelPath } from "./external-tunnel.js";

const MarkerSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  pid: z.number().int().positive(),
  url: z.string(),
});
export type LocalAgentMarker = z.infer<typeof MarkerSchema>;

/**
 * Where a listening local agent API says which port it holds.
 *
 * Beside the detached tunnel's state file, because the tunnel process is the
 * one reader: it has no database and no other way to learn which loopback port
 * must never be published.
 */
export function localAgentMarkerPath(): string {
  return join(dirname(externalTunnelPath()), "local-agent.json");
}

export function writeLocalAgentMarker(path: string, marker: LocalAgentMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2));
}

export function clearLocalAgentMarker(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale marker only makes the tunnel guard refuse one more port.
  }
}

export function readLocalAgentMarker(
  path = localAgentMarkerPath(),
): LocalAgentMarker | undefined {
  try {
    const parsed = MarkerSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a detached tunnel must not forward `targetPort`, if it must not.
 *
 * The local agent API trusts whoever can reach its loopback port; a tunnel in
 * front of it would hand that trust to the internet. The default port is
 * refused even without a marker — the API may simply not be listening yet —
 * unless it is the Host's own port, which an operator may have chosen.
 */
export function localAgentTunnelConflict(
  targetPort: number,
  hostPort: number,
  marker: LocalAgentMarker | undefined = readLocalAgentMarker(),
): string | undefined {
  if (marker && marker.port === targetPort)
    return `Port ${targetPort} is the Fleet local agent API, which must never be tunnelled. Point the tunnel at the Host's port instead.`;
  if (targetPort === LOCAL_AGENT_DEFAULT_PORT && targetPort !== hostPort)
    return `Port ${targetPort} is reserved for the Fleet local agent API, which must never be tunnelled. Point the tunnel at the Host's port instead.`;
  return undefined;
}
