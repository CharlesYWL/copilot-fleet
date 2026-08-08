import { useEffect, useRef } from "react";
import { eventPayload, type SessionEvent } from "@fleet/protocol";

const BASE_TITLE = "Copilot Fleet";

/**
 * A waiting permission blocks its agent until the node's timeout expires, which
 * is long enough that nobody is watching the tab by then. Announce each request
 * outside the page: a tab-title badge that needs no consent, plus a desktop
 * notification that survives until it is clicked.
 */
export function usePermissionAlerts(
  pending: SessionEvent[],
  onSelectSession: (sessionId: string) => void,
): void {
  const announced = useRef(new Set<string>());
  const selectRef = useRef(onSelectSession);
  selectRef.current = onSelectSession;

  useEffect(() => {
    document.title = pending.length ? `(${pending.length}) ${BASE_TITLE}` : BASE_TITLE;
  }, [pending.length]);

  useEffect(() => {
    const ids = new Set(pending.map((event) => requestIdOf(event)));
    // Resolved requests can never come back, so forgetting them keeps the set
    // bounded without risking a duplicate notification.
    announced.current = new Set([...announced.current].filter((id) => ids.has(id)));

    if (pending.length === 0 || typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission();
    if (Notification.permission !== "granted") return;

    for (const event of pending) {
      const requestId = requestIdOf(event);
      if (!requestId || announced.current.has(requestId)) continue;
      announced.current.add(requestId);
      notifyDesktop(event, requestId, selectRef.current);
    }
  }, [pending]);
}

function notifyDesktop(
  event: SessionEvent,
  requestId: string,
  onSelectSession: (sessionId: string) => void,
): void {
  const notification = new Notification("Copilot needs approval", {
    body:
      eventPayload(event, "permission")?.title || "A tool call is waiting for a decision",
    tag: requestId,
    requireInteraction: true,
  });
  notification.onclick = () => {
    window.focus();
    onSelectSession(event.sessionId);
    notification.close();
  };
}

function requestIdOf(event: SessionEvent): string {
  return eventPayload(event, "permission")?.requestId ?? "";
}
