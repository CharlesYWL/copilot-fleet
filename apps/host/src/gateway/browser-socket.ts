import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { FleetService } from "../fleet-service.js";
import { OPERATOR_COOKIE, readCookie } from "../auth.js";
import { NO_AUTH_PRINCIPAL, type FleetAuth } from "../auth/service.js";
import {
  AUTHENTICATION_CLOSE_CODE,
  type BrowserSessionRegistry,
} from "./browser-registry.js";

export type BrowserGatewayOptions = {
  service: FleetService;
  auth: FleetAuth;
  registry: BrowserSessionRegistry;
};

/**
 * The browser-facing WebSocket.
 *
 * Send-only: the page issues every change over REST, so a frame arriving here
 * would have no meaning and is simply never read.
 *
 * The socket is registered against the session that opened it. A REST request
 * is checked once and ends; this stays open and streams every transcript in the
 * fleet, so without a binding a removed administrator would keep watching for
 * as long as they left the tab open.
 */
export function registerBrowserGateway(
  app: FastifyInstance,
  { service, auth, registry }: BrowserGatewayOptions,
): void {
  app.get(
    "/ws/browser",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const session =
        request.fleetSession ??
        auth.verifySession(readCookie(request.headers.cookie, OPERATOR_COOKIE));
      // The guard has already refused an unauthenticated handshake; this asks
      // the same question at the moment the stream starts, because the two are
      // not the same moment and this is the one that lasts.
      const noAuth =
        auth.noAuthEnabled() && auth.noAuthEndpointAllowed(request.headers.host);
      if (noAuth) {
        registry.add(socket, {
          tokenHash: NO_AUTH_PRINCIPAL,
          administratorId: "",
          expiresAt: Infinity,
        });
      } else if (session && auth.sessionStillAuthorized(session)) {
        registry.add(socket, {
          tokenHash: session.tokenHash,
          administratorId: session.administratorId,
          expiresAt: session.expiresAt,
        });
      } else {
        socket.close(AUTHENTICATION_CLOSE_CODE, "Session ended — sign in again");
        return;
      }
      service.addBrowser(socket);
      service.send(socket, { type: "snapshot", data: service.snapshot() });
      socket.on("close", () => {
        registry.remove(socket);
        service.removeBrowser(socket);
      });
    },
  );
}
