import { createServer, type Server } from "node:http";
import { z } from "zod";
import {
  BACKUP_VERSION,
  HOST_BACKUP_KIND,
  NODE_BACKUP_KIND,
  NodeBackupSchema,
  backupKind,
  errorMessage,
} from "@fleet/protocol";
import { EditableSettingsSchema } from "./settings.js";
import { configAsset } from "./config-assets.js";
import { createSessionRouteHandler } from "./config-session-routes.js";
import type {
  ConfigReply,
  ConfigRouter,
  ConfigServerOptions,
  FleetApi,
} from "./config-server-types.js";
import { FleetClient } from "./fleet-client.js";
import { pickFolder as pickFolderDefault } from "./pick-folder.js";
import { inspectPath as inspectPathDefault } from "./path-check.js";
import { CopilotSessionDiscovery } from "./copilot-sessions.js";

export type {
  ConfigReply,
  ConfigRouter,
  ConfigServerOptions,
  ConfigStatus,
  FleetApi,
  SessionDiscoveryApi,
} from "./config-server-types.js";

/** An id turns create into update; the page uses one form for both. */
const WorkspaceInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
});

const PlacementInputSchema = z.object({
  id: z.string().optional(),
  workspaceId: z.string().default(""),
  localPath: z.string().min(1).max(4096),
});

/** A handler answers one method+path; the body arrives already read. */
type Handler = (body: string) => Promise<ConfigReply>;

/**
 * A node executes arbitrary commands, so anything that can repoint it at a
 * different Host is a full compromise of this machine. The listener therefore
 * binds to loopback only: reaching it requires already being on the box (or an
 * explicit SSH tunnel), which is the same bar as editing the config file.
 */
const HOST = "127.0.0.1";

/** Loopback names a browser on this machine can legitimately have used. */
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function hostnameOf(value: string): string | undefined {
  const authority = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0] ?? "";
  const bracketed = /^\[([^\]]+)]/.exec(authority);
  if (bracketed) return bracketed[1]?.toLowerCase();
  const [host] = authority.split(":");
  return host ? host.toLowerCase() : undefined;
}

function portOf(value: string): string | undefined {
  const authority = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0] ?? "";
  const withoutHost = authority.startsWith("[")
    ? authority.slice(authority.indexOf("]") + 1)
    : authority;
  const [, port] = withoutHost.split(":");
  return port;
}

export type GuardInput = {
  method: string;
  host?: string | undefined;
  origin?: string | undefined;
  contentType?: string | undefined;
  port: number;
};

/**
 * Why a request was refused before it reached a handler, or `undefined`.
 *
 * Binding to loopback is not by itself a boundary a browser respects. Any page
 * the person at this machine happens to open can POST to 127.0.0.1 — and a
 * simple request (`text/plain`, a form) is sent without a preflight the server
 * ever gets to refuse, so the first place this can be stopped is here, by what
 * the browser was honest about: `Origin`. `Host` closes the other half, DNS
 * rebinding, where the attacker's own name resolves to loopback and the page is
 * therefore same-origin with this server.
 */
export function refuseRequest({
  method,
  host,
  origin,
  contentType,
  port,
}: GuardInput): ConfigReply | undefined {
  const name = host ? hostnameOf(host) : undefined;
  const hostPort = host ? portOf(host) : undefined;
  if (!name || !LOOPBACK_NAMES.has(name) || (hostPort && hostPort !== String(port))) {
    return {
      status: 403,
      body: {
        error: `This page is only reachable at http://${HOST}:${port}. Open it there rather than through another name.`,
      },
    };
  }
  if (origin !== undefined) {
    const originName = hostnameOf(origin);
    const originPort = portOf(origin);
    if (
      !originName ||
      !LOOPBACK_NAMES.has(originName) ||
      (originPort ?? "") !== String(port)
    ) {
      return { status: 403, body: { error: "Cross-origin request refused" } };
    }
  }
  if (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") return undefined;
  // A cross-site form or `text/plain` fetch cannot set this header, so
  // insisting on it is what keeps a request that never asked permission out.
  if (!(contentType ?? "").toLowerCase().startsWith("application/json")) {
    return {
      status: 415,
      body: { error: "Expected content-type: application/json" },
    };
  }
  return undefined;
}

export function configServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.FLEET_NODE_CONFIG_PORT ?? 8788);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 8788;
}

