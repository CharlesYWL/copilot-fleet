import {
  BrowserMessageSchema,
  SessionPermissions,
  TRANSCRIPT_PAGE_LIMIT,
  TRANSCRIPT_PAGE_MAX,
  type BrowserMessage,
  type ConsoleSessionView,
  type ConsoleStatus,
  type SessionEvent,
  type TranscriptPage,
} from "@fleet/protocol";
import {
  TranscriptCache,
  type TranscriptView,
} from "../../../host/ui/src/lib/transcript-cache";
import type { TranscriptActivity } from "../../../host/ui/src/hooks/useFleet";
import { nodeApi, sessionPath } from "./api";

export type ConnectionStatus = {
  status: ConsoleStatus;
  offlineAllowed: boolean;
  detail?: string | undefined;
};

export type SessionSnapshot = ConsoleSessionView;

export type SessionView = ConnectionStatus & {
  snapshot?: SessionSnapshot;
  transcript?: TranscriptView | undefined;
  pendingPermission?: SessionEvent | undefined;
  activity?: TranscriptActivity | undefined;
  error?: string | undefined;
};

type StreamMessage = BrowserMessage | ({ type: "connection" } & ConnectionStatus);

/**
 * Subscribe first, then hydrate. Deltas received during the page request are
 * held by Host's existing cache; session/permission changes wait for the snapshot.
 */
