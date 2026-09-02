import type { FastifyPluginAsync } from "fastify";
import {
  MarkAllNotificationsReadResponseSchema,
  NotificationCursorSchema,
  UpdateNotificationPreferenceSchema,
} from "@fleet/protocol";
import { z } from "zod";
import type { FleetService } from "../fleet-service.js";

const EncodedCursorSchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    try {
      const decoded = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      ) as unknown;
      const parsed = NotificationCursorSchema.safeParse(decoded);
      if (parsed.success) return parsed.data;
    } catch {
      // Reported through the schema issue below.
    }
    context.addIssue({ code: "custom", message: "Invalid notification cursor" });
    return z.NEVER;
  });

const ListNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: EncodedCursorSchema.optional(),
  includeDismissed: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

const encodeCursor = (cursor: z.infer<typeof NotificationCursorSchema>): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

export type NotificationRouteOptions = { service: FleetService };

/** Durable notification hydration, preferences, and acknowledgement actions. */
export const notificationRoutes: FastifyPluginAsync<NotificationRouteOptions> = async (
  app,
  { service },
) => {
  app.get("/api/notifications", async (request) => {
    const query = ListNotificationsQuerySchema.parse(request.query);
    const page = service.notifications.list({
      limit: query.limit,
      before: query.cursor,
      includeDismissed: query.includeDismissed,
    });
    return {
      notifications: page.notifications,
      unreadCount: service.store.notificationUnreadCount(),
      ...(page.nextCursor ? { nextCursor: encodeCursor(page.nextCursor) } : {}),
    };
  });

  app.get("/api/notifications/preferences/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const preference = service.effectiveNotificationPreference(sessionId);
    return preference ?? reply.code(404).send({ error: "Session not found" });
  });

  app.route({
    method: ["PUT", "PATCH"],
    url: "/api/notifications/preferences/:sessionId",
    handler: async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const input = UpdateNotificationPreferenceSchema.parse(request.body);
      const preference = service.updateNotificationPreference(
        sessionId,
        input.lifecycleEnabled,
      );
      return preference ?? reply.code(404).send({ error: "Session not found" });
    },
  });

  app.delete("/api/notifications/preferences/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const preference = service.resetNotificationPreference(sessionId);
    return preference ?? reply.code(404).send({ error: "Session not found" });
  });

  app.post("/api/notifications/read-all", async () => {
    return MarkAllNotificationsReadResponseSchema.parse(
      service.notifications.markAllRead(),
    );
  });

  app.post("/api/notifications/dismiss-all", async () => {
    return MarkAllNotificationsReadResponseSchema.parse(
      service.notifications.dismissAll(),
    );
  });

  app.post("/api/notifications/:id/read", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = service.notifications.markRead(id);
    if (!result) return reply.code(404).send({ error: "Notification not found" });
    return {
      notification: result.notification,
      unreadCount: service.store.notificationUnreadCount(),
    };
  });

  app.post("/api/notifications/:id/dismiss", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = service.notifications.dismiss(id);
    if (!result) return reply.code(404).send({ error: "Notification not found" });
    return {
      notification: result.notification,
      unreadCount: service.store.notificationUnreadCount(),
    };
  });
};
