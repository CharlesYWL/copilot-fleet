import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
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
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
import { groupSessionsByWorkspace } from "../lib/session-groups";
import {
  DRAG_MIME,
  decodeDrag,
  edgeFromPointer,
  encodeDrag,
  reorder,
  type DropEdge,
} from "../lib/drag-drop";
import { useCatalog } from "../hooks/useCatalog";
import { sessionLabel } from "../lib/session-label";
import { sessionAccent, sessionStatusLabel } from "../lib/session-status";
import {
  nextClosedItems,
  nodeKey,
  treeActivity,
  workspaceKey,
  type TreeActivity,
} from "../lib/tree-collapse";
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
  draggable: {
    cursor: "grab",
    ":active": { cursor: "grabbing" },
  },
  /*
   * The insertion line, as a pseudo-element rather than an inset shadow.
   *
   * A row paints its own background across its whole box, so a shadow drawn
   * underneath it never showed: the rule was applied and nothing appeared.
   * This draws above the row, inset by a pixel so a clipped parent cannot
   * swallow it.
   */
  dropBefore: {
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      height: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
      zIndex: 2,
    },
  },
  dropAfter: {
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
      zIndex: 2,
    },
  },
  dropTarget: {
    outline: `2px solid ${tokens.colorBrandStroke1}`,
    outlineOffset: "-2px",
    borderRadius: tokens.borderRadiusMedium,
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
  placements: Placement[];
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
  placements,
  selectedSessionId,
  view,
  endedCount,
  onSelectSession,
  onNewSession,
  onSelectView,
  onClearEnded,
}: SidebarProps) => {
  const styles = useStyles();
  const [closedItems, setClosedItems] = useState<ReadonlySet<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<{ key: string; edge: DropEdge }>();
  const { updatePlacement, reorderPlacements, reorderWorkspaces, reorderSessions } =
    useCatalog();

  /** The tree shows a node under a workspace; that pairing is a placement. */
  const placementFor = (workspaceId: string, nodeId: string) =>
    placements.find(
      (entry) => entry.workspaceId === workspaceId && entry.nodeId === nodeId,
    );

  const groups = useMemo(
    () => groupSessionsByWorkspace(sessions, nodes, workspaces, placements),
    [sessions, nodes, workspaces, placements],
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

  /*
   * A row folds itself away once nothing under it is running, and opens again
   * when work turns up there — a session created, or one back from offline or
   * stopped. Done in an effect against the previous reading, so only a change
   * moves a row and a branch the operator opened by hand stays open. The branch
   * holding the session on screen is left alone either way.
   */
  const activity = useMemo(() => treeActivity(groups), [groups]);
  const lastActivity = useRef<TreeActivity | undefined>(undefined);
  useEffect(() => {
    setClosedItems((closed) =>
      nextClosedItems(closed, lastActivity.current, activity, selectedSessionId),
    );
    lastActivity.current = activity;
  }, [activity, selectedSessionId]);

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
                <TreeItemLayout
                  iconBefore={<Folder20Regular />}
                  draggable
                  className={mergeClasses(
                    styles.draggable,
                    dropTarget?.key === group.workspaceId &&
                      (dropTarget.edge === "before"
                        ? styles.dropBefore
                        : styles.dropAfter),
                  )}
                  title={`${group.workspaceName} — drag above or below another workspace to reorder`}
                  onDragStart={(event: DragEvent<HTMLDivElement>) => {
                    event.dataTransfer.setData(
                      DRAG_MIME,
                      encodeDrag({ kind: "workspace", id: group.workspaceId }),
                    );
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event: DragEvent<HTMLDivElement>) => {
                    if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropTarget({
                      key: group.workspaceId,
                      edge: edgeFromPointer(
                        event.currentTarget.getBoundingClientRect(),
                        event.clientY,
                      ),
                    });
                  }}
                  onDragLeave={() => setDropTarget(undefined)}
                  onDrop={(event: DragEvent<HTMLDivElement>) => {
                    const edge = dropTarget?.edge ?? "before";
                    setDropTarget(undefined);
                    const payload = decodeDrag(event.dataTransfer.getData(DRAG_MIME));
                    if (!payload) return;
                    event.preventDefault();
                    if (payload.kind === "workspace") {
                      void reorderWorkspaces(
                        reorder(
                          workspaces.map((entry) => entry.id),
                          payload.id,
                          group.workspaceId,
                          edge,
                        ),
                      );
                      return;
                    }
                    if (payload.kind !== "placement") return;
                    void updatePlacement(payload.id, { workspaceId: group.workspaceId });
                  }}
                >
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
                          // The node under a workspace is that workspace's
                          // checkout on that machine, so this row is the
                          // placement — drag it to file it elsewhere. A node
                          // left over from deleted history has no placement to
                          // move and stays put.
                          draggable={Boolean(
                            placementFor(group.workspaceId, nodeGroup.nodeId),
                          )}
                          onDragStart={(event: DragEvent<HTMLDivElement>) => {
                            const placement = placementFor(
                              group.workspaceId,
                              nodeGroup.nodeId,
                            );
                            if (!placement) return;
                            event.dataTransfer.setData(
                              DRAG_MIME,
                              encodeDrag({ kind: "placement", id: placement.id }),
                            );
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          title={
                            placementFor(group.workspaceId, nodeGroup.nodeId)
                              ? `${nodeGroup.nodeName} — drag onto a sibling to reorder, or onto another workspace to move`
                              : nodeGroup.nodeName
                          }
                          className={mergeClasses(
                            nodeGroup.online ? undefined : styles.offline,
                            placementFor(group.workspaceId, nodeGroup.nodeId) &&
                              styles.draggable,
                            dropTarget?.key ===
                              nodeKey(group.workspaceId, nodeGroup.nodeId) &&
                              (dropTarget.edge === "before"
                                ? styles.dropBefore
                                : styles.dropAfter),
                          )}
                          onDragOver={(event: DragEvent<HTMLDivElement>) => {
                            const target = placementFor(
                              group.workspaceId,
                              nodeGroup.nodeId,
                            );
                            if (!target) return;
                            if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            // Stops the workspace row underneath from also
                            // showing a line, which would make it unclear where
                            // the item is going to land.
                            event.stopPropagation();
                            setDropTarget({
                              key: nodeKey(group.workspaceId, nodeGroup.nodeId),
                              edge: edgeFromPointer(
                                event.currentTarget.getBoundingClientRect(),
                                event.clientY,
                              ),
                            });
                          }}
                          onDragLeave={() => setDropTarget(undefined)}
                          onDrop={(event: DragEvent<HTMLDivElement>) => {
                            const edge = dropTarget?.edge ?? "before";
                            setDropTarget(undefined);
                            const target = placementFor(
                              group.workspaceId,
                              nodeGroup.nodeId,
                            );
                            const payload = decodeDrag(
                              event.dataTransfer.getData(DRAG_MIME),
                            );
                            if (!target || payload?.kind !== "placement") return;
                            event.preventDefault();
                            event.stopPropagation();
                            const siblings = placements
                              .filter((entry) => entry.workspaceId === group.workspaceId)
                              .map((entry) => entry.id);
                            // Dropping a placement from another workspace onto
                            // a row here means "put it in this workspace", not
                            // "reorder"; the id is not among these siblings.
                            if (!siblings.includes(payload.id)) {
                              void updatePlacement(payload.id, {
                                workspaceId: group.workspaceId,
                              });
                              return;
                            }
                            void reorderPlacements(
                              group.workspaceId,
                              reorder(siblings, payload.id, target.id, edge),
                            );
                          }}
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
                                  draggable
                                  className={mergeClasses(
                                    styles.row,
                                    styles.draggable,
                                    isSelected && styles.selectedRow,
                                    dropTarget?.key === session.id &&
                                      (dropTarget.edge === "before"
                                        ? styles.dropBefore
                                        : styles.dropAfter),
                                  )}
                                  onDragStart={(event: DragEvent<HTMLDivElement>) => {
                                    event.dataTransfer.setData(
                                      DRAG_MIME,
                                      encodeDrag({ kind: "session", id: session.id }),
                                    );
                                    event.dataTransfer.effectAllowed = "move";
                                  }}
                                  onDragOver={(event: DragEvent<HTMLDivElement>) => {
                                    if (!event.dataTransfer.types.includes(DRAG_MIME)) {
                                      return;
                                    }
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                    // Without this the node row above also
                                    // claims the drag, and the line appears in
                                    // the wrong place.
                                    event.stopPropagation();
                                    setDropTarget({
                                      key: session.id,
                                      edge: edgeFromPointer(
                                        event.currentTarget.getBoundingClientRect(),
                                        event.clientY,
                                      ),
                                    });
                                  }}
                                  onDragLeave={() => setDropTarget(undefined)}
                                  onDrop={(event: DragEvent<HTMLDivElement>) => {
                                    const edge = dropTarget?.edge ?? "before";
                                    setDropTarget(undefined);
                                    const payload = decodeDrag(
                                      event.dataTransfer.getData(DRAG_MIME),
                                    );
                                    if (payload?.kind !== "session") return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const siblings = nodeGroup.sessions.map(
                                      (entry) => entry.id,
                                    );
                                    // Sessions belong to the machine that runs
                                    // them, so one dragged from another node is
                                    // not something this list can accept.
                                    if (!siblings.includes(payload.id)) return;
                                    void reorderSessions(
                                      reorder(siblings, payload.id, session.id, edge),
                                    );
                                  }}
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
