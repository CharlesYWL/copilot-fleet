import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  AUTH_FAILED_CLOSE_CODE,
  NodeToHostMessageSchema,
  SUPERSEDED_CLOSE_CODE,
  decodeFrame,
  resolveNodeName,
} from "@fleet/protocol";
import { heartbeatSessionsBelongTo, nodeMessageBelongsTo } from "../node-messages.js";
import type { FleetService } from "../fleet-service.js";
import type { FleetNode } from "@fleet/protocol";

/**
 * Reconciles the name a Node calls itself with the one the Host has for it.
 *
 * A rename used to cost the machine its identity: the Node re-registered under
 * the new name, and the placements and sessions of the old one stayed behind on
 * a row that would never come back online. The name is a label on the `nodeId`
 * instead, so the only question left here is which label wins — and whoever
 * lost has to be told, or the two ends disagree until someone restarts one.
 */
function settleNodeName(
  service: FleetService,
  app: FastifyInstance,
  node: FleetNode,
  reported: string | undefined,
  knownName: string | undefined,
): FleetNode {
  const outcome = resolveNodeName({ stored: node.name, reported, knownName });
  if (outcome.renameStored) {
    const renamed = service.store.tryRenameNode(node.id, outcome.name);
    if (renamed) {
      app.log.info(
        { nodeId: node.id, from: node.name, to: outcome.name },
        "Node renamed itself",
      );
      // Confirmed even though the Node already calls itself this: what it has
      // to catch up on is the record of what the Host holds.
      if (outcome.tellNode) service.announceNodeName(node.id, renamed.name);
      return renamed;
    }
    // The name went to another machine while this one was away. Keeping the
    // stored name and saying so beats failing the connection over a label.
    app.log.warn(
      { nodeId: node.id, requested: outcome.name },
      "Node requested a name already in use; keeping the stored name",
    );
    service.announceNodeName(node.id, node.name);
    return node;
  }
  if (outcome.tellNode) service.announceNodeName(node.id, outcome.name);
  return node;
}

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
      service.store.setNodeIdentity(hello.nodeId, {
        version: hello.version,
        revision: hello.revision,
        capabilities: hello.capabilities,
        maxSessions: hello.maxSessions,
        os: hello.os,
        arch: hello.arch,
        homeDir: hello.homeDir,
      });
      const activeSessionIds = hello.activeSessionIds ?? [];
      const node = service.store.setNodeOnline(
        hello.nodeId,
        true,
        activeSessionIds.length,
      );
      // Settled after the socket is attached, so the Node can be told the name
      // it did not get, and before publishing, so browsers see one node with
      // one name rather than the rename arriving as a second update.
      const named = node
        ? settleNodeName(service, app, node, hello.name, hello.knownName)
        : undefined;
      if (named) service.publishNode(named);
      // The node's Chats checkout is written from the home directory it just
      // reported, so the catalog browsers hold is a beat out of date until it is
      // republished — and a machine that has only ever connected once would
      // otherwise show no Chats row at all until something else changed.
      service.publishCatalog();
      // After the node is published, so the row already shows the revision it
      // came back on when the update it was waiting for is marked finished.
      service.settleUpdateOnReconnect(hello.nodeId, hello.revision);
      // Welcome precedes reconciliation because reconciliation can dispatch
      // commands, and a Node should not be told to resume a session before it
      // has been told its hello was accepted.
      service.send(socket, { type: "welcome", nodeId: hello.nodeId });
      service.publishSessions(
        service.reconcile(hello.nodeId, activeSessionIds, hello.busySessionIds),
      );

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
          service.recordPresence(
            hello.nodeId,
            message.activeSessionIds,
            message.busySessionIds,
          );
          return;
        }
        if (message.type === "event") {
          service.handleEvent(message.event);
          return;
        }
        if (message.type === "update_status") {
          app.log.info(
            {
              nodeId: hello.nodeId,
              updateId: message.updateId,
              stage: message.stage,
              detail: message.detail,
            },
            "Node self-update progress",
          );
          service.publishNodeUpdate(hello.nodeId, message.stage, message.detail);
          return;
        }
        if (message.type === "command_result" && !message.ok) {
          app.log.warn(
            { commandId: message.commandId, error: message.error, fatal: message.fatal },
            "Node command failed",
          );
          if (message.fatal) {
            service.failFromCommandResult(
              message.sessionId,
              message.error ?? "Node command failed",
            );
          } else {
            // Refused, not broken. The Node re-announces the session's real
            // state right behind this, so all that is owed is the reason.
            service.reportSessionNotice(
              message.sessionId,
              message.error ?? "Node refused the command",
            );
          }
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
