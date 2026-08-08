import { z } from "zod";

/**
 * The subset of a placement this page needs. Declared locally rather than
 * imported from the protocol so the node keeps working against a Host that has
 * added fields it does not care about.
 */
const PlacementLikeSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  nodeId: z.string(),
  localPath: z.string(),
  workspaceName: z.string().optional(),
});
export type PlacementLike = z.infer<typeof PlacementLikeSchema>;

const WorkspaceLikeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional().default(""),
});
export type WorkspaceLike = z.infer<typeof WorkspaceLikeSchema>;

/**
 * Narrows the fleet's placements to the ones this machine owns.
 *
 * The page exists to fix absolute paths, and an absolute path only means
 * anything on the machine it was written for, so exposing other nodes' rows
 * would mostly offer ways to break them. An empty id matches nothing: a node
 * that has not enrolled has no identity to scope by.
 */
export function ownPlacements(
  placements: readonly PlacementLike[],
  nodeId: string,
): PlacementLike[] {
  if (!nodeId) return [];
  return placements.filter((placement) => placement.nodeId === nodeId);
}

export type FleetClientOptions = {
  hostUrl: () => string;
  nodeId: () => string;
};

async function request<T>(
  base: string,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: string } = {},
): Promise<T> {
  const response = await fetch(new URL(path, base), {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body
      ? { body: init.body, headers: { "content-type": "application/json" } }
      : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // The Host replies with {error} on failure; fall back to the raw body so a
    // proxy error page does not surface as an empty message.
    let message = text;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        message = String((parsed as { error: unknown }).error);
      }
    } catch {
      // Keep the raw text.
    }
    throw new Error(`Host responded ${response.status}: ${message}`);
  }
  return schema.parse(text ? JSON.parse(text) : undefined);
}

/**
 * Talks to the Host's HTTP API on behalf of the local config page.
 *
 * The page cannot call the Host directly: it is served from a different origin
 * and the Host sends no CORS headers, so the browser would block it. Proxying
 * through this process also keeps the node's identity server-side, which is
 * what lets the ownership scoping above mean anything.
 */
export class FleetClient {
  constructor(private readonly options: FleetClientOptions) {}

  async listWorkspaces(): Promise<WorkspaceLike[]> {
    return request(
      this.options.hostUrl(),
      "/api/workspaces",
      z.array(WorkspaceLikeSchema),
    );
  }

  async listOwnPlacements(): Promise<PlacementLike[]> {
    const placements = await request(
      this.options.hostUrl(),
      "/api/placements",
      z.array(PlacementLikeSchema),
    );
    return ownPlacements(placements, this.options.nodeId());
  }

  async createWorkspace(name: string, description: string): Promise<WorkspaceLike> {
    return request(
      this.options.hostUrl(),
      "/api/workspaces",
      WorkspaceLikeSchema,
      { method: "POST", body: JSON.stringify({ name, description }) },
    );
  }

  async updateWorkspace(
    id: string,
    name: string,
    description: string,
  ): Promise<WorkspaceLike> {
    return request(
      this.options.hostUrl(),
      `/api/workspaces/${encodeURIComponent(id)}`,
      WorkspaceLikeSchema,
      { method: "PATCH", body: JSON.stringify({ name, description }) },
    );
  }

  /**
   * Rejects a path on a placement this node does not own. The Host cannot make
   * that call for us — it has no way to tell which node the request came from —
   * so the check has to happen here, where the identity is known.
   */
  async updateOwnPlacementPath(id: string, localPath: string): Promise<PlacementLike> {
    const mine = await this.listOwnPlacements();
    if (!mine.some((placement) => placement.id === id)) {
      throw new Error("That placement belongs to a different node");
    }
    return request(
      this.options.hostUrl(),
      `/api/placements/${encodeURIComponent(id)}`,
      PlacementLikeSchema,
      { method: "PATCH", body: JSON.stringify({ localPath }) },
    );
  }

  async createOwnPlacement(
    workspaceId: string,
    localPath: string,
  ): Promise<PlacementLike> {
    return request(
      this.options.hostUrl(),
      "/api/placements",
      PlacementLikeSchema,
      {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          nodeId: this.options.nodeId(),
          localPath,
        }),
      },
    );
  }
}