const ok = (body: unknown): ConfigReply => ({ status: 200, body });
const badRequest = (error: string): ConfigReply => ({ status: 400, body: { error } });

/** Host calls fail for ordinary reasons (offline, stale URL), so they are
 * reported as a message the page can show rather than a 500. */
async function relay(work: () => Promise<unknown>): Promise<ConfigReply> {
  try {
    return ok(await work());
  } catch (error) {
    return { status: 502, body: { error: errorMessage(error) } };
  }
}

function pathFrom(body: string): string {
  const input: unknown = JSON.parse(body);
  return input && typeof input === "object" && "path" in input
    ? String((input as { path: unknown }).path)
    : "";
}

/**
 * The config endpoints as a table, separate from the HTTP plumbing.
 *
 * Every dependency that reaches off this process — the Host, the folder dialog,
 * the filesystem — arrives as an option, so the endpoints can be exercised
 * without a Host to talk to or a display to open a dialog on.
 */
export function createConfigRouter(options: ConfigServerOptions): ConfigRouter {
  const fleet: FleetApi =
    options.fleet ??
    new FleetClient({
      hostUrl: () => options.getSettings().hostUrl,
      nodeId: () => options.getStatus().nodeId,
      nodeSecret: () => options.getCredentials()?.secret,
    });
  const pickFolder = options.pickFolder ?? pickFolderDefault;
  const inspectPath = options.inspectPath ?? inspectPathDefault;
  const discovery =
    options.sessionDiscovery ??
    new CopilotSessionDiscovery({
      getCopilotCommand: () => options.getSettings().copilotCommand,
      getContextTier: () => options.getSettings().contextTier,
    });
  const sessionRoute = createSessionRouteHandler(fleet, discovery);
  const state = (): ConfigReply =>
    ok({ settings: options.getSettings(), status: options.getStatus() });

  const routes = new Map<string, Handler>([
    ["GET /api/config", async () => state()],
    [
      "GET /api/backup",
      async () => {
        const credentials = options.getCredentials();
        if (!credentials) {
          return {
            status: 409,
            body: { error: "Enroll this node before exporting its identity." },
          };
        }
        return ok({
          kind: NODE_BACKUP_KIND,
          version: BACKUP_VERSION,
          exportedAt: new Date().toISOString(),
          credentials,
          settings: options.getSettings(),
        });
      },
    ],
    [
      "POST /api/backup",
      async (body) => {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(body);
        } catch {
          return badRequest("Not valid JSON.");
        }
        if (backupKind(parsedBody) === HOST_BACKUP_KIND) {
          return badRequest(
            "This file is a Host archive. Import it under Settings → General on the Host.",
          );
        }
        const parsed = NodeBackupSchema.safeParse(parsedBody);
        if (!parsed.success) {
          return badRequest("Not a Copilot Fleet node identity archive.");
        }
        await options.applyBackup(parsed.data);
        return state();
      },
    ],
    [
      "POST /api/config",
      async (body) => {
        const parsed = EditableSettingsSchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          return badRequest(parsed.error.issues[0]?.message ?? "Invalid settings");
        }
        // Merged rather than replaced: the page posts back the fields it shows,
        // and the rest of the settings are bookkeeping this process maintains —
        // a save must not be able to erase them.
        await options.applySettings({ ...options.getSettings(), ...parsed.data });
        return state();
      },
    ],
    [
      "GET /api/fleet",
      async () =>
        relay(async () => ({
          workspaces: await fleet.listWorkspaces(),
          placements: await fleet.listOwnPlacements(),
        })),
    ],
    ["POST /api/check-path", async (body) => ok(inspectPath(pathFrom(body)))],
    [
      "GET /api/logs",
      async () => ok({ entries: options.recentLogs ? options.recentLogs() : [] }),
    ],
    [
      "POST /api/devtunnel/rebuild",
      async () => {
        if (!options.rebuildDevTunnel) {
          return {
            status: 409,
            body: {
              error:
                "This node does not use a dev tunnel; it dials the Host URL directly.",
            },
          };
        }
        options.rebuildDevTunnel();
        // The new forward is not up yet and may land on a different port, so
        // this reports that the work started rather than claiming a result it
        // cannot have. The page polls the status for the outcome.
        options.log("Dev tunnel rebuild requested from the config page");
        return ok({ started: true });
      },
    ],
    [
      "POST /api/pick-folder",
      // The dialog opens on this machine's display, so this only resolves once
      // whoever is sitting there answers it.
      async (body) => ok(await pickFolder(pathFrom(body))),
    ],
    [
      "POST /api/workspaces",
      async (body) => {
        const input = WorkspaceInputSchema.safeParse(JSON.parse(body));
        if (!input.success) {
          return badRequest(input.error.issues[0]?.message ?? "Invalid workspace");
        }
        const { id, name, description } = input.data;
        return relay(async () =>
          id
            ? fleet.updateWorkspace(id, name, description)
            : fleet.createWorkspace(name, description),
        );
      },
    ],
    [
      "POST /api/placements",
      async (body) => {
        const input = PlacementInputSchema.safeParse(JSON.parse(body));
        if (!input.success) {
          return badRequest(input.error.issues[0]?.message ?? "Invalid placement");
        }
        const { id, workspaceId, localPath } = input.data;
        // Refusing a path this machine cannot open keeps the mistake here,
        // instead of surfacing later as a session that will not start.
        const check = inspectPath(localPath);
        if (!check.ok) return badRequest(check.reason);
        return relay(async () =>
          id
            ? fleet.updateOwnPlacementPath(id, localPath.trim())
            : fleet.createOwnPlacement(workspaceId, localPath.trim()),
        );
      },
    ],
  ]);

  return async (method, url, body) => {
    try {
      const sessionReply = await sessionRoute(method, url, body);
      if (sessionReply) return sessionReply;
      // Query strings belong to the page, not to the route key.
      const pathname = url.split("?")[0] ?? url;
      const handler = routes.get(`${method} ${pathname}`);
      if (!handler) return { status: 404, body: { error: "Not found" } };
      return await handler(body);
    } catch (error) {
      const message = errorMessage(error);
      options.log(`Config request failed: ${message}`);
      return { status: 500, body: { error: message } };
    }
  };
}

