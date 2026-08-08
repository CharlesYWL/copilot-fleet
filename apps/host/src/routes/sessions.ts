import type { FastifyPluginAsync } from "fastify";
import {
  CreateSessionSchema,
  PermissionResponseSchema,
  PromptSchema,
  canTransition,
  errorMessage,
  terminalSessionStates,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { reservedSessionCount, yoloUnsupportedReason } from "../session-policy.js";

export type SessionRouteOptions = { service: FleetService };

/** Session lifecycle: create, prompt, resume, cancel, stop, dismiss. */
export const sessionRoutes: FastifyPluginAsync<SessionRouteOptions> = async (
  app,
  { service },
) => {
  const { store } = service;

  app.get("/api/sessions", async () => store.listSessions());

  app.post("/api/sessions", async (request, reply) => {
    const input = CreateSessionSchema.parse(request.body);
    const placement = store.getPlacement(input.placementId);
    if (!placement) return reply.code(404).send({ error: "Placement not found" });
    const node = store.getNode(placement.nodeId);
    if (!node?.online) return reply.code(409).send({ error: "Node is offline" });
    if (reservedSessionCount(store.listSessions(), node.id) >= node.maxSessions) {
      return reply.code(409).send({ error: "Node is at capacity" });
    }
    const yolo = input.yolo ?? store.getDefaultYolo();
    const unsupported = yoloUnsupportedReason(node, yolo);
    if (unsupported) return reply.code(409).send({ error: unsupported });

    const session = store.createSession(placement, input.prompt, yolo);
    service.publishSession(session);
    const dispatched = service.dispatch(
      node.id,
      {
        type: "start_session",
        sessionId: session.id,
        localPath: placement.localPath,
        prompt: input.prompt,
        yolo,
      },
      { state: "failed", activity: "Node disconnected before process start" },
    );
    if (!dispatched.sent) {
      return reply
        .code(503)
        .send({ error: "Node disconnected", session: dispatched.session });
    }
    return reply.code(202).send(session);
  });

  app.get("/api/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) {
      return reply.code(404).send({ error: "Session not found" });
    }
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
    const dispatched = service.dispatch(
      session.nodeId,
      { type: "prompt", sessionId: id, prompt: input.prompt },
      { state: "failed", activity: "Node disconnected before prompt" },
    );
    if (!dispatched.sent) return reply.code(503).send({ error: "Node disconnected" });
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

    // No fallback transition: a resume that never left the Host leaves the
    // session exactly as the operator found it, so they can retry.
    const dispatched = service.dispatch(session.nodeId, {
      type: "resume_session",
      sessionId: id,
      localPath: placement.localPath,
      agentSessionId: session.agentSessionId,
      sequenceOffset: store.maxEventSequence(id),
      yolo: session.yolo,
    });
    if (!dispatched.sent) return reply.code(503).send({ error: "Node is offline" });
    service.publishSession(
      store.transitionSession(id, "starting", "Resuming Copilot session"),
    );
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/sessions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.state !== "running") {
      return reply.code(409).send({ error: "Session is not running" });
    }
    service.publishSession(
      store.transitionSession(id, "cancelling", "Cancelling active turn"),
    );
    const dispatched = service.dispatch(
      session.nodeId,
      { type: "cancel", sessionId: id },
      { state: "failed", activity: "Node disconnected during cancel" },
    );
    return reply.code(dispatched.sent ? 202 : 503).send({ ok: dispatched.sent });
  });

  app.post("/api/sessions/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    // Idempotent: dismissing a corpse from the UI should not toast an error.
    if (terminalSessionStates.has(session.state)) {
      return reply.code(200).send({ ok: true, alreadyTerminal: true });
    }
    const dispatched = service.dispatch(
      session.nodeId,
      { type: "stop", sessionId: id },
      { state: "stopped", activity: "Stopped while offline" },
    );
    return reply.code(dispatched.sent ? 202 : 200).send({ ok: true });
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) {
      return reply.code(404).send({ error: "Session not found" });
    }
    try {
      store.deleteSession(id);
    } catch (error) {
      return reply
        .code(409)
        .send({ error: errorMessage(error, "Cannot dismiss session") });
    }
    return reply.code(204).send();
  });

  app.delete("/api/sessions", async () => ({ removed: store.deleteEndedSessions() }));

  app.post("/api/sessions/:id/permission", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = PermissionResponseSchema.parse(request.body);
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const dispatched = service.dispatch(session.nodeId, {
      type: "permission_response",
      sessionId: id,
      requestId: input.requestId,
      outcome: input.outcome,
      ...(input.optionId ? { optionId: input.optionId } : {}),
    });
    return reply.code(dispatched.sent ? 202 : 503).send({ ok: dispatched.sent });
  });
};
