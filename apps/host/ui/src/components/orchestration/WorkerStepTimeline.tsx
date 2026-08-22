import { useState } from "react";
import {
  shorthands,
  Button,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ChevronDown20Regular,
  ChevronRight20Regular,
  Open16Regular,
} from "@fluentui/react-icons";
import type { FleetSession, RunStep } from "@fleet/protocol";
import { semanticColors, statusVisuals, terminal } from "../../theme";
import { relativeTime } from "./OrchestratorRunList";

const useStyles = makeStyles({
  list: { display: "grid", gap: "8px", listStyle: "none", margin: 0, padding: 0 },
  item: {
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
    overflow: "hidden",
  },
  summary: {
    width: "100%",
    minHeight: "44px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 12px",
    ...shorthands.borderStyle("none"),
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    ":hover": { background: tokens.colorNeutralBackground1Hover },
  },
  dot: { width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0 },
  title: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: tokens.fontWeightSemibold,
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
    whiteSpace: "nowrap",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "0 12px 12px 30px",
  },
  facts: { display: "flex", gap: "16px", flexWrap: "wrap" },
  output: {
    margin: 0,
    maxHeight: "260px",
    overflow: "auto",
    padding: "10px",
    borderRadius: tokens.borderRadiusSmall,
    background: terminal.background,
    color: tokens.colorNeutralForeground2,
    fontFamily: terminal.font,
    fontSize: "11px",
    lineHeight: "1.55",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  phaseTag: {
    padding: "1px 6px",
    borderRadius: tokens.borderRadiusSmall,
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
    whiteSpace: "nowrap",
  },
});

const stepColour = (step: RunStep): string => {
  if (step.state === "succeeded") return statusVisuals.success.foreground;
  if (step.state === "failed" || step.state === "cancelled") {
    return statusVisuals.danger.foreground;
  }
  if (step.state === "running" || step.state === "starting") {
    return semanticColors.interaction;
  }
  return statusVisuals.neutral.foreground;
};

export type WorkerStepTimelineProps = {
  steps: RunStep[];
  phases: readonly string[];
  sessions: readonly FleetSession[];
  onOpenWorker: (sessionId: string) => void;
};

/**
 * What was sent out for this task, in the order it went.
 *
 * Collapsed by default: a settled step's headline is usually enough, and a
 * page of expanded outputs buries the one that is still running. Opening one
 * shows where it ran and what it said, which is the answer to "why did the
 * orchestrator decide that" without leaving for a transcript.
 */
export const WorkerStepTimeline = ({
  steps,
  phases,
  sessions,
  onOpenWorker,
}: WorkerStepTimelineProps) => {
  const styles = useStyles();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const sessionById = new Map(sessions.map((session) => [session.id, session]));

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (steps.length === 0) {
    return (
      <Text className={styles.meta}>Nothing has been dispatched in this task yet.</Text>
    );
  }

  return (
    <ul className={styles.list}>
      {steps.map((step) => {
        const expanded = open.has(step.id);
        const session = step.sessionId ? sessionById.get(step.sessionId) : undefined;
        const Chevron = expanded ? ChevronDown20Regular : ChevronRight20Regular;
        return (
          <li key={step.id} className={styles.item}>
            <button
              type="button"
              className={styles.summary}
              aria-expanded={expanded}
              onClick={() => toggle(step.id)}
            >
              <Chevron aria-hidden="true" />
              <span
                className={styles.dot}
                style={{ background: stepColour(step) }}
                aria-hidden="true"
              />
              <span className={styles.title}>{step.title}</span>
              {phases[step.phaseIndex] && (
                <span className={styles.phaseTag}>{phases[step.phaseIndex]}</span>
              )}
              <span className={styles.meta}>
                {step.category || "step"} · {step.state}
              </span>
            </button>
            {expanded && (
              <div className={styles.body}>
                <div className={styles.facts}>
                  <Text className={styles.meta}>
                    {session
                      ? `${session.nodeName} · ${session.workspaceName}`
                      : "not dispatched"}
                  </Text>
                  <Text className={styles.meta}>
                    updated {relativeTime(step.updatedAt)}
                  </Text>
                  {step.attempts > 1 && (
                    <Text className={styles.meta}>attempt {step.attempts}</Text>
                  )}
                </div>
                {step.output ? (
                  <pre className={styles.output}>{step.output}</pre>
                ) : (
                  <Text className={styles.meta}>No output recorded yet.</Text>
                )}
                {/*
                  Offered only while the session is still there. Archiving a
                  task removes its sessions, and a step keeps the id of one that
                  is gone — a button that led nowhere would be worse than saying
                  so. What the step produced is on the step itself, above.
                */}
                {step.sessionId && session && (
                  <div>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Open16Regular />}
                      onClick={() => onOpenWorker(step.sessionId)}
                    >
                      Open transcript
                    </Button>
                  </div>
                )}
                {step.sessionId && !session && (
                  <Text className={styles.meta}>
                    Its session has been cleared away; the output above is what it left.
                  </Text>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export { stepColour };
export const timelineClasses = mergeClasses;
