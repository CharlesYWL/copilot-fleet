import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  AUTH_FAILED_CLOSE_CODE,
  NodeToHostMessageSchema,
  SUPERSEDED_CLOSE_CODE,
  decodeFrame,
} from "@fleet/protocol";
import { heartbeatSessionsBelongTo, nodeMessageBelongsTo } from "../node-messages.js";
import type { FleetService } from "../fleet-service.js";

/**
 * The Node-facing WebSocket: authenticate, then relay events and heartbeats.
 *
 * Nothing here may trust the frame it was handed — a Node is a separate machine
 * the operator enrolled — so every frame is schema-checked and every session id
 * it names is verified to belong to the node that sent it.
 */
export function registerNodeGateway(app: FastifyInstance, service: FleetService): void {
  app.get("/ws/node", { websocket: true }, (socket: WebSocket) => {
    let authenticatedNodeId: string | undefined;

    socket.once("message", (data: unknown) => {
      const frame = decodeFrame(String(data), NodeToHostMessageSchema);
      if (!frame.ok) {
        app.log.warn({ error: frame.detail }, "Rejected malformed node hello");
        socket.close(frame.code, frame.reason);
        return;
      }
      if (frame.value.type !== "hello") {
        socket.close(1008, "Expected authenticated hello");
        return;
      }
      const hello = frame.value;
      if (!service.store.authenticateNode(hello.nodeId, hello.secret)) {
        // A dedicated code lets the Node tell "your secret is stale, enroll
        // again" apart from a protocol error worth retrying as-is.
        socket.close(AUTH_FAILED_CLOSE_CODE, "Authentication failed");
        return;
      }
      authenticatedNodeId = hello.nodeId;

      const previousSocket = service.nodeSocket(hello.nodeId);
      if (previousSocket) {
        previousSocket.close(SUPERSEDED_CLOSE_CODE, "Superseded connection");
        service.disconnectNode(
          hello.nodeId,
          "Execution stopped when the Node connection was superseded",
        );
      }
      service.attachNode(hello.nodeId, socket);
      service.store.setNodeHomeDir(hello.nodeId, hello.homeDir);
      service.store.setNodeIdentity(hello.nodeId, hello.version, hello.capabilities);
      const activeSessionIds = hello.activeSessionIds ?? [];
      const node = service.store.setNodeOnline(
        hello.nodeId,
        true,
        activeSessionIds.length,
      );
      if (node) service.publishNode(node);
      service.publishSessions(
        service.store.reconcileOfflineSessions(hello.nodeId, activeSessionIds),
      );
      service.send(socket, { type: "welcome", nodeId: hello.nodeId });

      socket.on("message", (raw: unknown) => {
        const next = decodeFrame(String(raw), NodeToHostMessageSchema);
        if (!next.ok) {
          app.log.warn(
            { nodeId: hello.nodeId, error: next.detail },
            "Rejected node message",
          );
          socket.close(next.code, next.reason);
          return;
        }
        const message = next.value;
        if (
          !nodeMessageBelongsTo(hello.nodeId, message, (id) =>
            service.store.getSession(id),
          )
        ) {
          app.log.warn(
            { nodeId: hello.nodeId, messageType: message.type },
            "Rejected cross-node message",
          );
          socket.close(1008, "Session ownership mismatch");
          return;
        }
        if (message.type === "heartbeat") {
          if (
            !heartbeatSessionsBelongTo(hello.nodeId, message.activeSessionIds, (id) =>
              service.store.getSession(id),
            )
          ) {
            app.log.warn(
              { nodeId: hello.nodeId },
              "Rejected cross-node heartbeat inventory",
            );
            socket.close(1008, "Session ownership mismatch");
            return;
          }
          service.recordPresence(hello.nodeId, message.activeSessionIds);
          return;
        }
        if (message.type === "event") {
          service.handleEvent(message.event);
          return;
        }
        if (message.type === "command_result" && !message.ok) {
          app.log.warn(
            { commandId: message.commandId, error: message.error },
            "Node command failed",
          );
          service.failFromCommandResult(
            message.sessionId,
            message.error ?? "Node command failed",
          );
        }
      });
    });

    socket.on("close", () => {
      if (!authenticatedNodeId || service.shuttingDown) return;
      if (service.nodeSocket(authenticatedNodeId) === socket) {
        service.disconnectNode(
          authenticatedNodeId,
          "Execution stopped when the Node connection was lost",
        );
      }
    });
  });
}
