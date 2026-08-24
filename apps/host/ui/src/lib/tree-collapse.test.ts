import { describe, expect, it } from "vitest";
import type { FleetSession, SessionState } from "@fleet/protocol";
import type { SessionWorkspaceGroup } from "./session-groups";
import {
  isActiveSession,
  nextClosedItems,
  nodeKey,
  treeActivity,
  workspaceKey,
  type TreeReading,
} from "./tree-collapse";

const session = (id: string, state: SessionState): FleetSession =>
  ({ id, state }) as FleetSession;

const groups = (
  ...nodes: { nodeId: string; sessions: FleetSession[] }[]
): SessionWorkspaceGroup[] => [
  {
    workspaceId: "w1",
    workspaceName: "repo",
    kind: "project",
    nodes: nodes.map((entry) => ({
      nodeId: entry.nodeId,
      nodeName: entry.nodeId,
      online: true,
      sessions: entry.sessions,
    })),
  },
];

/** A reading of the tree: what each branch holds, plus the session on screen. */
const reading = (
  activity: ReturnType<typeof treeActivity>,
  selectedSessionId?: string,
): TreeReading => ({ activity, selectedSessionId });

const ws = workspaceKey("w1");
const n1 = nodeKey("w1", "n1");
const n2 = nodeKey("w1", "n2");

describe("isActiveSession", () => {
  it("counts anything that has not settled or dropped off", () => {
    for (const state of ["queued", "starting", "running", "idle", "cancelling"]) {
      expect(isActiveSession({ state: state as SessionState })).toBe(true);
    }
  });

  it("does not count stopped, finished or offline sessions", () => {
    for (const state of ["stopped", "completed", "failed", "offline"]) {
      expect(isActiveSession({ state: state as SessionState })).toBe(false);
    }
  });
});

describe("treeActivity", () => {
  it("rolls a node's sessions up into its workspace", () => {
    const activity = treeActivity(
      groups(
        { nodeId: "n1", sessions: [session("s1", "idle"), session("s2", "stopped")] },
        { nodeId: "n2", sessions: [session("s3", "offline")] },
      ),
    );
    expect(activity.get(n1)?.active).toBe(1);
    expect(activity.get(n2)?.active).toBe(0);
    expect(activity.get(ws)?.active).toBe(1);
    expect([...(activity.get(ws)?.sessions ?? [])]).toEqual(["s1", "s2", "s3"]);
  });
});

