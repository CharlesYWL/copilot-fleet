import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { WebSocket } from "ws";
import {
  BrowserMessageSchema,
  CreatePlacementSchema,
  CreateSessionSchema,
  CreateWorkspaceSchema,
  HostToNodeMessageSchema,
  NodeToHostMessageSchema,
  PermissionResponseSchema,
  PromptSchema,
  RegisterNodeSchema,
  RenameNodeSchema,
  SessionStateSchema,
  UpdatePlacementSchema,
  UpdateDefaultsSchema,
  UpdateTunnelSchema,
  UpdateWorkspaceSchema,
  canTransition,
  terminalSessionStates,
  tryParseJson,
  type BrowserMessage,
  type FleetSession,
  type FleetNode,
  type NodeCommand,
  type SessionEvent,
} from "@fleet/protocol";
import {
  heartbeatSessionsBelongTo,
  isHeartbeatStale,
  nodeMessageBelongsTo,
} from "./node-messages.js";
import { FleetStore } from "./store.js";
import { TunnelManager } from "./tunnel.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const VERSION = "0.1.0";

export async function buildServer(options: {
  databasePath?: string;
  enrollmentToken?: string;
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const enrollmentToken = resolveEnrollmentToken(
    options.enrollmentToken ?? process.env.ENROLLMENT_TOKEN,
    process.env.NODE_ENV,
  );
  const store = new FleetStore(
    options.databasePath ?? process.env.DATABASE_PATH ?? "./apps/host/data/fleet.db",
  );
  store.resetConnectivity();
  const nodeSockets = new Map<string, WebSocket>();
  const browserSockets = new Set<WebSocket>();
  const heartbeatTimeoutMs = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 15_000);
  const listenPort = process.env.PORT ?? "8787";
  let closing = false;

  const tunnel = new TunnelManager({
    localTarget: `http://127.0.0.1:${listenPort}`,
    onEnabledCleared: () => store.setTunnelEnabled(false),
  });
  void tunnel.setEnabled(false, store.getTunnelProvider());

  const fallbackPublicUrl = () =>
    resolvePublicHostUrl(
      process.env.FLEET_PUBLIC_URL,
      process.env.HOST,
      process.env.PORT,
    );

  const enrollmentHostUrl = () =>
    resolveEnrollmentHostUrl(tunnel.activeTunnelUrl(), fallbackPublicUrl());

  await app.register(websocket);

  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (message: BrowserMessage) => {
    BrowserMessageSchema.parse(message);
    for (const socket of browserSockets) send(socket, message);
  };
  const publishSession = (session: FleetSession) =>
    broadcast({ type: "session", session });
  const commandFor = (nodeId: string, command: NodeCommand): boolean => {
    const socket = nodeSockets.get(nodeId);
    if (!socket || socket.readyState !== socket.OPEN) return false;
    send(socket, HostToNodeMessageSchema.parse({ type: "command", command }));
    return true;
  };
  const publishReconciled = (sessions: FleetSession[]) => {
    for (const session of sessions) publishSession(session);
  };
  const disconnectNode = (nodeId: string, activity: string) => {
    nodeSockets.delete(nodeId);
    const node = store.setNodeOnline(nodeId, false, 0);
    if (node) broadcast({ type: "node", node });
    // Soft-fail: the Node may still be running agents and will resurrect
    // them on the next hello that lists those session ids.
    publishReconciled(store.markNodeSessionsOffline(nodeId, activity));
  };

  app.get("/api/health", async () => ({ ok: true, version: VERSION }));
  app.get("/api/enrollment", async () => ({
    hostUrl: enrollmentHostUrl(),
    enrollmentToken,
  }));
  app.get("/api/tunnel", async () => tunnel.info(fallbackPublicUrl()));
  app.post("/api/tunnel", async (request, reply) => {
    const input = UpdateTunnelSchema.parse(request.body);
    const provider = input.provider ?? store.getTunnelProvider();
    store.setTunnelProvider(provider);
    store.setTunnelEnabled(input.enabled);
    try {
      await tunnel.setEnabled(input.enabled, provider);
    } catch (error) {
      store.setTunnelEnabled(false);
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Tunnel failed to start",
        tunnel: tunnel.info(fallbackPublicUrl()),
      });
    }
    return tunnel.info(fallbackPublicUrl());
  });
  app.get("/api/defaults", async () => ({ yolo: store.getDefaultYolo() }));
  app.post("/api/defaults", async (request) => {
    const input = UpdateDefaultsSchema.parse(request.body);
    store.setDefaultYolo(input.yolo);
    return { yolo: store.getDefaultYolo() };
  });
  app.get("/api/snapshot", async () => ({
    nodes: store.listNodes(),
    workspaces: store.listWorkspaces(),
    placements: store.listPlacements(),
    sessions: store.listSessions(),
  }));
  app.get("/api/nodes", async () => store.listNodes());
  app.get("/api/workspaces", async () => store.listWorkspaces());
  app.get("/api/placements", async () => store.listPlacements());
  app.get("/api/sessions", async () => store.listSessions());

  app.post("/api/nodes/register", async (request, reply) => {
    const input = RegisterNodeSchema.parse(request.body);
    if (input.enrollmentToken !== enrollmentToken) {
      return reply.code(401).send({ error: "Invalid enrollment token" });
    }
    try {
      const { node, secret } = store.registerNode({
        name: input.name,
        os: input.os,
        arch: input.arch,
        version: input.version,
        capabilities: input.capabilities,
        maxSessions: input.maxSessions,
        homeDir: input.homeDir,
      });
      return reply.code(201).send({ nodeId: node.id, secret });
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "Registration failed" });
    }
  });

  app.patch("/api/nodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = RenameNodeSchema.parse(request.body);
    if (!store.getNode(id)) return reply.code(404).send({ error: "Unknown node" });
    try {
      const node = store.renameNode(id, input.name);
      if (node) broadcast({ type: "node", node });
      return node;
    } catch {
      return reply.code(409).send({ error: `A node named "${input.name}" already exists` });
    }
  });

  app.delete("/api/nodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getNode(id)) return reply.code(404).send({ error: "Unknown node" });
    try {
      store.deleteNode(id);
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "Cannot delete node" });
    }
    const socket = nodeSockets.get(id);
    if (socket) {
      nodeSockets.delete(id);
      socket.close(4002, "Node deleted");
    }
    return reply.code(204).send();
  });

  app.post("/api/workspaces", async (request, reply) => {
    const input = CreateWorkspaceSchema.parse(request.body);
    try {
      return reply.code(201).send(store.createWorkspace(input.name, input.description));
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "Workspace exists" });
    }
  });

  app.patch("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = UpdateWorkspaceSchema.parse(request.body);
    if (!store.getWorkspace(id)) return reply.code(404).send({ error: "Unknown workspace" });
    try {
      return store.updateWorkspace(id, input.name, input.description);
    } catch {
      return reply.code(409).send({ error: `A workspace named "${input.name}" already exists` });
    }
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getWorkspace(id)) return reply.code(404).send({ error: "Unknown workspace" });
    try {
      store.deleteWorkspace(id);
      return reply.code(204).send();
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "Cannot delete workspace" });
    }
  });

  app.post("/api/placements", async (request, reply) => {
    const input = CreatePlacementSchema.parse(request.body);
    try {
      return reply
        .code(201)
        .send(store.createPlacement(input.workspaceId, input.nodeId, input.localPath));
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "Invalid placement" });
    }
  });

  app.patch("/api/placements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = UpdatePlacementSchema.parse(request.body);
    if (!store.getPlacement(id)) return reply.code(404).send({ error: "Unknown placement" });
    return store.updatePlacement(id, input.localPath);
  });

  app.delete("/api/placements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getPlacement(id)) return reply.code(404).send({ error: "Unknown placement" });
    try {
      store.deletePlacement(id);
      return reply.code(204).send();
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "Cannot delete placement" });
    }
  });

  app.post("/api/sessions", async (request, reply) => {
    const input = CreateSessionSchema.parse(request.body);
    const placement = store.getPlacement(input.placementId);
    if (!placement) return reply.code(404).send({ error: "Placement not found" });
    const node = store.getNode(placement.nodeId);
    if (!node?.online) return reply.code(409).send({ error: "Node is offline" });
    const reserved = store
      .listSessions()
      .filter(
        (session) =>
          session.nodeId === node.id && !terminalSessionStates.has(session.state),
      ).length;
    if (reserved >= node.maxSessions) {
      return reply.code(409).send({ error: "Node is at capacity" });
    }
    const yolo = input.yolo ?? store.getDefaultYolo();
    const unsupported = yoloUnsupportedReason(node, yolo);
    if (unsupported) return reply.code(409).send({ error: unsupported });
    const session = store.createSession(placement, input.prompt, yolo);
    publishSession(session);
    const command: NodeCommand = {
      type: "start_session",
      commandId: randomUUID(),
      sessionId: session.id,
      localPath: placement.localPath,
      prompt: input.prompt,
      yolo,
    };
    if (!commandFor(node.id, command)) {
      const failed = store.transitionSession(
        session.id,
        "failed",
        "Node disconnected before process start",
      );
      publishSession(failed);
      return reply.code(503).send({ error: "Node disconnected", session: failed });
    }
    return reply.code(202).send(session);
  });

  app.get("/api/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "Session not found" });
    return store.listEvents(id);
  });

  app.post("/api/sessions/:id/prompt", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = PromptSchema.parse(request.body);
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.state !== "idle") {
      return reply.code(409).send({ error: "Session must be idle" });
    }
    if (
      !commandFor(session.nodeId, {
        type: "prompt",
        commandId: randomUUID(),
        sessionId: id,
        prompt: input.prompt,
      })
    ) {
      publishSession(
        store.transitionSession(id, "failed", "Node disconnected before prompt"),
      );
      return reply.code(503).send({ error: "Node disconnected" });
    }
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/sessions/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!canTransition(session.state, "starting")) {
      return reply.code(409).send({ error: "Session is already live" });
    }
    if (!session.agentSessionId) {
      return reply.code(409).send({ error: "Session has no resumable agent id" });
    }
    const placement = store.getPlacement(session.placementId);
    if (!placement) return reply.code(409).send({ error: "Placement was removed" });
    const node = store.getNode(session.nodeId);
    const unsupported = node && yoloUnsupportedReason(node, session.yolo);
    if (unsupported) return reply.code(409).send({ error: unsupported });
    const sent = commandFor(session.nodeId, {
      type: "resume_session",
      commandId: randomUUID(),
      sessionId: id,
      localPath: placement.localPath,
      agentSessionId: session.agentSessionId,
      sequenceOffset: store.maxEventSequence(id),
      yolo: session.yolo,
    });
    if (!sent) return reply.code(503).send({ error: "Node is offline" });
    publishSession(store.transitionSession(id, "starting", "Resuming Copilot session"));
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/sessions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.state !== "running") {
      return reply.code(409).send({ error: "Session is not running" });
    }
    const updated = store.transitionSession(id, "cancelling", "Cancelling active turn");
    publishSession(updated);
    const sent = commandFor(session.nodeId, {
      type: "cancel",
      commandId: randomUUID(),
      sessionId: id,
    });
    if (!sent) {
      publishSession(
        store.transitionSession(id, "failed", "Node disconnected during cancel"),
      );
    }
    return reply.code(sent ? 202 : 503).send({ ok: sent });
  });

  app.post("/api/sessions/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    // Idempotent: dismissing a corpse from the UI should not toast an error.
    if (terminalSessionStates.has(session.state)) {
      return reply.code(200).send({ ok: true, alreadyTerminal: true });
    }
    const sent = commandFor(session.nodeId, {
      type: "stop",
      commandId: randomUUID(),
      sessionId: id,
    });
    if (!sent) {
      const stopped = store.transitionSession(id, "stopped", "Stopped while offline");
      publishSession(stopped);
    }
    return reply.code(sent ? 202 : 200).send({ ok: true });
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "Session not found" });
    try {
      store.deleteSession(id);
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "Cannot dismiss session" });
    }
    return reply.code(204).send();
  });

  app.delete("/api/sessions", async (_request, reply) => {
    const removed = store.deleteEndedSessions();
    return { removed };
  });

  app.post("/api/sessions/:id/permission", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = PermissionResponseSchema.parse(request.body);
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const sent = commandFor(session.nodeId, {
      type: "permission_response",
      commandId: randomUUID(),
      sessionId: id,
      requestId: input.requestId,
      outcome: input.outcome,
      ...(input.optionId ? { optionId: input.optionId } : {}),
    });
    return reply.code(sent ? 202 : 503).send({ ok: sent });
  });

  app.get("/ws/browser", { websocket: true }, (socket) => {
    browserSockets.add(socket);
    send(socket, {
      type: "snapshot",
      data: {
        nodes: store.listNodes(),
        workspaces: store.listWorkspaces(),
        placements: store.listPlacements(),
        sessions: store.listSessions(),
      },
    });
    socket.on("close", () => browserSockets.delete(socket));
  });

  app.get("/ws/node", { websocket: true }, (socket) => {
    let authenticatedNodeId: string | undefined;
    socket.once("message", (data) => {
      const frame = tryParseJson(data.toString());
      if (!frame.ok) {
        app.log.warn({ error: frame.error }, "Rejected malformed node hello");
        socket.close(1007, "Malformed JSON");
        return;
      }
      const parsed = NodeToHostMessageSchema.safeParse(frame.value);
      if (!parsed.success || parsed.data.type !== "hello") {
        socket.close(1008, "Expected authenticated hello");
        return;
      }
      const hello = parsed.data;
      if (!store.authenticateNode(hello.nodeId, hello.secret)) {
        socket.close(1008, "Authentication failed");
        return;
      }
      authenticatedNodeId = hello.nodeId;
      const previousSocket = nodeSockets.get(hello.nodeId);
      if (previousSocket) {
        previousSocket.close(4001, "Superseded connection");
        disconnectNode(
          hello.nodeId,
          "Execution stopped when the Node connection was superseded",
        );
      }
      nodeSockets.set(hello.nodeId, socket);
      store.setNodeHomeDir(hello.nodeId, hello.homeDir);
      store.setNodeIdentity(hello.nodeId, hello.version, hello.capabilities);
      const activeSessionIds = hello.activeSessionIds ?? [];
      const node = store.setNodeOnline(hello.nodeId, true, activeSessionIds.length);
      if (node) broadcast({ type: "node", node });
      publishReconciled(
        store.reconcileOfflineSessions(hello.nodeId, activeSessionIds),
      );
      send(socket, { type: "welcome", nodeId: hello.nodeId });

      socket.on("message", (raw) => {
        const frame = tryParseJson(raw.toString());
        if (!frame.ok) {
          app.log.warn({ nodeId: hello.nodeId, error: frame.error }, "Rejected malformed node message");
          socket.close(1007, "Malformed JSON");
          return;
        }
        const result = NodeToHostMessageSchema.safeParse(frame.value);
        if (!result.success) {
          app.log.warn({ issues: result.error.issues }, "Rejected node message");
          socket.close(1008, "Invalid node message");
          return;
        }
        const message = result.data;
        if (!nodeMessageBelongsTo(hello.nodeId, message, (id) => store.getSession(id))) {
          app.log.warn({ nodeId: hello.nodeId, messageType: message.type }, "Rejected cross-node message");
          socket.close(1008, "Session ownership mismatch");
          return;
        }
        if (message.type === "heartbeat") {
          if (
            !heartbeatSessionsBelongTo(
              hello.nodeId,
              message.activeSessionIds,
              (id) => store.getSession(id),
            )
          ) {
            app.log.warn({ nodeId: hello.nodeId }, "Rejected cross-node heartbeat inventory");
            socket.close(1008, "Session ownership mismatch");
            return;
          }
          const refreshed = store.setNodeOnline(
            hello.nodeId,
            true,
            message.activeSessionIds.length,
          );
          if (refreshed) broadcast({ type: "node", node: refreshed });
          publishReconciled(
            store.reconcileOfflineSessions(hello.nodeId, message.activeSessionIds),
          );
          return;
        }
        if (message.type === "event") handleEvent(message.event);
        if (message.type === "command_result" && !message.ok) {
          app.log.warn(
            { commandId: message.commandId, error: message.error },
            "Node command failed",
          );
          const session = store.getSession(message.sessionId);
          if (session && !terminalSessionStates.has(session.state)) {
            publishSession(
              store.transitionSession(
                session.id,
                "failed",
                message.error ?? "Node command failed",
              ),
            );
          }
        }
      });
    });
    socket.on("close", () => {
      if (!authenticatedNodeId || closing) return;
      if (nodeSockets.get(authenticatedNodeId) === socket) {
        disconnectNode(
          authenticatedNodeId,
          "Execution stopped when the Node connection was lost",
        );
      }
    });
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const node of store.listNodes()) {
      if (!node.online || !isHeartbeatStale(node.lastHeartbeat, now, heartbeatTimeoutMs)) {
        continue;
      }
      const socket = nodeSockets.get(node.id);
      if (socket) {
        socket.close(4000, "Heartbeat timeout");
      } else {
        disconnectNode(node.id, "Execution stopped after heartbeat timeout");
      }
    }
  }, Math.min(5_000, heartbeatTimeoutMs));
  heartbeatTimer.unref();

  function handleEvent(event: SessionEvent): void {
    try {
      if (!store.appendEvent(event)) return;
      broadcast({ type: "event", event });
      const session = store.getSession(event.sessionId);
      if (!session) return;
      if (event.type === "state") {
        const state = SessionStateSchema.safeParse(event.payload.state);
        if (state.success) {
          // A rejected transition would otherwise strand the session in its old
          // state with nothing but a log line to explain it.
          if (!canTransition(session.state, state.data)) {
            app.log.error(
              { sessionId: session.id, from: session.state, to: state.data },
              "Dropped session state event the transition table forbids",
            );
            return;
          }
          publishSession(
            store.transitionSession(
              session.id,
              state.data,
              typeof event.payload.activity === "string"
                ? event.payload.activity
                : session.currentActivity,
            ),
          );
        }
      } else {
        publishSession(store.getSession(session.id)!);
      }
    } catch (error) {
      app.log.error({ error, event }, "Rejected session event");
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    const status = hasIssues(error) ? 400 : getStatusCode(error);
    const message = error instanceof Error ? error.message : "Internal server error";
    reply.code(status).send({ error: message });
  });

  const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
  if (existsSync(uiRoot)) {
    await app.register(fastifyStatic, { root: uiRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/ws/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onReady", () => {
    if (!store.getTunnelEnabled()) return;
    void tunnel.setEnabled(true, store.getTunnelProvider()).catch((error) => {
      store.setTunnelEnabled(false);
      app.log.error({ err: error }, "Failed to restore tunnel");
    });
  });

  app.addHook("onClose", async () => {
    closing = true;
    clearInterval(heartbeatTimer);
    await tunnel.stop();
    // Mark offline rather than failed so a quick Host restart (tsx watch,
    // deploy bounce) can resurrect agents the Node kept alive.
    for (const [nodeId, socket] of [...nodeSockets.entries()]) {
      disconnectNode(nodeId, "Host stopped; waiting for Node reconnect");
      socket.close();
    }
    for (const socket of browserSockets) socket.close();
    store.close();
  });
  return app;
}

