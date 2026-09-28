import { useState } from "react";
import { shorthands, Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import {
  ChevronDown20Regular,
  ChevronRight20Regular,
  Open16Regular,
} from "@fluentui/react-icons";
import type { FleetSession, RunStep } from "@fleet/protocol";
import { terminal } from "../../theme";
import { stepStatusDescriptor } from "../../lib/run-step-status";
import { StatusIndicator } from "../StatusIndicator";
import { relativeTime } from "./OrchestratorRunList";
import { StepAdmissionLine } from "./StepAdmissionLine";

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
  title: {
    minWidth: 0,
    overflowWrap: "anywhere",
    fontWeight: tokens.fontWeightSemibold,
  },
  identity: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    gap: "5px",
  },
  node: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
    overflowWrap: "anywhere",
  },
  status: { flexShrink: 0, maxWidth: "110px", fontSize: "11px" },
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
  admission: { padding: "0 12px 10px 30px" },
});

export type WorkerStepTimelineProps = {
  steps: RunStep[];
  phases: readonly string[];
  sessions: readonly FleetSession[];
  awaitingPermissionSessionId?: string;
  onOpenWorker: (sessionId: string) => void;
  /** Asks the Host to resume a queued follow-up now; it decides whether that needs approval. */
  onResumeNow?: ((step: RunStep) => Promise<unknown> | void) | undefined;
  /** Reopens a pending "Resume now" approval that was put off. */
  onReviewApproval?: ((requestId: string) => void) | undefined;
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
  awaitingPermissionSessionId,
  onOpenWorker,
  onResumeNow,
  onReviewApproval,
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
        const status = stepStatusDescriptor(
          step.state,
          session,
          Boolean(step.sessionId && step.sessionId === awaitingPermissionSessionId),
          step.admission,
        );
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
              <span className={styles.identity}>
                <span className={styles.title}>{session?.name || step.title}</span>
                <span className={styles.node}>
                  {session
                    ? session.nodeName
                    : step.sessionId
                      ? "Session no longer available"
                      : "Not dispatched"}
                </span>
              </span>
              <span className={styles.status}>
                <StatusIndicator descriptor={status} wrap />
              </span>
            </button>
            {step.admission && step.admission.state !== "running" && (
              <div className={styles.admission}>
                <StepAdmissionLine
                  step={step}
                  onResumeNow={onResumeNow}
                  onReviewApproval={onReviewApproval}
                />
              </div>
            )}
            {expanded && (
              <div className={styles.body}>
                {session?.name && session.name !== step.title ? (
                  <Text>{step.title}</Text>
                ) : null}
                <div className={styles.facts}>
                  {phases[step.phaseIndex] ? (
                    <span className={styles.phaseTag}>{phases[step.phaseIndex]}</span>
                  ) : null}
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
