import { describe, expect, it } from "vitest";
import type { FleetSession, SessionState } from "@fleet/protocol";
import {
  RESUMABLE_ACCENT,
  filterVisibleSessions,
  isDisposableSession,
  isDormantSession,
  sessionAccent,
  sessionStatusLabel,
} from "./session-status";

const session = (values: Partial<FleetSession> & { id?: string }): FleetSession => ({
  id: "s1",
  workspaceId: "w1",
  workspaceName: "repo",
  placementId: "p1",
  nodeId: "n1",
  nodeName: "node",
  state: "idle",
  name: "",
  initialPrompt: "prompt",
  currentActivity: "",
  lastText: "",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  agentSessionId: "",
  yolo: false,
  commands: [],
  configOptions: [],
  ...values,
});

/** What a node reboot leaves behind: ended, but Copilot still has the thread. */
const dormant = (id: string, state: SessionState = "failed") =>
  session({ id, state, agentSessionId: "copilot-abc" });

/** Ended before the agent ever started, so there is nothing to re-attach to. */
const spent = (id: string, state: SessionState = "failed") => session({ id, state });

describe("filterVisibleSessions", () => {
  it("keeps a session that can still be resumed", () => {
    // This is the whole bug: a node reboot marked every recoverable session
    // failed, the list hid them, and the only thing left on screen was the
    // button that deletes them.
    const visible = filterVisibleSessions([dormant("a")], undefined);
    expect(visible.map((item) => item.id)).toEqual(["a"]);
  });

  it("hides an ended session with nothing left to recover", () => {
    expect(filterVisibleSessions([spent("a")], undefined)).toEqual([]);
  });

  it("keeps live sessions and whatever is selected", () => {
    const sessions = [session({ id: "live" }), spent("watched"), spent("other")];
    expect(filterVisibleSessions(sessions, "watched").map((item) => item.id)).toEqual([
      "live",
      "watched",
    ]);
  });

  it("keeps an offline session, which the node may still reclaim", () => {
    expect(filterVisibleSessions([dormant("a", "offline")], undefined)).toHaveLength(1);
  });
});

describe("isDisposableSession", () => {
  it("counts only what Clear ended actually removes", () => {
    expect(isDisposableSession(spent("a"))).toBe(true);
    expect(isDisposableSession(dormant("a"))).toBe(false);
    expect(isDisposableSession(session({ id: "a", state: "running" }))).toBe(false);
  });
});

describe("session status", () => {
  it("reads an ended-but-recoverable session as resumable, not failed", () => {
    const value = dormant("a");
    expect(isDormantSession(value)).toBe(true);
    expect(sessionStatusLabel(value)).toBe("resumable");
    expect(sessionAccent(value)).toBe(RESUMABLE_ACCENT);
  });

  it("leaves an offline session describing itself", () => {
    // The node is usually seconds from reclaiming it on its own, so calling it
    // resumable would invite the operator to act on something self-healing.
    const value = dormant("a", "offline");
    expect(isDormantSession(value)).toBe(false);
    expect(sessionStatusLabel(value)).toBe("offline");
  });

  it("leaves a genuinely dead session looking dead", () => {
    const value = spent("a");
    expect(sessionStatusLabel(value)).toBe("failed");
    expect(sessionAccent(value)).not.toBe(RESUMABLE_ACCENT);
  });
});
