import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  type MarkAllNotificationsReadResponse,
  type BrowserMessage,
  type Notification,
  type NodeUpdateStage,
  type RunStep,
  type RunNote,
  type SessionEvent,
  type Snapshot,
} from "@fleet/protocol";
import { announceSignedOut } from "../lib/auth";
import { reconnectDelay } from "./reconnect-delay";
import { mergeEvents } from "../lib/merge-events";

export type { Snapshot };

export type Notify = (message: string, intent?: "error" | "success") => void;

export type LiveNotificationUpdate = {
  sequence: number;
  notification: Notification;
  deliver: boolean;
};

type NotificationHydrationChange =
  | { revision: number; type: "upsert"; notification: Notification }
  | { revision: number; type: "count"; unreadCount: number }
  | {
      revision: number;
      type: "snapshot";
      notifications: Notification[];
      unreadCount: number;
    };

/**
 * The outcome of one call, so a caller can tell "succeeded with no body" from
 * "failed" — a DELETE answers 204, which is indistinguishable from a thrown
 * request once both have been reduced to `undefined`.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

const emptySnapshot: Snapshot = {
  nodes: [],
  workspaces: [],
  placements: [],
  sessions: [],
  runs: [],
  notifications: [],
  notificationUnreadCount: 0,
  hostRevision: "",
};

/** The latest self-update progress per node, cleared once it settles. */
export type NodeUpdateProgress = Record<
  string,
  { stage: NodeUpdateStage; detail: string }
>;

