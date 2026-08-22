import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  empty: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    padding: "40px",
    textAlign: "center",
  },
  lead: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold },
  body: { color: tokens.colorNeutralForeground3, maxWidth: "460px" },
});

export type StartOrchestratorProps = {
  canStart: boolean;
  onStart: () => void;
};

/** What the Orchestrator view shows before there is anything to talk to. */
export const StartOrchestrator = ({ canStart, onStart }: StartOrchestratorProps) => {
  const styles = useStyles();
  return (
    <section className={styles.empty} aria-label="Orchestrator">
      <Text className={styles.lead}>No orchestrator yet</Text>
      <Text className={styles.body}>
        An orchestrator is a session you talk to. It does not write code itself — you tell
        it what you want, and it starts agents on your machines to do it, then reports
        back when they finish. Ask it for a review and it sends one to the same checkout
        the work happened in.
      </Text>
      <Button appearance="primary" disabled={!canStart} onClick={onStart}>
        Start orchestrator
      </Button>
      {!canStart && (
        <Text className={styles.body}>
          No online node holds a workspace yet, so there would be nowhere to send work.
        </Text>
      )}
    </section>
  );
};
