import { z } from "zod";
import {
  NODE_ID_HEADER,
  NODE_PROOF_NONCE_HEADER,
  NODE_PROOF_SIGNATURE_HEADER,
  NODE_PROOF_TIMESTAMP_HEADER,
  NODE_SECRET_HEADER,
  SessionSchema,
} from "@fleet/protocol";
import { signNodeHttpProof } from "@fleet/protocol/node-auth";

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

const SessionStatusLikeSchema = SessionSchema.pick({
  id: true,
  placementId: true,
  nodeId: true,
  state: true,
  agentSessionId: true,
});
export type SessionStatusLike = z.infer<typeof SessionStatusLikeSchema>;

const StartedSessionSchema = SessionSchema.pick({
  id: true,
  state: true,
  agentSessionId: true,
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
   * anonymous one. Absent before enrollment, and on a node that has a key.
   */
  nodeSecret?: () => string | undefined;
  /**
   * This node's private key, for a machine that has one instead of a secret.
   *
   * Preferred over the secret when both somehow exist: a signature authorises
   * the one call it was made for, and a secret authorises every call anyone
   * who sees it cares to make.
   */
  nodeKey?: () => string | undefined;
};

/** The identity headers a relayed call carries, or nothing before enrollment. */
type NodeCredentialHeaders = Record<string, string>;

async function request<T>(
  base: string,
  path: string,
  schema: z.ZodType<T>,
  init: {
    method?: string;
    body?: string;
    credentials?: (input: {
      method: string;
      path: string;
      body?: string;
    }) => NodeCredentialHeaders;
  } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const url = new URL(path, base);
  const response = await fetch(url, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body ? { body: init.body } : {}),
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      // Built here rather than passed in, because a signature covers the exact
      // call being made — the method, the path the URL resolved to, and the
      // body — and a caller assembling it separately is a caller that will
      // eventually sign one request and send another.
      ...init.credentials?.({
        method,
        path: url.pathname,
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
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
   *
   * A keyed node signs the call instead of presenting anything reusable. That
   * is the whole difference: a secret observed once authorises every future
   * call, and a signature authorises the one that carried it.
   */
  private credentials(input: {
    method: string;
    path: string;
    body?: string;
  }): NodeCredentialHeaders {
    const nodeId = this.options.nodeId();
    if (!nodeId) return {};
    const privateKey = this.options.nodeKey?.();
    if (privateKey) {
      const proof = signNodeHttpProof({
        privateKey,
        nodeId,
        method: input.method,
        path: input.path,
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      return {
        [NODE_ID_HEADER]: nodeId,
        [NODE_PROOF_TIMESTAMP_HEADER]: proof.timestamp,
        [NODE_PROOF_NONCE_HEADER]: proof.nonce,
        [NODE_PROOF_SIGNATURE_HEADER]: proof.signature,
      };
    }
    const secret = this.options.nodeSecret?.();
    if (!secret) return {};
    return { [NODE_ID_HEADER]: nodeId, [NODE_SECRET_HEADER]: secret };
  }

  async listWorkspaces(): Promise<WorkspaceLike[]> {
    return request(
      this.options.hostUrl(),
      "/api/workspaces",
      z.array(WorkspaceLikeSchema),
      { credentials: (input) => this.credentials(input) },
    );
  }

  async listOwnPlacements(): Promise<PlacementLike[]> {
    const placements = await request(
      this.options.hostUrl(),
      "/api/placements",
      z.array(PlacementLikeSchema),
      { credentials: (input) => this.credentials(input) },
    );
    return ownPlacements(placements, this.options.nodeId());
  }

  async createWorkspace(name: string, description: string): Promise<WorkspaceLike> {
    return request(this.options.hostUrl(), "/api/workspaces", WorkspaceLikeSchema, {
      method: "POST",
      body: JSON.stringify({ name, description }),
      credentials: (input) => this.credentials(input),
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
        credentials: (input) => this.credentials(input),
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
        credentials: (input) => this.credentials(input),
      },
    );
  }

  async createOwnPlacement(
    workspaceId: string,
    localPath: string,
  ): Promise<PlacementLike> {
    return request(this.options.hostUrl(), "/api/placements", PlacementLikeSchema, {
      method: "POST",
      credentials: (input) => this.credentials(input),
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
      { credentials: (input) => this.credentials(input) },
    );
  }

  async createOwnSession(input: {
    placementId: string;
    prompt: string;
    name?: string;
  }): Promise<StartedSession> {
    return request(this.options.hostUrl(), "/api/sessions", StartedSessionSchema, {
      method: "POST",
      credentials: (requestInput) => this.credentials(requestInput),
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
      credentials: (requestInput) => this.credentials(requestInput),
      body: JSON.stringify(input),
    });
  }
}