/**
 * The URL a node on another machine should dial. Wildcard bind addresses are
 * not dialable, so they fall back to loopback and the operator is expected to
 * set FLEET_PUBLIC_URL once the Host is reachable from outside.
 */
/**
 * Older node agents ignore the yolo flag and always launch Copilot with
 * prompts enabled. The Host must refuse rather than downgrade, because the UI
 * badge would otherwise promise unattended execution that never happens.
 */
export function yoloUnsupportedReason(
  node: Pick<FleetNode, "name" | "capabilities">,
  yolo: boolean,
): string | undefined {
  if (!yolo || node.capabilities.includes("host-yolo")) return undefined;
  return `Node "${node.name}" runs an older agent that cannot apply YOLO mode. Update and restart it, or turn YOLO off for this session.`;
}

export function resolvePublicHostUrl(
  publicUrl: string | undefined,
  host: string | undefined,
  port: string | undefined,
): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const wildcard = !host || host === "0.0.0.0" || host === "::";
  return `http://${wildcard ? "127.0.0.1" : host}:${port ?? "8787"}`;
}

/** Enrollment / Connect commands prefer a live tunnel URL over env / bind fallbacks. */
export function resolveEnrollmentHostUrl(
  tunnelUrl: string | undefined,
  fallbackPublicUrl: string,
): string {
  if (tunnelUrl) return tunnelUrl.replace(/\/+$/, "");
  return fallbackPublicUrl.replace(/\/+$/, "");
}

export function resolveEnrollmentToken(
  token: string | undefined,
  nodeEnv: string | undefined,
): string {
  const resolved = token ?? "change-me";
  if (nodeEnv === "production" && (!token || token === "change-me")) {
    throw new Error(
      "ENROLLMENT_TOKEN must be set to a non-default value in production",
    );
  }
  return resolved;
}

function hasIssues(value: unknown): value is { issues: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "issues" in value &&
    Array.isArray(value.issues)
  );
}

function getStatusCode(value: unknown): number {
  if (
    typeof value === "object" &&
    value !== null &&
    "statusCode" in value &&
    typeof value.statusCode === "number"
  ) {
    return value.statusCode;
  }
  return 500;
}

if (process.env.NODE_ENV !== "test") {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
}
