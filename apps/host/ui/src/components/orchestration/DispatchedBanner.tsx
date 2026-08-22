import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import type { FleetSession, RunStep } from "@fleet/protocol";

const useStyles = makeStyles({
  banner: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 14px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground3,
  },
  text: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

export type DispatchedBannerProps = {
  session: FleetSession;
  step: RunStep | undefined;
  /** The task being returned to, when the operator came from one. */
  runName?: string | undefined;
  onBack: () => void;
};

/**
 * The way back out of a conversation opened from the orchestrator.
 *
 * Without one the only exit was the Orchestrator row in the sidebar, which
 * reads as navigating somewhere new rather than returning — and landed on the
 * front page rather than the task the operator had been looking at.
 */
export const DispatchedBanner = ({
  session,
  step,
  runName,
  onBack,
}: DispatchedBannerProps) => {
  const styles = useStyles();
  const role = session.runRole === "reviewer" ? "review" : "worker";
  return (
    <div className={styles.banner}>
      <Button size="small" appearance="subtle" onClick={onBack}>
        ← {runName ?? "Orchestrator"}
      </Button>
      <Text className={styles.text}>
        {step
          ? `${step.title} · ${step.category || role} · ${step.state}`
          : session.runRole === "lead"
            ? "The orchestrator's own conversation"
            : `Dispatched by the orchestrator (${role})`}
      </Text>
    </div>
  );
};
