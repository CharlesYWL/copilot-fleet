import { shorthands, Text, makeStyles, tokens } from "@fluentui/react-components";
import {
  ORCHESTRATION_STAGES,
  STAGE_LABELS,
  type OrchestrationStage,
  type RunViewModel,
} from "../../lib/orchestration-view";
import { terminal } from "../../theme";
import { RunCard } from "./RunCard";

const useStyles = makeStyles({
  board: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(190px, 1fr))",
    gap: "10px",
    // The board keeps its four columns and scrolls inside its own surface;
    // the page itself must never scroll sideways.
    minWidth: "820px",
  },
  column: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
    overflow: "hidden",
  },
  head: {
    height: "38px",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "0 10px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
    fontWeight: tokens.fontWeightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  count: { fontFamily: terminal.font, fontSize: "10px" },
  body: { display: "grid", gap: "7px", padding: "7px", alignContent: "start" },
  empty: {
    padding: "18px 8px",
    color: tokens.colorNeutralForeground4,
    textAlign: "center",
    fontSize: tokens.fontSizeBase200,
  },
});

export type OrchestratorStageBoardProps = {
  models: RunViewModel[];
  selectedRunId?: string | undefined;
  onOpenRun: (runId: string) => void;
  onOpenWorker: (sessionId: string) => void;
};

/**
 * Tasks arranged by how far along they are.
 *
 * The models arrive already sorted by attention, so taking them in order per
 * column puts whatever needs a person at the top of the column it is in — no
 * second sort, and no chance of the two orders disagreeing.
 */
export const OrchestratorStageBoard = ({
  models,
  selectedRunId,
  onOpenRun,
  onOpenWorker,
}: OrchestratorStageBoardProps) => {
  const styles = useStyles();
  const byStage = new Map<OrchestrationStage, RunViewModel[]>();
  for (const stage of ORCHESTRATION_STAGES) byStage.set(stage, []);
  for (const model of models) byStage.get(model.stage)?.push(model);

  return (
    <div className={styles.board}>
      {ORCHESTRATION_STAGES.map((stage) => {
        const column = byStage.get(stage) ?? [];
        return (
          <section
            key={stage}
            className={styles.column}
            aria-label={`${STAGE_LABELS[stage]}, ${column.length} tasks`}
          >
            <header className={styles.head}>
              <span>{STAGE_LABELS[stage]}</span>
              <span className={styles.count}>{column.length}</span>
            </header>
            <div className={styles.body}>
              {column.length === 0 ? (
                <Text className={styles.empty}>Nothing here</Text>
              ) : (
                column.map((model) => (
                  <RunCard
                    key={model.run.id}
                    model={model}
                    selected={model.run.id === selectedRunId}
                    onOpen={() => onOpenRun(model.run.id)}
                    onOpenWorker={onOpenWorker}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
};
