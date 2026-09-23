import { afterEach, describe, expect, it } from "vitest";
import type { Notification, Run } from "@fleet/protocol";
import { FleetStore } from "../store.js";
import { NotificationService } from "./service.js";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new FleetStore(":memory:");
  stores.push(store);
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
  const published = {
    notifications: [] as Notification[],
    counts: [] as number[],
    runs: [] as Run[],
  };
  const service = new NotificationService(store, {
    notificationUpsert: (notification) => published.notifications.push(notification),
    notificationUnreadCount: (count) => published.counts.push(count),
    runUpsert: (run) => published.runs.push(run),
  });
  return { store, service, placement, workspace, published };
}

describe("NotificationService", () => {
  it("uses controlled lifecycle content and deduplicates a producer retry", () => {
    const { store, service, placement, published } = setup();
    const secret = "password=do-not-copy raw stack trace";
    const session = store.createSession(placement, secret, false, "Failure agent");
    const input = {
      kind: "agent_failure" as const,
      session,
      transition: {
        eventId: `event-${secret}`,
        sequence: 7,
        createdAt: "2026-09-01T18:00:00.000Z",
        from: "running" as const,
        to: "failed" as const,
        source: "session_event" as const,
      },
    };

    const first = service.createAgentLifecycle(input);
    const duplicate = service.createAgentLifecycle(input);

    expect(first?.created).toBe(true);
    expect(duplicate?.created).toBe(false);
    expect(store.listNotifications().notifications).toHaveLength(1);
    expect(published.notifications).toHaveLength(1);
    expect(published.counts).toEqual([1]);
    const serialized = JSON.stringify(first?.notification);
    expect(serialized).not.toContain(secret);
    expect(first?.notification).toMatchObject({
      kind: "agent_failure",
      title: "Failure agent session failed",
      body: "The agent session ended unexpectedly.",
      subject: {
        label: "Failure agent",
        parentLabel: "Agent",
      },
      navigation: { sessionId: session.id },
    });
  });

  it("uses the operator-assigned agent name in lifecycle notifications", () => {
    const { store, service, placement } = setup();
    const session = store.createSession(
      placement,
      "private prompt",
      false,
      "Router cleanup",
    );

    const created = service.createAgentLifecycle({
      kind: "agent_completion",
      session,
      transition: {
        eventId: "turn-completed",
        sequence: 2,
        createdAt: "2026-09-01T18:00:00.000Z",
        from: "running",
        to: "idle",
        source: "session_event",
      },
      turnComplete: { eventId: "turn-completed", sequence: 2 },
    });

    expect(created?.notification).toMatchObject({
      title: "Router cleanup completed a turn",
      subject: {
        type: "agent",
        label: "Router cleanup",
      },
    });
  });

  it("keeps a fallback override when the stable agent id arrives", () => {
    const { store, service, placement } = setup();
    const session = store.createSession(placement, "work");
    store.updateNotificationPreference(session.id, session.id, false);
    store.appendEvent({
      eventId: "agent-session",
      sessionId: session.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "a".repeat(300) },
      createdAt: "2026-09-01T18:00:00.000Z",
    });

    const current = store.getSession(session.id)!;
    expect(service.effectivePreference(current)).toMatchObject({
      agentId: "a".repeat(300),
      lifecycleEnabled: false,
      source: "explicit",
    });
    expect(service.updatePreference(current, true)).toMatchObject({
      lifecycleEnabled: true,
      source: "explicit",
    });
    expect(store.getNotificationPreference(session.id, session.id)).toBeUndefined();
  });

  it("creates and resolves one generic permission request", () => {
    const { store, service, placement, published } = setup();
    const session = store.createSession(placement, "credential in prompt");
    const request = {
      session,
      requestId: "request-1",
      event: {
        eventId: "permission-event",
        sequence: 3,
        createdAt: "2026-09-01T18:00:00.000Z",
      },
    };

    const created = service.createPermissionRequest(request);
    const duplicate = service.createPermissionRequest(request);
    expect(
      service.resolvePermissionRequest({
        ...request,
        requestId: "another-request",
        event: {
          eventId: "unmatched-result",
          sequence: 4,
          createdAt: "2026-09-01T18:00:30.000Z",
        },
      }),
    ).toBeUndefined();
    const resolved = service.resolvePermissionRequest({
      ...request,
      event: {
        eventId: "permission-result",
        sequence: 5,
        createdAt: "2026-09-01T18:01:00.000Z",
      },
    });

    expect(created.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(resolved).toMatchObject({
      changed: true,
      notification: {
        id: created.notification.id,
        status: "resolved",
        readAt: expect.any(String),
      },
    });
    expect(created.notification).toMatchObject({
      title: "Permission requested",
      body: "An agent is waiting for a permission decision.",
    });
    expect(JSON.stringify(created.notification)).not.toContain("credential in prompt");
    expect(published.notifications.map((entry) => entry.status)).toEqual([
      "active",
      "resolved",
    ]);
    expect(published.counts).toEqual([1, 0]);
    expect(store.notificationUnreadCount()).toBe(0);
  });

  it("resolves permission requests outside the bounded hydration window", () => {
    const { store, service, placement } = setup();
    const session = store.createSession(placement, "work");
    const oldest = service.createPermissionRequest({
      session,
      event: {
        eventId: "oldest-permission",
        sequence: 1,
        createdAt: "2026-09-01T17:00:00.000Z",
      },
    });
    for (let index = 0; index < 250; index += 1) {
      store.insertNotification({
        sourceKey: `filler:${index}`,
        category: "agent_lifecycle",
        kind: "agent_completion",
        severity: "info",
        title: `Filler ${index}`,
        body: "",
        subject: { type: "session", id: session.id, label: "Work" },
        navigation: { type: "session", sessionId: session.id },
        data: {},
        createdAt: `2026-09-01T18:${String(index % 60).padStart(2, "0")}:00.000Z`,
      });
    }

    expect(
      store
        .listNotificationHydration()
        .some((notification) => notification.id === oldest.notification.id),
    ).toBe(false);
    expect(
      service.resolvePermissionRequest({
        session,
        event: {
          eventId: "permission-result-without-request-id",
          sequence: 2,
          createdAt: "2026-09-01T19:00:00.000Z",
        },
      }),
    ).toMatchObject({
      changed: true,
      notification: { id: oldest.notification.id, status: "resolved" },
    });

    const pending = [3, 4, 5].map((sequence) =>
      service.createPermissionRequest({
        session,
        requestId: `request-${sequence}`,
        event: {
          eventId: `permission-${sequence}`,
          sequence,
          createdAt: `2026-09-01T19:0${sequence}:00.000Z`,
        },
      }),
    );
    expect(service.resolveSessionPermissionRequests(session.id)).toBe(3);
    expect(
      pending.map((entry) => store.getNotification(entry.notification.id)?.status),
    ).toEqual(["resolved", "resolved", "resolved"]);
  });

  it("increments review identity, avoids duplicates, and creates a new record after send-back", () => {
    const { store, service, workspace, published } = setup();
    const run = store.createRun({
      workspaceId: workspace.id,
      name: "Ship notifications",
      objective: "do not copy this objective",
    });
    store.setRunState(run.id, "running");

    const first = service.requestRunReview({
      runId: run.id,
      note: "Completed report with private transcript details.",
      reason: "completed",
    });
    const duplicate = service.requestRunReview({
      runId: run.id,
      note: "This duplicate note must not be written.",
      reason: "completed",
    });

    expect(first?.reviewSeq).toBe(1);
    expect(duplicate).toBeUndefined();
    expect(store.listRunNotes(run.id)).toHaveLength(1);
    const firstNotification = store.listNotifications().notifications[0]!;
    expect(firstNotification).toMatchObject({
      sourceKey: `review:${run.id}:1`,
      body: "The orchestrator reports that this task is complete and ready for approval.",
      navigation: { type: "run", runId: run.id },
    });
    expect(JSON.stringify(firstNotification)).not.toContain("private transcript");

    service.resolveRunReview(first!);
    store.setRunState(run.id, "running");
    const second = service.requestRunReview({
      runId: run.id,
      note: "Blocked report with raw failure output.",
      reason: "blocked",
    });

    expect(second?.reviewSeq).toBe(2);
    expect(store.listNotifications().notifications).toHaveLength(2);
    expect(store.getNotificationBySourceKey(`review:${run.id}:2`)).toMatchObject({
      status: "active",
      body: "The orchestrator is blocked and needs a human decision before work can continue.",
      data: { reason: "blocked", reviewSeq: 2 },
    });
    expect(published.runs.map((entry) => entry.reviewSeq)).toEqual([1, 2]);
  });

  it("bounds orchestration titles and copied labels before schema validation", () => {
    const { store, service, workspace } = setup();
    const longName = "run".repeat(100);
    const longTitle = "step".repeat(100);
    const created = store.createRun({
      workspaceId: workspace.id,
      name: "run",
      objective: "exercise copied notification text",
    });
    const run = store.updateRun(created.id, {
      name: longName,
      state: "running",
    })!;
    const step = store.upsertRunStep(run.id, {
      stepKey: "long-step",
      title: longTitle,
      prompt: "work",
    });

    service.requestRunReview({
      runId: run.id,
      note: "ready",
      reason: "completed",
    });
    service.createOrchestrationStepFailure(run, step);

    const review = store.getNotificationBySourceKey(`review:${run.id}:1`)!;
    const failure = store.getNotificationBySourceKey(
      `orchestration_step_failure:${run.id}:${step.id}:${step.attempts}`,
    )!;
    expect(review.title).toHaveLength(200);
    expect(review.subject.label).toHaveLength(200);
    expect(failure.title).toHaveLength(200);
    expect(failure.subject.label).toHaveLength(200);
    expect(failure.subject.parentLabel).toHaveLength(200);
  });

  it("publishes and returns the exact rows changed by mark-all", () => {
    const { store, service, published } = setup();
    const notifications = ["first", "second"].map(
      (key, index) =>
        store.insertNotification({
          sourceKey: `mark-all:${key}`,
          category: "agent_lifecycle",
          kind: "agent_completion",
          severity: "info",
          title: key,
          body: "",
          subject: { type: "session", id: key, label: key },
          navigation: { type: "session", sessionId: key },
          data: {},
          createdAt: `2026-09-01T18:0${index}:00.000Z`,
        }).notification,
    );

    const result = service.markAllRead();

    expect(result).toMatchObject({
      updated: 2,
      unreadCount: 0,
      notifications: [
        { id: notifications[1]!.id, readAt: expect.any(String) },
        { id: notifications[0]!.id, readAt: expect.any(String) },
      ],
    });
    expect(published.notifications).toEqual(result.notifications);
    expect(published.counts).toEqual([0]);
  });

  it("publishes and returns every row changed by clear-all", () => {
    const { store, service, published } = setup();
    const notifications = ["first", "second"].map(
      (key, index) =>
        store.insertNotification({
          sourceKey: `clear-all:${key}`,
          category: "agent_lifecycle",
          kind: "agent_completion",
          severity: "info",
          title: key,
          body: "",
          subject: { type: "session", id: key, label: key },
          navigation: { type: "session", sessionId: key },
          data: {},
          createdAt: `2026-09-01T18:0${index}:00.000Z`,
        }).notification,
    );

    const result = service.dismissAll();

    expect(result).toMatchObject({
      updated: 2,
      unreadCount: 0,
      notifications: [
        { id: notifications[1]!.id, status: "dismissed" },
        { id: notifications[0]!.id, status: "dismissed" },
      ],
    });
    expect(published.notifications).toEqual(result.notifications);
    expect(published.counts).toEqual([0]);
  });
});
