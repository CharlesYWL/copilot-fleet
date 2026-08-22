import { describe, expect, it } from "vitest";
import type { FleetSession, SessionState } from "@fleet/protocol";
import {
  RESUMABLE_ACCENT,
  filterVisibleSessions,
  isDisposableSession,
  isDormantSession,
  sessionAccent,
  sessionStatusDescriptor,
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
  runId: "",
  runRole: "" as const,
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

describe("run-owned sessions in the session list", () => {
  it("shows a run's workers but keeps the orchestrator out of the list", () => {
    const mine = session({ id: "mine" });
    const worker = session({ id: "worker", runId: "r1", runRole: "worker" });
    const lead = session({ id: "lead", runId: "r1", runRole: "lead" });

    /*
     * This has to agree with the tree exactly. When it did not, an operator
     * landed on a worker transcript beside "No sessions", with a Resume button
     * that would have restarted it outside the run that owns it.
     */
    expect(
      filterVisibleSessions([mine, worker, lead], undefined).map((s) => s.id),
    ).toEqual(["mine", "worker"]);
  });

  it("still shows one that was opened from the Runs panel on purpose", () => {
    const worker = session({ id: "worker", runId: "r1", runRole: "worker" });
    expect(filterVisibleSessions([worker], "worker").map((s) => s.id)).toEqual([
      "worker",
    ]);
  });
});

describe("sessionStatusDescriptor", () => {
  it("puts a blocked session above a running one", () => {
    // The session is still `running` as far as its own state machine knows;
    // the permission lives in the event log, so it is passed in.
    const blocked = sessionStatusDescriptor(session({ state: "running" }), true);
    const busy = sessionStatusDescriptor(session({ state: "running" }));

    expect(blocked.state).toBe("waiting-for-permission");
    expect(blocked.priority).toBeGreaterThan(busy.priority);
  });

  it("never leaves colour as the only signal", () => {
    // Someone who cannot separate amber from green must still be able to read
    // every state, so each one carries a word and an icon of its own.
    const states: SessionState[] = ["running", "idle", "failed", "completed", "offline"];
    const seen = new Set<string>();
    for (const state of states) {
      const descriptor = sessionStatusDescriptor(session({ state }));
      expect(descriptor.label).not.toBe("");
      expect(descriptor.shortLabel).not.toBe("");
      expect(descriptor.icon).toBeTruthy();
      seen.add(descriptor.shortLabel);
    }
    expect(sessionStatusDescriptor(session({ state: "running" }), true).shortLabel).toBe(
      "needs you",
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("shows a recoverable session as resumable rather than as a casualty", () => {
    const descriptor = sessionStatusDescriptor(dormant("a"));

    expect(descriptor.shortLabel).toBe("resumable");
    expect(descriptor.tone).toBe("attention");
    expect(descriptor.color).toBe(RESUMABLE_ACCENT);
  });

  it("keeps a genuinely dead session looking dead", () => {
    const descriptor = sessionStatusDescriptor(spent("a"));

    expect(descriptor.state).toBe("failed");
    expect(descriptor.tone).toBe("danger");
  });

  it("calls a session that finished cleanly done, not failed", () => {
    expect(sessionStatusDescriptor(session({ state: "completed" })).state).toBe("done");
  });

  it("reads a starting session as running, because work is on its way", () => {
    expect(sessionStatusDescriptor(session({ state: "starting" })).state).toBe("running");
  });
});
