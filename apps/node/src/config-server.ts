import { createServer, type Server } from "node:http";
import { z } from "zod";
import { SettingsSchema, type Settings } from "./settings.js";
import { CONFIG_PAGE } from "./config-page.js";
import { FleetClient } from "./fleet-client.js";
import { inspectPath } from "./path-check.js";

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

export type ConfigStatus = {
  nodeId: string;
  version: string;
  connected: boolean;
  activeSessions: number;
  mockAgent: boolean;
};

export type ConfigServerOptions = {
  getSettings: () => Settings;
  getStatus: () => ConfigStatus;
  applySettings: (settings: Settings) => Promise<void>;
  log: (message: string) => void;
};

/**
 * A node executes arbitrary commands, so anything that can repoint it at a
 * different Host is a full compromise of this machine. The listener therefore
 * binds to loopback only: reaching it requires already being on the box (or an
 * explicit SSH tunnel), which is the same bar as editing the config file.
 */
const HOST = "127.0.0.1";

export function configServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.FLEET_NODE_CONFIG_PORT ?? 8788);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 8788;
}

export function startConfigServer(options: ConfigServerOptions): Server {
  const fleet = new FleetClient({
    hostUrl: () => options.getSettings().hostUrl,
    nodeId: () => options.getStatus().nodeId,
  });

  const server = createServer((request, response) => {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json",
        // The page is same-origin only; no browser should embed or frame it.
        "cache-control": "no-store",
      });
      response.end(payload);
    };

    const readBody = (handle: (body: string) => Promise<void>): void => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk;
        // Nothing legitimate approaches this size; stop reading rather than
        // buffering whatever a runaway client decides to send.
        if (body.length > 64_000) request.destroy();
      });
      request.on("end", () => {
        void handle(body).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          options.log(`Config request failed: ${message}`);
          send(500, { error: message });
        });
      });
    };

    /** Host calls fail for ordinary reasons (offline, stale URL), so they are
     * reported as a message the page can show rather than a 500. */
    const relay = async (work: () => Promise<unknown>): Promise<void> => {
      try {
        send(200, await work());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(502, { error: message });
      }
    };

    const url = request.url ?? "/";

    if (request.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(CONFIG_PAGE);
      return;
    }

    if (request.method === "GET" && url === "/api/config") {
      send(200, { settings: options.getSettings(), status: options.getStatus() });
      return;
    }

    if (request.method === "POST" && url === "/api/config") {
      readBody(async (body) => {
        const parsed = SettingsSchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          send(400, { error: parsed.error.issues[0]?.message ?? "Invalid settings" });
          return;
        }
        await options.applySettings(parsed.data);
        send(200, { settings: options.getSettings(), status: options.getStatus() });
      });
      return;
    }

    if (request.method === "GET" && url === "/api/fleet") {
      void relay(async () => ({
        workspaces: await fleet.listWorkspaces(),
        placements: await fleet.listOwnPlacements(),
      }));
      return;
    }

    if (request.method === "POST" && url === "/api/check-path") {
      readBody(async (body) => {
        const input: unknown = JSON.parse(body);
        const path =
          input && typeof input === "object" && "path" in input
            ? String((input as { path: unknown }).path)
            : "";
        send(200, inspectPath(path));
      });
      return;
    }

    if (request.method === "POST" && url === "/api/workspaces") {
      readBody(async (body) => {
        const input = WorkspaceInputSchema.safeParse(JSON.parse(body));
        if (!input.success) {
          send(400, { error: input.error.issues[0]?.message ?? "Invalid workspace" });
          return;
        }
        const { id, name, description } = input.data;
        await relay(async () =>
          id
            ? fleet.updateWorkspace(id, name, description)
            : fleet.createWorkspace(name, description),
        );
      });
      return;
    }

    if (request.method === "POST" && url === "/api/placements") {
      readBody(async (body) => {
        const input = PlacementInputSchema.safeParse(JSON.parse(body));
        if (!input.success) {
          send(400, { error: input.error.issues[0]?.message ?? "Invalid placement" });
          return;
        }
        const { id, workspaceId, localPath } = input.data;
        // Refusing a path this machine cannot open keeps the mistake here,
        // instead of surfacing later as a session that will not start.
        const check = inspectPath(localPath);
        if (!check.ok) {
          send(400, { error: check.reason });
          return;
        }
        await relay(async () =>
          id
            ? fleet.updateOwnPlacementPath(id, localPath.trim())
            : fleet.createOwnPlacement(workspaceId, localPath.trim()),
        );
      });
      return;
    }

    send(404, { error: "Not found" });
  });

  const port = configServerPort();
  server.listen(port, HOST, () => {
    options.log(`  config UI   http://${HOST}:${port}`);
  });
  server.on("error", (error) => {
    options.log(`Config UI unavailable: ${error.message}`);
  });
  return server;
}
