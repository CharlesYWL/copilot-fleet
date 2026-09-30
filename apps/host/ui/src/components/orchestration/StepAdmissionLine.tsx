import { useState } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowClockwise16Regular, ShieldTask16Regular } from "@fluentui/react-icons";
import type { RunStep } from "@fleet/protocol";
import { terminal } from "../../theme";
import { admissionStateLabels, canResumeNow } from "../../lib/worker-resume";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px 10px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
  },
  heading: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
  state: { fontWeight: tokens.fontWeightSemibold },
  code: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  detail: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  conflicts: {
    margin: 0,
    paddingLeft: "18px",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
});

export type StepAdmissionLineProps = {
  step: RunStep;
  onResumeNow?: ((step: RunStep) => Promise<unknown> | void) | undefined;
  onReviewApproval?: ((requestId: string) => void) | undefined;
};

/**
 * What a queued or starting step is waiting on, as the Host's scheduler says.
 *
 * "Resume now" asks the Host; it never launches anything by itself. Ordinary
 * scheduling answers first, and only a follow-up held back by a Node's reserved
 * slot turns into an approval an authenticated operator decides.
 */
export const StepAdmissionLine = ({
  step,
  onResumeNow,
  onReviewApproval,
}: StepAdmissionLineProps) => {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const admission = step.admission;
  if (!admission || admission.state === "running") return null;
  const resumable = Boolean(onResumeNow) && canResumeNow(step);
  const requestId = admission.requestId;
  return (
    <div className={styles.root} role="status" aria-label="Scheduling status">
      <div className={styles.heading}>
        <Text className={styles.state}>{admissionStateLabels[admission.state]}</Text>
        <Text className={styles.code}>{admission.code}</Text>
        {step.attempts > 1 && (
          <Text className={styles.code}>queued follow-up · attempt {step.attempts}</Text>
        )}
      </div>
      <Text className={styles.detail}>{admission.detail}</Text>
      {admission.conflicts.length > 0 && (
        <ul className={styles.conflicts} aria-label="Sessions involved">
          {admission.conflicts.map((conflict) => (
            <li key={conflict.sessionId}>
              {conflict.name || conflict.sessionId} ({conflict.state || "unknown"})
              {conflict.taskName
                ? ` · task “${conflict.taskName}”${conflict.sameTask ? " (this task)" : ""}`
                : conflict.role
                  ? ` · ${conflict.role}`
                  : " · not managed by a task"}
            </li>
          ))}
        </ul>
      )}
      {(resumable || (admission.state === "awaiting_approval" && requestId)) && (
        <div className={styles.actions}>
          {resumable && (
            <Button
              size="small"
              appearance="primary"
              icon={<ArrowClockwise16Regular />}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void Promise.resolve(onResumeNow?.(step)).finally(() => setBusy(false));
              }}
            >
              Resume now
            </Button>
          )}
          {admission.state === "awaiting_approval" && requestId && onReviewApproval && (
            <Button
              size="small"
              icon={<ShieldTask16Regular />}
              onClick={() => onReviewApproval(requestId)}
            >
              Review approval
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
