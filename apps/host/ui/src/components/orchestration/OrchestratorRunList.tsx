import { makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import {
  STAGE_LABELS,
  currentPhase,
  type RunViewModel,
} from "../../lib/orchestration-view";
import { semanticColors, statusVisuals, terminal } from "../../theme";
import { RunCard } from "./RunCard";
import { RunStatusIndicator } from "./RunStatusIndicator";
import { WorkerLinks } from "./WorkerLinks";

const NARROW = "@media (max-width: 900px)";

const useStyles = makeStyles({
  table: {
    width: "100%",
    borderCollapse: "collapse",
    [NARROW]: { display: "none" },
  },
  th: {
    padding: "10px 11px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    textAlign: "left",
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
    letterSpacing: "0.07em",
    fontWeight: tokens.fontWeightRegular,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "10px 11px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    verticalAlign: "top",
  },
  row: {
    cursor: "pointer",
    ":hover": { background: tokens.colorNeutralBackground1Hover },
    ":focus-within": { background: tokens.colorNeutralBackground1Hover },
  },
  attentionRow: { background: statusVisuals.attention.surface },
  selected: {
    background: tokens.colorNeutralBackground3,
    boxShadow: `inset 2px 0 ${semanticColors.interaction}`,
  },
  /**
   * The row's target, as a real button.
   *
   * The row used to carry `role="button"` itself, which tells a screen reader a
   * table row is a button and takes the table's own semantics with it. A button
   * in the first cell keeps both, and the cell is positioned so the button can
   * stretch across the row for the mouse.
   */
  nameCell: { position: "relative" },
  open: {
    ...shorthands.border("none"),
    padding: 0,
    background: "none",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    fontWeight: tokens.fontWeightSemibold,
    "::after": { content: '""', position: "absolute", inset: 0 },
  },
  sub: {
    display: "block",
    marginTop: "3px",
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  mono: { fontFamily: terminal.font, fontSize: "11px", whiteSpace: "nowrap" },
  /** Below the table's comfortable width the same rows become cards. */
  cards: {
    display: "none",
    [NARROW]: { display: "grid", gap: "8px" },
  },
  empty: {
    padding: "40px 12px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
});

export type OrchestratorRunListProps = {
  models: RunViewModel[];
  selectedRunId?: string | undefined;
  onOpenRun: (runId: string) => void;
  onOpenWorker: (sessionId: string) => void;
};

/**
 * Tasks as rows, for comparing them rather than tracking one.
 *
 * A real table on a wide screen, because that is what the columns are for, and
 * the same rows as cards below the width where those columns would have to be
 * squeezed into something unreadable.
 */
export const OrchestratorRunList = ({
  models,
  selectedRunId,
  onOpenRun,
  onOpenWorker,
}: OrchestratorRunListProps) => {
  const styles = useStyles();

  if (models.length === 0) {
    return <p className={styles.empty}>No tasks yet.</p>;
  }

  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.th}>Task</th>
            <th className={styles.th}>Status</th>
            <th className={styles.th}>Stage</th>
            <th className={styles.th}>Dispatched work</th>
            <th className={styles.th}>Steps</th>
            <th className={styles.th}>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr
              key={model.run.id}
              className={mergeClasses(
                styles.row,
                Boolean(model.attention) && styles.attentionRow,
                model.run.id === selectedRunId && styles.selected,
              )}
              onClick={() => onOpenRun(model.run.id)}
            >
              <td className={mergeClasses(styles.td, styles.nameCell)}>
                <button
                  type="button"
                  className={styles.open}
                  aria-label={`Open ${model.run.name}`}
                  onClick={(event) => {
                    // The row handles the click; without this it fires twice.
                    event.stopPropagation();
                    onOpenRun(model.run.id);
                  }}
                >
                  {model.run.name}
                </button>
                <span className={styles.sub}>
                  {currentPhase(model.run) || model.run.objective}
                </span>
              </td>
              <td className={styles.td}>
                <RunStatusIndicator model={model} />
              </td>
              <td className={styles.td}>{STAGE_LABELS[model.stage]}</td>
              <td className={styles.td}>
                <WorkerLinks
                  steps={model.steps}
                  max={3}
                  onOpenWorker={onOpenWorker}
                  onOpenMore={() => onOpenRun(model.run.id)}
                />
              </td>
              <td className={mergeClasses(styles.td, styles.mono)}>
                {model.completedSteps} / {model.totalSteps}
              </td>
              <td className={mergeClasses(styles.td, styles.mono)}>
                {relativeTime(model.latestActivityAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.cards}>
        {models.map((model) => (
          <RunCard
            key={model.run.id}
            model={model}
            selected={model.run.id === selectedRunId}
            onOpen={() => onOpenRun(model.run.id)}
            onOpenWorker={onOpenWorker}
          />
        ))}
      </div>
    </>
  );
};

/** "4m ago", for a column too narrow to hold a timestamp. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
