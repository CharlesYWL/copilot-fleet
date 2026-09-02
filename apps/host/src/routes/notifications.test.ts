import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateNotification, Notification } from "@fleet/protocol";
import { buildServer } from "../server.js";
import { FleetStore } from "../store.js";

const PASSWORD = "notification-route-password";

describe("notification routes", () => {
  let app: FastifyInstance;
  let directory: string;
  let cookie = "";
  let sessionId = "";
  let seeded: Notification[] = [];

  const inject = (options: InjectOptions) =>
    app.inject({ ...options, headers: { ...options.headers, cookie } });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "fleet-notification-routes-"));
    const databasePath = join(directory, "fleet.db");
    const store = new FleetStore(databasePath);
    const { node } = store.registerNode({
      name: "node",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 4,
    });
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
    const session = store.createSession(placement, "private prompt", false, "", {
      runRole: "worker",
    });
    sessionId = session.id;
    store.appendEvent({
      eventId: "agent-session",
      sessionId,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "stable-agent-id" },
      createdAt: "2026-09-01T18:00:00.000Z",
    });

    seeded = ["first", "second", "third", "dismissed"].map(
      (key, index) =>
        store.insertNotification(
          notificationInput(key, `2026-09-01T18:0${index}:00.000Z`, sessionId),
        ).notification,
    );
    store.dismissNotification(seeded[3]!.id, "2026-09-01T19:00:00.000Z");
    store.close();

    app = await buildServer({
      databasePath,
      enrollmentToken: "test-token",
      operatorPassword: PASSWORD,
    });
    app.log.level = "silent";
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: PASSWORD },
    });
    cookie = (login.headers["set-cookie"] as string).split(";")[0] ?? "";
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires the existing operator authentication guard", async () => {
    const response = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(response.statusCode).toBe(401);
  });

  it("lists and paginates the non-dismissed hydration view", async () => {
    const first = await inject({
      method: "GET",
      url: "/api/notifications?limit=2",
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      notifications: Notification[];
      unreadCount: number;
      nextCursor: string;
    };
    expect(firstBody.notifications.map((entry) => entry.title)).toEqual([
      "Notification third",
      "Notification second",
    ]);
    expect(firstBody.unreadCount).toBe(3);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await inject({
      method: "GET",
      url: `/api/notifications?limit=2&cursor=${encodeURIComponent(
        firstBody.nextCursor,
      )}`,
    });
    expect(second.statusCode).toBe(200);
    expect(
      (second.json() as { notifications: Notification[] }).notifications.map(
        (entry) => entry.title,
      ),
    ).toEqual(["Notification first"]);

    const withDismissed = await inject({
      method: "GET",
      url: "/api/notifications?includeDismissed=true",
    });
    expect(
      (withDismissed.json() as { notifications: Notification[] }).notifications,
    ).toHaveLength(4);
  });

  it("rejects malformed pagination input", async () => {
    expect(
      (await inject({ method: "GET", url: "/api/notifications?limit=0" })).statusCode,
    ).toBe(400);
    expect(
      (
        await inject({
          method: "GET",
          url: "/api/notifications?cursor=not-a-cursor",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("gets, updates, and resets the effective session preference", async () => {
    const read = async () =>
      (
        await inject({
          method: "GET",
          url: `/api/notifications/preferences/${sessionId}`,
        })
      ).json();

    expect(await read()).toMatchObject({
      sessionId,
      agentId: "stable-agent-id",
      runRole: "worker",
      lifecycleEnabled: false,
      source: "role",
    });

    const updated = await inject({
      method: "PATCH",
      url: `/api/notifications/preferences/${sessionId}`,
      payload: { lifecycleEnabled: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      lifecycleEnabled: true,
      source: "explicit",
    });

    const reset = await inject({
      method: "DELETE",
      url: `/api/notifications/preferences/${sessionId}`,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      lifecycleEnabled: false,
      source: "role",
    });

    expect(
      (
        await inject({
          method: "PUT",
          url: `/api/notifications/preferences/${sessionId}`,
          payload: { lifecycleEnabled: "yes" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await inject({
          method: "GET",
          url: "/api/notifications/preferences/missing",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("marks read, marks all read, dismisses, and reports missing ids", async () => {
    const read = await inject({
      method: "POST",
      url: `/api/notifications/${seeded[0]!.id}/read`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      notification: { id: seeded[0]!.id, readAt: expect.any(String) },
      unreadCount: 2,
    });

    const dismissed = await inject({
      method: "POST",
      url: `/api/notifications/${seeded[1]!.id}/dismiss`,
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({
      notification: { id: seeded[1]!.id, status: "dismissed" },
      unreadCount: 1,
    });

    const all = await inject({
      method: "POST",
      url: "/api/notifications/read-all",
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({
      updated: 1,
      unreadCount: 0,
      notifications: [
        {
          id: seeded[2]!.id,
          readAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
    });

    for (const suffix of ["read", "dismiss"]) {
      const missing = await inject({
        method: "POST",
        url: `/api/notifications/missing/${suffix}`,
      });
      expect(missing.statusCode).toBe(404);
    }
  });
});

function notificationInput(
  key: string,
  createdAt: string,
  sessionId: string,
): CreateNotification {
  return {
    sourceKey: `route:${key}`,
    category: "agent_lifecycle",
    kind: "agent_completion",
    severity: "info",
    title: `Notification ${key}`,
    body: "Controlled body.",
    subject: { type: "session", id: sessionId, label: "Session" },
    navigation: { type: "session", sessionId },
    data: {},
    createdAt,
  };
}
