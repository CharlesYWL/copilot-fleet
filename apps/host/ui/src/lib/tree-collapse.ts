import { terminalSessionStates, type FleetSession } from "@fleet/protocol";
import type { SessionWorkspaceGroup } from "./session-groups";

export const workspaceKey = (workspaceId: string) => `ws:${workspaceId}`;
export const nodeKey = (workspaceId: string, nodeId: string) =>
  `node:${workspaceId}:${nodeId}`;

/**
 * Whether a session is still worth a row on screen.
 *
 * Stopped, completed and failed sessions have finished, and an offline one is
 * only a transcript until its Node comes back — none of them are doing
 * anything, so a branch holding nothing else has nothing to watch.
 */
export function isActiveSession(session: Pick<FleetSession, "state">): boolean {
  return !terminalSessionStates.has(session.state) && session.state !== "offline";
}

/** What a branch held last time, and what it holds now. */
export type BranchActivity = {
  /** Sessions in a state that is still doing something. */
  active: number;
  /** Session ids under the branch, used to spot one that was just created. */
  sessions: ReadonlySet<string>;
};

export type TreeActivity = ReadonlyMap<string, BranchActivity>;

/**
 * Activity per collapsible row of the sidebar tree.
 *
 * A workspace counts every session below it, not just the ones on one node, so
 * a workspace only folds away once every machine under it has gone quiet.
 */
export function treeActivity(groups: readonly SessionWorkspaceGroup[]): TreeActivity {
  const activity = new Map<string, BranchActivity>();
  for (const group of groups) {
    const workspaceSessions = new Set<string>();
    let workspaceActive = 0;
    for (const nodeGroup of group.nodes) {
      const sessions = new Set<string>();
      let active = 0;
      for (const session of nodeGroup.sessions) {
        sessions.add(session.id);
        workspaceSessions.add(session.id);
        if (!isActiveSession(session)) continue;
        active += 1;
        workspaceActive += 1;
      }
      activity.set(nodeKey(group.workspaceId, nodeGroup.nodeId), { active, sessions });
    }
    activity.set(workspaceKey(group.workspaceId), {
      active: workspaceActive,
      sessions: workspaceSessions,
    });
  }
  return activity;
}

/**
 * One reading of the tree: what each branch holds, and what is on screen.
 *
 * The selection travels with the activity because both decide whether a row
 * moves, and both have to be compared against the reading before it.
 */
export type TreeReading = {
  activity: TreeActivity;
  /** The session whose transcript the operator is looking at, if any. */
  selectedSessionId: string | undefined;
};

/**
 * The closed rows after the tree moved from `previous` to `current`.
 *
 * Only *changes* fold or unfold a row, never the standing state: a branch that
 * has been quiet since it was first seen stays as the operator left it, so a
 * dormant workspace opened by hand to read an old transcript does not snap shut
 * again on the next heartbeat.
 *
 * Four things move a row:
 *  - first sight, which folds a branch away when nothing under it is running;
 *  - a session waking up — created here, or back from offline or stopped —
 *    which opens the branch so the operator sees where the work went;
 *  - the last active session under a branch settling, which folds it away;
 *  - the operator moving to another session, which opens the branch holding it,
 *    since the selection can move from outside the tree — a tile on the monitor
 *    wall, or the first session picked on a fresh page.
 *
 * A branch holding the selected session is never folded away: the transcript on
 * screen would lose its row in the tree at the moment the operator watched the
 * run end. Collapsing by hand still folds it, and nothing reopens it while the
 * selection stays put.
 *
 * The same set is handed back when nothing moved, so a caller storing this in
 * state does not re-render on every snapshot the Host pushes.
 */
export function nextClosedItems(
  closed: ReadonlySet<string>,
  previous: TreeReading | undefined,
  current: TreeReading,
): ReadonlySet<string> {
  const next = new Set(closed);
  let changed = false;

  const selected = current.selectedSessionId;
  const holdsSelection = (branch: BranchActivity) =>
    selected !== undefined && branch.sessions.has(selected);
  const selectionMoved = previous?.selectedSessionId !== selected;

  const close = (key: string) => {
    if (next.has(key)) return;
    next.add(key);
    changed = true;
  };
  const open = (key: string) => {
    if (!next.has(key)) return;
    next.delete(key);
    changed = true;
  };

  for (const [key, activity] of current.activity) {
    const before = previous?.activity.get(key);
    if (holdsSelection(activity)) {
      // The row for the transcript on screen: kept out of every fold, and
      // opened when the operator has just moved here from somewhere the tree
      // does not show.
      if (selectionMoved) open(key);
      continue;
    }
    if (!before) {
      // A branch the tree has not shown before — a fresh page, or a machine
      // that just enrolled. Nothing running under it means nothing to watch.
      if (activity.active === 0) close(key);
      else open(key);
      continue;
    }
    const created = [...activity.sessions].some((id) => !before.sessions.has(id));
    if (created || (before.active === 0 && activity.active > 0)) {
      open(key);
      continue;
    }
    if (before.active > 0 && activity.active === 0) close(key);
  }

  // A branch that is gone — its last session cleared, or its workspace deleted
  // — should not leave a closed row behind for whatever takes its key next.
  const stale = [...next].filter((key) => !current.activity.has(key));
  for (const key of stale) {
    next.delete(key);
    changed = true;
  }

  return changed ? next : closed;
}
