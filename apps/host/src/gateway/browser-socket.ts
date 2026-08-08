import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { FleetService } from "../fleet-service.js";

/**
 * The browser-facing WebSocket.
 *
 * Send-only: the page issues every change over REST, so a frame arriving here
 * would have no meaning and is simply never read.
 */
export function registerBrowserGateway(
  app: FastifyInstance,
  service: FleetService,
): void {
  app.get("/ws/browser", { websocket: true }, (socket: WebSocket) => {
    service.addBrowser(socket);
    service.send(socket, { type: "snapshot", data: service.snapshot() });
    socket.on("close", () => service.removeBrowser(socket));
  });
}
