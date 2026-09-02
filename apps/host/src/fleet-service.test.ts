import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import {
  CHATS_WORKSPACE_NAME,
  HOST_URL_SYNC_CAPABILITY,
  NODE_NAME_SYNC_CAPABILITY,
  SELF_UPDATE_CAPABILITY,
  type Notification,
  type RunRole,
  type SessionEvent,
} from "@fleet/protocol";
import { FleetService } from "./fleet-service.js";
import { OrchestratorEngine } from "./orchestrator/engine.js";
import { FleetStore } from "./store.js";

type SentFrame = {
  type: string;
  hostUrl?: string;
  name?: string;
  nodeId?: string;
  stage?: string;
  detail?: string;
  notification?: Notification;
  unreadCount?: number;
  command?: { type: string; sessionId: string; localPath?: string };
};

/** Just enough socket for the service to consider it writable and record sends. */
function fakeSocket() {
  const sent: SentFrame[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as SentFrame),
  };
  return { sent, socket: socket as unknown as WebSocket };
}

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
} as unknown as FastifyBaseLogger;

function setup(hostRevision: string | (() => string) = "") {
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, silentLog, hostRevision);
  const enroll = (name: string, capabilities: string[], revision = "") => {
    const { node } = store.registerNode({
      name,
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      revision,
      capabilities,
      maxSessions: 1,
    });
    const wire = fakeSocket();
    service.attachNode(node.id, wire.socket);
    return { ...wire, nodeId: node.id };
  };
  return { store, service, enroll };
}

describe("adopting discovered Copilot sessions", () => {
  it("creates one Fleet session with the stable ACP id and dispatches resume", () => {
    const { store, service, enroll } = setup();
    const wire = enroll("box", ["copilot-acp", "host-yolo"]);
    store.setNodeOnline(wire.nodeId, true, 0);
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, wire.nodeId, "C:\\repo");

    const result = service.adoptAndResumeSession({
      placement,
      agentSessionId: "stable-acp-id",
      additionalDirectories: ["C:\\shared"],
      yolo: false,
      name: "Existing work",
    });

    expect(result.ok).toBe(true);
    expect(store.listSessions()).toHaveLength(1);
    expect(store.listSessions()[0]).toMatchObject({
      agentSessionId: "stable-acp-id",
      name: "Existing work",
      state: "starting",
    });
    expect(wire.sent.at(-1)).toMatchObject({
      type: "command",
      command: {
        type: "resume_session",
        sessionId: store.listSessions()[0]!.id,
        localPath: "C:\\repo",
        additionalDirectories: ["C:\\shared"],
      },
    });
  });

  it("prevents a second live adoption of the same ACP session", () => {
    const { store, service, enroll } = setup();
    const wire = enroll("box", ["copilot-acp"]);
    store.setNodeOnline(wire.nodeId, true, 0);
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, wire.nodeId, "C:\\repo");

    expect(
      service.adoptAndResumeSession({
        placement,
        agentSessionId: "same-acp-id",
        yolo: false,
      }).ok,
    ).toBe(true);
    const duplicate = service.adoptAndResumeSession({
      placement,
      agentSessionId: "same-acp-id",
      yolo: false,
    });

    expect(duplicate).toEqual({
      ok: false,
      status: 409,
      error: "This Copilot session is already live in Fleet",
    });
    expect(store.listSessions()).toHaveLength(1);
  });

  it("reuses a settled ACP session on another node without duplicating history", () => {
    const { store, service, enroll } = setup();
    const first = enroll("first", ["copilot-acp"]);
    const second = enroll("second", ["copilot-acp"]);
    store.setNodeOnline(first.nodeId, true, 0);
    store.setNodeOnline(second.nodeId, true, 0);
    const workspace = store.createWorkspace("repo", "");
    const oldPlacement = store.createPlacement(
      workspace.id,
      first.nodeId,
      "C:\\old-repo",
    );
    const newPlacement = store.createPlacement(workspace.id, second.nodeId, "D:\\repo");

    const original = service.adoptAndResumeSession({
      placement: oldPlacement,
      agentSessionId: "portable-acp-id",
      yolo: false,
    });
    expect(original.ok).toBe(true);
    const originalId = original.ok ? original.session.id : "";
    store.transitionSession(originalId, "failed", "Old node stopped");

    const resumed = service.adoptAndResumeSession({
      placement: newPlacement,
      agentSessionId: "portable-acp-id",
      yolo: false,
    });

    expect(resumed.ok).toBe(true);
    expect(store.listSessions()).toHaveLength(1);
    expect(resumed.ok ? resumed.session : undefined).toMatchObject({
      id: originalId,
      nodeId: second.nodeId,
      placementId: newPlacement.id,
      state: "starting",
    });
    expect(second.sent.at(-1)).toMatchObject({
      command: { type: "resume_session", sessionId: originalId, localPath: "D:\\repo" },
    });
  });

  it("does not relocate settled history when the target node cannot resume", () => {
    const { store, service, enroll } = setup();
    const first = enroll("first", ["copilot-acp"]);
    const second = enroll("second", ["copilot-acp"]);
    store.setNodeOnline(first.nodeId, true, 0);
    store.setNodeOnline(second.nodeId, false, 0);
    const workspace = store.createWorkspace("repo", "");
    const oldPlacement = store.createPlacement(
      workspace.id,
      first.nodeId,
      "C:\\old-repo",
    );
    const newPlacement = store.createPlacement(workspace.id, second.nodeId, "D:\\repo");
    const original = service.adoptAndResumeSession({
      placement: oldPlacement,
      agentSessionId: "stable-history",
      yolo: false,
    });
    expect(original.ok).toBe(true);
    const originalId = original.ok ? original.session.id : "";
    store.transitionSession(originalId, "failed", "Old node stopped");

    expect(
      service.adoptAndResumeSession({
        placement: newPlacement,
        agentSessionId: "stable-history",
        yolo: false,
      }),
    ).toEqual({ ok: false, status: 503, error: "Node is offline" });
    expect(store.getSession(originalId)).toMatchObject({
      nodeId: first.nodeId,
      placementId: oldPlacement.id,
      state: "failed",
    });
  });
});

