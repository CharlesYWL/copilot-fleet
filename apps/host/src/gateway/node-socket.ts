import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  AUTH_FAILED_CLOSE_CODE,
  AuthenticatedEnvelopeSchema,
  INVALID_MESSAGE_CLOSE_CODE,
  MUTUAL_AUTH_PROTOCOL,
  NodeFirstFrameSchema,
  NodeProofSchema,
  NodeToHostMessageSchema,
  OUTBOX_ACK_CAPABILITY,
  SUPERSEDED_CLOSE_CODE,
  decodeFrame,
  resolveNodeName,
  type OutboxEventPosition,
  type OutboxFlushIdentity,
} from "@fleet/protocol";
import type { AuthenticatedChannel } from "@fleet/protocol/node-auth";
import { heartbeatSessionsBelongTo, nodeMessageOwnership } from "../node-messages.js";
import type { FleetService, NodeLink } from "../fleet-service.js";
import type { FleetNode, NodeReady, NodeToHostMessage } from "@fleet/protocol";
import type { HostIdentityService } from "../auth/host-identity.js";
import { HostChannelHandshake, SealedNodeLink } from "./node-channel.js";

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

/** What a Node says about itself, whichever protocol carried it here. */
type NodeInventory = Omit<NodeReady, "type">;

export type NodeGatewayOptions = { identity: HostIdentityService };

/**
 * The Node-facing WebSocket: authenticate, then relay events and heartbeats.
 *
 * Two protocols arrive on this path, and the first frame decides which. A
 * legacy `hello` carries a shared secret and continues in plain JSON; a
 * `client_hello` starts a mutual handshake, after which every frame in both
 * directions is sealed. Accepting both is not a convenience — a fleet cannot be
 * upgraded atomically, and a gateway that took only one would strand whichever
 * half of the machines had not been restarted yet.
 *
 * What the two protocols share begins at {@link acceptNode}: the inventory, the
 * welcome, the reconciliation and every message after them are identical, and
 * the only difference is the pipe they travel through. That is deliberate —
 * anything a mutually authenticated Node cannot do is a reason not to upgrade.
 *
 * What a legacy connection cannot do is upgrade itself. The Host used to ask
 * for a key over it; it no longer does, because the secret that authenticated
 * such a connection has by then been handed to whatever terminated it, so
 * nothing sent back over it can prove which Host is on the other end. A legacy
 * machine migrates by running a fresh Connect command, which carries the Host
 * fingerprint from the operator and reclaims that machine's own row.
 *
 * Nothing here may trust the frame it was handed — a Node is a separate machine
 * the operator enrolled — so every frame is schema-checked and every session id
 * it names is verified to belong to the node that sent it.
 */
