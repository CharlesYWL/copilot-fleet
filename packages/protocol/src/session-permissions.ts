import { eventPayload, type SessionEvent } from "./index.js";

/** Resolutions are retained so late/replayed requests cannot resurrect a prompt. */
export class SessionPermissions {
  private readonly sessions = new Map<string, Map<string, SessionEvent>>();
  private pending: SessionEvent[] = [];

  apply(events: readonly SessionEvent[]): boolean {
    let changed = false;
    for (const event of events) {
      if (event.type !== "permission" && event.type !== "permission_result") continue;
      const requestId = eventPayload(event, event.type)?.requestId;
      if (!requestId) continue;
      let requests = this.sessions.get(event.sessionId);
      const previous = requests?.get(requestId);
      if (previous && previous.sequence >= event.sequence) continue;
      if (!requests) {
        requests = new Map();
        this.sessions.set(event.sessionId, requests);
      }
      requests.set(requestId, event);
      if (event.type === "permission" || previous?.type === "permission") changed = true;
    }
    if (changed) this.rebuild();
    return changed;
  }

  prune(sessionIds: ReadonlySet<string>): boolean {
    let changed = false;
    for (const id of this.sessions.keys()) {
      if (sessionIds.has(id)) continue;
      this.sessions.delete(id);
      changed = true;
    }
    if (changed) this.rebuild();
    return changed;
  }

  requests(): SessionEvent[] {
    return this.pending;
  }

  latestEvents(): SessionEvent[] {
    return [...this.sessions.values()].flatMap((requests) => [...requests.values()]);
  }

  private rebuild(): void {
    this.pending = this.latestEvents()
      .filter((event) => event.type === "permission")
      .sort((left, right) => left.sequence - right.sequence);
  }
}
