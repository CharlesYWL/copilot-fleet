import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserMessage,
  FleetSession,
  Notification,
  SessionEvent,
  Snapshot,
} from "@fleet/protocol";
import { RunSchema } from "@fleet/protocol";
import { useFleet } from "./useFleet";
import { csrfToken, forgetCsrfToken } from "../lib/auth";

const ISO = "2026-09-01T18:00:00.000Z";

const notification = (
  id: string,
  overrides: Partial<Notification> = {},
): Notification => ({
  id,
  sourceKey: `source:${id}`,
  category: "agent_lifecycle",
  kind: "agent_completion",
  severity: "info",
  status: "active",
  title: `Notification ${id}`,
  body: "Safe summary",
  subject: { type: "session", id: "s1", label: "Agent one" },
  navigation: { type: "session", sessionId: "s1" },
  data: {},
  createdAt: ISO,
  updatedAt: ISO,
  readAt: null,
  dismissedAt: null,
  resolvedAt: null,
  ...overrides,
});

const snapshot = (
  notifications: Notification[] = [],
  notificationUnreadCount = 0,
): Snapshot => ({
  nodes: [],
  workspaces: [],
  placements: [],
  sessions: [],
  runs: [],
  notifications,
  notificationUnreadCount,
  hostRevision: "abc",
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: BrowserMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  open(): void {
    this.onopen?.();
  }

  disconnect(): void {
    this.onclose?.();
  }
}

const json = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(async () => {
  forgetCsrfToken();
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string | URL | Request) => {
      if (String(path) === "/api/auth/csrf") return json({ csrfToken: "proof" });
      if (String(path) === "/api/snapshot") return json(snapshot());
      if (String(path) === "/api/runs") {
        return json({ stepsByRunId: {}, notesByRunId: {} });
      }
      throw new Error(`Unexpected fetch ${String(path)}`);
    }),
  );
  await csrfToken();
});

