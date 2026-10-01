import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  updateFinished,
  BrowserMessageSchema,
  decodeFrame,
  isTranscriptEvent,
  SessionPermissions,
  TRANSCRIPT_PAGE_LIMIT,
  TRANSCRIPT_PAGE_MAX,
  type CommandOutputEvent,
  type HostUpdateStatus,
  type MarkAllNotificationsReadResponse,
  type Notification,
  type NodeUpdateStage,
  type RunStep,
  type RunNote,
  type SessionEvent,
  type SessionActivity,
  type Snapshot,
  type TranscriptPage,
  type TranscriptUpdate,
} from "@fleet/protocol";
import { announceSignedOut, csrfToken, forgetCsrfToken } from "../lib/auth";
import { reconnectDelay } from "./reconnect-delay";
import { mergeEvents } from "../lib/merge-events";
import { mergeCommandExecutions, mergeCommandOutput } from "../lib/command-output";
import { mergeResumeRequests } from "../lib/worker-resume";
import { TranscriptCache, type TranscriptView } from "../lib/transcript-cache";

export type { Snapshot };

export type Notify = (
  message: string,
  intent?: "error" | "success" | "warning" | "info",
) => void;

export type LiveNotificationUpdate = {
  sequence: number;
  notification: Notification;
  deliver: boolean;
};

export type TranscriptActivity = SessionActivity & { live: boolean };
export type { TranscriptView };

/**
 * How long live events are gathered before they are applied together.
 *
 * A streaming agent sends dozens of tiny events a second; applying each on its
 * own re-rendered the whole app per chunk. Two frames is too short to read as lag.
 */
export const LIVE_FLUSH_MS = 32;
/** Recent transcript events kept per session, for monitor-wall previews only. */
const LIVE_TAIL_EVENTS = 200;
const MAX_TRANSCRIPT_RESYNCS = 3;

type LiveItem = {
  sessionId: string;
  event?: SessionEvent;
  update?: TranscriptUpdate | undefined;
  reset?: true;
};

type SnapshotHydrationChange =
  | { revision: number; type: "upsert"; notification: Notification }
  | { revision: number; type: "count"; unreadCount: number }
  | { revision: number; type: "host_update"; status: HostUpdateStatus }
  | { revision: number; type: "snapshot"; data: Snapshot };

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

/**
 * The Host update this tab saw start, so its end is announced exactly once.
 *
 * Kept in session storage rather than memory because the end usually arrives
 * after a restart: the socket drops while the Host is replaced, and under
 * `npm run dev` Vite reloads the page as well, so the first word of how it went
 * is a snapshot that a fresh page would otherwise have no reason to announce.
 */
const WATCHED_HOST_UPDATE = "copilot-fleet.watched-host-update";

function watchedHostUpdate(): string | undefined {
  try {
    return sessionStorage.getItem(WATCHED_HOST_UPDATE) ?? undefined;
  } catch {
    return undefined;
  }
}

function watchHostUpdate(updateId: string | undefined): void {
  try {
    if (updateId) sessionStorage.setItem(WATCHED_HOST_UPDATE, updateId);
    else sessionStorage.removeItem(WATCHED_HOST_UPDATE);
  } catch {
    // Without storage the announcement is lost to a reload, nothing worse.
  }
}

