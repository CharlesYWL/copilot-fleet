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
  Delete20Regular,
  Folder20Regular,
  Server20Regular,
  Settings20Regular,
} from "@fluentui/react-icons";
import type { FleetNode, FleetSession, Workspace } from "@fleet/protocol";
import { groupSessionsByWorkspace } from "../lib/session-groups";
import { sessionLabel } from "../lib/session-label";
import { sessionAccent, sessionStatusLabel } from "../lib/session-status";
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

export type SidebarView = "session" | "settings";

type SidebarProps = {
  nodes: FleetNode[];
  workspaces: Workspace[];
  sessions: FleetSession[];
  selectedSessionId: string | undefined;
  view: SidebarView;
  endedCount: number;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onSelectView: (view: Exclude<SidebarView, "session">) => void;
  onClearEnded: () => void;
};

export const Sidebar = ({
  nodes,
  workspaces,
  sessions,
  selectedSessionId,
  view,
  endedCount,
  onSelectSession,
  onNewSession,
  onSelectView,
  onClearEnded,
}: SidebarProps) => {
  const styles = useStyles();
  const [closedItems, setClosedItems] = useState<Set<string>>(new Set());

  const groups = useMemo(
    () => groupSessionsByWorkspace(sessions, nodes, workspaces),
    [sessions, nodes, workspaces],
  );
  const openItems = useMemo(
    () =>
      groups
        .flatMap((group) => [
          workspaceKey(group.workspaceId),
          ...group.nodes.map((item) => nodeKey(group.workspaceId, item.nodeId)),
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
          <p className={styles.empty}>No workspaces yet.</p>
        ) : (
          <Tree
            aria-label="Sessions by workspace"
            openItems={openItems}
            onOpenChange={handleOpenChange}
          >
            {groups.map((group) => (
              <TreeItem
                itemType="branch"
                value={workspaceKey(group.workspaceId)}
                key={group.workspaceId}
              >
                <TreeItemLayout iconBefore={<Folder20Regular />}>
                  {group.workspaceName}
                </TreeItemLayout>
                <Tree>
                  {group.nodes.length === 0 ? (
                    <TreeItem
                      itemType="leaf"
                      value={`${workspaceKey(group.workspaceId)}:empty`}
                    >
                      <TreeItemLayout className={styles.offline}>
                        No sessions
                      </TreeItemLayout>
                    </TreeItem>
                  ) : (
                    group.nodes.map((nodeGroup) => (
                      <TreeItem
                        itemType="branch"
                        value={nodeKey(group.workspaceId, nodeGroup.nodeId)}
                        key={nodeGroup.nodeId}
                      >
                        <TreeItemLayout
                          iconBefore={<Server20Regular />}
                          className={nodeGroup.online ? undefined : styles.offline}
                        >
                          {nodeGroup.nodeName}
                        </TreeItemLayout>
                        <Tree>
                          {nodeGroup.sessions.map((session) => {
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
                                    <StatusDot
                                      state={session.state}
                                      color={sessionAccent(session)}
                                    />
                                    <span
                                      className={styles.sessionName}
                                      title={`${sessionStatusLabel(session)} · ${session.initialPrompt}`}
                                    >
                                      {sessionLabel(session)}
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
        {endedCount > 0 && (
          <Button
            appearance="subtle"
            className={styles.navButton}
            icon={<Delete20Regular />}
            onClick={onClearEnded}
          >
            Clear ended ({endedCount})
          </Button>
        )}
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

const workspaceKey = (workspaceId: string) => `ws:${workspaceId}`;
const nodeKey = (workspaceId: string, nodeId: string) => `node:${workspaceId}:${nodeId}`;
