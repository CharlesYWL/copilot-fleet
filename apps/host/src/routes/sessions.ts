import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  CreateSessionSchema,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_ATTACHMENT_BYTES,
  PermissionResponseSchema,
  PromptSchema,
  RenameSessionSchema,
  ReorderSessionsSchema,
  SESSION_NAME_MAX_LENGTH,
  SetSessionConfigSchema,
  base64Bytes,
  errorMessage,
  terminalSessionStates,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { conversationTitle, isUnnamed } from "../orchestrator/conversation-title.js";
import { configUnsupportedReason } from "../session-policy.js";

export type SessionRouteOptions = { service: FleetService };

const AdoptSessionSchema = CreateSessionSchema.pick({
  placementId: true,
  yolo: true,
}).extend({
  agentSessionId: z.string().min(1).max(500),
  additionalDirectories: z.array(z.string().min(1).max(4096)).max(100).default([]),
  name: z.string().max(SESSION_NAME_MAX_LENGTH).optional(),
});

/** Session lifecycle: create, prompt, resume, cancel, stop, dismiss. */
export const sessionRoutes: FastifyPluginAsync<SessionRouteOptions> = async (
  app,
  { service },
) => {
  const { store } = service;

  app.get("/api/sessions", async (request) => {
    const sessions = store.listSessions();
    return request.fleetNodeId
      ? sessions.filter((session) => session.nodeId === request.fleetNodeId)
      : sessions;
  });

  app.post("/api/sessions", async (request, reply) => {
    const input = CreateSessionSchema.parse(request.body);
    const placement = store.getPlacement(input.placementId);
    if (!placement) return reply.code(404).send({ error: "Placement not found" });
    if (request.fleetNodeId && placement.nodeId !== request.fleetNodeId) {
      return reply.code(403).send({ error: "A node may only start its own sessions" });
    }
    const result = service.createAndStartSession({
      placement,
      prompt: input.prompt,
      yolo: input.yolo ?? store.getDefaultYolo(),
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    if (!result.ok) {
      return reply.code(result.status).send({
        error: result.error,
        ...(result.session ? { session: result.session } : {}),
      });
    }
    return reply.code(202).send(result.session);
  });

  app.post("/api/sessions/adopt", async (request, reply) => {
    const input = AdoptSessionSchema.parse(request.body);
    const placement = store.getPlacement(input.placementId);
    if (!placement) return reply.code(404).send({ error: "Placement not found" });
    if (request.fleetNodeId && placement.nodeId !== request.fleetNodeId) {
      return reply.code(403).send({ error: "A node may only resume its own sessions" });
    }
    const result = service.adoptAndResumeSession({
      placement,
      agentSessionId: input.agentSessionId,
      additionalDirectories: input.additionalDirectories,
      yolo: input.yolo ?? store.getDefaultYolo(),
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(202).send(result.session);
  });

  /**
   * The order an operator dragged sessions into.
   *
   * Registered before `/api/sessions/:id` so "reorder" is not read as a
   * session id — Fastify matches static segments first, but the neighbouring
   * routes make that easy to break by moving one.
   */
  app.post("/api/sessions/reorder", async (request) => {
    const input = ReorderSessionsSchema.parse(request.body);
    store.reorderSessions(input.sessionIds);
    // A whole snapshot, not a session-by-session update: browsers patch a
    // session in place when one arrives, keeping its slot in the array, so
    // announcing a new order one session at a time would change nothing on
    // screen until the page was reloaded.
    service.broadcast({ type: "snapshot", data: service.snapshot() });
    return { ok: true };
  });

  app.get("/api/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) {
      return reply.code(404).send({ error: "Session not found" });
    }
    return store.listEvents(id);
  });

  /**
   * Renames a session. Allowed in every state, including terminal ones: naming
   * a finished run is how it stays findable in the history the UI keeps.
   */
  app.patch("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = RenameSessionSchema.parse(request.body);
    const session = store.renameSession(id, input.name);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    service.publishSession(session);
    return session;
  });

  app.post(
    "/api/sessions/:id/prompt",
    {
      // Fastify's default body ceiling is a megabyte, which a single pasted
      // screenshot clears before it has finished being base64. The limit is
      // raised only on this route, and only far enough for the per-attachment
      // ceilings the schema already enforces.
      bodyLimit: (MAX_ATTACHMENT_BYTES * MAX_ATTACHMENTS_PER_PROMPT * 4) / 3 + 1_000_000,
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = PromptSchema.parse(request.body);
      const oversized = input.attachments.find(
        (attachment) => base64Bytes(attachment.data) > MAX_ATTACHMENT_BYTES,
      );
      if (oversized) {
        return reply.code(413).send({
          error: `"${oversized.name}" is larger than the ${Math.round(
            MAX_ATTACHMENT_BYTES / (1024 * 1024),
          )} MB limit for one attachment`,
        });
      }
      const session = store.getSession(id);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (session.state !== "idle") {
        return reply.code(409).send({ error: "Session must be idle" });
      }
      const dispatched = service.dispatch(
        session.nodeId,
        {
          type: "prompt",
          sessionId: id,
          prompt: input.prompt,
          attachments: input.attachments,
        },
        { state: "failed", activity: "Node disconnected before prompt" },
      );
      if (!dispatched.sent) return reply.code(503).send({ error: "Node disconnected" });
      /*
       * An orchestrator's conversation takes its name from the first thing a
       * person says to it, so a fleet running several can tell them apart.
       *
       * Named from the request rather than from the reply because the request
       * is what the person came to do, and because it is available now — a name
       * that appears only after the model has finished would leave every new
       * conversation anonymous for exactly as long as it is most confusing.
       *
       * Never overwrites a name: their own beats ours, and the second message
       * of a conversation is not what it is about.
       */
      if (session.runRole === "lead" && isUnnamed(session.name)) {
        const title = conversationTitle(input.prompt);
        if (title) {
          const named = store.renameSession(id, title);
          if (named) service.publishSession(named);
        }
      }
      return reply.code(202).send({ ok: true });
    },
  );

  app.post("/api/sessions/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const resumed = service.resumeSession(id);
    if (!resumed.ok) return reply.code(resumed.status).send({ error: resumed.error });
    return reply.code(202).send({ ok: true });
  });

  /**
   * Changes a session picker: the model, the mode, the reasoning effort.
   *
   * Allowed while the agent is working as well as when it is idle. These are
   * settings on the live ACP session rather than turns, and the moment an
   * operator most wants to switch models is usually mid-run.
   */
  app.post("/api/sessions/:id/config", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = SetSessionConfigSchema.parse(request.body);
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (terminalSessionStates.has(session.state)) {
      return reply.code(409).send({ error: "Session has ended" });
    }
    const node = store.getNode(session.nodeId);
    const unsupported = node && configUnsupportedReason(node);
    if (unsupported) return reply.code(409).send({ error: unsupported });
    // No fallback transition: failing to change a model must not be able to
    // fail the session the operator is in the middle of using.
    const dispatched = service.dispatch(session.nodeId, {
      type: "set_config_option",
      sessionId: id,
      configId: input.configId,
      value: input.value,
    });
    if (!dispatched.sent) return reply.code(503).send({ error: "Node is offline" });
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
    if (session.stopRequested) {
      return reply.code(200).send({ ok: true, alreadyStopping: true });
    }
    service.publishSession(store.setSessionControls(id, { stopRequested: true }));
    const dispatched = service.dispatch(session.nodeId, {
      type: "stop",
      sessionId: id,
    });
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