export function registerNodeGateway(
  app: FastifyInstance,
  service: FleetService,
  { identity }: NodeGatewayOptions,
): void {
  app.get("/ws/node", { websocket: true }, (socket: WebSocket) => {
    let authenticatedNodeId: string | undefined;
    let awaitingOutboxFlush = false;
    let acknowledgeOutbox = false;
    let outboxFlush: TrackedOutboxFlush | undefined;

    const rejectOutbox = (nodeId: string, reason: string): void => {
      app.log.warn({ nodeId, reason }, "Rejected invalid outbox flush");
      socket.close(1008, "Invalid outbox flush");
    };

    /**
     * Wraps a frame handler so a throw ends one connection and nothing else.
     *
     * Everything below runs on bytes a stranger put on a socket, and the layers
     * it calls into are not all total functions: a key exchange over an
     * attacker-chosen ephemeral key, a database write that hits a constraint, a
     * verifier handed a malformed signature. Each of those returns a refusal on
     * the paths that expect one, but "expected to" is not a property — and an
     * exception raised inside a `message` listener has no caller to catch it,
     * so it reaches the process. Closing the socket is the honest answer to a
     * frame nobody can make sense of, and it is the same answer every explicit
     * refusal here already gives.
     */
    const guarded =
      <T extends unknown[]>(where: string, handler: (...args: T) => void) =>
      (...args: T): void => {
        try {
          handler(...args);
        } catch (error) {
          app.log.error(
            { err: error, nodeId: authenticatedNodeId, where },
            "Closed a Node connection on an unhandled frame failure",
          );
          try {
            socket.close(INVALID_MESSAGE_CLOSE_CODE, "Node frame could not be handled");
          } catch {
            // Already closing, or already closed. Either is the outcome wanted.
          }
        }
      };

    /** Plain JSON in: the protocol a legacy Node speaks. */
    const readPlain = (raw: string): NodeToHostMessage | undefined => {
      const next = decodeFrame(raw, NodeToHostMessageSchema);
      if (!next.ok) {
        app.log.warn({ error: next.detail }, "Rejected node message");
        socket.close(next.code, next.reason);
        return undefined;
      }
      return next.value;
    };

    /** Opens an envelope, or hangs up: there is no third answer on this path. */
    const readSealed =
      (channel: AuthenticatedChannel) =>
      (raw: string): NodeToHostMessage | undefined => {
        const frame = decodeFrame(raw, AuthenticatedEnvelopeSchema);
        if (!frame.ok) {
          app.log.warn({ error: frame.detail }, "Rejected node envelope");
          socket.close(frame.code, frame.reason);
          return undefined;
        }
        const opened = channel.open(frame.value);
        if (!opened.ok) {
          // A tag that does not verify, a repeat, a gap, or a frame for another
          // connection. None of them is recoverable: the stream is no longer
          // the one that was authenticated, so it ends here.
          app.log.warn(
            { reason: opened.reason },
            "Closed a Node connection on an unauthenticated frame",
          );
          socket.close(AUTH_FAILED_CLOSE_CODE, "Channel authentication failed");
          return undefined;
        }
        const message = decodeFrame(opened.plaintext, NodeToHostMessageSchema);
        if (!message.ok) {
          app.log.warn({ error: message.detail }, "Rejected node message");
          socket.close(message.code, message.reason);
          return undefined;
        }
        return message.value;
      };

    /**
     * Everything that happens once a Node is authenticated, by either protocol.
     *
     * `link` is what the service speaks through — the raw socket for a legacy
     * Node, a sealing wrapper for a mutually authenticated one — and `read` is
     * the inverse. Every path below is the behaviour that was here before, kept
     * word for word so that upgrading a machine changes how it is
     * authenticated and nothing else about what it can do.
     */
    const acceptNode = (input: {
      nodeId: string;
      inventory: NodeInventory;
      link: NodeLink;
      read: (raw: string) => NodeToHostMessage | undefined;
      /** Which protocol authenticated *this* connection, not what the row says. */
      protocol: "legacy-secret" | typeof MUTUAL_AUTH_PROTOCOL;
    }): void => {
      const { nodeId, inventory } = input;
      authenticatedNodeId = nodeId;

      const previous = service.nodeSocket(nodeId);
      if (previous) {
        previous.close(SUPERSEDED_CLOSE_CODE, "Superseded connection");
        service.disconnectNode(
          nodeId,
          "Execution stopped when the Node connection was superseded",
        );
      }
      service.attachNode(nodeId, input.link);
      service.store.setNodeIdentity(nodeId, {
        version: inventory.version,
        revision: inventory.revision,
        capabilities: inventory.capabilities,
        maxSessions: inventory.maxSessions,
        os: inventory.os,
        arch: inventory.arch,
        homeDir: inventory.homeDir,
      });
      const activeSessionIds = inventory.activeSessionIds;
      const node = service.store.setNodeOnline(nodeId, true, activeSessionIds.length);
      // Settled after the socket is attached, so the Node can be told the name
      // it did not get, and before publishing, so browsers see one node with
      // one name rather than the rename arriving as a second update.
      const named = node
        ? settleNodeName(service, app, node, inventory.name, inventory.knownName)
        : undefined;
      if (named) service.publishNode(named);
      // The node's Chats checkout is written from the home directory it just
      // reported, so the catalog browsers hold is a beat out of date until it is
      // republished — and a machine that has only ever connected once would
      // otherwise show no Chats row at all until something else changed.
      service.publishCatalog();
      // After the node is published, so the row already shows the revision it
      // came back on when the update it was waiting for is marked finished.
      service.settleUpdateOnReconnect(nodeId, inventory.revision);
      // Welcome precedes reconciliation because reconciliation can dispatch
      // commands, and a Node should not be told to resume a session before it
      // has been told its hello was accepted.
      acknowledgeOutbox = inventory.capabilities.includes(OUTBOX_ACK_CAPABILITY);
      awaitingOutboxFlush =
        inventory.pendingOutbox ||
        inventory.pendingOutboxCount > 0 ||
        inventory.outboxFlush !== undefined;
      if (acknowledgeOutbox && awaitingOutboxFlush) {
        if (
          !inventory.outboxFlush ||
          inventory.outboxFlush.eventCount !== inventory.pendingOutboxCount
        ) {
          rejectOutbox(nodeId, "node inventory did not identify its batch");
          return;
        }
        outboxFlush = trackOutboxFlush(inventory.outboxFlush);
      } else if (inventory.outboxFlush) {
        rejectOutbox(nodeId, "node inventory identified a batch it did not advertise");
        return;
      }
      service.send(input.link, {
        type: "welcome",
        nodeId,
        reconcileAfterOutbox: awaitingOutboxFlush,
        acknowledgeOutbox,
      });
      if (!awaitingOutboxFlush) {
        try {
          service.reconcile(nodeId, activeSessionIds, inventory.busySessionIds);
        } catch (error) {
          app.log.error({ nodeId, error }, "Failed initial node reconciliation");
          socket.close(1011, "Failed to reconcile node");
          return;
        }
      }

      const onNodeMessage = (raw: unknown) => {
        const message = input.read(String(raw));
        if (!message) return;
        const ownership = nodeMessageOwnership(nodeId, message, (id) =>
          service.store.getSession(id),
        );
        const missingReplayEvent =
          ownership === "missing" &&
          message.type === "event" &&
          message.outboxFlush !== undefined;
        if (ownership === "foreign" || (ownership === "missing" && !missingReplayEvent)) {
          app.log.warn(
            { nodeId, messageType: message.type, ownership },
            "Rejected cross-node message",
          );
          socket.close(1008, "Session ownership mismatch");
          return;
        }
        try {
          if (message.type === "heartbeat") {
            if (
              !inventoryBelongsToNode(
                nodeId,
                message.activeSessionIds,
                message.busySessionIds,
                (id) => service.store.getSession(id),
              )
            ) {
              app.log.warn({ nodeId }, "Rejected cross-node heartbeat inventory");
              socket.close(1008, "Session ownership mismatch");
              return;
            }
            service.recordPresence(
              nodeId,
              message.activeSessionIds,
              message.busySessionIds,
              !awaitingOutboxFlush,
            );
            return;
          }
          if (message.type === "outbox_flushed") {
            if (message.outboxFlush) {
              const flush = outboxFlush;
              if (
                !acknowledgeOutbox ||
                !awaitingOutboxFlush ||
                !flush ||
                !sameOutboxFlush(flush, message.outboxFlush) ||
                flush.nextEventIndex !== flush.eventCount ||
                !inventoryBelongsToNode(
                  nodeId,
                  message.activeSessionIds,
                  message.busySessionIds,
                  (id) => service.store.getSession(id),
                )
              ) {
                rejectOutbox(nodeId, "completion did not match the received batch");
                return;
              }
              service.recordPresence(
                nodeId,
                message.activeSessionIds,
                message.busySessionIds,
              );
              const flushId = flush.flushId;
              outboxFlush = undefined;
              awaitingOutboxFlush = false;
              service.send(input.link, { type: "outbox_flush_ack", flushId });
              return;
            }
            if (
              acknowledgeOutbox ||
              !awaitingOutboxFlush ||
              !inventoryBelongsToNode(
                nodeId,
                message.activeSessionIds,
                message.busySessionIds,
                (id) => service.store.getSession(id),
              )
            ) {
              app.log.warn(
                { nodeId },
                "Rejected unexpected or cross-node outbox reconciliation",
              );
              socket.close(1008, "Invalid outbox reconciliation");
              return;
            }
            awaitingOutboxFlush = false;
            service.recordPresence(
              nodeId,
              message.activeSessionIds,
              message.busySessionIds,
            );
            return;
          }
          if (message.type === "event") {
            if (outboxFlush || message.outboxFlush) {
              if (!acknowledgeOutbox || !message.outboxFlush) {
                rejectOutbox(nodeId, "an acknowledged batch contained an untagged event");
                return;
              }
              if (!outboxFlush) {
                if (message.outboxFlush.eventIndex !== 0) {
                  rejectOutbox(nodeId, "a subsequent batch did not start at event zero");
                  return;
                }
                outboxFlush = trackOutboxFlush(message.outboxFlush);
                awaitingOutboxFlush = true;
              }
              const flush = outboxFlush;
              const eventKey = `${message.event.sessionId}:${message.event.sequence}`;
              if (
                !sameOutboxFlush(flush, message.outboxFlush) ||
                message.outboxFlush.eventIndex !== flush.nextEventIndex ||
                flush.eventIds.has(message.event.eventId) ||
                flush.eventSequences.has(eventKey)
              ) {
                rejectOutbox(
                  nodeId,
                  "event identity, position, or cardinality did not match",
                );
                return;
              }
              const handled = service.handleEventResult(message.event);
              if (handled.outcome === "retryable_failure") {
                socket.close(1011, "Failed to persist outbox event");
                return;
              }
              if (handled.outcome === "permanent_rejection") {
                app.log.warn(
                  {
                    nodeId,
                    flushId: flush.flushId,
                    eventId: message.event.eventId,
                    sessionId: message.event.sessionId,
                    reason: handled.reason,
                  },
                  "Skipped permanently unstorable outbox event",
                );
              }
              flush.eventIds.add(message.event.eventId);
              flush.eventSequences.add(eventKey);
              flush.nextEventIndex += 1;
              return;
            }
            service.handleEvent(message.event);
            return;
          }
          if (message.type === "node_key") {
            /*
             * A legacy connection has already disclosed its shared secret to
             * every relay on its path, so no key offered over that connection
             * can prove which Host received it. Keep older Nodes connected, but
             * require a fresh Connect command for migration.
             */
            app.log.warn(
              { nodeId },
              "Ignored a Node key offered over a legacy connection; migration needs a fresh Connect command",
            );
            return;
          }
          if (message.type === "update_status") {
            app.log.info(
              {
                nodeId,
                updateId: message.updateId,
                stage: message.stage,
                detail: message.detail,
              },
              "Node self-update progress",
            );
            service.publishNodeUpdate(nodeId, message.stage, message.detail);
            return;
          }
          if (message.type === "command_result" && !message.ok) {
            app.log.warn(
              {
                commandId: message.commandId,
                error: message.error,
                fatal: message.fatal,
              },
              "Node command failed",
            );
            if (message.fatal) {
              service.failFromCommandResult(
                message.sessionId,
                message.commandId,
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
        } catch (error) {
          app.log.error(
            { nodeId, messageType: message.type, error },
            "Failed to process node message",
          );
          socket.close(1011, "Failed to process node message");
        }
      };

      socket.on("message", guarded("node message", onNodeMessage));
    };

    /** Frame 3 and 4 of the mutual handshake: the proof, then the inventory. */
    const awaitProof = (handshake: HostChannelHandshake, nodeId: string): void => {
      const onProof = (raw: unknown) => {
        const proof = decodeFrame(String(raw), NodeProofSchema);
        if (!proof.ok) {
          // A frame where the proof belongs is not a proof, whatever else it
          // claims to be. Nothing is read as a command, an event or an
          // inventory until this has passed.
          app.log.warn({ nodeId, error: proof.detail }, "Rejected node handshake frame");
          socket.close(INVALID_MESSAGE_CLOSE_CODE, "Expected a node proof");
          return;
        }
        const finished = handshake.finish(proof.value.signature);
        if (!finished.ok) {
          app.log.warn({ nodeId, reason: finished.reason }, "Refused a Node proof");
          socket.close(AUTH_FAILED_CLOSE_CODE, "Authentication failed");
          return;
        }
        const channel = finished.channel;
        const read = readSealed(channel);
        const onInventory = (sealed: unknown) => {
          const message = read(String(sealed));
          if (!message) return;
          if (message.type !== "ready") {
            app.log.warn({ nodeId }, "Rejected a Node frame sent before its inventory");
            socket.close(INVALID_MESSAGE_CLOSE_CODE, "Expected a node inventory");
            return;
          }
          const { type: _ready, ...inventory } = message;
          acceptNode({
            nodeId,
            inventory,
            link: new SealedNodeLink(socket, channel),
            read,
            protocol: MUTUAL_AUTH_PROTOCOL,
          });
        };
        socket.once("message", guarded("node inventory", onInventory));
      };
      socket.once("message", guarded("node proof", onProof));
    };

    const onFirstFrame = (data: unknown) => {
      const frame = decodeFrame(String(data), NodeFirstFrameSchema);
      if (!frame.ok) {
        app.log.warn({ error: frame.detail }, "Rejected malformed node hello");
        socket.close(frame.code, frame.reason);
        return;
      }

      if (frame.value.type === "hello") {
        const { type: _hello, nodeId, secret, ...inventory } = frame.value;
        if (service.store.mutualNodeAuthenticationRequired()) {
          // The operator has declared the migration finished. Accepting a
          // shared secret now would make the switch a preference rather than a
          // policy, which is the whole reason it exists.
          app.log.warn({ nodeId }, "Refused a legacy hello: mutual auth is enforced");
          socket.close(AUTH_FAILED_CLOSE_CODE, "Authentication failed");
          return;
        }
        if (!service.store.authenticateNode(nodeId, secret)) {
          // A dedicated code lets the Node tell "your secret is stale, enroll
          // again" apart from a protocol error worth retrying as-is.
          socket.close(AUTH_FAILED_CLOSE_CODE, "Authentication failed");
          return;
        }
        acceptNode({
          nodeId,
          inventory,
          link: socket,
          read: readPlain,
          protocol: "legacy-secret",
        });
        return;
      }

      const hello = frame.value;
      const handshake = new HostChannelHandshake({
        identity: identity.identity(),
        sign: (message) => identity.sign(message),
      });
      // Looked up before anything is signed: a Host that challenged first would
      // spend a signature on every stranger who asked, and would answer
      // differently for a node id that exists.
      const begun = handshake.begin(hello, service.store.nodePublicKey(hello.nodeId));
      if (!begun.ok) {
        app.log.warn(
          { nodeId: hello.nodeId, reason: begun.reason },
          "Refused a Node handshake",
        );
        socket.close(AUTH_FAILED_CLOSE_CODE, "Authentication failed");
        return;
      }
      socket.send(JSON.stringify(begun.challenge));
      awaitProof(handshake, hello.nodeId);
    };

    socket.once("message", guarded("node hello", onFirstFrame));

    socket.on("close", () => {
      if (!authenticatedNodeId || service.shuttingDown) return;
      const link = service.nodeSocket(authenticatedNodeId);
      // A sealed connection hands the service a wrapper rather than this
      // socket, so identity is not enough: what matters is whether the link the
      // service holds is the one that just closed.
      if (link === socket || (link instanceof SealedNodeLink && link.wraps(socket))) {
        service.disconnectNode(
          authenticatedNodeId,
          "Execution stopped when the Node connection was lost",
        );
      }
    });
  });
}

type TrackedOutboxFlush = OutboxFlushIdentity & {
  nextEventIndex: number;
  eventIds: Set<string>;
  eventSequences: Set<string>;
};

function trackOutboxFlush(identity: OutboxFlushIdentity): TrackedOutboxFlush {
  return {
    ...identity,
    nextEventIndex: 0,
    eventIds: new Set(),
    eventSequences: new Set(),
  };
}

function sameOutboxFlush(
  tracked: Pick<TrackedOutboxFlush, "flushId" | "eventCount">,
  received: Pick<OutboxFlushIdentity | OutboxEventPosition, "flushId" | "eventCount">,
): boolean {
  return (
    tracked.flushId === received.flushId && tracked.eventCount === received.eventCount
  );
}

function inventoryBelongsToNode(
  nodeId: string,
  activeSessionIds: readonly string[],
  busySessionIds: readonly string[],
  getSession: Parameters<typeof heartbeatSessionsBelongTo>[2],
): boolean {
  const active = new Set(activeSessionIds);
  return (
    busySessionIds.every((sessionId) => active.has(sessionId)) &&
    heartbeatSessionsBelongTo(nodeId, activeSessionIds, getSession) &&
    heartbeatSessionsBelongTo(nodeId, busySessionIds, getSession)
  );
}
