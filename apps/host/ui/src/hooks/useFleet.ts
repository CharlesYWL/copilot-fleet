import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserMessage,
  FleetNode,
  FleetSession,
  Placement,
  SessionEvent,
  Workspace,
} from "@fleet/protocol";

export type Snapshot = {
  nodes: FleetNode[];
  workspaces: Workspace[];
  placements: Placement[];
  sessions: FleetSession[];
};

export type Notify = (message: string, intent?: "error" | "success") => void;

const emptySnapshot: Snapshot = {
  nodes: [],
  workspaces: [],
  placements: [],
  sessions: [],
};

export function useFleet(notify: Notify) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [events, setEvents] = useState<Record<string, SessionEvent[]>>({});
  const [connected, setConnected] = useState(false);

  // Kept in a ref so the socket subscription never re-runs when the caller
  // re-creates its notify callback.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const report = useCallback((reason: unknown) => {
    notifyRef.current(
      reason instanceof Error ? reason.message : String(reason),
      "error",
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api<Snapshot>("/api/snapshot"));
    } catch (reason) {
      report(reason);
    }
  }, [report]);

  const loadEvents = useCallback(
    async (sessionId: string) => {
      try {
        const items = await api<SessionEvent[]>(
          `/api/sessions/${sessionId}/events`,
        );
        setEvents((value) => ({ ...value, [sessionId]: items }));
      } catch (reason) {
        report(reason);
      }
    },
    [report],
  );

  const command = useCallback(
    async (path: string, body?: unknown) => {
      try {
        await api(path, {
          method: "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return true;
      } catch (reason) {
        report(reason);
        return false;
      }
    },
    [report],
  );

  useEffect(() => {
    void refresh();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/browser`);
    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = ({ data }) => {
      const message = parseBrowserMessage(String(data));
      if (!message) {
        notifyRef.current("Malformed live update", "error");
        socket.close(1007, "Malformed JSON");
        return;
      }
      if (message.type === "snapshot") {
        setSnapshot(message.data as unknown as Snapshot);
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
          notifyRef.current(
            session.currentActivity || "Session failed",
            "error",
          );
        }
        setSnapshot((value) => ({
          ...value,
          sessions: upsert(value.sessions, session),
        }));
        return;
      }
      const { event } = message;
      setEvents((value) => ({
        ...value,
        [event.sessionId]: [
          ...(value[event.sessionId] ?? []).filter(
            (item) => item.eventId !== event.eventId,
          ),
          event,
        ].sort((a, b) => a.sequence - b.sequence),
      }));
    };
    return () => socket.close();
  }, [refresh]);

  return { snapshot, events, connected, refresh, loadEvents, command };
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

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
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
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
