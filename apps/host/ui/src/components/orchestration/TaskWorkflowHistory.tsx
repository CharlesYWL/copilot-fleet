import { useState } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { ChevronRight16Regular, Open16Regular } from "@fluentui/react-icons";
import type { FleetSession, RunNote } from "@fleet/protocol";
import { MarkdownBody } from "../MarkdownBody";
import { terminal } from "../../theme";

const useStyles = makeStyles({
  root: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "12px",
    backgroundColor: tokens.colorNeutralBackground1,
    overflowWrap: "anywhere",
  },
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "16px 20px",
    border: 0,
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  title: { fontSize: "13px", fontWeight: tokens.fontWeightSemibold },
  count: {
    fontFamily: terminal.font,
    fontSize: "10px",
    color: tokens.colorNeutralForeground3,
  },
  list: {
    listStyleType: "none",
    margin: 0,
    padding: "0 20px 16px",
    display: "grid",
    gap: "16px",
  },
  entry: {
    display: "grid",
    gridTemplateColumns: "130px minmax(0, 1fr)",
    gap: "16px",
    "@media (max-width: 640px)": { gridTemplateColumns: "1fr", gap: "4px" },
  },
  time: {
    fontFamily: terminal.font,
    color: tokens.colorNeutralForeground3,
    fontSize: "10px",
    paddingTop: "3px",
  },
  content: {
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: "16px",
    minWidth: 0,
  },
  summary: { margin: 0, fontSize: "13px", fontWeight: tokens.fontWeightSemibold },
  metadata: {
    margin: "4px 0 8px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
  },
  details: { marginTop: "8px" },
  body: {
    marginTop: "12px",
    padding: "12px 16px",
    borderRadius: "8px",
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: "13px",
    lineHeight: "1.6",
  },
  empty: { margin: 0, padding: "0 20px 16px", color: tokens.colorNeutralForeground3 },
});

const kinds = {
  progress: "Progress",
  review: "Review",
  blocked: "Blocker",
  decision: "Decision",
  worker: "Worker result",
  lifecycle: "Task update",
};
const sources = {
  orchestrator: "Orchestrator",
  worker: "Worker",
  operator: "Operator",
  system: "Fleet",
};

export function TaskWorkflowHistory({
  notes,
  phases,
  sessions,
  onOpenWorker,
}: {
  notes: readonly RunNote[];
  phases: readonly string[];
  sessions: readonly FleetSession[];
  onOpenWorker: (sessionId: string) => void;
}) {
  const styles = useStyles();
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleEntry = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section className={styles.root} aria-label="Workflow history">
      <button
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight16Regular
          aria-hidden
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        />
        <span className={styles.title}>Workflow history</span>
        <span className={styles.count}>
          {notes.length} {notes.length === 1 ? "update" : "updates"}
        </span>
      </button>
      {open ? (
        notes.length ? (
          <ol className={styles.list}>
            {[...notes].reverse().map((note) => {
              const session = note.sessionId
                ? sessionById.get(note.sessionId)
                : undefined;
              return (
                <li className={styles.entry} key={note.id}>
                  <time
                    className={styles.time}
                    dateTime={note.createdAt}
                    title={new Date(note.createdAt).toLocaleString()}
                  >
                    {new Date(note.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                  <div className={styles.content}>
                    <p className={styles.summary}>
                      {note.summary ||
                        (phases[note.phaseIndex]
                          ? `${phases[note.phaseIndex]} update`
                          : "Recorded task update")}
                    </p>
                    <p className={styles.metadata}>
                      {note.kind ? kinds[note.kind] : "Original note"}
                      {note.source ? ` · ${sources[note.source]}` : ""}
                      {phases[note.phaseIndex] ? ` · ${phases[note.phaseIndex]}` : ""}
                    </p>
                    <div className={styles.details}>
                      <Button
                        appearance="subtle"
                        size="small"
                        aria-expanded={expanded.has(note.id)}
                        onClick={() => toggleEntry(note.id)}
                      >
                        {note.kind === "worker"
                          ? "Work result and response"
                          : "Original report and details"}
                      </Button>
                      {expanded.has(note.id) ? (
                        <div className={styles.body}>
                          <MarkdownBody text={note.body} copyable />
                          {session && note.kind === "worker" ? (
                            <Button
                              appearance="subtle"
                              size="small"
                              icon={<Open16Regular />}
                              onClick={() => onOpenWorker(session.id)}
                            >
                              Open {session.name || "session"}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className={styles.empty}>No checkpoints have been recorded yet.</p>
        )
      ) : null}
    </section>
  );
}
