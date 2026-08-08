import type { FleetNode, FleetSession, Workspace } from "@fleet/protocol";

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
 */
export function groupSessionsByWorkspace(
  sessions: FleetSession[],
  nodes: FleetNode[],
  workspaces: Workspace[] = [],
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