export function startConfigServer(options: ConfigServerOptions): Server {
  const route = createConfigRouter(options);
  const port = options.port ?? configServerPort();

  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    const pathname = url.split("?")[0] ?? url;
    const refusal = refuseRequest({
      method: request.method ?? "GET",
      host: request.headers.host,
      origin: request.headers.origin,
      contentType: request.headers["content-type"],
      port,
    });
    if (refusal) {
      // Read to completion first: a body left unread makes a browser report the
      // refusal as a network error rather than as the answer it is.
      request.resume();
      response.writeHead(refusal.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(refusal.body));
      return;
    }
    const asset = request.method === "GET" ? configAsset(pathname) : undefined;
    if (asset) {
      response.writeHead(200, {
        "content-type": asset.contentType,
        // The page is same-origin only; no browser should embed or frame it.
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      response.end(asset.body);
      return;
    }

    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk;
      // Nothing legitimate approaches this size; stop reading rather than
      // buffering whatever a runaway client decides to send.
      if (body.length > 64_000) request.destroy();
    });
    request.on("end", () => {
      void route(request.method ?? "GET", url, body).then((reply) => {
        response.writeHead(reply.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(reply.body));
      });
    });
  });

  server.listen(port, HOST, () => {
    options.log(`  config UI   http://${HOST}:${port}`);
  });
  server.on("error", (error) => {
    options.log(`Config UI unavailable: ${error.message}`);
  });
  return server;
}