export function useFleet(notify: Notify) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [liveNotificationUpdates, setLiveNotificationUpdates] = useState<
    LiveNotificationUpdate[]
  >([]);
  const [events, setEvents] = useState<Record<string, SessionEvent[]>>({});
  const [activities, setActivities] = useState<Record<string, TranscriptActivity>>({});
  const activityRecords = useRef(new Map<string, SessionActivity>());
  const permissions = useRef(new SessionPermissions());
  const [pendingPermissions, setPendingPermissions] = useState<SessionEvent[]>([]);
  const transcriptCache = useRef(new TranscriptCache());
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptView>>({});
  const transcriptRequests = useRef(
    new Map<string, { controller: AbortController; promise: Promise<void> }>(),
  );
  const olderTranscriptRequests = useRef(new Map<string, Promise<void>>());
  const resyncAttempts = useRef(new Map<string, number>());
  /** The transcript last asked for, which is the one on screen. */
  const activeTranscript = useRef<string>(undefined);
  const [commandOutput, setCommandOutput] = useState<CommandOutputEvent[]>([]);
  /**
   * Steps per run, kept beside the snapshot rather than inside it.
   *
   * A snapshot carries runs so a refreshed browser has something to draw, but
   * steps are the part that changes every few seconds, and they arrive whole
   * per run — so they patch by run id instead of forcing a whole snapshot.
   */
  const [runSteps, setRunSteps] = useState<Record<string, RunStep[]>>({});
  const runStepRevision = useRef(0);
  const runStepRevisions = useRef(new Map<string, number>());
  /** Durable task checkpoints, including the original reports and worker attempts. */
  const [runNotes, setRunNotes] = useState<Record<string, RunNote[]>>({});
  const runNoteRevision = useRef(0);
  const runNoteRevisions = useRef(new Map<string, number>());
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
  const hydrationChanges = useRef<SnapshotHydrationChange[]>([]);

  // Kept in a ref so the socket subscription never re-runs when the caller
  // re-creates its notify callback.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const report = useCallback((reason: unknown) => {
    notifyRef.current(errorMessage(reason), "error");
  }, []);

  const applyPermissionEvents = useCallback((items: readonly SessionEvent[]) => {
    if (permissions.current.apply(items))
      setPendingPermissions(permissions.current.requests());
  }, []);

  const applyActivity = useCallback(
    (sessionId: string, activity: SessionActivity | undefined, live: boolean) => {
      if (!activity) return;
      const previous = activityRecords.current.get(sessionId);
      if (previous && previous.sequence >= activity.sequence) return;
      const next = {
        eventId: activity.eventId,
        sequence: activity.sequence,
        createdAt: activity.createdAt,
      };
      activityRecords.current.set(sessionId, next);
      setActivities((current) => ({
        ...current,
        [sessionId]: { ...next, live },
      }));
    },
    [],
  );

  /** Announces the end of a Host update this tab watched begin. */
  const announceHostUpdate = useCallback((status: HostUpdateStatus | undefined) => {
    const update = status?.update;
    if (!update) return;
    if (!updateFinished(update.stage)) {
      watchHostUpdate(update.updateId);
      return;
    }
    if (watchedHostUpdate() !== update.updateId) return;
    watchHostUpdate(undefined);
    if (update.stage === "failed") {
      notifyRef.current(update.detail || "The Host update failed", "error");
      return;
    }
    notifyRef.current(
      update.revision
        ? `Host ${update.detail.charAt(0).toLowerCase()}${update.detail.slice(1)}. Reload this page to load the updated interface.`
        : update.detail || "The Host is already up to date",
      "success",
    );
  }, []);

  const recordHydrationChange = useCallback(
    (
      change:
        | Omit<Extract<SnapshotHydrationChange, { type: "upsert" }>, "revision">
        | Omit<Extract<SnapshotHydrationChange, { type: "count" }>, "revision">
        | Omit<Extract<SnapshotHydrationChange, { type: "host_update" }>, "revision">
        | Omit<Extract<SnapshotHydrationChange, { type: "snapshot" }>, "revision">,
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
      applyPermissionEvents(next.permissionEvents ?? []);
      if (permissions.current.prune(new Set(next.sessions.map((session) => session.id))))
        setPendingPermissions(permissions.current.requests());
      const revision = recordHydrationChange({
        type: "snapshot",
        data: next,
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
      setSnapshotRevision((value) => value + 1);
      announceHostUpdate(next.hostUpdate);
    },
    [announceHostUpdate, applyPermissionEvents, recordHydrationChange],
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

      let latest = next;
      let notifications = next.notifications;
      let unreadCount = next.notificationUnreadCount;
      let hostUpdate = next.hostUpdate;
      let replayedNotificationChange = false;
      let replayedUnreadCount = false;
      for (const change of hydrationChanges.current) {
        if (change.revision <= request.revision) continue;
        if (change.type === "snapshot") {
          latest = change.data;
          notifications = latest.notifications;
          unreadCount = latest.notificationUnreadCount;
          hostUpdate = latest.hostUpdate;
          replayedNotificationChange = true;
          replayedUnreadCount = true;
          continue;
        }
        if (change.type === "host_update") {
          hostUpdate = change.status;
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
      applyPermissionEvents(latest.permissionEvents ?? []);
      setSnapshot({
        ...latest,
        notifications: sortNotifications(notifications),
        notificationUnreadCount: unreadCount,
        hostUpdate,
      });
      setSnapshotRevision((value) => value + 1);
      currentUnreadCount.current = unreadCount;
      announceHostUpdate(hostUpdate);
      return true;
    },
    [announceHostUpdate, applyPermissionEvents],
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
      const stepsStartedAt = runStepRevision.current;
      const notesStartedAt = runNoteRevision.current;
      const runs = await api<{
        stepsByRunId: Record<string, RunStep[]>;
        notesByRunId: Record<string, RunNote[]>;
      }>("/api/runs");
      if (hydration.ticket === latestHydrationTicket.current) {
        setRunSteps((current) => {
          const next = { ...runs.stepsByRunId };
          for (const [runId, revision] of runStepRevisions.current) {
            if (revision > stepsStartedAt && current[runId]) {
              next[runId] = current[runId];
            }
          }
          return next;
        });
        setRunNotes((current) => {
          const next = { ...runs.notesByRunId };
          for (const [runId, revision] of runNoteRevisions.current) {
            if (revision > notesStartedAt && current[runId]) {
              next[runId] = current[runId];
            }
          }
          return next;
        });
      }
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

  const dismissAllNotifications = useCallback(async () => {
    const startedAtRevision = notificationRevision.current;
    const result = await request<MarkAllNotificationsReadResponse>(
      "/api/notifications/dismiss-all",
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

  const publishTranscripts = useCallback(() => {
    setTranscripts(transcriptCache.current.views());
  }, []);

  /**
   * The newest page of a session's transcript, then live changes on top of it.
   *
   * A session already followed live is shown from the copy, without a request.
   * `force` refetches one that missed a change; a copy that keeps going stale
   * is given up on with an error rather than refetched forever.
   */
  const loadTranscript = useCallback(
    (sessionId: string, force = false): Promise<void> => {
      activeTranscript.current = sessionId;
      const requests = transcriptRequests.current;
      const cache = transcriptCache.current;
      const pending = requests.get(sessionId);
      if (pending) return pending.promise;
      if (!force && cache.view(sessionId)) {
        cache.trim(sessionId);
        publishTranscripts();
        return Promise.resolve();
      }
      const controller = new AbortController();
      cache.begin(sessionId);
      const promise = (async () => {
        try {
          const page = await api<TranscriptPage>(
            `/api/sessions/${encodeURIComponent(sessionId)}/transcript?limit=${TRANSCRIPT_PAGE_LIMIT}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          requests.delete(sessionId);
          applyActivity(sessionId, page.activity, false);
          const consistent = cache.receive(sessionId, page);
          cache.trim(activeTranscript.current ?? sessionId);
          publishTranscripts();
          if (consistent) {
            resyncAttempts.current.delete(sessionId);
            return;
          }
          const attempts = (resyncAttempts.current.get(sessionId) ?? 0) + 1;
          resyncAttempts.current.set(sessionId, attempts);
          if (attempts > MAX_TRANSCRIPT_RESYNCS) {
            cache.drop(sessionId);
            publishTranscripts();
            report(
              new Error(
                "The transcript kept changing while it loaded. Reopen it to retry.",
              ),
            );
            return;
          }
          void loadTranscriptRef.current(sessionId, true);
        } catch (reason) {
          if (controller.signal.aborted) return;
          cache.cancel(sessionId);
          publishTranscripts();
          report(reason);
        } finally {
          if (requests.get(sessionId)?.controller === controller) {
            requests.delete(sessionId);
          }
        }
      })();
      requests.set(sessionId, { controller, promise });
      return promise;
    },
    [applyActivity, publishTranscripts, report],
  );
  const loadTranscriptRef = useRef(loadTranscript);
  loadTranscriptRef.current = loadTranscript;

  /** Older blocks before the loaded copy: one page, or back to `toIndex`. */
  const loadOlderTranscript = useCallback(
    (sessionId: string, toIndex?: number): Promise<void> => {
      const pending = olderTranscriptRequests.current.get(sessionId);
      if (pending) return pending;
      const view = transcriptCache.current.view(sessionId);
      if (!view || view.start === 0) return Promise.resolve();
      // A little context above a prompt that is jumped to, so it is not flush
      // against the top of the page that was fetched for it.
      const from = Math.max(
        0,
        toIndex === undefined ? view.start - TRANSCRIPT_PAGE_LIMIT : toIndex - 20,
      );
      const limit = Math.min(TRANSCRIPT_PAGE_MAX, view.start - from);
      if (limit <= 0) return Promise.resolve();
      const promise = (async () => {
        try {
          const page = await api<TranscriptPage>(
            `/api/sessions/${encodeURIComponent(sessionId)}/transcript?before=${view.start}&limit=${limit}`,
          );
          if (transcriptCache.current.receiveOlder(sessionId, page)) publishTranscripts();
          else void loadTranscriptRef.current(sessionId, true);
        } catch (reason) {
          report(reason);
        } finally {
          olderTranscriptRequests.current.delete(sessionId);
        }
      })();
      olderTranscriptRequests.current.set(sessionId, promise);
      return promise;
    },
    [publishTranscripts, report],
  );

  const sessionCommandKeys = useRef(new Map<string, string>());
  const command = useCallback(
    async (path: string, body?: unknown) => {
      const sessionTurn = /^\/api\/sessions\/[^/]+\/(?:prompt|resume)$/.test(path);
      const key = `${path}:${JSON.stringify(body)}`;
      if (sessionTurn) {
        const operationId = sessionCommandKeys.current.get(key) ?? crypto.randomUUID();
        sessionCommandKeys.current.set(key, operationId);
        body = { operationId, ...(typeof body === "object" && body ? body : {}) };
      }
      const result = await request(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (result.ok) sessionCommandKeys.current.delete(key);
      return result.ok;
    },
    [request],
  );

  useEffect(() => {
    const pendingTranscriptRequests = transcriptRequests.current;
    let liveFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingLive: LiveItem[] = [];

    const flushLive = () => {
      const batch = pendingLive;
      pendingLive = [];
      liveFlushTimer = undefined;
      if (closed) return;
      const cache = transcriptCache.current;
      const permissionChanges: SessionEvent[] = [];
      const latest = new Map<string, SessionEvent>();
      const tails = new Map<string, SessionEvent[]>();
      const resyncs = new Set<string>();
      let transcriptChanged = false;
      for (const item of batch) {
        if (item.reset) {
          if (cache.has(item.sessionId)) resyncs.add(item.sessionId);
          continue;
        }
        const { event, update } = item;
        if (event) {
          permissionChanges.push(event);
          if (event.type !== "usage") latest.set(event.sessionId, event);
          if (isTranscriptEvent(event)) {
            const tail = tails.get(event.sessionId) ?? [];
            tail.push(event);
            tails.set(event.sessionId, tail);
          }
        }
        if (update && !resyncs.has(item.sessionId)) {
          const result = cache.apply(item.sessionId, update);
          if (result === "applied") transcriptChanged = true;
          if (result === "resync") resyncs.add(item.sessionId);
        }
      }
      applyPermissionEvents(permissionChanges);
      for (const [sessionId, event] of latest) applyActivity(sessionId, event, true);
      if (tails.size > 0) {
        setEvents((value) => {
          const next = { ...value };
          for (const [sessionId, items] of tails) {
            next[sessionId] = mergeEvents(items, value[sessionId] ?? []).slice(
              -LIVE_TAIL_EVENTS,
            );
          }
          return next;
        });
      }
      if (transcriptChanged) publishTranscripts();
      for (const sessionId of resyncs) void loadTranscriptRef.current(sessionId, true);
    };

    const queueLive = (item: LiveItem) => {
      pendingLive.push(item);
      liveFlushTimer ??= setTimeout(flushLive, LIVE_FLUSH_MS);
    };
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let commandFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingCommandOutput: CommandOutputEvent[] = [];
    let attempt = 0;
    let closed = false;
    let connectionLost = false;

    const connect = () => {
      if (closed) return;
      acceptsLiveNotifications.current = false;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/ws/browser`);
      socket.onopen = () => {
        attempt = 0;
        // Changes sent while the socket was down are gone, so only the copy on
        // screen is kept, and it is refetched rather than trusted.
        const active = activeTranscript.current;
        transcriptCache.current.retain(active);
        publishTranscripts();
        if (active && connectionLost) void loadTranscriptRef.current(active, true);
        setConnected(true);
        if (connectionLost) {
          connectionLost = false;
          notifyRef.current("Connection to the Host restored.", "info");
        }
        // Anything that changed while the socket was down was never delivered,
        // so start again from the Host's current truth rather than from state
        // that stopped being updated at an arbitrary moment.
        void refreshWithStatus().then((hydrated) => {
          if (hydrated) acceptsLiveNotifications.current = true;
        });
      };
      socket.onclose = () => {
        for (const request of pendingTranscriptRequests.values()) {
          request.controller.abort();
        }
        pendingTranscriptRequests.clear();
        setConnected(false);
        if (closed) return;
        if (!connectionLost) {
          connectionLost = true;
          notifyRef.current(
            "Connection to the Host lost. Live updates are paused while reconnecting.",
            "warning",
          );
        }
        // Without this the page goes permanently deaf after any restart of the
        // Host and only a manual reload brings it back.
        retryTimer = setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };
      socket.onmessage = ({ data }) => {
        const decoded = decodeFrame(String(data), BrowserMessageSchema);
        if (!decoded.ok) {
          notifyRef.current("Malformed live update", "error");
          socket?.close(decoded.code, decoded.reason);
          return;
        }
        const message = decoded.value;
        if (message.type === "command_execution") {
          setSnapshot((value) => ({
            ...value,
            commandExecutions: mergeCommandExecutions(value.commandExecutions ?? [], [
              message.execution,
            ]).slice(0, 200),
          }));
          return;
        }
        if (message.type === "command_execution_output") {
          pendingCommandOutput = mergeCommandOutput(pendingCommandOutput, [
            message.event,
          ]);
          if (!commandFlushTimer) {
            commandFlushTimer = setTimeout(() => {
              const batch = pendingCommandOutput;
              pendingCommandOutput = [];
              commandFlushTimer = undefined;
              if (!closed) setCommandOutput((value) => mergeCommandOutput(value, batch));
            }, 100);
          }
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
        if (message.type === "host_update") {
          const { status } = message;
          recordHydrationChange({ type: "host_update", status });
          setSnapshot((value) => ({ ...value, hostUpdate: status }));
          announceHostUpdate(status);
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
          if (message.notes) {
            runNoteRevisions.current.set(incoming.id, ++runNoteRevision.current);
            const notes = message.notes;
            setRunNotes((value) => ({ ...value, [incoming.id]: notes }));
          }
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
          runStepRevisions.current.set(runId, ++runStepRevision.current);
          setRunSteps((value) => ({ ...value, [runId]: steps }));
          return;
        }
        if (message.type === "worker_resume_request") {
          const { request } = message;
          setSnapshot((value) => ({
            ...value,
            workerResumeRequests: mergeResumeRequests(value.workerResumeRequests ?? [], [
              request,
            ]),
          }));
          return;
        }
        if (message.type === "transcript_reset") {
          queueLive({ sessionId: message.sessionId, reset: true });
          return;
        }
        if (message.type === "transcript") {
          queueLive({ sessionId: message.sessionId, update: message.update });
          return;
        }
        const { event } = message;
        queueLive({ sessionId: event.sessionId, event, update: message.transcript });
      };
    };

    connect();
    return () => {
      closed = true;
      for (const request of pendingTranscriptRequests.values())
        request.controller.abort();
      pendingTranscriptRequests.clear();
      if (liveFlushTimer) clearTimeout(liveFlushTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (commandFlushTimer) clearTimeout(commandFlushTimer);
      socket?.close();
    };
  }, [
    announceHostUpdate,
    applyActivity,
    applyPermissionEvents,
    applyNotification,
    hydrateSocketSnapshot,
    publishTranscripts,
    recordHydrationChange,
    recordNotificationUpsert,
    recordUnreadCount,
    refreshWithStatus,
  ]);

  return {
    snapshot,
    snapshotRevision,
    liveNotificationUpdates,
    events,
    transcripts,
    activities,
    pendingPermissions,
    commandOutput,
    runSteps,
    runNotes,
    connected,
    nodeUpdates,
    refresh,
    loadTranscript,
    loadOlderTranscript,
    command,
    request,
    markNotificationRead,
    markAllNotificationsRead,
    dismissAllNotifications,
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

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Fastify rejects an empty body when Content-Type is application/json, so
  // only advertise JSON when we are actually sending a payload.
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  /*
   * The Host requires a CSRF proof on every state-changing operator request.
   * It is derived from the session rather than stored, so one fetch serves the
   * whole session and a sign-out is what invalidates it.
   */
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !headers.has("x-csrf-token")) {
    headers.set("x-csrf-token", await csrfToken());
  }
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    // The session ended under us — expired, or the Host restarted and forgot
    // it. Saying so once puts the sign-in screen back up rather than leaving
    // every subsequent call to fail into a toast.
    forgetCsrfToken();
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
