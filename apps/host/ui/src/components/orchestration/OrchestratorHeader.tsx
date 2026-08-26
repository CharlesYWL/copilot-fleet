import {
  Button,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { Add20Regular, Chat20Regular } from "@fluentui/react-icons";
import type { OrchestratorSummary } from "../../lib/orchestration-view";
import { STAGE_LABELS } from "../../lib/orchestration-view";
import { semanticColors, terminal } from "../../theme";

const useStyles = makeStyles({
  head: {
    flexShrink: 0,
    display: "flex",
    alignItems: "flex-start",
    gap: "16px",
    flexWrap: "wrap",
    padding: "16px 20px 12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  titles: {
    minWidth: 0,
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  eyebrow: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: tokens.fontSizeBase200,
  },
  title: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold },
  actions: { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 },
  counts: {
    display: "flex",
    alignItems: "center",
    gap: "18px",
    flexWrap: "wrap",
    padding: "10px 20px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  count: { display: "flex", alignItems: "baseline", gap: "6px" },
  countValue: {
    fontFamily: terminal.font,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
  },
  countLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  attention: { color: semanticColors.permission },
});

export type OrchestratorHeaderProps = {
  summary: OrchestratorSummary;
  canCreateRun: boolean;
  onNewRun: () => void;
  onOpenLead: () => void;
};

/**
 * The one header the three task views share.
 *
 * Counts rather than budgets. "2 of 8 sessions" told an operator how much of a
 * quota was spent, which is a number only the machine cares about; what they
 * are actually scanning for is whether anything is waiting on them.
 */
export const OrchestratorHeader = ({
  summary,
  canCreateRun,
  onNewRun,
  onOpenLead,
}: OrchestratorHeaderProps) => {
  const styles = useStyles();
  const stage = summary.dominantStage ? STAGE_LABELS[summary.dominantStage] : "";
  return (
    <>
      <header className={styles.head}>
        <div className={styles.titles}>
          <Text className={styles.eyebrow}>
            {summary.total === 0
              ? "No tasks yet"
              : `${summary.total} task${summary.total === 1 ? "" : "s"}${
                  stage ? ` · mostly ${stage.toLowerCase()}` : ""
                }`}
          </Text>
          <Text as="h1" className={styles.title}>
            Orchestrator
          </Text>
        </div>
        <div className={styles.actions}>
          <Button
            appearance="subtle"
            icon={<Chat20Regular />}
            title="The orchestrator's own chat. Ask it anything — including for new work."
            onClick={onOpenLead}
          >
            Conversation
          </Button>
          <Button
            appearance="primary"
            icon={<Add20Regular />}
            title={
              canCreateRun
                ? "Record a task, then ask the orchestrator in its conversation to plan it."
                : "Resume the orchestrator before starting another task."
            }
            disabled={!canCreateRun}
            onClick={onNewRun}
          >
            New task
          </Button>
        </div>
      </header>
      <div
        className={styles.counts}
        role="status"
        aria-live="polite"
        aria-label={`${summary.total} tasks, ${summary.running} running, ${summary.needsYou} needing you`}
      >
        <span className={styles.count}>
          <span className={styles.countValue}>{summary.total}</span>
          <Text className={styles.countLabel}>all</Text>
        </span>
        <span className={styles.count}>
          <span className={styles.countValue}>{summary.running}</span>
          <Text className={styles.countLabel}>running</Text>
        </span>
        <span
          className={mergeClasses(styles.count, summary.needsYou > 0 && styles.attention)}
        >
          <span className={styles.countValue}>{summary.needsYou}</span>
          <Text
            className={mergeClasses(
              styles.countLabel,
              summary.needsYou > 0 && styles.attention,
            )}
          >
            needs you
          </Text>
        </span>
      </div>
    </>
  );
};
