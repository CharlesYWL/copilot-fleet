import { useMemo, useState, type KeyboardEvent } from "react";
import {
  Button,
  Text,
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  mergeClasses,
  tokens,
  type TreeOpenChangeData,
} from "@fluentui/react-components";
import {
  Add20Regular,
  Folder20Regular,
  Server20Regular,
  Settings20Regular,
} from "@fluentui/react-icons";
import type { FleetNode, FleetSession } from "@fleet/protocol";
import { StatusDot } from "./StatusDot";

const useStyles = makeStyles({
  sidebar: {
    width: "280px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  scroll: {
    flexGrow: 1,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "10px 8px",
  },
  sectionLabel: {
    display: "block",
    padding: "6px 10px",
    fontSize: "10px",
    letterSpacing: "1.4px",
    textTransform: "uppercase",
    color: tokens.colorNeutralForeground4,
  },
  row: {
    borderRadius: tokens.borderRadiusMedium,
    minWidth: 0,
    // The layout's main slot defaults to min-width:auto, which stops the
    // session label from ever shrinking enough to ellipsize.
    "& .fui-TreeItemLayout__main": {
      minWidth: 0,
      overflow: "hidden",
    },
  },
  selectedRow: {
    background: tokens.colorNeutralBackground6,
  },
  sessionLabel: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
  },
  sessionName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  offline: {
    color: tokens.colorNeutralForeground4,
  },
  empty: {
    padding: "10px 12px",
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase200,
  },
  footer: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "10px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  navButton: {
    justifyContent: "flex-start",
  },
});

type WorkspaceGroup = {
  workspaceId: string;
  workspaceName: string;
  sessions: FleetSession[];
};

type NodeGroup = {
  node: FleetNode;
  workspaces: WorkspaceGroup[];
};

export type SidebarView = "session" | "settings";

type SidebarProps = {
  nodes: FleetNode[];
  sessions: FleetSession[];
  selectedSessionId: string | undefined;
  view: SidebarView;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onSelectView: (view: Exclude<SidebarView, "session">) => void;
};

export const Sidebar = ({
  nodes,
  sessions,
  selectedSessionId,
  view,
  onSelectSession,
  onNewSession,
  onSelectView,
}: SidebarProps) => {
  const styles = useStyles();
  const [closedItems, setClosedItems] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupSessions(nodes, sessions), [nodes, sessions]);
  const openItems = useMemo(
    () =>
      groups
        .flatMap((group) => [
          nodeKey(group.node.id),
          ...group.workspaces.map((item) => workspaceKey(group.node.id, item.workspaceId)),
        ])
        .filter((key) => !closedItems.has(key)),
    [groups, closedItems],
  );

  const handleOpenChange = (_event: unknown, data: TreeOpenChangeData) => {
    const key = String(data.value);
    setClosedItems((previous) => {
      const next = new Set(previous);
      if (data.open) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleSessionKeyDown = (sessionId: string) => (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelectSession(sessionId);
  };

  return (
    <nav className={styles.sidebar} aria-label="Fleet navigation">
      <div className={styles.scroll}>
        <Text as="span" className={styles.sectionLabel}>
          Agents
        </Text>
        {groups.length === 0 ? (
          <p className={styles.empty}>No nodes registered yet.</p>
        ) : (
          <Tree aria-label="Sessions by node" openItems={openItems} onOpenChange={handleOpenChange}>
            {groups.map((group) => (
              <TreeItem itemType="branch" value={nodeKey(group.node.id)} key={group.node.id}>
                <TreeItemLayout
                  iconBefore={<Server20Regular />}
                  className={group.node.online ? undefined : styles.offline}
                >
                  {group.node.name}
                </TreeItemLayout>
                <Tree>
                  {group.workspaces.length === 0 ? (
                    <TreeItem itemType="leaf" value={`${nodeKey(group.node.id)}:empty`}>
                      <TreeItemLayout className={styles.offline}>
                        {group.node.online ? "No sessions" : "Offline"}
                      </TreeItemLayout>
                    </TreeItem>
                  ) : (
                    group.workspaces.map((workspace) => (
                      <TreeItem
                        itemType="branch"
                        value={workspaceKey(group.node.id, workspace.workspaceId)}
                        key={workspace.workspaceId}
                      >
                        <TreeItemLayout iconBefore={<Folder20Regular />}>
                          {workspace.workspaceName}
                        </TreeItemLayout>
                        <Tree>
                          {workspace.sessions.map((session) => {
                            const isSelected =
                              view === "session" && session.id === selectedSessionId;
                            return (
                              <TreeItem
                                itemType="leaf"
                                value={session.id}
                                key={session.id}
                                aria-selected={isSelected}
                                onClick={() => onSelectSession(session.id)}
                                onKeyDown={handleSessionKeyDown(session.id)}
                              >
                                <TreeItemLayout
                                  className={mergeClasses(
                                    styles.row,
                                    isSelected && styles.selectedRow,
                                  )}
                                >
                                  <span className={styles.sessionLabel}>
                                    <StatusDot state={session.state} />
                                    <span
                                      className={styles.sessionName}
                                      title={session.initialPrompt}
                                    >
                                      {session.initialPrompt}
                                    </span>
                                  </span>
                                </TreeItemLayout>
                              </TreeItem>
                            );
                          })}
                        </Tree>
                      </TreeItem>
                    ))
                  )}
                </Tree>
              </TreeItem>
            ))}
          </Tree>
        )}
      </div>

      <div className={styles.footer}>
        <Button appearance="primary" icon={<Add20Regular />} onClick={onNewSession}>
          New session
        </Button>
        <Button
          appearance={view === "settings" ? "secondary" : "subtle"}
          className={styles.navButton}
          icon={<Settings20Regular />}
          onClick={() => onSelectView("settings")}
        >
          Settings
        </Button>
      </div>
    </nav>
  );
};

function groupSessions(nodes: FleetNode[], sessions: FleetSession[]): NodeGroup[] {
  return nodes.map((node) => {
    const nodeSessions = sessions.filter((session) => session.nodeId === node.id);
    const workspaces: WorkspaceGroup[] = [];
    for (const session of nodeSessions) {
      const existing = workspaces.find((item) => item.workspaceId === session.workspaceId);
      if (existing) {
        existing.sessions.push(session);
        continue;
      }
      workspaces.push({
        workspaceId: session.workspaceId,
        workspaceName: session.workspaceName,
        sessions: [session],
      });
    }
    return { node, workspaces };
  });
}

const nodeKey = (nodeId: string) => `node:${nodeId}`;
const workspaceKey = (nodeId: string, workspaceId: string) => `ws:${nodeId}:${workspaceId}`;
