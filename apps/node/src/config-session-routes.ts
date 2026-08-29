import { resolve } from "node:path";
import { z } from "zod";
import { SESSION_NAME_MAX_LENGTH, errorMessage } from "@fleet/protocol";
import { CopilotSessionDiscoveryError } from "./copilot-sessions.js";
import type {
  ConfigReply,
  FleetApi,
  SessionDiscoveryApi,
} from "./config-server-types.js";

const NewSessionInputSchema = z.object({
  placementId: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  name: z.string().max(SESSION_NAME_MAX_LENGTH).optional(),
});

const liveStates = new Set(["queued", "starting", "running", "idle", "cancelling"]);
const ok = (body: unknown): ConfigReply => ({ status: 200, body });
const badRequest = (error: string): ConfigReply => ({ status: 400, body: { error } });

function discoveryFailure(error: unknown): ConfigReply {
  if (!(error instanceof CopilotSessionDiscoveryError)) {
    return { status: 502, body: { error: errorMessage(error) } };
  }
  const status =
    error.code === "session_not_found"
      ? 404
      : error.code === "unsupported_list" || error.code === "unsupported_load"
        ? 409
        : error.code === "load_failed"
          ? 422
          : 502;
  return { status, body: { error: error.message, code: error.code } };
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function queryValue(url: string, name: string): string | undefined {
  const query = url.split("?")[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get(name) ?? undefined;
}

async function relay(work: () => Promise<unknown>): Promise<ConfigReply> {
  try {
    return ok(await work());
  } catch (error) {
    return { status: 502, body: { error: errorMessage(error) } };
  }
}

export function createSessionRouteHandler(
  fleet: FleetApi,
  discovery: SessionDiscoveryApi,
): (method: string, url: string, body: string) => Promise<ConfigReply | undefined> {
  return async (method, url, body) => {
    const pathname = url.split("?")[0] ?? url;
    if (method === "POST" && pathname === "/api/sessions/new") {
      const input = NewSessionInputSchema.safeParse(JSON.parse(body));
      if (!input.success) {
        return badRequest(input.error.issues[0]?.message ?? "Invalid session");
      }
      const mine = await fleet.listOwnPlacements();
      if (!mine.some((placement) => placement.id === input.data.placementId)) {
        return {
          status: 403,
          body: { error: "That placement belongs to another node" },
        };
      }
      return relay(async () => {
        const created = await fleet.createOwnSession({
          placementId: input.data.placementId,
          prompt: input.data.prompt,
          ...(input.data.name === undefined ? {} : { name: input.data.name }),
        });
        return { sessionId: created.id, state: created.state };
      });
    }

    if (method === "GET" && pathname === "/api/sessions") {
      try {
        const [page, placements, statuses] = await Promise.all([
          discovery.list(queryValue(url, "cursor")),
          fleet.listOwnPlacements(),
          fleet.listOwnSessions(),
        ]);
        const placementByPath = new Map(
          placements.map((placement) => [comparablePath(placement.localPath), placement]),
        );
        const statusByAgentId = new Map(
          statuses
            .filter((status) => status.agentSessionId)
            .map((status) => [status.agentSessionId, status]),
        );
        return ok({
          sessions: page.sessions.map((session) => {
            const placement = placementByPath.get(comparablePath(session.cwd));
            const status = statusByAgentId.get(session.id);
            const alreadyLive = status && liveStates.has(status.state);
            const resumeReason = !session.loadSupported
              ? "This Copilot version can discover this session but cannot load its context."
              : !placement
                ? "No Fleet placement on this node matches this session's project."
                : alreadyLive
                  ? "This Copilot session is already live in Fleet."
                  : undefined;
            return {
              id: session.id,
              title: session.title ?? null,
              updatedAt: session.updatedAt ?? null,
              createdAt: null,
              status: status?.state ?? "Available",
              workspaceName: placement?.workspaceName ?? null,
              placementId: placement?.id ?? null,
              resumable: Boolean(session.loadSupported && placement && !alreadyLive),
              resumeReason: resumeReason ?? null,
              legacy: session.title === undefined || session.updatedAt === undefined,
            };
          }),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
      } catch (error) {
        return discoveryFailure(error);
      }
    }

    const previewMatch = /^\/api\/sessions\/([^/]+)\/preview$/.exec(pathname);
    if (method === "GET" && previewMatch?.[1]) {
      try {
        const id = decodeURIComponent(previewMatch[1]);
        return ok({ id, ...(await discovery.preview(id)) });
      } catch (error) {
        return discoveryFailure(error);
      }
    }

    const resumeMatch = /^\/api\/sessions\/([^/]+)\/resume$/.exec(pathname);
    if (method !== "POST" || !resumeMatch?.[1]) return undefined;
    const sessionId = decodeURIComponent(resumeMatch[1]);
    const session = discovery.get(sessionId);
    if (!session) {
      return {
        status: 404,
        body: { error: "Refresh the Copilot session list before resuming it" },
      };
    }
    try {
      const [placements, statuses] = await Promise.all([
        fleet.listOwnPlacements(),
        fleet.listOwnSessions(),
      ]);
      const placement = placements.find(
        (candidate) =>
          comparablePath(candidate.localPath) === comparablePath(session.cwd),
      );
      if (!placement) {
        return {
          status: 409,
          body: {
            error: "No Fleet placement on this node matches this session's project.",
          },
        };
      }
      const live = statuses.find(
        (status) => status.agentSessionId === sessionId && liveStates.has(status.state),
      );
      if (live) {
        return {
          status: 409,
          body: { error: "This Copilot session is already live in Fleet." },
        };
      }
      const resumed = await fleet.adoptOwnSession({
        placementId: placement.id,
        agentSessionId: sessionId,
        additionalDirectories: session.additionalDirectories,
        ...(session.title === undefined
          ? {}
          : { name: session.title.slice(0, SESSION_NAME_MAX_LENGTH) }),
      });
      return ok({ sessionId: resumed.id, state: resumed.state });
    } catch (error) {
      return { status: 502, body: { error: errorMessage(error) } };
    }
  };
}
