import {
  shorthands,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type { RunViewModel } from "../../lib/orchestration-view";
import { awaitingPlan, currentPhase } from "../../lib/orchestration-view";
import { semanticColors, statusVisuals, terminal } from "../../theme";
import { RunStatusIndicator, runVisual } from "./RunStatusIndicator";
import { WorkerLinks } from "./WorkerLinks";

const useStyles = makeStyles({
  card: {
    position: "relative",
    width: "100%",
    minHeight: "116px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "10px",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    textAlign: "left",
    ":hover": {
      ...shorthands.borderColor(tokens.colorNeutralStroke1),
      background: tokens.colorNeutralBackground1Hover,
    },
    /*
     * The ring belongs to the card, not to the word inside it.
     *
     * The whole card is one target, reached through the title's overlay, so a
     * ring drawn tightly around the title would point at the wrong thing.
     */
    ":focus-within": {
      ...shorthands.borderColor(semanticColors.interaction),
    },
  },
  /**
   * The card's primary target.
   *
   * Stretched over the whole card with a pseudo-element rather than by making
   * the card itself a button, because the card also carries links to the
   * sessions it dispatched — and a button inside a button is neither valid nor
   * reachable.
   */
  open: {
    ...shorthands.border("none"),
    padding: 0,
    background: "none",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: "1.4",
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    ":focus": { outlineStyle: "none" },
    "::after": { content: '""', position: "absolute", inset: 0, borderRadius: "inherit" },
  },
  attention: {
    ...shorthands.borderWidth("2px"),
    ...shorthands.borderColor(statusVisuals.attention.border),
    background: statusVisuals.attention.surface,
  },
  selected: {
    ...shorthands.borderColor(semanticColors.interaction),
    boxShadow: `inset 2px 0 ${semanticColors.interaction}`,
  },
  kicker: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  workers: { marginTop: "2px" },
  detail: {
    margin: 0,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.45",
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  foot: {
    marginTop: "auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  progress: { display: "flex", gap: "2px", width: "52px", flexShrink: 0 },
  pip: { flexGrow: 1, height: "3px", background: tokens.colorNeutralStroke2 },
  pipDone: { background: semanticColors.completed },
  pipNow: { background: semanticColors.interaction },
});

export type RunCardProps = {
  model: RunViewModel;
  selected?: boolean;
  onOpen: () => void;
  /** Opens one of the sessions this task has dispatched. */
  onOpenWorker?: ((sessionId: string) => void) | undefined;
};

/**
 * One task, wherever tasks are shown as cards.
 *
 * Clicking anywhere opens the task; the title carries that target and stretches
 * over the card. The card is not itself a button because it also lists the
 * sessions the task dispatched, and those have to be reachable in their own
 * right — every dispatched step is a real session with a real transcript, and
 * making a person open the task first to reach one was a step for nothing.
 */
export const RunCard = ({
  model,
  selected = false,
  onOpen,
  onOpenWorker,
}: RunCardProps) => {
  const styles = useStyles();
  const { run } = model;
  const attention = Boolean(model.attention);
  const phase = currentPhase(run);
  const visual = runVisual(model);

  return (
    <article
      className={mergeClasses(
        styles.card,
        attention && styles.attention,
        selected && styles.selected,
      )}
      onClick={onOpen}
    >
      <span className={styles.kicker}>
        <span>{run.workspaceId ? phase || run.state : run.state}</span>
        <RunStatusIndicator model={model} />
      </span>
      <button
        type="button"
        className={styles.open}
        aria-label={`${run.name} — ${visual.label}`}
        onClick={(event) => {
          // The card handles the click; without this the title fires it twice.
          event.stopPropagation();
          onOpen();
        }}
      >
        {run.name}
      </button>
      {run.objective && run.objective !== run.name && (
        <p className={styles.detail}>{run.objective}</p>
      )}
      {onOpenWorker && (
        <WorkerLinks
          className={styles.workers}
          steps={model.steps}
          max={2}
          onOpenWorker={onOpenWorker}
          onOpenMore={onOpen}
        />
      )}
      <span className={styles.foot}>
        {run.phases.length > 0 ? (
          <span
            className={styles.progress}
            role="img"
            aria-label={`Phase ${Math.min(run.phaseIndex + 1, run.phases.length)} of ${run.phases.length}`}
          >
            {run.phases.map((name, index) => (
              <i
                key={name + String(index)}
                className={mergeClasses(
                  styles.pip,
                  index < run.phaseIndex && styles.pipDone,
                  index === run.phaseIndex && styles.pipNow,
                )}
              />
            ))}
          </span>
        ) : (
          <span>{model.placement?.nodeName ?? ""}</span>
        )}
        <span>
          {awaitingPlan(model)
            ? "waiting to be planned"
            : model.totalSteps === 0
              ? "no steps yet"
              : `${model.completedSteps}/${model.totalSteps} steps`}
        </span>
      </span>
    </article>
  );
};

/** The one-line form, for the empty column caption. */
export const RunCardEmpty = ({ label }: { label: string }) => {
  const styles = useStyles();
  return <Text className={styles.detail}>{label}</Text>;
};
