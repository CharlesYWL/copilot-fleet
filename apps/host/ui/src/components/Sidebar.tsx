import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  shorthands,
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
  ChevronDown20Regular,
  ChevronRight20Regular,
  Delete20Regular,
  Chat20Regular,
  Flow16Regular,
  Flow20Regular,
  Folder20Regular,
  Server20Regular,
  Settings20Regular,
} from "@fluentui/react-icons";
import type {
  FleetNode,
  FleetSession,
  Placement,
  SessionEvent,
  Workspace,
} from "@fleet/protocol";
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
import { customAgentName } from "../lib/session-config";
import {
  sessionAccent,
  sessionStatusDescriptor,
  sessionStatusLabel,
} from "../lib/session-status";
import {
  nextClosedItems,
  nodeKey,
  treeActivity,
  workspaceKey,
  type TreeReading,
} from "../lib/tree-collapse";
import { StatusDot } from "./StatusDot";
import { StatusIndicator } from "./StatusIndicator";
import { statusVisuals } from "../theme";
import type { AppView } from "../App";

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
  sectionDisclosure: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    ...shorthands.borderStyle("none"),
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    ":hover": { color: tokens.colorNeutralForeground3 },
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
  /** Marks a session the engine is driving, not the operator. */
  dispatchedMark: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    color: tokens.colorBrandForeground2,
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
  /** The one row that is not a workspace, so it is styled as its own thing. */
  /**
   * The row that holds the fold control and the link into the board.
   *
   * The frame lives here rather than on either control, because they are two
   * buttons — one inside the other is invalid, and it made the row announce
   * itself as "Hide conversations Orchestrator".
   */
  orchestrationRow: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    width: "100%",
    marginBottom: "4px",
    paddingLeft: "6px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    ":hover": { background: tokens.colorNeutralBackground3 },
  },
  orchestration: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexGrow: 1,
    minWidth: 0,
    padding: "8px 10px 8px 4px",
    ...shorthands.borderStyle("none"),
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    color: tokens.colorNeutralForeground1,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  orchestrationActive: {
    background: tokens.colorNeutralBackground3,
    // Griffel wants the longhand here, since the shorthand is set above.
    borderTopColor: tokens.colorBrandStroke1,
    borderRightColor: tokens.colorBrandStroke1,
    borderBottomColor: tokens.colorBrandStroke1,
    borderLeftColor: tokens.colorBrandStroke1,
  },
  /** The fold control, sized to the tree's own chevrons so the rows line up. */
  disclosure: {
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    width: "20px",
    height: "20px",
    ...shorthands.borderStyle("none"),
    borderRadius: tokens.borderRadiusSmall,
    background: "transparent",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    "> svg": { fontSize: "16px" },
    ":hover": {
      background: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  orchestrationLabel: {
    flexGrow: 1,
    minWidth: 0,
    fontWeight: tokens.fontWeightSemibold,
    /*
     * One line, always.
     *
     * These labels were fixed short strings until conversations started naming
     * themselves after whatever a person asked for. A 48-character title
     * wrapped to three lines, pushing the icon and the status dot to the
     * vertical middle of a row that was no longer row-shaped. The whole text
     * is on the row's tooltip.
     */
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  orchestrationCount: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  /** Amber only, and only for what a person has to act on. */
  attentionBadge: {
    minWidth: "18px",
    height: "18px",
    display: "grid",
    placeItems: "center",
    padding: "0 5px",
    borderRadius: "9px",
    background: statusVisuals.attention.surface,
    color: statusVisuals.attention.foreground,
    ...shorthands.border("1px", "solid", statusVisuals.attention.border),
    fontSize: "10px",
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
  },
  /** The lead's conversation, one level under the orchestrator row. */
  leadRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    minHeight: "34px",
    padding: "0 12px 0 28px",
    ...shorthands.borderStyle("none"),
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    color: tokens.colorNeutralForeground2,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    // The icon and the status dot keep their size; only the name gives way.
    "> svg": { flexShrink: 0 },
    ":hover": { background: tokens.colorNeutralBackground1Hover },
  },
});

