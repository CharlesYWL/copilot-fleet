import { createServer, type Server } from "node:http";
import { SettingsSchema, type Settings } from "./settings.js";
import { CONFIG_PAGE } from "./config-page.js";

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
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk;
        // Nothing legitimate approaches this size; stop reading rather than
        // buffering whatever a runaway client decides to send.
        if (body.length > 64_000) request.destroy();
      });
      request.on("end", () => {
        void (async () => {
          try {
            const parsed = SettingsSchema.safeParse(JSON.parse(body));
            if (!parsed.success) {
              send(400, { error: parsed.error.issues[0]?.message ?? "Invalid settings" });
              return;
            }
            await options.applySettings(parsed.data);
            send(200, { settings: options.getSettings(), status: options.getStatus() });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.log(`Config update failed: ${message}`);
            send(500, { error: message });
          }
        })();
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