describe("handleEvent after a Host restart", () => {
  const event = (sessionId: string, sequence: number, payload: object, type = "state") =>
    ({
      eventId: `e${sequence}`,
      sessionId,
      sequence,
      type,
      payload,
      createdAt: new Date().toISOString(),
    }) as Parameters<FleetService["handleEvent"]>[0];

  it("keeps applying events whose predecessors were lost", () => {
    // The exact freeze: the Host restarted mid-turn, the Node kept working and
    // kept numbering, and the first event afterwards was ahead of what the Host
    // expected. Refusing it refused everything after it, so the session sat at
    // whatever state the reconnect had guessed — accepting no output and no
    // state change — while its agent was alive and well on the Node.
    const { store, service } = setup();
    const { node } = store.registerNode({
      name: "devbox",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 4,
    });
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
    const session = store.createSession(placement, "long task");

    service.handleEvent(event(session.id, 1, { state: "starting" }));
    service.handleEvent(event(session.id, 2, { state: "running" }));
    expect(store.getSession(session.id)?.state).toBe("running");

    // Host restarts: everything live is parked, and the Node that still owns the
    // session brings it back as idle on reconnect.
    store.resetConnectivity();
    store.reconcileOfflineSessions(node.id, [session.id]);
    expect(store.getSession(session.id)?.state).toBe("idle");

    // Events 3-11 were raised while nothing was listening.
    service.handleEvent(event(session.id, 12, { text: "back" }, "agent_text"));
    service.handleEvent(event(session.id, 13, { state: "running" }));

    expect(store.getSession(session.id)?.lastText).toBe("back");
    expect(store.getSession(session.id)?.state).toBe("running");

    // And the session keeps moving, rather than being deaf from here on.
    service.handleEvent(event(session.id, 14, { state: "idle", activity: "Done" }));
    expect(store.getSession(session.id)?.state).toBe("idle");
  });
});