afterEach(() => {
  forgetCsrfToken();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useFleet durable notifications", () => {
  it("hydrates live checkpoints without refetching or dropping them for an older run message", () => {
    const { result } = renderHook(() => useFleet(vi.fn()));
    const run = RunSchema.parse({
      id: "task",
      workspaceId: "workspace",
      name: "Task",
      objective: "Ship",
      state: "running",
      createdAt: ISO,
      updatedAt: ISO,
    });
    const note = {
      id: "checkpoint",
      runId: run.id,
      phaseIndex: 0,
      createdAt: ISO,
      summary: "PR opened.",
      body: "Full evidence",
      kind: "progress" as const,
      source: "orchestrator" as const,
    };
    const socket = MockWebSocket.instances[0]!;
    const calls = vi.mocked(fetch).mock.calls.length;
    act(() => socket.send({ type: "run", run, notes: [note] }));
    expect(result.current.runNotes[run.id]).toEqual([note]);
    act(() => socket.send({ type: "run", run }));
    expect(result.current.runNotes[run.id]).toEqual([note]);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  });

  it("does not let a delayed REST response erase a newer live checkpoint", async () => {
    let finish: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((path) => {
      if (String(path) === "/api/snapshot") return json(snapshot());
      if (String(path) === "/api/runs")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      throw new Error(`Unexpected fetch ${String(path)}`);
    });
    const { result } = renderHook(() => useFleet(vi.fn()));
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    await waitFor(() => expect(finish).toBeDefined());
    const run = RunSchema.parse({
      id: "task",
      workspaceId: "workspace",
      name: "Task",
      objective: "Ship",
      state: "running",
      createdAt: ISO,
      updatedAt: ISO,
    });
    const note = {
      id: "live",
      runId: run.id,
      phaseIndex: 0,
      createdAt: ISO,
      body: "New live report",
      summary: "New checkpoint.",
    };
    act(() => MockWebSocket.instances[0]!.send({ type: "run", run, notes: [note] }));
    await act(async () => {
      finish!(response({ stepsByRunId: {}, notesByRunId: { [run.id]: [] } }));
      await refreshing;
    });
    expect(result.current.runNotes[run.id]).toEqual([note]);
  });

  it("reuses the session prompt/resume operation key on retry, without sending a trust flag", async () => {
    const { result } = renderHook(() => useFleet(vi.fn()));
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).endsWith("/prompt") || String(path).endsWith("/resume")) {
        calls.push({ path: String(path), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ error: "Receipt unknown" }), {
          status: calls.length % 2 ? 409 : 202,
        });
      }
      return response({});
    });
    for (const kind of ["prompt", "resume"]) {
      await act(async () => {
        await result.current.command(
          `/api/sessions/worker/${kind}`,
          kind === "prompt" ? { prompt: "Manual fix" } : undefined,
        );
        await result.current.command(
          `/api/sessions/worker/${kind}`,
          kind === "prompt" ? { prompt: "Manual fix" } : undefined,
        );
      });
    }
    expect(calls[0]!.body.operationId).toEqual(calls[1]!.body.operationId);
    expect(calls[2]!.body.operationId).toEqual(calls[3]!.body.operationId);
    expect(calls[0]!.body).toEqual({
      prompt: "Manual fix",
      operationId: expect.any(String),
    });
    expect(calls[2]!.body).toEqual({ operationId: expect.any(String) });
  });
  it("advances snapshot revisions for registry refresh without requiring a changed task", () => {
    const { result } = renderHook(() => useFleet(vi.fn()));
    const socket = MockWebSocket.instances[0]!;
    expect(result.current.snapshotRevision).toBe(0);
    act(() => socket.send({ type: "snapshot", data: snapshot() }));
    expect(result.current.snapshotRevision).toBe(1);
    act(() => socket.send({ type: "snapshot", data: snapshot() }));
    expect(result.current.snapshotRevision).toBe(2);
    act(() => socket.send({ type: "notification_unread_count", unreadCount: 1 }));
    expect(result.current.snapshotRevision).toBe(2);
  });

  it("reports connection loss once per outage and reports recovery, but not initial connection or unmount", async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const { unmount } = renderHook(() => useFleet(notify));
    const first = MockWebSocket.instances[0]!;
    await act(async () => first.open());
    expect(notify).not.toHaveBeenCalled();

    act(() => first.disconnect());
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Connection to the Host lost. Live updates are paused while reconnecting.",
      "warning",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const second = MockWebSocket.instances[1]!;
    act(() => second.disconnect());
    expect(notify).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const third = MockWebSocket.instances[2]!;
    await act(async () => third.open());
    expect(notify).toHaveBeenLastCalledWith("Connection to the Host restored.", "info");
    expect(notify).toHaveBeenCalledTimes(2);

    unmount();
    act(() => third.disconnect());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("hydrates notifications and unread count without treating them as live delivery", () => {
    const notify = vi.fn();
    const { result, rerender } = renderHook(({ onNotify }) => useFleet(onNotify), {
      initialProps: { onNotify: notify },
    });
    const socket = MockWebSocket.instances[0]!;
    const hydrated = notification("hydrated");

    act(() => {
      socket.send({
        type: "snapshot",
        data: snapshot([hydrated], 1),
      });
    });

    expect(result.current.snapshot.notifications).toEqual([hydrated]);
    expect(result.current.snapshot.notificationUnreadCount).toBe(1);
    expect(result.current.liveNotificationUpdates).toEqual([]);

    rerender({ onNotify: vi.fn() });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("upserts records, updates the count, and only queues newly inserted live records", () => {
    const { result } = renderHook(() => useFleet(vi.fn()));
    const socket = MockWebSocket.instances[0]!;
    const existing = notification("existing");
    const inserted = notification("inserted", {
      createdAt: "2026-09-01T19:00:00.000Z",
      updatedAt: "2026-09-01T19:00:00.000Z",
    });

    act(() => {
      socket.send({ type: "snapshot", data: snapshot([existing], 1) });
      socket.send({
        type: "notification_upsert",
        notification: { ...existing, readAt: ISO },
      });
      socket.send({ type: "notification_upsert", notification: inserted });
      socket.send({ type: "notification_unread_count", unreadCount: 1 });
    });

    expect(result.current.snapshot.notifications.map((item) => item.id)).toEqual([
      "inserted",
      "existing",
    ]);
    expect(result.current.snapshot.notifications[1]?.readAt).toBe(ISO);
    expect(result.current.snapshot.notificationUnreadCount).toBe(1);
    expect(result.current.liveNotificationUpdates).toEqual([
      {
        sequence: 1,
        notification: { ...existing, readAt: ISO },
        deliver: false,
      },
      { sequence: 2, notification: inserted, deliver: true },
    ]);
  });

  it("replays websocket notification changes over a slower REST hydration", async () => {
    let resolveSnapshot!: (value: Response) => void;
    const pendingSnapshot = new Promise<Response>((resolve) => {
      resolveSnapshot = resolve;
    });
    vi.mocked(fetch).mockImplementation((path: string | URL | Request) => {
      if (String(path) === "/api/snapshot") return pendingSnapshot;
      if (String(path) === "/api/runs") {
        return json({ stepsByRunId: {}, notesByRunId: {} });
      }
      throw new Error(`Unexpected fetch ${String(path)}`);
    });

    const { result } = renderHook(() => useFleet(vi.fn()));
    const socket = MockWebSocket.instances[0]!;
    const existing = notification("existing");
    const resolved = notification("existing", {
      status: "resolved",
      updatedAt: "2026-09-01T19:00:00.000Z",
      resolvedAt: "2026-09-01T19:00:00.000Z",
    });

    act(() => {
      socket.send({ type: "snapshot", data: snapshot([existing], 1) });
      socket.open();
      socket.send({ type: "notification_upsert", notification: resolved });
      socket.send({ type: "notification_unread_count", unreadCount: 2 });
    });
    await act(async () => {
      resolveSnapshot(response(snapshot([], 0)));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.snapshot.notifications).toEqual([resolved]);
    expect(result.current.snapshot.notificationUnreadCount).toBe(2);

    act(() => {
      socket.send({ type: "notification_upsert", notification: resolved });
    });
    expect(result.current.liveNotificationUpdates).toEqual([
      { sequence: 1, notification: resolved, deliver: false },
      { sequence: 2, notification: resolved, deliver: false },
    ]);
  });

  it("applies only mark-all rows returned by the Host and preserves a raced count", async () => {
    let resolveMarkAll!: (value: Response) => void;
    const pendingMarkAll = new Promise<Response>((resolve) => {
      resolveMarkAll = resolve;
    });
    vi.mocked(fetch).mockImplementation((path: string | URL | Request) => {
      if (String(path) === "/api/notifications/read-all") return pendingMarkAll;
      if (String(path) === "/api/snapshot") return json(snapshot());
      if (String(path) === "/api/runs") {
        return json({ stepsByRunId: {}, notesByRunId: {} });
      }
      throw new Error(`Unexpected fetch ${String(path)}`);
    });

    const { result } = renderHook(() => useFleet(vi.fn()));
    const socket = MockWebSocket.instances[0]!;
    const before = notification("before");
    const arrival = notification("arrival", {
      createdAt: "2026-09-01T19:30:00.000Z",
      updatedAt: "2026-09-01T19:30:00.000Z",
    });
    const marked = notification("before", {
      readAt: "2026-09-01T19:15:00.000Z",
      updatedAt: "2026-09-01T19:15:00.000Z",
    });

    act(() => {
      socket.send({ type: "snapshot", data: snapshot([before], 1) });
    });
    let completed!: Promise<boolean>;
    act(() => {
      completed = result.current.markAllNotificationsRead();
    });
    act(() => {
      socket.send({ type: "notification_upsert", notification: arrival });
      socket.send({ type: "notification_unread_count", unreadCount: 1 });
    });
    await act(async () => {
      resolveMarkAll(
        response({
          updated: 1,
          notifications: [marked],
          unreadCount: 0,
        }),
      );
      await completed;
    });

    expect(result.current.snapshot.notifications).toEqual([arrival, marked]);
    expect(result.current.snapshot.notifications[1]?.readAt).toBe(
      "2026-09-01T19:15:00.000Z",
    );
    expect(result.current.snapshot.notificationUnreadCount).toBe(1);
  });

  it("accepts a mark-read count across a resolution-only upsert", async () => {
    let resolveMarkRead!: (value: Response) => void;
    const pendingMarkRead = new Promise<Response>((resolve) => {
      resolveMarkRead = resolve;
    });
    vi.mocked(fetch).mockImplementation((path: string | URL | Request) => {
      if (String(path) === "/api/notifications/item/read") return pendingMarkRead;
      if (String(path) === "/api/snapshot") return json(snapshot());
      if (String(path) === "/api/runs") {
        return json({ stepsByRunId: {}, notesByRunId: {} });
      }
      throw new Error(`Unexpected fetch ${String(path)}`);
    });

    const { result } = renderHook(() => useFleet(vi.fn()));
    const socket = MockWebSocket.instances[0]!;
    const before = notification("item");
    const resolved = notification("item", {
      status: "resolved",
      updatedAt: "2026-09-01T19:00:00.000Z",
      resolvedAt: "2026-09-01T19:00:00.000Z",
    });
    const marked = {
      ...resolved,
      readAt: "2026-09-01T19:15:00.000Z",
      updatedAt: "2026-09-01T19:15:00.000Z",
    };

    act(() => {
      socket.send({ type: "snapshot", data: snapshot([before], 1) });
    });
    let completed!: Promise<boolean>;
    act(() => {
      completed = result.current.markNotificationRead("item");
    });
    act(() => {
      socket.send({ type: "notification_upsert", notification: resolved });
    });
    await act(async () => {
      resolveMarkRead(response({ notification: marked, unreadCount: 0 }));
      await completed;
    });

    expect(result.current.snapshot.notifications).toEqual([marked]);
    expect(result.current.snapshot.notificationUnreadCount).toBe(0);
  });

  it("accepts a mark-all count across resolution-only upserts", async () => {
    let resolveMarkAll!: (value: Response) => void;
    const pendingMarkAll = new Promise<Response>((resolve) => {
      resolveMarkAll = resolve;
    });
    vi.mocked(fetch).mockImplementation((path: string | URL | Request) => {
      if (String(path) === "/api/notifications/read-all") return pendingMarkAll;
      if (String(path) === "/api/snapshot") return json(snapshot());
      if (String(path) === "/api/runs") {
        return json({ stepsByRunId: {}, notesByRunId: {} });
      }
      throw new Error(`Unexpected fetch ${String(path)}`);
    });

    const { result } = renderHook(() => useFleet(vi.fn()));
    const socket = MockWebSocket.instances[0]!;
    const before = notification("item");
    const resolved = notification("item", {
      status: "resolved",
      updatedAt: "2026-09-01T19:00:00.000Z",
      resolvedAt: "2026-09-01T19:00:00.000Z",
    });
    const marked = {
      ...resolved,
      readAt: "2026-09-01T19:15:00.000Z",
      updatedAt: "2026-09-01T19:15:00.000Z",
    };

    act(() => {
      socket.send({ type: "snapshot", data: snapshot([before], 1) });
    });
    let completed!: Promise<boolean>;
    act(() => {
      completed = result.current.markAllNotificationsRead();
    });
    act(() => {
      socket.send({ type: "notification_upsert", notification: resolved });
    });
    await act(async () => {
      resolveMarkAll(
        response({
          updated: 1,
          notifications: [marked],
          unreadCount: 0,
        }),
      );
      await completed;
    });

    expect(result.current.snapshot.notifications).toEqual([marked]);
    expect(result.current.snapshot.notificationUnreadCount).toBe(0);
  });

  it("does not resurrect a notification from a delayed mark-read after REST hydration removed it", async () => {
    let resolveMarkRead!: (value: Response) => void;
    const pendingMarkRead = new Promise<Response>((resolve) => {
      resolveMarkRead = resolve;
    });
    vi.mocked(fetch).mockImplementation((path: string | URL | Request) => {
      if (String(path) === "/api/notifications/item/read") return pendingMarkRead;
      if (String(path) === "/api/snapshot") return json(snapshot([], 0));
      if (String(path) === "/api/runs") {
        return json({ stepsByRunId: {}, notesByRunId: {} });
      }
      throw new Error(`Unexpected fetch ${String(path)}`);
    });

    const { result } = renderHook(() => useFleet(vi.fn()));
    const socket = MockWebSocket.instances[0]!;
    const before = notification("item");
    const staleMarked = notification("item", {
      readAt: "2026-09-01T18:30:00.000Z",
      updatedAt: "2026-09-01T18:30:00.000Z",
    });

    act(() => {
      socket.send({ type: "snapshot", data: snapshot([before], 1) });
    });
    let completed!: Promise<boolean>;
    act(() => {
      completed = result.current.markNotificationRead("item");
    });
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      resolveMarkRead(response({ notification: staleMarked, unreadCount: 0 }));
      await completed;
    });

    expect(result.current.snapshot.notifications).toEqual([]);
    expect(result.current.snapshot.notificationUnreadCount).toBe(0);
  });

  it("does not let a delayed dismiss overwrite a newer REST hydration", async () => {
    let resolveDismiss!: (value: Response) => void;
    const pendingDismiss = new Promise<Response>((resolve) => {
      resolveDismiss = resolve;
    });
    const resolved = notification("item", {
      status: "resolved",
      updatedAt: "2026-09-01T20:00:00.000Z",
      resolvedAt: "2026-09-01T20:00:00.000Z",
    });
    vi.mocked(fetch).mockImplementation((path: string | URL | Request) => {
      if (String(path) === "/api/notifications/item/dismiss") return pendingDismiss;
      if (String(path) === "/api/snapshot") return json(snapshot([resolved], 1));
      if (String(path) === "/api/runs") {
        return json({ stepsByRunId: {}, notesByRunId: {} });
      }
      throw new Error(`Unexpected fetch ${String(path)}`);
    });

    const { result } = renderHook(() => useFleet(vi.fn()));
    const socket = MockWebSocket.instances[0]!;
    const before = notification("item");
    const staleDismissed = notification("item", {
      status: "dismissed",
      updatedAt: "2026-09-01T19:00:00.000Z",
      dismissedAt: "2026-09-01T19:00:00.000Z",
    });

    act(() => {
      socket.send({ type: "snapshot", data: snapshot([before], 1) });
    });
    let completed!: Promise<boolean>;
    act(() => {
      completed = result.current.dismissNotification("item");
    });
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      resolveDismiss(response({ notification: staleDismissed, unreadCount: 0 }));
      await completed;
    });

    expect(result.current.snapshot.notifications).toEqual([resolved]);
    expect(result.current.snapshot.notificationUnreadCount).toBe(1);
  });

  it("rehydrates after reconnect without replaying missed records as live delivery", async () => {
    vi.useFakeTimers();
    const missed = notification("missed");
    vi.mocked(fetch).mockImplementation((path: string | URL | Request) => {
      if (String(path) === "/api/snapshot") return json(snapshot([missed], 1));
      if (String(path) === "/api/runs") {
        return json({ stepsByRunId: {}, notesByRunId: {} });
      }
      throw new Error(`Unexpected fetch ${String(path)}`);
    });
    const { result } = renderHook(() => useFleet(vi.fn()));
    const first = MockWebSocket.instances[0]!;

    act(() => first.disconnect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const second = MockWebSocket.instances[1]!;
    await act(async () => {
      second.open();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.snapshot.notifications.map((item) => item.id)).toEqual([
      "missed",
    ]);
    expect(result.current.liveNotificationUpdates).toEqual([]);
  });

  it("does not emit legacy failure or permission alerts from session updates", () => {
    const notify = vi.fn();
    const { result } = renderHook(() => useFleet(notify));
    const socket = MockWebSocket.instances[0]!;
    const failed = {
      id: "s1",
      state: "failed",
      nodeName: "node",
      currentActivity: "failed",
    } as FleetSession;
    const permission = {
      eventId: "e1",
      sessionId: "s1",
      sequence: 1,
      type: "permission",
      payload: { requestId: "p1", title: "Run command" },
      createdAt: ISO,
    } as SessionEvent;

    act(() => {
      socket.send({ type: "snapshot", data: snapshot() });
      socket.send({ type: "session", session: failed });
      socket.send({ type: "event", event: permission });
    });

    expect(notify).not.toHaveBeenCalled();
    expect(result.current.liveNotificationUpdates).toEqual([]);
  });
});