describe("nextClosedItems", () => {
  it("folds a branch away the first time it is seen with nothing running", () => {
    const current = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "stopped")] }),
    );
    expect([...nextClosedItems(new Set(), undefined, reading(current))].sort()).toEqual(
      [n1, ws].sort(),
    );
  });

  it("leaves a branch open the first time it is seen with work under it", () => {
    const current = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "running")] }),
    );
    expect([...nextClosedItems(new Set([n1, ws]), undefined, reading(current))]).toEqual(
      [],
    );
  });

  it("folds a branch away when its last active session settles", () => {
    const before = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "running")] }),
    );
    const after = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "stopped")] }),
    );
    expect(
      [...nextClosedItems(new Set(), reading(before), reading(after))].sort(),
    ).toEqual([n1, ws].sort());
  });

  it("opens a closed branch when a session goes live again", () => {
    const before = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "offline")] }),
    );
    const after = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "idle")] }),
    );
    expect([
      ...nextClosedItems(new Set([n1, ws]), reading(before), reading(after)),
    ]).toEqual([]);
  });

  it("opens a closed branch when a session is created under it", () => {
    const before = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "running")] }),
    );
    const after = treeActivity(
      groups({
        nodeId: "n1",
        sessions: [session("s1", "running"), session("s2", "queued")],
      }),
    );
    // Closed by hand while work was already running: a new session still has
    // to be visible, otherwise it starts somewhere the operator cannot see.
    expect([
      ...nextClosedItems(new Set([n1, ws]), reading(before), reading(after)),
    ]).toEqual([]);
  });

  it("keeps a quiet branch the operator opened by hand open", () => {
    const activity = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "stopped")] }),
    );
    // Same reading twice: nothing changed, so nothing moves.
    expect(nextClosedItems(new Set(), reading(activity), reading(activity)).size).toBe(0);
  });

  it("hands back the same set when nothing moved", () => {
    const closed = new Set([n1]);
    const activity = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "stopped")] }),
    );
    expect(nextClosedItems(closed, reading(activity), reading(activity))).toBe(closed);
  });

  it("folds only the node that went quiet, leaving its busy workspace open", () => {
    const before = treeActivity(
      groups(
        { nodeId: "n1", sessions: [session("s1", "running")] },
        { nodeId: "n2", sessions: [session("s2", "running")] },
      ),
    );
    const after = treeActivity(
      groups(
        { nodeId: "n1", sessions: [session("s1", "stopped")] },
        { nodeId: "n2", sessions: [session("s2", "running")] },
      ),
    );
    expect([...nextClosedItems(new Set(), reading(before), reading(after))]).toEqual([
      n1,
    ]);
  });

  it("drops rows that no longer exist so a reused key starts fresh", () => {
    const before = treeActivity(
      groups(
        { nodeId: "n1", sessions: [session("s1", "stopped")] },
        { nodeId: "n2", sessions: [session("s2", "running")] },
      ),
    );
    const after = treeActivity(
      groups({ nodeId: "n2", sessions: [session("s2", "running")] }),
    );
    expect([...nextClosedItems(new Set([n1]), reading(before), reading(after))]).toEqual(
      [],
    );
  });

  it("keeps the branch of the session on screen open when it finishes", () => {
    const before = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "running")] }),
    );
    const after = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "completed")] }),
    );
    // The transcript being read stays reachable in the tree: folding it away
    // takes the row out from under the operator exactly when the run ends.
    expect([
      ...nextClosedItems(new Set(), reading(before, "s1"), reading(after, "s1")),
    ]).toEqual([]);
  });

  it("keeps the branch of the session on screen open the first time it is seen", () => {
    const current = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "stopped")] }),
    );
    expect([...nextClosedItems(new Set(), undefined, reading(current, "s1"))]).toEqual(
      [],
    );
  });

  it("still folds a quiet branch that does not hold the session on screen", () => {
    const before = treeActivity(
      groups(
        { nodeId: "n1", sessions: [session("s1", "running")] },
        { nodeId: "n2", sessions: [session("s2", "running")] },
      ),
    );
    const after = treeActivity(
      groups(
        { nodeId: "n1", sessions: [session("s1", "completed")] },
        { nodeId: "n2", sessions: [session("s2", "running")] },
      ),
    );
    expect([
      ...nextClosedItems(new Set(), reading(before, "s2"), reading(after, "s2")),
    ]).toEqual([n1]);
  });

  it("leaves a branch the operator collapsed by hand closed", () => {
    const before = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "running")] }),
    );
    const after = treeActivity(
      groups({ nodeId: "n1", sessions: [session("s1", "completed")] }),
    );
    // Holding the selection only stops the automatic fold; it never reopens a
    // row the operator shut while the selection stays where it was.
    expect(
      nextClosedItems(new Set([n1]), reading(before, "s1"), reading(after, "s1")),
    ).toEqual(new Set([n1]));
  });

  it("opens the folded branch of a session the operator has just moved to", () => {
    const activity = treeActivity(
      groups(
        { nodeId: "n1", sessions: [session("s1", "stopped")] },
        { nodeId: "n2", sessions: [session("s2", "running")] },
      ),
    );
    // The selection can move from outside the tree — a monitor wall tile, or
    // the first session picked on a fresh page — so the row has to come back.
    expect([
      ...nextClosedItems(new Set([n1]), reading(activity, "s2"), reading(activity, "s1")),
    ]).toEqual([]);
  });
});
