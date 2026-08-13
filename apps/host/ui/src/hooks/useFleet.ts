import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  type BrowserMessage,
  type NodeUpdateStage,
  type SessionEvent,
  type Snapshot,
} from "@fleet/protocol";
import { reconnectDelay } from "./reconnect-delay";
import { mergeEvents } from "../lib/merge-events";

export type { Snapshot };

export type Notify = (message: string, intent?: "error" | "success") => void;

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
  hostRevision: "",
};

/** The latest self-update progress per node, cleared once it settles. */
export type NodeUpdateProgress = Record<
  string,
  { stage: NodeUpdateStage; detail: string }
>;

export function useFleet(notify: Notify) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [events, setEvents] = useState<Record<string, SessionEvent[]>>({});
  const [connected, setConnected] = useState(false);
  const [nodeUpdates, setNodeUpdates] = useState<NodeUpdateProgress>({});

  // Kept in a ref so the socket subscription never re-runs when the caller
  // re-creates its notify callback.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const report = useCallback((reason: unknown) => {
    notifyRef.current(errorMessage(reason), "error");
  }, []);

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

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api<Snapshot>("/api/snapshot"));
    } catch (reason) {
      report(reason);
    }
  }, [report]);

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
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/ws/browser`);
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        // Anything that changed while the socket was down was never delivered,
        // so start again from the Host's current truth rather than from state
        // that stopped being updated at an arbitrary moment.
        void refresh();
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
          setSnapshot(message.data);
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
          if (session.state === "failed") {
            notifyRef.current(session.currentActivity || "Session failed", "error");
          }
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
  }, [refresh]);

  return {
    snapshot,
    events,
    connected,
    nodeUpdates,
    refresh,
    loadEvents,
    command,
    request,
  };
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [next, ...items];
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
