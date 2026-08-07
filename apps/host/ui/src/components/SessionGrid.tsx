import { makeStyles, tokens } from "@fluentui/react-components";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
import { EmptySessions } from "./EmptySessions";
import { SessionTile } from "./SessionTile";

// Shared so a session without events keeps the same array identity between
// renders and its tile can memoise the derived preview.
const noEvents: SessionEvent[] = [];

const useStyles = makeStyles({
  grid: {
    flexGrow: 1,
    minWidth: 0,
    overflowY: "auto",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    alignContent: "start",
    gap: "14px",
    padding: "16px",
    background: tokens.colorNeutralBackground1,
  },
});

type SessionGridProps = {
  sessions: FleetSession[];
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
  events,
  onOpen,
  onPermission,
  onNewSession,
}: SessionGridProps) => {
  const styles = useStyles();

  if (sessions.length === 0) return <EmptySessions onNewSession={onNewSession} />;

  return (
    <section className={styles.grid} aria-label="Session monitor">
      {sessions.map((session) => (
        <SessionTile
          key={session.id}
          session={session}
          events={events[session.id] ?? noEvents}
          onOpen={onOpen}
          onPermission={onPermission}
        />
      ))}
    </section>
  );
};
