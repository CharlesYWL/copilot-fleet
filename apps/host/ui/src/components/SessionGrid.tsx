import { useMemo, useState } from "react";
import { Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Folder20Regular } from "@fluentui/react-icons";
import type { FleetNode, FleetSession, SessionEvent, Workspace } from "@fleet/protocol";
import { groupSessionsByWorkspace } from "../lib/session-groups";
import {
  DRAG_MIME,
  decodeDrag,
  edgeFromPointer,
  encodeDrag,
  horizontalEdgeFromPointer,
  reorder,
  type DropEdge,
} from "../lib/drag-drop";
import { useCatalog } from "../hooks/useCatalog";
import { EmptySessions } from "./EmptySessions";
import { SessionTile } from "./SessionTile";

// Shared so a session without events keeps the same array identity between
// renders and its tile can memoise the derived preview.
const noEvents: SessionEvent[] = [];

const useStyles = makeStyles({
  wall: {
    flexGrow: 1,
    minWidth: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "16px",
    background: tokens.colorNeutralBackground1,
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "16px",
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    background: "rgba(255, 255, 255, 0.02)",
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.03)",
  },
  head: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
    paddingBottom: "4px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  count: {
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase200,
    marginLeft: "auto",
    flexShrink: 0,
  },
  tiles: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap: "12px",
  },
  // The tile keeps its own shape; this wrapper only carries the drag handlers
  // and the line, so a highlight never fights the tile's own border.
  tileWrap: {
    position: "relative",
    display: "flex",
    minWidth: 0,
    borderRadius: tokens.borderRadiusXLarge,
  },
  draggable: {
    cursor: "grab",
    ":active": { cursor: "grabbing" },
  },
  /*
   * The line is a pseudo-element, not an inset shadow.
   *
   * A tile paints its own opaque background over its whole box, so a shadow
   * drawn on the wrapper underneath is invisible — the rule was there and
   * nothing appeared. This sits above the tile and in the gap beside it, where
   * the item is actually going to land.
   */
  tileBefore: {
    "::before": {
      content: '""',
      position: "absolute",
      top: 0,
      bottom: 0,
      left: "-8px",
      width: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
      zIndex: 2,
    },
  },
  tileAfter: {
    "::before": {
      content: '""',
      position: "absolute",
      top: 0,
      bottom: 0,
      right: "-8px",
      width: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
      zIndex: 2,
    },
  },
  headBefore: {
    "::before": {
      content: '""',
      position: "absolute",
      left: 0,
      right: 0,
      top: "-6px",
      height: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
      zIndex: 2,
    },
  },
  headAfter: {
    "::before": {
      content: '""',
      position: "absolute",
      left: 0,
      right: 0,
      bottom: "-6px",
      height: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
      zIndex: 2,
    },
  },
});

type SessionGridProps = {
  sessions: FleetSession[];
  nodes: FleetNode[];
  events: Record<string, SessionEvent[]>;
  onOpen: (sessionId: string) => void;
  onPermission: (
    sessionId: string,
    requestId: string,
    outcome: "allow_once" | "deny",
    optionId?: string,
  ) => void;
  onNewSession: () => void;
  workspaces: Workspace[];
};

export const SessionGrid = ({
  sessions,
  nodes,
  events,
  onOpen,
  onPermission,
  onNewSession,
  workspaces,
}: SessionGridProps) => {
  const styles = useStyles();
  const [dropTarget, setDropTarget] = useState<{ key: string; edge: DropEdge }>();
  const { reorderSessions, reorderWorkspaces } = useCatalog();
  const groups = useMemo(
    () =>
      groupSessionsByWorkspace(sessions, nodes).filter((group) => group.nodes.length > 0),
    [sessions, nodes],
  );

  /** The sessions a tile may be reordered among: its own node's, as in the tree. */
  const siblingsOf = (sessionId: string): string[] => {
    for (const group of groups) {
      for (const nodeGroup of group.nodes) {
        const ids = nodeGroup.sessions.map((entry) => entry.id);
        if (ids.includes(sessionId)) return ids;
      }
    }
    return [];
  };

  if (sessions.length === 0) return <EmptySessions onNewSession={onNewSession} />;

  return (
    <section className={styles.wall} aria-label="Session monitor">
      {groups.map((group) => {
        const sessionCount = group.nodes.reduce(
          (total, nodeGroup) => total + nodeGroup.sessions.length,
          0,
        );
        return (
          <section
            className={styles.group}
            key={group.workspaceId}
            aria-label={`Workspace ${group.workspaceName}`}
          >
            <div
              className={mergeClasses(
                styles.head,
                styles.draggable,
                dropTarget?.key === group.workspaceId &&
                  (dropTarget.edge === "before" ? styles.headBefore : styles.headAfter),
              )}
              draggable
              title={`${group.workspaceName} — drag above or below another workspace to reorder`}
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  DRAG_MIME,
                  encodeDrag({ kind: "workspace", id: group.workspaceId }),
                );
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
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
              onDrop={(event) => {
                const edge = dropTarget?.edge ?? "before";
                setDropTarget(undefined);
                const payload = decodeDrag(event.dataTransfer.getData(DRAG_MIME));
                if (payload?.kind !== "workspace") return;
                event.preventDefault();
                void reorderWorkspaces(
                  reorder(
                    workspaces.map((entry) => entry.id),
                    payload.id,
                    group.workspaceId,
                    edge,
                  ),
                );
              }}
            >
              <Folder20Regular aria-hidden="true" />
              <Text weight="semibold" className={styles.title}>
                {group.workspaceName}
              </Text>
              <Text className={styles.count}>
                {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
              </Text>
            </div>
            <div className={styles.tiles}>
              {group.nodes.flatMap((nodeGroup) =>
                nodeGroup.sessions.map((session) => (
                  <div
                    key={session.id}
                    className={mergeClasses(
                      styles.tileWrap,
                      styles.draggable,
                      dropTarget?.key === session.id &&
                        (dropTarget.edge === "before"
                          ? styles.tileBefore
                          : styles.tileAfter),
                    )}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        DRAG_MIME,
                        encodeDrag({ kind: "session", id: session.id }),
                      );
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      // Tiles flow left to right, so the halves that matter are
                      // the left and right ones, not the top and bottom.
                      setDropTarget({
                        key: session.id,
                        edge: horizontalEdgeFromPointer(
                          event.currentTarget.getBoundingClientRect(),
                          event.clientX,
                        ),
                      });
                    }}
                    onDragLeave={() => setDropTarget(undefined)}
                    onDrop={(event) => {
                      const edge = dropTarget?.edge ?? "before";
                      setDropTarget(undefined);
                      const payload = decodeDrag(event.dataTransfer.getData(DRAG_MIME));
                      if (payload?.kind !== "session") return;
                      event.preventDefault();
                      const siblings = siblingsOf(session.id);
                      // Same rule as the tree: a session belongs to the machine
                      // running it, so it only reorders among that node's own.
                      if (!siblings.includes(payload.id)) return;
                      void reorderSessions(
                        reorder(siblings, payload.id, session.id, edge),
                      );
                    }}
                  >
                    <SessionTile
                      session={session}
                      events={events[session.id] ?? noEvents}
                      onOpen={onOpen}
                      onPermission={onPermission}
                    />
                  </div>
                )),
              )}
            </div>
          </section>
        );
      })}
    </section>
  );
};
