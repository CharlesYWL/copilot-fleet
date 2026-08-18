import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";

export type SessionNodeGroup = {
  nodeId: string;
  nodeName: string;
  online: boolean;
  sessions: FleetSession[];
};

export type SessionWorkspaceGroup = {
  workspaceId: string;
  workspaceName: string;
  nodes: SessionNodeGroup[];
};

/**
 * Workspace → Node → Session. Used by both the sidebar tree and the monitor
 * wall so the two layouts stay aligned.
 *
 * Both orders are supplied rather than inferred. Workspaces come from the
 * Host's list, and the node rows under one come from its placements: a node
 * under a workspace *is* that placement, so the order an operator dragged the
 * placements into is the order those rows belong in. Deriving it from the
 * sessions instead — which is what happened before — meant a reorder was
 * written, acknowledged, and then rendered in whatever order the first session
 * of each machine happened to arrive in.
 */
export function groupSessionsByWorkspace(
  sessions: FleetSession[],
  nodes: FleetNode[],
  workspaces: Workspace[] = [],
  placements: Placement[] = [],
): SessionWorkspaceGroup[] {
  const onlineById = new Map(nodes.map((node) => [node.id, node.online]));
  const byWorkspace = new Map<string, SessionWorkspaceGroup>();

  const ensureWorkspace = (workspaceId: string, workspaceName: string) => {
    const existing = byWorkspace.get(workspaceId);
    if (existing) return existing;
    const created: SessionWorkspaceGroup = {
      workspaceId,
      workspaceName,
      nodes: [],
    };
    byWorkspace.set(workspaceId, created);
    return created;
  };

  for (const workspace of workspaces) {
    ensureWorkspace(workspace.id, workspace.name);
  }

  for (const session of sessions) {
    const group = ensureWorkspace(session.workspaceId, session.workspaceName);
    const nodeGroup = group.nodes.find((item) => item.nodeId === session.nodeId);
    if (nodeGroup) {
      nodeGroup.sessions.push(session);
      continue;
    }
    group.nodes.push({
      nodeId: session.nodeId,
      nodeName: session.nodeName,
      online: onlineById.get(session.nodeId) ?? false,
      sessions: [session],
    });
  }

  // The Host hands placements out in workspace-then-position order, so the
  // index one sits at is already the rank it should hold among its siblings.
  const placementRank = new Map<string, number>();
  placements.forEach((placement, index) => {
    const key = `${placement.workspaceId}\u0000${placement.nodeId}`;
    if (!placementRank.has(key)) placementRank.set(key, index);
  });

  for (const group of byWorkspace.values()) {
    group.nodes = orderNodes(group, placementRank);
  }

  // Prefer the Host's workspace order, then any workspace that only appeared
  // on a session (deleted from the catalog but still in history).
  const ordered: SessionWorkspaceGroup[] = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const group = byWorkspace.get(workspace.id);
    if (!group) continue;
    ordered.push(group);
    seen.add(workspace.id);
  }
  for (const group of byWorkspace.values()) {
    if (!seen.has(group.workspaceId)) ordered.push(group);
  }
  return ordered;
}

/**
 * A workspace's node rows in placement order.
 *
 * A node with no placement left — history kept after the checkout was removed —
 * has no rank to sort by and keeps its place at the end rather than jumping to
 * the front, which `undefined` compared as a number would do.
 */
function orderNodes(
  group: SessionWorkspaceGroup,
  ranks: ReadonlyMap<string, number>,
): SessionNodeGroup[] {
  const rankOf = (nodeId: string) =>
    ranks.get(`${group.workspaceId}\u0000${nodeId}`) ?? Number.MAX_SAFE_INTEGER;
  // Sorting is stable, so unplaced nodes keep the order their sessions gave
  // them relative to each other.
  return [...group.nodes].sort((a, b) => rankOf(a.nodeId) - rankOf(b.nodeId));
}
