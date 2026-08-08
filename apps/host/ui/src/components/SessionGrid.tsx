import { useMemo } from "react";
import { Text, makeStyles, tokens } from "@fluentui/react-components";
import { Folder20Regular } from "@fluentui/react-icons";
import type { FleetNode, FleetSession, SessionEvent } from "@fleet/protocol";
import { groupSessionsByWorkspace } from "../lib/session-groups";
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
};

export const SessionGrid = ({
  sessions,
  nodes,
  events,
  onOpen,
  onPermission,
  onNewSession,
}: SessionGridProps) => {
  const styles = useStyles();
  const groups = useMemo(
    () =>
      groupSessionsByWorkspace(sessions, nodes).filter((group) => group.nodes.length > 0),
    [sessions, nodes],
  );

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
            <div className={styles.head}>
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
                  <SessionTile
                    key={session.id}
                    session={session}
                    events={events[session.id] ?? noEvents}
                    onOpen={onOpen}
                    onPermission={onPermission}
                  />
                )),
              )}
            </div>
          </section>
        );
      })}
    </section>
  );
};