type SidebarProps = {
  nodes: FleetNode[];
  workspaces: Workspace[];
  sessions: FleetSession[];
  placements: Placement[];
  selectedSessionId: string | undefined;
  view: AppView;
  endedCount: number;
  /** Live work across the fleet, shown beside the Orchestrator row. */
  liveWorkCount: number;
  /** Tasks waiting on a person; drawn separately because amber means act. */
  attentionCount: number;
  /**
   * The orchestrator's conversations, newest first.
   *
   * Plural because the Host runs as many as you open: each is a thread you talk
   * to, with its own tasks under it, and they are listed here for the same
   * reason a chat app lists them — you pick one up, not "the" one.
   */
  leadSessions: readonly FleetSession[];
  dismissedLeadSessions?: readonly FleetSession[];
  waitingPermissions: readonly SessionEvent[];
  onSelectSession: (sessionId: string) => void;
  onSelectLeadSession: (sessionId: string) => void;
  onRestoreLeadSession?: (sessionId: string) => void;
  /** Starts another conversation with the orchestrator. */
  onNewConversation: () => void;
  onNewSession: () => void;
  onSelectView: (view: Exclude<AppView, "session" | "overview">) => void;
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
  liveWorkCount,
  attentionCount,
  leadSessions,
  dismissedLeadSessions = [],
  waitingPermissions,
  onSelectSession,
  onSelectLeadSession,
  onRestoreLeadSession,
  onNewConversation,
  onNewSession,
  onSelectView,
  onClearEnded,
}: SidebarProps) => {
  const styles = useStyles();
  const [closedItems, setClosedItems] = useState<ReadonlySet<string>>(new Set());
  /*
   * Conversations fold away like a workspace's sessions do, and for the same
   * reason: this list grows with use, and it sits above everything else in the
   * sidebar. Open by default and remembered only when closed, so a fleet with
   * one conversation never has to open anything.
   */
  const [conversationsClosed, setConversationsClosed] = useState(false);
  const [dismissedClosed, setDismissedClosed] = useState(true);
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
   * holding the session on screen is never folded, and opens when the operator
   * moves to a session the tree was not showing.
   */
  const reading = useMemo<TreeReading>(
    () => ({ activity: treeActivity(groups), selectedSessionId }),
    [groups, selectedSessionId],
  );
  const lastReading = useRef<TreeReading | undefined>(undefined);
  useEffect(() => {
    setClosedItems((closed) => nextClosedItems(closed, lastReading.current, reading));
    lastReading.current = reading;
  }, [reading]);

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
          Fleet
        </Text>
        {/*
          The orchestrator sits above the workspaces rather than inside one.
          It is the fleet-wide surface — the session you brief, and the work it
          has out on every machine — so nesting it under a repository would
          both bury it and imply it belongs to that repository.
        */}
        {/*
          Two controls, side by side, rather than one inside the other: a
          button nested in a button is invalid, and the outer row ended up
          announcing itself as "Hide conversations Orchestrator".
        */}
        <div
          className={mergeClasses(
            styles.orchestrationRow,
            (view === "orchestrator" || view === "orchestrator-task") &&
              styles.orchestrationActive,
          )}
        >
          {leadSessions.length > 0 && (
            <button
              type="button"
              className={styles.disclosure}
              aria-expanded={!conversationsClosed}
              aria-label={
                conversationsClosed ? "Show conversations" : "Hide conversations"
              }
              title={conversationsClosed ? "Show conversations" : "Hide conversations"}
              onClick={() => setConversationsClosed((closed) => !closed)}
            >
              {conversationsClosed ? (
                <ChevronRight20Regular aria-hidden="true" />
              ) : (
                <ChevronDown20Regular aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            className={styles.orchestration}
            aria-current={view === "orchestrator" ? "page" : undefined}
            onClick={() => onSelectView("orchestrator")}
          >
            <Flow20Regular aria-hidden="true" />
            <span className={styles.orchestrationLabel}>Orchestrator</span>
            {attentionCount > 0 && (
              <span
                className={styles.attentionBadge}
                title={`${attentionCount} waiting for you`}
              >
                {attentionCount}
              </span>
            )}
            {liveWorkCount > 0 && (
              <span className={styles.orchestrationCount}>{liveWorkCount}</span>
            )}
          </button>
        </div>
        {/*
          A conversation belongs to the orchestrator, not to the workspace its
          process happens to run in. They are filtered out of the session tree
          for the same reason, so these are their only way in.
        */}
        {!conversationsClosed &&
          leadSessions.map((lead) => {
            const open = view === "session" && selectedSessionId === lead.id;
            return (
              <button
                key={lead.id}
                type="button"
                className={mergeClasses(
                  styles.leadRow,
                  open && styles.orchestrationActive,
                )}
                aria-current={open ? "page" : undefined}
                title={sessionLabel(lead)}
                onClick={() => onSelectLeadSession(lead.id)}
              >
                <Chat20Regular aria-hidden="true" />
                <span className={styles.orchestrationLabel}>{sessionLabel(lead)}</span>
                <StatusIndicator
                  descriptor={sessionStatusDescriptor(
                    lead,
                    waitingPermissions.some((event) => event.sessionId === lead.id),
                  )}
                  variant="dot"
                />
              </button>
            );
          })}
        {leadSessions.length > 0 && !conversationsClosed && (
          <button
            type="button"
            className={styles.leadRow}
            title="Start another conversation with the orchestrator"
            onClick={onNewConversation}
          >
            <Add20Regular aria-hidden="true" />
            <span className={styles.orchestrationLabel}>New conversation</span>
          </button>
        )}
        {dismissedLeadSessions.length > 0 && (
          <>
            <button
              type="button"
              className={mergeClasses(styles.sectionLabel, styles.sectionDisclosure)}
              aria-expanded={!dismissedClosed}
              aria-label={
                dismissedClosed
                  ? "Show dismissed orchestrators"
                  : "Hide dismissed orchestrators"
              }
              onClick={() => setDismissedClosed((closed) => !closed)}
            >
              {dismissedClosed ? (
                <ChevronRight20Regular aria-hidden="true" />
              ) : (
                <ChevronDown20Regular aria-hidden="true" />
              )}
              <span>Dismissed orchestrators</span>
            </button>
            {!dismissedClosed &&
              dismissedLeadSessions.map((lead) => (
                <button
                  key={lead.id}
                  type="button"
                  className={styles.leadRow}
                  title={`Restore ${sessionLabel(lead)}`}
                  onClick={() => onRestoreLeadSession?.(lead.id)}
                >
                  <Chat20Regular aria-hidden="true" />
                  <span className={styles.orchestrationLabel}>{sessionLabel(lead)}</span>
                  <span>Restore</span>
                </button>
              ))}
          </>
        )}
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
            {groups.map((group) => {
              // Chats is the fleet's own row rather than one of the operator's
              // projects: it cannot be reordered, and a checkout dropped on it
              // would be refused by the Host — so it does not offer either.
              const reserved = group.kind === "chats";
              // A chat checkout is the node's own home directory, written by the
              // Host from what that machine reports. There is nothing to refile
              // and nothing to reorder, so these rows offer no handle at all
              // rather than a drag the Host would then refuse.
              const movable = (nodeId: string) =>
                reserved ? undefined : placementFor(group.workspaceId, nodeId);
              return (
                <TreeItem
                  itemType="branch"
                  value={workspaceKey(group.workspaceId)}
                  key={group.workspaceId}
                >
                  <TreeItemLayout
                    iconBefore={reserved ? <Chat20Regular /> : <Folder20Regular />}
                    draggable={!reserved}
                    className={mergeClasses(
                      !reserved && styles.draggable,
                      dropTarget?.key === group.workspaceId &&
                        (dropTarget.edge === "before"
                          ? styles.dropBefore
                          : styles.dropAfter),
                    )}
                    title={
                      reserved
                        ? "Questions and research that need no checkout — each session runs in its node's home directory"
                        : `${group.workspaceName} — drag above or below another workspace to reorder`
                    }
                    onDragStart={(event: DragEvent<HTMLDivElement>) => {
                      if (reserved) return;
                      event.dataTransfer.setData(
                        DRAG_MIME,
                        encodeDrag({ kind: "workspace", id: group.workspaceId }),
                      );
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event: DragEvent<HTMLDivElement>) => {
                      if (reserved) return;
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
                      if (reserved) return;
                      const payload = decodeDrag(event.dataTransfer.getData(DRAG_MIME));
                      if (!payload) return;
                      event.preventDefault();
                      if (payload.kind === "workspace") {
                        void reorderWorkspaces(
                          reorder(
                            // Chats is pinned above the list by the Host and is
                            // not part of the order being described, so sending it
                            // back would ask for a move that is refused anyway.
                            workspaces
                              .filter((entry) => entry.kind !== "chats")
                              .map((entry) => entry.id),
                            payload.id,
                            group.workspaceId,
                            edge,
                          ),
                        );
                        return;
                      }
                      if (payload.kind !== "placement") return;
                      void updatePlacement(payload.id, {
                        workspaceId: group.workspaceId,
                      });
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
                            draggable={Boolean(movable(nodeGroup.nodeId))}
                            onDragStart={(event: DragEvent<HTMLDivElement>) => {
                              const placement = movable(nodeGroup.nodeId);
                              if (!placement) return;
                              event.dataTransfer.setData(
                                DRAG_MIME,
                                encodeDrag({ kind: "placement", id: placement.id }),
                              );
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            title={
                              movable(nodeGroup.nodeId)
                                ? `${nodeGroup.nodeName} — drag onto a sibling to reorder, or onto another workspace to move`
                                : nodeGroup.nodeName
                            }
                            className={mergeClasses(
                              nodeGroup.online ? undefined : styles.offline,
                              movable(nodeGroup.nodeId) && styles.draggable,
                              dropTarget?.key ===
                                nodeKey(group.workspaceId, nodeGroup.nodeId) &&
                                (dropTarget.edge === "before"
                                  ? styles.dropBefore
                                  : styles.dropAfter),
                            )}
                            onDragOver={(event: DragEvent<HTMLDivElement>) => {
                              const target = movable(nodeGroup.nodeId);
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
                              const target = movable(nodeGroup.nodeId);
                              const payload = decodeDrag(
                                event.dataTransfer.getData(DRAG_MIME),
                              );
                              if (!target || payload?.kind !== "placement") return;
                              event.preventDefault();
                              event.stopPropagation();
                              const siblings = placements
                                .filter(
                                  (entry) => entry.workspaceId === group.workspaceId,
                                )
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
                                      {session.runRole !== "" && (
                                        <span
                                          className={styles.dispatchedMark}
                                          role="img"
                                          aria-label="Dispatched by the orchestrator"
                                          title="Dispatched by the orchestrator"
                                        >
                                          <Flow16Regular />
                                        </span>
                                      )}
                                      <span
                                        className={styles.sessionName}
                                        /*
                                         * The agent joins the hover text rather
                                         * than the row: this list is the densest
                                         * thing on screen, and a badge here would
                                         * cost the name its width on every row to
                                         * say something true of almost none.
                                         */
                                        title={[
                                          sessionStatusLabel(session),
                                          customAgentName(session.configOptions),
                                          session.initialPrompt,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
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
              );
            })}
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