export function useFleet(notify: Notify) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [liveNotificationUpdates, setLiveNotificationUpdates] = useState<
    LiveNotificationUpdate[]
  >([]);
  const [events, setEvents] = useState<Record<string, SessionEvent[]>>({});
  /**
   * Steps per run, kept beside the snapshot rather than inside it.
   *
   * A snapshot carries runs so a refreshed browser has something to draw, but
   * steps are the part that changes every few seconds, and they arrive whole
   * per run — so they patch by run id instead of forcing a whole snapshot.
   */
  const [runSteps, setRunSteps] = useState<Record<string, RunStep[]>>({});
  /** What the orchestrator wrote as each phase ended, per task. */
  const [runNotes, setRunNotes] = useState<Record<string, RunNote[]>>({});
  const [connected, setConnected] = useState(false);
  const [nodeUpdates, setNodeUpdates] = useState<NodeUpdateProgress>({});
  const knownNotificationIds = useRef(new Set<string>());
  const acceptsLiveNotifications = useRef(false);
  const liveNotificationSequence = useRef(0);
  const notificationRevision = useRef(0);
  const notificationRevisions = useRef(new Map<string, number>());
  const notificationRecords = useRef(new Map<string, Notification>());
  const latestUnreadAffectingUpsertRevision = useRef(0);
  const unreadCountRevision = useRef(0);
  const currentUnreadCount = useRef(0);
  const hydrationTicket = useRef(0);
  const latestHydrationTicket = useRef(0);
  const activeHydrations = useRef(new Map<number, number>());
  const hydrationChanges = useRef<NotificationHydrationChange[]>([]);

  // Kept in a ref so the socket subscription never re-runs when the caller
  // re-creates its notify callback.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const report = useCallback((reason: unknown) => {
    notifyRef.current(errorMessage(reason), "error");
  }, []);

  const recordHydrationChange = useCallback(
    (
      change:
        | Omit<Extract<NotificationHydrationChange, { type: "upsert" }>, "revision">
        | Omit<Extract<NotificationHydrationChange, { type: "count" }>, "revision">
        | Omit<Extract<NotificationHydrationChange, { type: "snapshot" }>, "revision">,
    ) => {
      const revision = ++notificationRevision.current;
      if (activeHydrations.current.size > 0) {
        hydrationChanges.current.push({ ...change, revision });
      }
      return revision;
    },
    [],
  );

  const recordNotificationUpsert = useCallback(
    (notification: Notification) => {
      const revision = recordHydrationChange({ type: "upsert", notification });
      const previous = notificationRecords.current.get(notification.id);
      notificationRecords.current.set(notification.id, notification);
      notificationRevisions.current.set(notification.id, revision);
      if (isUnreadNotification(previous) !== isUnreadNotification(notification)) {
        latestUnreadAffectingUpsertRevision.current = revision;
      }
      knownNotificationIds.current.add(notification.id);
      return revision;
    },
    [recordHydrationChange],
  );

  const recordUnreadCount = useCallback(
    (unreadCount: number) => {
      const revision = recordHydrationChange({ type: "count", unreadCount });
      unreadCountRevision.current = revision;
      currentUnreadCount.current = unreadCount;
      return revision;
    },
    [recordHydrationChange],
  );

  const hydrateSocketSnapshot = useCallback(
    (next: Snapshot) => {
      const revision = recordHydrationChange({
        type: "snapshot",
        notifications: next.notifications,
        unreadCount: next.notificationUnreadCount,
      });
      for (const notification of next.notifications) {
        knownNotificationIds.current.add(notification.id);
        notificationRevisions.current.set(notification.id, revision);
      }
      notificationRecords.current = new Map(
        next.notifications.map((notification) => [notification.id, notification]),
      );
      latestUnreadAffectingUpsertRevision.current = revision;
      unreadCountRevision.current = revision;
      currentUnreadCount.current = next.notificationUnreadCount;
      setSnapshot({
        ...next,
        notifications: sortNotifications(next.notifications),
      });
    },
    [recordHydrationChange],
  );

  const beginHydration = useCallback(() => {
    const ticket = ++hydrationTicket.current;
    latestHydrationTicket.current = ticket;
    const revision = notificationRevision.current;
    activeHydrations.current.set(ticket, revision);
    return { ticket, revision };
  }, []);

  const finishHydration = useCallback((ticket: number) => {
    activeHydrations.current.delete(ticket);
    if (activeHydrations.current.size === 0) {
      hydrationChanges.current = [];
      return;
    }
    const oldestRevision = Math.min(...activeHydrations.current.values());
    hydrationChanges.current = hydrationChanges.current.filter(
      (change) => change.revision > oldestRevision,
    );
  }, []);

  const hydrateRestSnapshot = useCallback(
    (next: Snapshot, request: { ticket: number; revision: number }) => {
      if (latestHydrationTicket.current !== request.ticket) return false;

      let notifications = next.notifications;
      let unreadCount = next.notificationUnreadCount;
      let replayedNotificationChange = false;
      let replayedUnreadCount = false;
      for (const change of hydrationChanges.current) {
        if (change.revision <= request.revision) continue;
        if (change.type === "snapshot") {
          notifications = change.notifications;
          unreadCount = change.unreadCount;
          replayedNotificationChange = true;
          replayedUnreadCount = true;
          continue;
        }
        if (change.type === "upsert") {
          notifications = mergeNotification(notifications, change.notification);
          replayedNotificationChange = true;
          continue;
        }
        unreadCount = change.unreadCount;
        replayedUnreadCount = true;
      }
      if (replayedNotificationChange && !replayedUnreadCount) {
        unreadCount = currentUnreadCount.current;
      }

      const revision = ++notificationRevision.current;
      for (const id of knownNotificationIds.current) {
        notificationRevisions.current.set(id, revision);
      }
      for (const notification of notifications) {
        knownNotificationIds.current.add(notification.id);
        notificationRevisions.current.set(notification.id, revision);
      }
      notificationRecords.current = new Map(
        notifications.map((notification) => [notification.id, notification]),
      );
      latestUnreadAffectingUpsertRevision.current = revision;
      unreadCountRevision.current = revision;
      setSnapshot({
        ...next,
        notifications: sortNotifications(notifications),
        notificationUnreadCount: unreadCount,
      });
      currentUnreadCount.current = unreadCount;
      return true;
    },
    [],
  );

  /**
   * Every write the UI makes goes through here: one call, one toast on failure,
   * a result the caller can branch on. Without it each handler grew its own
   * identical try/catch, and they drifted.
   */
  const request = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<ApiResult<T>> => {
      try {
        return { ok: true, data: await api<T>(path, init) };
      } catch (reason) {
        report(reason);
        return { ok: false, error: errorMessage(reason) };
      }
    },
    [report],
  );

  const refreshWithStatus = useCallback(async () => {
    let hydrated = false;
    const hydration = beginHydration();
    try {
      hydrated = hydrateRestSnapshot(await api<Snapshot>("/api/snapshot"), hydration);
      finishHydration(hydration.ticket);
      /*
       * Steps come from their own endpoint, not the snapshot.
       * They change often enough that carrying every one of them in the
       * snapshot would bloat it, but without this a refreshed browser shows
       * every run as "0 steps" until the next live broadcast happens to
       * arrive — which for a finished run is never.
       */
      const runs = await api<{
        stepsByRunId: Record<string, RunStep[]>;
        notesByRunId: Record<string, RunNote[]>;
      }>("/api/runs");
      setRunSteps(runs.stepsByRunId ?? {});
      setRunNotes(runs.notesByRunId ?? {});
    } catch (reason) {
      finishHydration(hydration.ticket);
      report(reason);
    }
    return hydrated;
  }, [beginHydration, finishHydration, hydrateRestSnapshot, report]);
  const refresh = useCallback(async () => {
    await refreshWithStatus();
  }, [refreshWithStatus]);

  const applyNotification = useCallback((notification: Notification) => {
    setSnapshot((value) => ({
      ...value,
      notifications: sortNotifications(
        mergeNotification(value.notifications, notification),
      ),
    }));
  }, []);

  const applyResponseNotification = useCallback(
    (notification: Notification, startedAtRevision: number) => {
      if ((notificationRevisions.current.get(notification.id) ?? 0) > startedAtRevision) {
        const current = notificationRecords.current.get(notification.id);
        if (!current || current.updatedAt.localeCompare(notification.updatedAt) >= 0) {
          return;
        }
      }
      recordNotificationUpsert(notification);
      applyNotification(notification);
    },
    [applyNotification, recordNotificationUpsert],
  );

  const applyResponseUnreadCount = useCallback(
    (unreadCount: number, startedAtRevision: number) => {
      if (
        unreadCountRevision.current > startedAtRevision ||
        latestUnreadAffectingUpsertRevision.current > startedAtRevision
      ) {
        return;
      }
      recordUnreadCount(unreadCount);
      setSnapshot((value) => ({
        ...value,
        notificationUnreadCount: unreadCount,
      }));
    },
    [recordUnreadCount],
  );

  const markNotificationRead = useCallback(
    async (id: string) => {
      const startedAtRevision = notificationRevision.current;
      const result = await request<{
        notification: Notification;
        unreadCount: number;
      }>(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
      if (!result.ok) return false;
      applyResponseUnreadCount(result.data.unreadCount, startedAtRevision);
      applyResponseNotification(result.data.notification, startedAtRevision);
      return true;
    },
    [applyResponseNotification, applyResponseUnreadCount, request],
  );

  const markAllNotificationsRead = useCallback(async () => {
    const startedAtRevision = notificationRevision.current;
    const result = await request<MarkAllNotificationsReadResponse>(
      "/api/notifications/read-all",
      { method: "POST" },
    );
    if (!result.ok) return false;
    applyResponseUnreadCount(result.data.unreadCount, startedAtRevision);
    for (const notification of result.data.notifications) {
      applyResponseNotification(notification, startedAtRevision);
    }
    return true;
  }, [applyResponseNotification, applyResponseUnreadCount, request]);

  const dismissNotification = useCallback(
    async (id: string) => {
      const startedAtRevision = notificationRevision.current;
      const result = await request<{
        notification: Notification;
        unreadCount: number;
      }>(`/api/notifications/${encodeURIComponent(id)}/dismiss`, {
        method: "POST",
      });
      if (!result.ok) return false;
      applyResponseUnreadCount(result.data.unreadCount, startedAtRevision);
      applyResponseNotification(result.data.notification, startedAtRevision);
      return true;
    },
    [applyResponseNotification, applyResponseUnreadCount, request],
  );

  // Which fetch is the current one per session. Switching sessions quickly
  // leaves earlier requests in flight, and the slowest to answer would
  // otherwise be the one that wins and paint another session's transcript.
  // The ticket settles races between fetches; mergeEvents settles the race
  // between a fetch and the socket that kept appending while it travelled.
  const eventRequests = useRef(new Map<string, number>());

  const loadEvents = useCallback(
    async (sessionId: string) => {
      const ticket = (eventRequests.current.get(sessionId) ?? 0) + 1;
      eventRequests.current.set(sessionId, ticket);
      try {
        const items = await api<SessionEvent[]>(`/api/sessions/${sessionId}/events`);
        if (eventRequests.current.get(sessionId) !== ticket) return;
        setEvents((value) => ({
          ...value,
          [sessionId]: mergeEvents(items, value[sessionId] ?? []),
        }));
      } catch (reason) {
        report(reason);
      }
    },
    [report],
  );

  const command = useCallback(
    async (path: string, body?: unknown) => {
      const result = await request(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return result.ok;
    },
    [request],
  );

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      acceptsLiveNotifications.current = false;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/ws/browser`);
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        // Anything that changed while the socket was down was never delivered,
        // so start again from the Host's current truth rather than from state
        // that stopped being updated at an arbitrary moment.
        void refreshWithStatus().then((hydrated) => {
          if (hydrated) acceptsLiveNotifications.current = true;
        });
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        // Without this the page goes permanently deaf after any restart of the
        // Host and only a manual reload brings it back.
        retryTimer = setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };
      socket.onmessage = ({ data }) => {
        const message = parseBrowserMessage(String(data));
        if (!message) {
          notifyRef.current("Malformed live update", "error");
          socket?.close(1007, "Malformed JSON");
          return;
        }
        if (message.type === "snapshot") {
          hydrateSocketSnapshot(message.data);
          acceptsLiveNotifications.current = true;
          return;
        }
        if (message.type === "node") {
          const { node } = message;
          setSnapshot((value) => ({ ...value, nodes: upsert(value.nodes, node) }));
          return;
        }
        if (message.type === "catalog") {
          const { workspaces, placements } = message;
          setSnapshot((value) => ({ ...value, workspaces, placements }));
          return;
        }
        if (message.type === "session") {
          const { session } = message;
          setSnapshot((value) => ({
            ...value,
            sessions: upsert(value.sessions, session),
          }));
          return;
        }
        if (message.type === "node_update") {
          const { nodeId, stage, detail } = message;
          setNodeUpdates((value) => {
            // A finished update is not a state the row should go on describing:
            // the toast carries the news, and dropping it lets the badge and its
            // tooltip go back to explaining what the node is. A failure stays,
            // because its reason is worth reading after the toast has gone.
            if (stage !== "up_to_date") return { ...value, [nodeId]: { stage, detail } };
            const next = { ...value };
            delete next[nodeId];
            return next;
          });
          if (stage === "failed")
            notifyRef.current(detail || "Node update failed", "error");
          if (stage === "up_to_date")
            notifyRef.current(detail || "Already up to date", "success");
          return;
        }
        if (message.type === "session_notice") {
          // The session is fine; the command was refused. Saying so is the
          // whole point — a prompt dropped in silence is indistinguishable
          // from an agent that has stopped responding.
          notifyRef.current(message.message, "error");
          return;
        }
        if (message.type === "run") {
          const incoming = message.run;
          setSnapshot((value) => {
            const known = value.runs.some((run) => run.id === incoming.id);
            return {
              ...value,
              runs: known
                ? value.runs.map((run) => (run.id === incoming.id ? incoming : run))
                : [incoming, ...value.runs],
            };
          });
          return;
        }
        if (message.type === "notification_upsert") {
          const { notification } = message;
          const inserted = !knownNotificationIds.current.has(notification.id);
          recordNotificationUpsert(notification);
          applyNotification(notification);
          setLiveNotificationUpdates((value) =>
            [
              ...value,
              {
                sequence: ++liveNotificationSequence.current,
                notification,
                deliver:
                  inserted &&
                  acceptsLiveNotifications.current &&
                  notification.status === "active",
              },
            ].slice(-200),
          );
          return;
        }
        if (message.type === "notification_unread_count") {
          recordUnreadCount(message.unreadCount);
          setSnapshot((value) => ({
            ...value,
            notificationUnreadCount: message.unreadCount,
          }));
          return;
        }
        if (message.type === "run_steps") {
          const { runId, steps } = message;
          setRunSteps((value) => ({ ...value, [runId]: steps }));
          return;
        }
        const { event } = message;
        setEvents((value) => ({
          ...value,
          [event.sessionId]: mergeEvents([event], value[event.sessionId] ?? []),
        }));
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [
    applyNotification,
    hydrateSocketSnapshot,
    recordNotificationUpsert,
    recordUnreadCount,
    refreshWithStatus,
  ]);

  return {
    snapshot,
    liveNotificationUpdates,
    events,
    runSteps,
    runNotes,
    connected,
    nodeUpdates,
    refresh,
    loadEvents,
    command,
    request,
    markNotificationRead,
    markAllNotificationsRead,
    dismissNotification,
  };
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [next, ...items];
}

function mergeNotification(
  notifications: Notification[],
  notification: Notification,
): Notification[] {
  if (notification.status === "dismissed") {
    return notifications.filter((item) => item.id !== notification.id);
  }
  return upsert(notifications, notification);
}

function isUnreadNotification(notification: Notification | undefined): boolean {
  return Boolean(
    notification && notification.readAt === null && notification.status !== "dismissed",
  );
}

function sortNotifications(notifications: Notification[]): Notification[] {
  return [...notifications].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}

function parseBrowserMessage(text: string): BrowserMessage | undefined {
  try {
    return JSON.parse(text) as BrowserMessage;
  } catch {
    return undefined;
  }
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Fastify rejects an empty body when Content-Type is application/json, so
  // only advertise JSON when we are actually sending a payload.
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    // The session ended under us — expired, or the Host restarted and forgot
    // it. Saying so once puts the sign-in screen back up rather than leaving
    // every subsequent call to fail into a toast.
    announceSignedOut();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ApiError(
      body.error ?? `${response.status} ${response.statusText}`,
      response.status,
      body,
    );
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * A failed call that still carries what the Host said.
 *
 * Reducing a refusal to its message threw away the rest of the body, which is
 * where the Host explains itself — the sessions standing in the way of an
 * update, for instance, which a caller needs if it is going to offer to do
 * something about them rather than just repeat the complaint.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