export function connectSession(
  id: string,
  changed: (view: SessionView) => void,
  notify: (message: string) => void,
) {
  const cache = new TranscriptCache({ maxViews: 1, keepBlocks: TRANSCRIPT_PAGE_LIMIT });
  let permissions = new SessionPermissions();
  let stream = new EventSource(sessionPath(id, "stream"));
  let connected = false;
  let current: SessionView = { status: "syncing", offlineAllowed: false };
  let closed = false;
  let hydrating = false;
  let invalidated = false;
  let buffered: StreamMessage[] = [];
  let snapshotRequest: AbortController | undefined;
  let olderRequest: AbortController | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;

  const publish = () => {
    if (!closed)
      changed({
        ...current,
        transcript: cache.view(id),
        pendingPermission: permissions.requests().find((event) => event.sessionId === id),
      });
  };

  const applyMetadata = (message: StreamMessage) => {
    if (message.type === "connection") {
      current = { ...current, ...message };
    } else if (
      message.type === "session" &&
      message.session.id === id &&
      current.snapshot
    ) {
      if (message.session.updatedAt >= current.snapshot.session.updatedAt) {
        current = {
          ...current,
          snapshot: { ...current.snapshot, session: message.session },
        };
      }
    } else if (message.type === "event" && message.event.sessionId === id) {
      permissions.apply([message.event]);
      if (
        message.event.type !== "usage" &&
        message.event.sequence > (current.activity?.sequence ?? 0)
      ) {
        current = {
          ...current,
          activity: {
            eventId: message.event.eventId,
            sequence: message.event.sequence,
            createdAt: message.event.createdAt,
            live: true,
          },
        };
      }
    }
  };

  const hydrate = async () => {
    if (closed || !connected) return;
    snapshotRequest?.abort();
    olderRequest?.abort();
    olderRequest = undefined;
    const request = new AbortController();
    snapshotRequest = request;
    hydrating = true;
    current = { ...current, status: "syncing", offlineAllowed: false, error: undefined };
    publish();
    const timeout = setTimeout(() => {
      if (closed || snapshotRequest !== request) return;
      request.abort();
      hydrating = false;
      buffered = [];
      cache.cancel(id);
      current = {
        ...current,
        error: "Loading this session timed out. Retry to synchronize.",
      };
      publish();
    }, 15_000);
    request.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        invalidated = false;
        buffered = [];
        cache.begin(id);
        const [snapshot, page] = await Promise.all([
          nodeApi<SessionSnapshot>(sessionPath(id), { signal: request.signal }),
          nodeApi<TranscriptPage>(
            sessionPath(id, `transcript?limit=${TRANSCRIPT_PAGE_LIMIT}`),
            {
              signal: request.signal,
            },
          ),
        ]);
        if (closed || request.signal.aborted) return;
        const received = cache.receive(id, page);
        if (invalidated || !received) continue;
        permissions = new SessionPermissions();
        permissions.apply(snapshot.permissions);
        current = {
          ...snapshot,
          snapshot,
          ...(page.activity ? { activity: { ...page.activity, live: false } } : {}),
          error: undefined,
        };
        for (const message of buffered) applyMetadata(message);
        buffered = [];
        hydrating = false;
        publish();
        return;
      }
      throw new Error("Transcript changed while loading. Retry to synchronize.");
    } catch (error) {
      if (!closed && !request.signal.aborted) {
        request.abort();
        cache.cancel(id);
        hydrating = false;
        buffered = [];
        current = {
          ...current,
          error: error instanceof Error ? error.message : String(error),
        };
        publish();
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  stream.onopen = () => {
    connected = true;
    void hydrate();
  };
  stream.onerror = () => {
    connected = false;
    snapshotRequest?.abort();
    cache.cancel(id);
    hydrating = false;
    buffered = [];
    // Loss of this local browser stream does not prove an offline grant.
    current = {
      ...current,
      status: "syncing",
      offlineAllowed: false,
      detail: "Reconnecting to the Node console…",
      error:
        "Live updates are unavailable. Retry, or check the Node and Host connection and versions.",
    };
    publish();
  };
  stream.onmessage = (event) => {
    if (closed) return;
    let message: StreamMessage;
    try {
      const data: unknown = JSON.parse(event.data);
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "connection"
      ) {
        const connection = data as Partial<ConnectionStatus>;
        if (
          !["online", "offline", "syncing", "conflict"].includes(
            connection.status ?? "",
          ) ||
          typeof connection.offlineAllowed !== "boolean"
        )
          throw new Error("Invalid connection status");
        message = data as StreamMessage;
      } else {
        message = BrowserMessageSchema.parse(data);
      }
    } catch {
      if (hydrating) invalidated = true;
      else void hydrate();
      return;
    }
    if (message.type === "session_notice") {
      if (message.sessionId === id) notify(message.message);
      return;
    }
    const update =
      message.type === "event" && message.event.sessionId === id
        ? message.transcript
        : message.type === "transcript" && message.sessionId === id
          ? message.update
          : undefined;
    const reset = message.type === "transcript_reset" && message.sessionId === id;
    const resync = update && !invalidated ? cache.apply(id, update) === "resync" : false;
    if (hydrating) {
      if (reset || resync) invalidated = true;
      if (buffered.length < 2_000) buffered.push(message);
      else {
        invalidated = true;
        cache.cancel(id);
      }
      return;
    }
    applyMetadata(message);
    if (reset || resync) void hydrate();
    else if (!publishTimer)
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        publish();
      }, 32);
  };

  const loadOlder = async (toIndex?: number): Promise<void> => {
    const view = cache.view(id);
    if (closed || hydrating || olderRequest || !view?.start) return;
    const request = new AbortController();
    olderRequest = request;
    const limit = Math.min(
      TRANSCRIPT_PAGE_MAX,
      Math.max(TRANSCRIPT_PAGE_LIMIT, toIndex === undefined ? 0 : view.start - toIndex),
    );
    try {
      const page = await nodeApi<TranscriptPage>(
        sessionPath(id, `transcript?before=${view.start}&limit=${limit}`),
        { signal: request.signal },
      );
      if (closed || request.signal.aborted) return;
      if (!cache.receiveOlder(id, page)) await hydrate();
      else publish();
    } catch (error) {
      if (!closed && !request.signal.aborted) {
        current = {
          ...current,
          error: error instanceof Error ? error.message : String(error),
        };
        publish();
      }
    } finally {
      if (olderRequest === request) olderRequest = undefined;
    }
  };

  publish();
  return {
    loadOlder,
    async reload() {
      if (closed) return;
      if (connected) return hydrate();
      const previous = stream;
      previous.close();
      stream = new EventSource(sessionPath(id, "stream"));
      stream.onopen = previous.onopen;
      stream.onerror = previous.onerror;
      stream.onmessage = previous.onmessage;
      current = { ...current, error: undefined };
      publish();
    },
    close() {
      closed = true;
      stream.close();
      snapshotRequest?.abort();
      olderRequest?.abort();
      clearTimeout(publishTimer);
      buffered = [];
      cache.clear();
    },
  };
}