describe("durable session notifications", () => {
  const at = (minute: number) =>
    `2026-09-01T18:${String(minute).padStart(2, "0")}:00.000Z`;

  const event = (
    sessionId: string,
    sequence: number,
    type: SessionEvent["type"],
    payload: SessionEvent["payload"],
    createdAt = at(sequence),
  ): SessionEvent => ({
    eventId: `${sessionId}-${type}-${sequence}`,
    sessionId,
    sequence,
    type,
    payload,
    createdAt,
  });

  const world = (runRole: RunRole = "") => {
    const { store, service, enroll } = setup();
    const wire = enroll("box", ["copilot-acp"]);
    store.setNodeOnline(wire.nodeId, true, 0);
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, wire.nodeId, "C:\\repo");
    const session = store.createSession(placement, "sensitive prompt", false, "", {
      runRole,
    });
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "running");
    return { store, service, wire, workspace, placement, session };
  };

  const workerWorld = (attempts = 1) => {
    const kit = world("worker");
    const run = kit.store.createRun({
      workspaceId: kit.workspace.id,
      name: "Task",
      objective: "do the work",
    });
    kit.store.setRunState(run.id, "running");
    const step = kit.store.upsertRunStep(run.id, {
      stepKey: "implementation",
      title: "Implementation",
      prompt: "private worker prompt",
    });
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      kit.store.upsertRunStep(run.id, {
        stepKey: "implementation",
        title: "Implementation",
        prompt: "private retry prompt",
      });
    }
    const nodeBoundary = new Date(Date.now() - 60_000);
    if (attempts > 1) {
      kit.store.appendEvent({
        eventId: `${kit.session.id}-boundary`,
        sessionId: kit.session.id,
        sequence: 10,
        type: "agent_text",
        payload: { text: "previous attempt boundary" },
        createdAt: nodeBoundary.toISOString(),
      });
    }
    const current = kit.store.updateRunStep(step.id, {
      state: "running",
      sessionId: kit.session.id,
      eventSeqFrom: attempts > 1 ? 10 : 0,
      dispatchedAt: attempts > 1 ? new Date().toISOString() : at(0),
    })!;
    return {
      ...kit,
      run: kit.store.getRun(run.id)!,
      step: current,
      staleCreatedAt: new Date(nodeBoundary.getTime() - 10_000).toISOString(),
    };
  };

  it.each(["", "lead"] as const)(
    "notifies a %s session only after turn completion and an accepted idle transition",
    (runRole) => {
      const { store, service, session } = world(runRole);

      service.handleEvent(event(session.id, 1, "turn_complete", {}));
      service.handleEvent(event(session.id, 2, "state", { state: "idle" }));

      expect(store.listNotifications().notifications).toMatchObject([
        {
          kind: "agent_completion",
          navigation: { sessionId: session.id },
        },
      ]);
    },
  );

  it("mutes dependency lifecycle by default and lets an explicit override enable it", () => {
    const muted = workerWorld();
    muted.service.handleEvent(event(muted.session.id, 1, "turn_complete", {}));
    muted.service.handleEvent(event(muted.session.id, 2, "state", { state: "idle" }));
    expect(muted.store.listNotifications().notifications).toEqual([]);

    const enabled = workerWorld();
    enabled.store.updateNotificationPreference(
      enabled.session.id,
      enabled.session.id,
      true,
    );
    enabled.service.handleEvent(event(enabled.session.id, 1, "turn_complete", {}));
    enabled.service.handleEvent(event(enabled.session.id, 2, "state", { state: "idle" }));
    expect(enabled.store.listNotifications().notifications[0]).toMatchObject({
      kind: "agent_completion",
      data: {
        runId: enabled.run.id,
        stepId: enabled.step.id,
        attempts: 1,
      },
      navigation: {
        runId: enabled.run.id,
        stepId: enabled.step.id,
        sessionId: enabled.session.id,
      },
    });
  });

  it("lets a disabled root override mute lifecycle without muting permission requests", () => {
    const { store, service, session } = world();
    store.updateNotificationPreference(session.id, session.id, false);

    service.handleEvent(
      event(session.id, 1, "permission", {
        requestId: "request-1",
        title: "Run a secret command",
        options: [{ optionId: "yes", name: "Allow secret", kind: "allow" }],
      }),
    );
    service.handleEvent(
      event(session.id, 2, "permission_result", {
        requestId: "request-1",
        outcome: "allow_once",
      }),
    );
    service.handleEvent(event(session.id, 3, "turn_complete", {}));
    service.handleEvent(event(session.id, 4, "state", { state: "idle" }));

    expect(store.listNotifications().notifications).toMatchObject([
      {
        kind: "permission_request",
        status: "resolved",
        title: "Permission requested",
      },
    ]);
    expect(JSON.stringify(store.listNotifications().notifications[0])).not.toContain(
      "secret",
    );
  });

  it("applies the application lifecycle default to top-level sessions", () => {
    const { store, service, session } = world("lead");
    store.setDefaultNotificationLifecycleEnabled(false);

    service.handleEvent(event(session.id, 1, "turn_complete", {}));
    service.handleEvent(event(session.id, 2, "state", { state: "idle" }));

    expect(store.listNotifications().notifications).toEqual([]);
  });

  it("distinguishes a real failure from cancel and stop outcomes", () => {
    const failed = world();
    failed.service.handleEvent(event(failed.session.id, 1, "state", { state: "failed" }));
    expect(failed.store.listNotifications().notifications[0]?.kind).toBe("agent_failure");

    const cancelled = world();
    cancelled.service.dispatch(cancelled.session.nodeId, {
      type: "cancel",
      sessionId: cancelled.session.id,
    });
    cancelled.service.handleEvent(
      event(cancelled.session.id, 1, "turn_complete", {
        stopReason: "cancelled",
      }),
    );
    cancelled.service.handleEvent(
      event(cancelled.session.id, 2, "state", { state: "idle" }),
    );
    expect(cancelled.store.listNotifications().notifications).toEqual([]);
    expect(
      cancelled.store.getSessionTransitionIntent(cancelled.session.id),
    ).toBeUndefined();

    const cancelledAsFailed = world();
    cancelledAsFailed.service.dispatch(cancelledAsFailed.session.nodeId, {
      type: "cancel",
      sessionId: cancelledAsFailed.session.id,
    });
    cancelledAsFailed.service.handleEvent(
      event(cancelledAsFailed.session.id, 1, "state", { state: "failed" }),
    );
    expect(cancelledAsFailed.store.listNotifications().notifications).toEqual([]);

    const stopped = world();
    stopped.service.dispatch(stopped.session.nodeId, {
      type: "stop",
      sessionId: stopped.session.id,
    });
    stopped.service.handleEvent(
      event(stopped.session.id, 1, "state", { state: "stopped" }),
    );
    expect(stopped.store.listNotifications().notifications).toEqual([]);
    expect(stopped.store.getSessionTransitionIntent(stopped.session.id)).toBeUndefined();
  });

  it("rolls back commanded settlement when permission resolution fails", () => {
    const { store, service, session } = world();
    service.handleEvent(event(session.id, 1, "permission", { requestId: "request-1" }));
    service.dispatch(session.nodeId, { type: "stop", sessionId: session.id });
    const resolve = vi
      .spyOn(store, "resolveActivePermissionRequestsForSession")
      .mockImplementationOnce(() => {
        throw new Error("injected permission resolution failure");
      });

    expect(() =>
      service.settleCommandedSession(session.id, "stopped", "Stopped"),
    ).toThrow("injected permission resolution failure");
    expect(store.getSession(session.id)?.state).toBe("running");
    expect(store.getSessionTransitionIntent(session.id)).toBe("stop");
    expect(store.listNotifications().notifications[0]?.status).toBe("active");

    resolve.mockRestore();
    service.settleCommandedSession(session.id, "stopped", "Stopped");
    expect(store.getSession(session.id)?.state).toBe("stopped");
    expect(store.getSessionTransitionIntent(session.id)).toBeUndefined();
    expect(store.listNotifications().notifications[0]?.status).toBe("resolved");
  });

  it("notifies once for a fatal command result, including an authoritative stop failure", () => {
    const failed = world();
    failed.service.failFromCommandResult(
      failed.session.id,
      "command-failed",
      "Agent process crashed",
    );
    failed.service.failFromCommandResult(
      failed.session.id,
      "command-failed",
      "Agent process crashed",
    );

    expect(failed.store.listNotifications().notifications).toMatchObject([
      {
        kind: "agent_failure",
        data: { transitionSource: "fatal_command_result" },
      },
    ]);

    const stopped = world();
    stopped.service.dispatch(stopped.session.nodeId, {
      type: "stop",
      sessionId: stopped.session.id,
    });
    stopped.service.failFromCommandResult(
      stopped.session.id,
      "stop-command-failed",
      "Agent process crashed while stopping",
    );

    expect(stopped.store.listNotifications().notifications[0]).toMatchObject({
      kind: "agent_failure",
      data: { transitionSource: "fatal_command_result" },
    });
    expect(stopped.store.getSessionTransitionIntent(stopped.session.id)).toBeUndefined();
  });

  it("notifies once when reconciliation proves a session is missing", () => {
    const { store, service, session } = world();

    service.disconnectNode(session.nodeId, "disconnected");
    expect(store.listNotifications().notifications).toEqual([]);
    service.reconcile(session.nodeId, []);
    service.reconcile(session.nodeId, []);

    expect(store.getSession(session.id)?.state).toBe("failed");
    expect(store.listNotifications().notifications).toMatchObject([
      {
        kind: "agent_failure",
        data: { transitionSource: "reconciliation" },
      },
    ]);
  });

  it("suppresses a reconciliation failure that settles an operator stop", () => {
    const { store, service, session } = world();
    service.dispatch(session.nodeId, { type: "stop", sessionId: session.id });

    service.disconnectNode(session.nodeId, "disconnected while stopping");
    service.reconcile(session.nodeId, []);

    expect(store.getSession(session.id)?.state).toBe("failed");
    expect(store.getSessionTransitionIntent(session.id)).toBeUndefined();
    expect(store.listNotifications().notifications).toEqual([]);
  });

  it("accepts the commanded stop that settles an already-cancelled run step", () => {
    const { store, service, session, step } = workerWorld();
    service.dispatch(session.nodeId, { type: "stop", sessionId: session.id });
    store.updateRunStep(step.id, { state: "cancelled" });

    service.handleEvent(event(session.id, 1, "state", { state: "stopped" }));

    expect(store.getSession(session.id)?.state).toBe("stopped");
    expect(store.getSessionTransitionIntent(session.id)).toBeUndefined();
    expect(store.listNotifications().notifications).toEqual([]);
  });

  it("does not retain a stop intent when the command was never delivered", () => {
    const { store, service, session, step } = workerWorld();
    store.updateNotificationPreference(session.id, session.id, true);
    service.disconnectNode(session.nodeId, "offline");

    expect(
      service.dispatch(session.nodeId, { type: "stop", sessionId: session.id }),
    ).toEqual({ sent: false });
    expect(store.getSessionTransitionIntent(session.id)).toBeUndefined();

    const replacement = fakeSocket();
    service.attachNode(session.nodeId, replacement.socket);
    store.setNodeOnline(session.nodeId, true, 1);
    store.transitionSession(session.id, "running", "Still working");
    const engine = new OrchestratorEngine(service);
    service.onSessionEvent((accepted) => engine.handleSessionEvent(accepted));
    service.handleEvent(event(session.id, 1, "turn_complete", {}));
    service.handleEvent(event(session.id, 2, "state", { state: "idle" }));

    expect(store.getRunStep(step.id)?.state).toBe("succeeded");
    expect(store.listNotifications().notifications[0]?.kind).toBe("agent_completion");
  });

  it("does nothing for raw replay duplicates and hydrates existing records on restart", () => {
    const { store, service, session } = world();
    const browser = fakeSocket();
    service.addBrowser(browser.socket);
    const done = event(session.id, 1, "turn_complete", {});
    const idle = event(session.id, 2, "state", { state: "idle" });

    service.handleEvent(done);
    service.handleEvent(idle);
    service.handleEvent(done);
    service.handleEvent(idle);

    expect(store.listNotifications().notifications).toHaveLength(1);
    expect(
      browser.sent.filter((frame) => frame.type === "notification_upsert"),
    ).toHaveLength(1);
    expect(
      browser.sent
        .filter((frame) => frame.type === "notification_unread_count")
        .map((frame) => frame.unreadCount),
    ).toEqual([1]);

    const restarted = new FleetService(store, silentLog, "");
    expect(restarted.snapshot()).toMatchObject({
      notifications: [{ kind: "agent_completion" }],
      notificationUnreadCount: 1,
    });
    expect(store.listNotifications().notifications).toHaveLength(1);
  });

  it("rolls back a state event and transition when its lifecycle notification insert fails", () => {
    const { store, service, session } = world();
    const browser = fakeSocket();
    service.addBrowser(browser.socket);
    service.handleEvent(event(session.id, 1, "turn_complete", {}));
    browser.sent.length = 0;
    const idle = event(session.id, 2, "state", { state: "idle" });
    const insert = vi.spyOn(store, "insertNotification").mockImplementationOnce(() => {
      throw new Error("injected notification insert failure");
    });

    expect(service.handleEvent(idle)).toBe(false);

    expect(store.getSession(session.id)?.state).toBe("running");
    expect(store.listEvents(session.id)).toHaveLength(1);
    expect(store.getSessionTurnCompletion(session.id)).toBeDefined();
    expect(store.listNotifications().notifications).toEqual([]);
    expect(browser.sent).toEqual([]);

    insert.mockRestore();
    expect(service.handleEvent(idle)).toBe(true);
    expect(store.getSession(session.id)?.state).toBe("idle");
    expect(store.listEvents(session.id)).toHaveLength(2);
    expect(store.listNotifications().notifications).toHaveLength(1);
    expect(
      browser.sent.filter((frame) => frame.type === "notification_upsert"),
    ).toHaveLength(1);
  });

  it("rolls back a turn-complete event when its durable receipt cannot be written", () => {
    const { store, service, session } = world();
    const completed = event(session.id, 1, "turn_complete", {});
    const receipt = vi
      .spyOn(store, "setSessionTurnCompletion")
      .mockImplementationOnce(() => {
        throw new Error("injected receipt failure");
      });

    expect(service.handleEvent(completed)).toBe(false);
    expect(store.listEvents(session.id)).toEqual([]);
    expect(store.getSessionTurnCompletion(session.id)).toBeUndefined();

    receipt.mockRestore();
    expect(service.handleEvent(completed)).toBe(true);
    expect(store.listEvents(session.id)).toHaveLength(1);
    expect(store.getSessionTurnCompletion(session.id)).toMatchObject({
      eventId: completed.eventId,
      sequence: completed.sequence,
    });
  });

  it("classifies SQLite constraints as permanent but other failures as retryable", () => {
    const { store, service, session } = world();
    const append = vi.spyOn(store, "appendEvent");
    append.mockImplementationOnce(() => {
      throw Object.assign(new Error("constraint failed"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 787,
      });
    });
    expect(
      service.handleEventResult(
        event(session.id, 1, "agent_text", { text: "permanent" }),
      ),
    ).toEqual({ outcome: "permanent_rejection", reason: "sqlite_constraint" });

    append.mockImplementationOnce(() => {
      throw new Error("database temporarily unavailable");
    });
    expect(
      service.handleEventResult(
        event(session.id, 1, "agent_text", { text: "retryable" }),
      ),
    ).toEqual({ outcome: "retryable_failure" });
  });

  it("rolls back a fatal transition when its failure notification cannot be written", () => {
    const { store, service, session } = world();
    const browser = fakeSocket();
    service.addBrowser(browser.socket);
    browser.sent.length = 0;
    const insert = vi.spyOn(store, "insertNotification").mockImplementationOnce(() => {
      throw new Error("injected notification insert failure");
    });

    expect(() =>
      service.failFromCommandResult(session.id, "fatal-command", "process failed"),
    ).toThrow("injected notification insert failure");
    expect(store.getSession(session.id)?.state).toBe("running");
    expect(store.listNotifications().notifications).toEqual([]);
    expect(browser.sent).toEqual([]);

    insert.mockRestore();
    service.failFromCommandResult(session.id, "fatal-command", "process failed");
    expect(store.getSession(session.id)?.state).toBe("failed");
    expect(store.listNotifications().notifications).toHaveLength(1);
  });

  it("rolls back reconciliation failure and retries it with one notification", () => {
    const { store, service, session } = world();
    const browser = fakeSocket();
    service.addBrowser(browser.socket);
    service.disconnectNode(session.nodeId, "disconnected");
    browser.sent.length = 0;
    const insert = vi.spyOn(store, "insertNotification").mockImplementationOnce(() => {
      throw new Error("injected notification insert failure");
    });

    expect(() => service.reconcile(session.nodeId, [])).toThrow(
      "injected notification insert failure",
    );
    expect(store.getSession(session.id)?.state).toBe("offline");
    expect(store.listNotifications().notifications).toEqual([]);
    expect(browser.sent).toEqual([]);

    insert.mockRestore();
    service.reconcile(session.nodeId, []);
    expect(store.getSession(session.id)?.state).toBe("failed");
    expect(store.listNotifications().notifications).toHaveLength(1);
  });

  it("carries a completed-turn receipt across restart reconciliation", () => {
    const { store, service, session, step, run } = workerWorld();
    store.updateNotificationPreference(session.id, session.id, true);
    service.handleEvent(event(session.id, 1, "turn_complete", {}));
    expect(store.getSessionTurnCompletion(session.id)).toBeDefined();

    store.resetConnectivity();
    const restarted = new FleetService(store, silentLog, "");
    restarted.reconcile(session.nodeId, [session.id]);

    expect(store.getSession(session.id)?.state).toBe("idle");
    expect(store.listNotifications().notifications[0]).toMatchObject({
      kind: "agent_completion",
      data: {
        stepId: step.id,
        transitionSource: "reconciliation",
      },
    });
    expect(store.getSessionTurnCompletion(session.id)).toBeDefined();

    const engine = new OrchestratorEngine(restarted);
    store.setNodeOnline(session.nodeId, true, 1);
    engine.tickRun(run.id);
    expect(store.getRunStep(step.id)?.state).toBe("succeeded");
    expect(store.getSessionTurnCompletion(session.id)).toBeUndefined();
  });

  it("does not replay a delivered completion when its receipt survives restart", () => {
    const { store, service, session } = world();
    const completed = event(session.id, 1, "turn_complete", {});
    service.handleEvent(completed);
    service.handleEvent(event(session.id, 2, "state", { state: "idle" }));
    expect(store.listNotifications().notifications).toHaveLength(1);

    store.setSessionTurnCompletion(session.id, {
      eventId: completed.eventId,
      sequence: completed.sequence,
      attempt: `session:${session.id}`,
    });
    store.resetConnectivity();
    const restarted = new FleetService(store, silentLog, "");
    restarted.reconcile(session.nodeId, [session.id]);

    expect(store.listNotifications().notifications).toHaveLength(1);
    expect(store.getSessionTurnCompletion(session.id)).toBeUndefined();
  });

  it("still resolves a permission result after the step terminalizes", () => {
    const { store, service, session } = workerWorld();
    const engine = new OrchestratorEngine(service);
    service.onSessionEvent((accepted) => engine.handleSessionEvent(accepted));
    service.handleEvent(event(session.id, 1, "permission", { requestId: "request-1" }));

    service.handleEvent(event(session.id, 2, "state", { state: "failed" }));
    expect(store.listRunSteps(store.listRuns()[0]!.id)[0]?.state).toBe("failed");

    service.handleEvent(
      event(session.id, 3, "permission_result", {
        requestId: "request-1",
        outcome: "deny",
      }),
    );
    expect(
      store
        .listNotifications()
        .notifications.find((notification) => notification.kind === "permission_request"),
    ).toMatchObject({ status: "resolved" });
  });

  it("resolves permission requests when reconnect proves the agent is gone", () => {
    const { store, service, session } = world();
    service.handleEvent(event(session.id, 1, "permission", { requestId: "request-1" }));
    expect(store.listNotifications().notifications[0]?.status).toBe("active");

    service.disconnectNode(session.nodeId, "disconnected");
    service.reconcile(session.nodeId, []);

    expect(store.getSession(session.id)?.state).toBe("failed");
    expect(
      store
        .listNotifications()
        .notifications.find((notification) => notification.kind === "permission_request")
        ?.status,
    ).toBe("resolved");
  });

  it("persists stale old-attempt events but ignores them until the current retry finishes", () => {
    const { store, service, session, run, step, staleCreatedAt } = workerWorld(2);
    store.updateNotificationPreference(session.id, session.id, true);
    store.updateRunStep(step.id, { state: "starting" });
    const engine = new OrchestratorEngine(service);
    service.onSessionEvent((accepted) => engine.handleSessionEvent(accepted));
    const listener = vi.fn();
    service.onSessionEvent(listener);

    service.handleEvent(
      event(session.id, 11, "agent_text", { text: "old attempt output" }, staleCreatedAt),
    );
    service.handleEvent(event(session.id, 12, "turn_complete", {}, staleCreatedAt));
    service.handleEvent(
      event(session.id, 13, "state", { state: "idle" }, staleCreatedAt),
    );

    expect(store.getSession(session.id)?.state).toBe("running");
    expect(store.listEvents(session.id)).toHaveLength(4);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.listNotifications().notifications).toEqual([]);

    service.handleEvent(
      event(session.id, 14, "state", { state: "running" }, staleCreatedAt),
    );
    service.handleEvent(
      event(
        session.id,
        15,
        "agent_text",
        { text: "current retry output" },
        staleCreatedAt,
      ),
    );
    service.handleEvent(event(session.id, 16, "turn_complete", {}, staleCreatedAt));
    service.handleEvent(
      event(session.id, 17, "state", { state: "idle" }, staleCreatedAt),
    );

    expect(listener).toHaveBeenCalledTimes(5);
    expect(store.listEvents(session.id)).toHaveLength(8);
    expect(store.getRunStep(step.id)?.output).toBe("current retry output");
    expect(store.listNotifications().notifications[0]).toMatchObject({
      kind: "agent_completion",
      data: { runId: run.id, stepId: step.id, attempts: 2 },
    });
  });

  it("accepts a direct prompt after a worker step settled without reopening the step", () => {
    const { store, service, session, run, step } = workerWorld();
    const engine = new OrchestratorEngine(service);
    service.onSessionEvent((accepted) => engine.handleSessionEvent(accepted));
    service.handleEvent(event(session.id, 1, "turn_complete", {}));
    service.handleEvent(event(session.id, 4, "state", { state: "idle" }));
    expect(store.getRunStep(step.id)?.state).toBe("succeeded");

    const settledRun = store.getRun(run.id)!;
    const settledStep = store.getRunStep(step.id)!;
    store.updateNotificationPreference(session.id, session.id, true);
    const listener = vi.fn();
    service.onSessionEvent(listener);
    expect(
      service.dispatch(session.nodeId, {
        type: "prompt",
        sessionId: session.id,
        prompt: "direct follow-up",
        attachments: [],
      }),
    ).toEqual({ sent: true });
    expect(store.getSessionDispatchAttempt(session.id)).toMatchObject({
      eventSeqFrom: 4,
      attempt: `session:${session.id}`,
    });

    service.handleEvent(event(session.id, 3, "state", { state: "running" }));
    expect(store.getSession(session.id)?.state).toBe("idle");
    expect(listener).not.toHaveBeenCalled();

    service.handleEvent(event(session.id, 5, "state", { state: "running" }));
    service.handleEvent(
      event(session.id, 6, "permission", { requestId: "direct-permission" }),
    );
    service.handleEvent(
      event(session.id, 7, "permission_result", {
        requestId: "direct-permission",
        outcome: "allow",
      }),
    );
    service.handleEvent(event(session.id, 8, "turn_complete", {}));
    service.handleEvent(event(session.id, 9, "state", { state: "idle" }));

    expect(listener).toHaveBeenCalledTimes(5);
    expect(store.getSession(session.id)?.state).toBe("idle");
    expect(store.getRunStep(step.id)).toMatchObject({
      state: settledStep.state,
      attempts: settledStep.attempts,
      eventSeqFrom: settledStep.eventSeqFrom,
      output: settledStep.output,
    });
    expect(store.getRun(run.id)).toMatchObject({
      state: settledRun.state,
      settleSeq: settledRun.settleSeq,
      wakeSeq: settledRun.wakeSeq,
    });
    expect(
      store
        .listNotifications()
        .notifications.find((notification) => notification.kind === "permission_request"),
    ).toMatchObject({ status: "resolved", readAt: expect.any(String) });
    expect(
      store
        .listNotifications()
        .notifications.find((notification) => notification.kind === "agent_completion"),
    ).toMatchObject({
      status: "active",
      data: { attempt: `session:${session.id}` },
      navigation: { type: "session", sessionId: session.id },
    });
    expect(store.getSessionTurnCompletion(session.id)).toBeUndefined();
  });

  it("keeps streamed output off notification transactions and unread reads", () => {
    const { store, service, session } = world();
    const commit = vi.spyOn(service.notifications, "commitAtomically");
    const unread = vi.spyOn(store, "notificationUnreadCount");

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      expect(
        service.handleEvent(
          event(session.id, sequence, "agent_text", { text: `chunk ${sequence}` }, at(1)),
        ),
      ).toBe(true);
    }

    expect(store.listEvents(session.id)).toHaveLength(100);
    expect(store.listNotifications().notifications).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
    expect(unread).not.toHaveBeenCalled();
  });

  it("notifies listeners only for persisted, readable, accepted events", () => {
    const { store, service, session } = world();
    const listener = vi.fn();
    service.onSessionEvent(listener);

    service.handleEvent(event("missing", 1, "agent_text", { text: "ignored" }));
    service.handleEvent(event(session.id, 1, "state", { state: "not-a-state" }));
    expect(listener).not.toHaveBeenCalled();

    const queued = store.createSession(
      store.getPlacement(session.placementId)!,
      "queued",
    );
    service.handleEvent(event(queued.id, 1, "state", { state: "idle" }));
    expect(listener).not.toHaveBeenCalled();

    const accepted = event(session.id, 2, "agent_text", { text: "accepted" });
    service.handleEvent(accepted);
    service.handleEvent(accepted);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("broadcastHostUrl", () => {
  it("tells a node that can follow the Host where it went", () => {
    const { service, enroll } = setup();
    const node = enroll("new-node", ["copilot-acp", HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(1);
    expect(node.sent).toEqual([
      { type: "host_url", hostUrl: "https://two.trycloudflare.com" },
    ]);
  });

  it("says nothing to a node whose agent predates the message", () => {
    // An older agent validates every frame against its own copy of the message
    // union and closes the socket on anything it does not recognise, so sending
    // this would cost it the connection this feature exists to preserve — and
    // it would reconnect and lose it again, forever.
    const { service, enroll } = setup();
    const older = enroll("older-node", ["copilot-acp", "host-yolo"]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(0);
    expect(older.sent).toEqual([]);
  });

  it("reaches only the capable half of a mixed fleet", () => {
    const { service, enroll } = setup();
    const older = enroll("older-node", ["copilot-acp"]);
    const newer = enroll("new-node", [HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(1);
    expect(older.sent).toEqual([]);
    expect(newer.sent).toHaveLength(1);
  });

  it("refuses to send an address a node could never authenticate to", () => {
    // Checked here as well as where the address is chosen, because this is the
    // one mistake that cannot be taken back: a node that follows a Dev Tunnels
    // URL meets a Microsoft login, cannot reach the Host, and so cannot be told
    // to go anywhere else.
    const { service, enroll } = setup();
    const node = enroll("new-node", [HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("https://hqn74pr4-8790.usw2.devtunnels.ms")).toBe(0);
    expect(node.sent).toEqual([]);
  });

  it("refuses an address that names the Host's own machine", () => {
    const { service, enroll } = setup();
    const node = enroll("new-node", [HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("http://127.0.0.1:8790")).toBe(0);
    expect(node.sent).toEqual([]);
  });
});

describe("announceNodeName", () => {
  it("tells a node the name a browser gave it", () => {
    const { store, service, enroll } = setup();
    const node = enroll("weili-pc", ["copilot-acp", NODE_NAME_SYNC_CAPABILITY]);
    store.renameNode(node.nodeId, "build-01");

    expect(service.announceNodeName(node.nodeId, "build-01")).toBe(true);
    expect(node.sent).toEqual([{ type: "node_name", name: "build-01" }]);
  });

  it("says nothing to a node whose agent predates the message", () => {
    // Same hazard as `host_url`: an older agent hangs up on a frame its copy of
    // the union does not have, so a label change would cost it its connection.
    const { service, enroll } = setup();
    const older = enroll("weili-pc", ["copilot-acp"]);

    expect(service.announceNodeName(older.nodeId, "build-01")).toBe(false);
    expect(older.sent).toEqual([]);
  });

  it("reports nothing sent when the node is offline", () => {
    const { store, service } = setup();
    const { node } = store.registerNode({
      name: "offline-node",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: [NODE_NAME_SYNC_CAPABILITY],
      maxSessions: 1,
    });

    expect(service.announceNodeName(node.id, "build-01")).toBe(false);
  });
});

describe("requestUpdate", () => {
  it("asks a stale node to update itself", () => {
    const { service, enroll } = setup("host2222");
    const node = enroll("devbox", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");

    expect(service.requestUpdate(node.nodeId)).toEqual({ started: true });
    expect(node.sent.map((frame) => frame.type)).toEqual(["update_node"]);
  });

  it("refuses a node whose build cannot be updated remotely", () => {
    // The frame is not in that agent's copy of the message union, so sending it
    // would close the socket instead of updating the machine.
    const { service, enroll } = setup("host2222");
    const older = enroll("older", ["copilot-acp"], "node1111");

    const result = service.requestUpdate(older.nodeId);
    expect(result.started).toBe(false);
    expect(result.reason).toContain("by hand");
    expect(older.sent).toEqual([]);
  });

  it("refuses to restart a node out from under a running session", () => {
    // An update restarts the process and every agent it hosts dies with it, so
    // one click on "Update all" must not cost a colleague their running turn.
    const { store, service, enroll } = setup("host2222");
    const node = enroll("busy", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.nodeId, "C:\\repo");
    store.createSession(placement, "mid-flight");

    const result = service.requestUpdate(node.nodeId);
    expect(result.started).toBe(false);
    expect(result.reason).toContain("session");
    // Named, so a browser can offer to stop them rather than only complaining.
    expect(result.blockedBy?.map((session) => session.initialPrompt)).toEqual([
      "mid-flight",
    ]);
    expect(node.sent).toEqual([]);
  });

  it("stops the sessions in the way when told to", () => {
    // The operator has seen what is running and decided; the stop goes first so
    // each agent ends deliberately rather than dying with the process.
    const { store, service, enroll } = setup("host2222");
    const node = enroll("busy", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.nodeId, "C:\\repo");
    const session = store.createSession(placement, "mid-flight");

    expect(service.requestUpdate(node.nodeId, { stopSessions: true })).toEqual({
      started: true,
    });
    const sent = node.sent.map((frame) => frame.command?.type ?? frame.type);
    expect(sent).toEqual(["stop", "update_node"]);
    service.handleEvent({
      eventId: "update-stop",
      sessionId: session.id,
      sequence: 1,
      type: "state",
      payload: { state: "failed" },
      createdAt: new Date().toISOString(),
    });
    expect(store.listNotifications().notifications).toEqual([]);
  });

  it("lists only the nodes that are actually behind", () => {
    const { service, enroll } = setup("host2222");
    const stale = enroll("stale", [SELF_UPDATE_CAPABILITY], "node1111");
    enroll("current", [SELF_UPDATE_CAPABILITY], "host2222");
    // No revision on either side is not evidence of being behind.
    enroll("unknown", [SELF_UPDATE_CAPABILITY], "");

    expect(service.staleNodeIds()).toEqual([stale.nodeId]);
  });
});

describe("settleUpdateOnReconnect", () => {
  /** Enrols a node with an update already in flight and a browser watching. */
  function updating() {
    const { service, enroll } = setup("host2222");
    const node = enroll("devbox", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");
    const browser = fakeSocket();
    service.addBrowser(browser.socket);
    service.requestUpdate(node.nodeId);
    const stages = () =>
      browser.sent.filter((frame) => frame.type === "node_update").map((f) => f.stage);
    return { service, node, browser, stages };
  }

  it("finishes the update the node was never able to report on", () => {
    const { service, node, browser, stages } = updating();
    // "restarting" is the node's last word — it exits on the next line, so
    // without the Host noticing the return, the browser renders it forever.
    service.publishNodeUpdate(node.nodeId, "restarting", "Updated to abcdef123456");

    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");

    expect(stages()).toEqual(["checking", "restarting", "up_to_date"]);
    // The revision it came back on is what the operator wanted to know.
    expect(browser.sent.at(-1)?.detail).toBe("Updated to abcdef123456");
  });

  it("stays silent when a node reconnects for any other reason", () => {
    // Tunnels drop and machines wake up; neither is an update finishing.
    const { service, enroll } = setup("host2222");
    const node = enroll("devbox", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");
    const browser = fakeSocket();
    service.addBrowser(browser.socket);

    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");

    expect(browser.sent).toEqual([]);
  });

  it("settles an update once, however often the node reconnects", () => {
    const { service, node, browser } = updating();
    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");
    browser.sent.length = 0;

    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");

    expect(browser.sent).toEqual([]);
  });

  it("does not reopen an update that already failed", () => {
    // A failure is a conclusion. The node still comes back — it never left —
    // and that return must not overwrite the reason with a success.
    const { service, node, browser } = updating();
    service.publishNodeUpdate(node.nodeId, "failed", "A watcher owns this process");
    browser.sent.length = 0;

    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");

    expect(browser.sent).toEqual([]);
  });

  it("still concludes when the node cannot name a revision", () => {
    const { service, node, browser, stages } = updating();

    service.settleUpdateOnReconnect(node.nodeId, undefined);

    expect(stages()).toEqual(["checking", "up_to_date"]);
    expect(browser.sent.at(-1)?.detail).toBe("Update finished");
  });
});

describe("host revision", () => {
  it("follows a commit made while the Host kept running", () => {
    // The reported bug: an update that worked still showed "Update available".
    // Committing moves HEAD without touching a file, so nothing restarts the
    // Host; a revision captured at construction then disagreed with the node
    // that had just landed on the real HEAD, and pressing update again re-landed
    // the same commit — so the badge could never clear.
    let head = "aaaaaaaaaaaa";
    const { service, enroll } = setup(() => head);
    enroll("box", [SELF_UPDATE_CAPABILITY], "bbbbbbbbbbbb");

    expect(service.staleNodeIds()).toHaveLength(1);
    head = "bbbbbbbbbbbb";
    expect(service.staleNodeIds()).toEqual([]);
    expect(service.snapshot().hostRevision).toBe("bbbbbbbbbbbb");
  });

  it("still accepts a fixed revision", () => {
    const { service } = setup("cccccccccccc");
    expect(service.snapshot().hostRevision).toBe("cccccccccccc");
  });
});

describe("agentFor", () => {
  const orchestrator = { runRole: "lead" as const };
  const carries = { agents: [{ name: "fleet-orchestrator", description: "" }] };

  it("puts an orchestrator into the agent its machine carries", () => {
    const { service } = setup();
    expect(service.agentFor(orchestrator, carries)).toBe("fleet-orchestrator");
  });

  it.each(["worker", "reviewer", ""] as const)(
    "gives a %s session no agent at all",
    (runRole) => {
      /*
       * The same role gate as the MCP server: a worker is not denied an agent,
       * it is never given one, so no picker appears and there is nothing to ask
       * for. The catalog being present on the machine changes nothing.
       */
      const { service } = setup();
      expect(service.agentFor({ runRole }, carries)).toBe("");
    },
  );

  it("starts an ordinary lead on a machine that carries nothing", () => {
    // A Node too old for the catalog is stale, not broken. A lead steered by
    // its briefing alone is worth more than no orchestrator at all.
    const { service } = setup();
    expect(service.agentFor(orchestrator, { agents: [] })).toBe("");
  });

  it("does not settle for a different agent the machine happens to have", () => {
    const { service } = setup();
    const other = { agents: [{ name: "something-else", description: "" }] };
    expect(service.agentFor(orchestrator, other)).toBe("");
  });
});

/*
 * Mode is not a preference for a session the fleet drives, and the failure it
 * prevents was seen in the wild: an orchestrator left in Copilot's autopilot
 * had nothing to do between wakes, and spent the difference calling
 * `task_complete` over and over trying to end a turn nobody had started.
 */
describe("what a session starts on", () => {
  it("pins a fleet-driven session to agent mode", () => {
    const { service } = setup();

    for (const runRole of ["lead", "worker"] as const) {
      expect(service.startupConfigFor({ runRole })).toContainEqual({
        id: "mode",
        value: "agent",
      });
    }
  });

  it("leaves a hand-made session's mode alone", () => {
    // Plan mode is a reasonable thing for a person to want in their own
    // session. It is only wrong where the fleet is the one driving.
    const { service } = setup();

    expect(service.startupConfigFor({ runRole: "" })).toEqual([]);
  });

  it("says nothing about the model until somebody has an opinion", () => {
    const { service } = setup();

    expect(service.startupConfigFor({ runRole: "" })).toEqual([]);
  });

  it("carries the fleet's default model and effort to every session", () => {
    const { store, service } = setup();
    store.setDefaultModel("claude-opus-5");
    store.setDefaultReasoningEffort("xhigh");

    expect(service.startupConfigFor({ runRole: "" })).toEqual([
      { id: "model", value: "claude-opus-5" },
      { id: "reasoning_effort", value: "xhigh" },
    ]);
  });
});

/**
 * The whole point of Chats, checked end to end.
 *
 * The route tests prove the placement exists; this proves the working directory
 * the Node is actually told to start in is the machine's home directory, which
 * is the one fact an operator would notice being wrong.
 */
describe("a session started in Chats", () => {
  it("is dispatched to the node's home directory", () => {
    const store = new FleetStore(":memory:");
    const service = new FleetService(store, silentLog, "");
    const { node } = store.registerNode({
      name: "box",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 2,
      homeDir: "C:\\Users\\weili",
    });
    const wire = fakeSocket();
    service.attachNode(node.id, wire.socket);
    store.setNodeOnline(node.id, true, 0);

    const chat = store.chatPlacementFor(node.id)!;
    const result = service.createAndStartSession({
      placement: chat,
      prompt: "what is a monad",
      yolo: false,
    });

    expect(result.ok).toBe(true);
    const start = wire.sent.find((frame) => frame.command?.type === "start_session");
    expect(start).toMatchObject({
      command: { localPath: "C:\\Users\\weili" },
    });
    expect(store.getSession(result.ok ? result.session.id : "")?.workspaceName).toBe(
      CHATS_WORKSPACE_NAME,
    );
  });
});
