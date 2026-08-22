import { useMemo, useState } from "react";
import {
  shorthands,
  Button,
  Switch,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { Add20Regular, Flow20Regular, Folder20Regular } from "@fluentui/react-icons";
import type {
  FleetNode,
  FleetSession,
  Placement,
  SessionEvent,
  Workspace,
} from "@fleet/protocol";
import { groupSessionsByWorkspace } from "../lib/session-groups";
import type { OrchestratorSummary } from "../lib/orchestration-view";
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
import { SessionTile } from "./SessionTile";
import { semanticColors, statusVisuals, terminal } from "../theme";

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
  wallHead: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  },
  wallTitle: {
    marginRight: "auto",
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
  },
  wallActions: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
  wallEmpty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "10px",
    padding: "40px 16px",
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
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
  waitingPermissions: readonly SessionEvent[];
  attentionOnly: boolean;
  onAttentionOnlyChange: (value: boolean) => void;
  /** Always present, even with no runs: it is a destination, not a result. */
  orchestrator: {
    started: boolean;
    summary: OrchestratorSummary;
    onOpen: () => void;
  };
  onOpen: (sessionId: string) => void;
  onPermission: (
    sessionId: string,
    requestId: string,
    outcome: "allow_once" | "deny",
    optionId?: string,
  ) => void;
  onNewSession: () => void;
  workspaces: Workspace[];
  placements: Placement[];
};

export const SessionGrid = ({
  sessions,
  nodes,
  events,
  waitingPermissions,
  attentionOnly,
  onAttentionOnlyChange,
  orchestrator,
  onOpen,
  onPermission,
  onNewSession,
  workspaces,
  placements,
}: SessionGridProps) => {
  const styles = useStyles();
  const [dropTarget, setDropTarget] = useState<{ key: string; edge: DropEdge }>();
  const { reorderSessions, reorderWorkspaces } = useCatalog();
  const blocked = useMemo(
    () => new Set(waitingPermissions.map((event) => event.sessionId)),
    [waitingPermissions],
  );
  // Grid mode is the same fleet seen a different way, so it is grouped from the
  // same catalog order the tree uses. Left to infer the order from the sessions
  // alone, it disagreed with the sidebar the moment either list was rearranged.
  const groups = useMemo(() => {
    const shown = attentionOnly
      ? sessions.filter((session) => blocked.has(session.id))
      : sessions;
    return groupSessionsByWorkspace(shown, nodes, workspaces, placements)
      .filter((group) => group.nodes.length > 0)
      .map((group) => ({
        ...group,
        nodes: group.nodes.map((nodeGroup) => ({
          ...nodeGroup,
          // Whatever is blocking an agent goes first in its own group; it is
          // the only thing on this wall that cannot progress without a person.
          sessions: [...nodeGroup.sessions].sort(
            (a, b) => Number(blocked.has(b.id)) - Number(blocked.has(a.id)),
          ),
        })),
      }));
  }, [sessions, nodes, workspaces, placements, attentionOnly, blocked]);

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

  const visibleCount = groups.reduce(
    (total, group) =>
      total + group.nodes.reduce((sum, nodeGroup) => sum + nodeGroup.sessions.length, 0),
    0,
  );

  return (
    <section className={styles.wall} aria-label="Run overview">
      <header className={styles.wallHead}>
        <Text as="h1" className={styles.wallTitle}>
          Overview
        </Text>
        <div className={styles.wallActions}>
          <Switch
            checked={attentionOnly}
            label="Needs me only"
            onChange={(_, data) => onAttentionOnlyChange(data.checked)}
          />
          <Button appearance="primary" icon={<Add20Regular />} onClick={onNewSession}>
            New session
          </Button>
        </div>
      </header>

      <OrchestratorOverviewEntry {...orchestrator} />

      {/*
        The empty state sits inside the wall rather than replacing it. Swapping
        the whole page out took the orchestrator entry with it, which is how a
        fleet doing nothing but orchestrated work looked like a fleet with
        nowhere to go.
      */}
      {visibleCount === 0 ? (
        <div className={styles.wallEmpty}>
          <Text>
            {attentionOnly
              ? "Nothing is waiting on you."
              : "No sessions of your own yet."}
          </Text>
          {attentionOnly ? (
            <Button appearance="subtle" onClick={() => onAttentionOnlyChange(false)}>
              Show all
            </Button>
          ) : (
            <Button appearance="subtle" onClick={onNewSession}>
              Start one
            </Button>
          )}
        </div>
      ) : (
        groups.map((group) => {
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
                        awaitingPermission={blocked.has(session.id)}
                        onOpen={onOpen}
                        onPermission={onPermission}
                      />
                    </div>
                  )),
                )}
              </div>
            </section>
          );
        })
      )}
    </section>
  );
};

const useEntryStyles = makeStyles({
  entry: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    width: "100%",
    minHeight: "64px",
    padding: "12px 16px",
    marginBottom: "14px",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    ":hover": {
      ...shorthands.borderColor(tokens.colorNeutralStroke1),
      background: tokens.colorNeutralBackground1Hover,
    },
  },
  attention: {
    ...shorthands.borderWidth("2px"),
    ...shorthands.borderColor(statusVisuals.attention.border),
    background: statusVisuals.attention.surface,
  },
  icon: { flexShrink: 0, color: semanticColors.interaction, fontSize: "20px" },
  body: {
    flexGrow: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  title: { fontWeight: tokens.fontWeightSemibold },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "11px",
  },
  attentionCopy: {
    color: statusVisuals.attention.foreground,
    fontWeight: tokens.fontWeightSemibold,
  },
});

/**
 * The way into the orchestrator from the wall.
 *
 * Fixed above the workspaces, and present whether or not there is anything to
 * show: the wall used to hide the sidebar entirely, which left no route to the
 * orchestrator at all and made the mode switch a one-way door.
 */
const OrchestratorOverviewEntry = ({
  started,
  summary,
  onOpen,
}: {
  started: boolean;
  summary: OrchestratorSummary;
  onOpen: () => void;
}) => {
  const styles = useEntryStyles();
  const attention = summary.needsYou > 0;
  return (
    <button
      type="button"
      className={mergeClasses(styles.entry, attention && styles.attention)}
      onClick={onOpen}
    >
      <Flow20Regular className={styles.icon} aria-hidden="true" />
      <span className={styles.body}>
        <span className={styles.title}>Orchestrator</span>
        <span className={styles.meta}>
          {!started
            ? "not started — open to start one"
            : summary.total === 0
              ? "no tasks yet"
              : `${summary.total} task${summary.total === 1 ? "" : "s"} · ${summary.running} running`}
          {attention && (
            <>
              {" · "}
              <span className={styles.attentionCopy}>{summary.needsYou} needs you</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
};
