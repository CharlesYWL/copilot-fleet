import { z } from "zod";
import { NODE_ID_HEADER, NODE_SECRET_HEADER } from "@fleet/protocol";

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

const SessionStatusLikeSchema = z.object({
  id: z.string(),
  placementId: z.string(),
  nodeId: z.string(),
  state: z.string(),
  agentSessionId: z.string().default(""),
});
export type SessionStatusLike = z.infer<typeof SessionStatusLikeSchema>;

const StartedSessionSchema = z.object({
  id: z.string(),
  state: z.string(),
  agentSessionId: z.string().default(""),
});
export type StartedSession = z.infer<typeof StartedSessionSchema>;

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
  /**
   * This node's secret, which is how the Host tells a relayed call from an
   * anonymous one. Absent before enrollment, when there is nothing to say.
   */
  nodeSecret?: () => string | undefined;
};

/** The identity headers a relayed call carries, or nothing before enrollment. */
type NodeCredentialHeaders = Record<string, string>;

async function request<T>(
  base: string,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: string; credentials?: NodeCredentialHeaders } = {},
): Promise<T> {
  const response = await fetch(new URL(path, base), {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body ? { body: init.body } : {}),
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.credentials,
    },
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

  /**
   * What identifies this node to the Host, when it has an identity yet.
   *
   * Sent on every call rather than only the writes: the Host's API is not open
   * to anonymous callers any more, so a read without this is a 401.
   */
  private credentials(): NodeCredentialHeaders {
    const nodeId = this.options.nodeId();
    const secret = this.options.nodeSecret?.();
    if (!nodeId || !secret) return {};
    return { [NODE_ID_HEADER]: nodeId, [NODE_SECRET_HEADER]: secret };
  }

  async listWorkspaces(): Promise<WorkspaceLike[]> {
    return request(
      this.options.hostUrl(),
      "/api/workspaces",
      z.array(WorkspaceLikeSchema),
      { credentials: this.credentials() },
    );
  }

  async listOwnPlacements(): Promise<PlacementLike[]> {
    const placements = await request(
      this.options.hostUrl(),
      "/api/placements",
      z.array(PlacementLikeSchema),
      { credentials: this.credentials() },
    );
    return ownPlacements(placements, this.options.nodeId());
  }

  async createWorkspace(name: string, description: string): Promise<WorkspaceLike> {
    return request(this.options.hostUrl(), "/api/workspaces", WorkspaceLikeSchema, {
      method: "POST",
      body: JSON.stringify({ name, description }),
      credentials: this.credentials(),
    });
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
      {
        method: "PATCH",
        body: JSON.stringify({ name, description }),
        credentials: this.credentials(),
      },
    );
  }

  /**
   * Rejects a path on a placement this node does not own.
   *
   * The Host now refuses the same thing, having learned who is calling from the
   * credentials above, but the message it can give is a bare 403; checking here
   * is what turns that into something the page can explain.
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
      {
        method: "PATCH",
        body: JSON.stringify({ localPath }),
        credentials: this.credentials(),
      },
    );
  }

  async createOwnPlacement(
    workspaceId: string,
    localPath: string,
  ): Promise<PlacementLike> {
    return request(this.options.hostUrl(), "/api/placements", PlacementLikeSchema, {
      method: "POST",
      credentials: this.credentials(),
      body: JSON.stringify({
        workspaceId,
        nodeId: this.options.nodeId(),
        localPath,
      }),
    });
  }

  async listOwnSessions(): Promise<SessionStatusLike[]> {
    return request(
      this.options.hostUrl(),
      "/api/sessions",
      z.array(SessionStatusLikeSchema),
      { credentials: this.credentials() },
    );
  }

  async createOwnSession(input: {
    placementId: string;
    prompt: string;
    name?: string;
  }): Promise<StartedSession> {
    return request(this.options.hostUrl(), "/api/sessions", StartedSessionSchema, {
      method: "POST",
      credentials: this.credentials(),
      body: JSON.stringify(input),
    });
  }

  async adoptOwnSession(input: {
    placementId: string;
    agentSessionId: string;
    additionalDirectories: string[];
    name?: string;
  }): Promise<StartedSession> {
    return request(this.options.hostUrl(), "/api/sessions/adopt", StartedSessionSchema, {
      method: "POST",
      credentials: this.credentials(),
      body: JSON.stringify(input),
    });
  }
}
