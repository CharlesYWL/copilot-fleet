import {
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { Flow16Regular } from "@fluentui/react-icons";
import type { RunStep } from "@fleet/protocol";
import { semanticColors, terminal } from "../../theme";

const stepColor: Record<string, string> = {
  pending: terminal.dim,
  starting: semanticColors.permission,
  running: semanticColors.running,
  succeeded: semanticColors.completed,
  failed: semanticColors.failed,
  skipped: terminal.dim,
  cancelled: terminal.dim,
};

const useStyles = makeStyles({
  row: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexWrap: "wrap",
    /*
     * Above the card's click overlay.
     *
     * The card is clickable as a whole through a pseudo-element stretched over
     * it, so anything meant to be its own target has to sit on top of that.
     */
    position: "relative",
    zIndex: 1,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    maxWidth: "150px",
    padding: "2px 7px",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontFamily: terminal.font,
    fontSize: "10px",
    lineHeight: "16px",
    cursor: "pointer",
    ":hover": {
      ...shorthands.borderColor(semanticColors.interaction),
      color: tokens.colorNeutralForeground1,
    },
  },
  more: {
    fontFamily: terminal.font,
    fontSize: "10px",
    color: tokens.colorNeutralForeground3,
  },
  dot: { flexShrink: 0, fontSize: "12px" },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
});

export type WorkerLinksProps = {
  steps: readonly RunStep[];
  /** How many to show before collapsing the rest into a count. */
  max?: number;
  onOpenWorker: (sessionId: string) => void;
  /** Where "+N more" goes: the task, which lists all of them. */
  onOpenMore?: (() => void) | undefined;
  className?: string | undefined;
};

/** Steps that actually reached a machine, and so have something to read. */
export function dispatchedSteps(steps: readonly RunStep[]): RunStep[] {
  return steps.filter((step) => step.sessionId);
}

/**
 * The sessions a task has out, as links.
 *
 * Every dispatched step is a real session with a real transcript, and until
 * this existed the only way to reach one was to open the task first. A person
 * scanning the board for what is happening is usually looking for exactly that
 * transcript, so the board should be able to hand it over directly.
 */
export const WorkerLinks = ({
  steps,
  max = 3,
  onOpenWorker,
  onOpenMore,
  className,
}: WorkerLinksProps) => {
  const styles = useStyles();
  const dispatched = dispatchedSteps(steps);
  if (dispatched.length === 0) return null;

  const shown = dispatched.slice(0, max);
  const hidden = dispatched.length - shown.length;

  return (
    <span className={mergeClasses(styles.row, className)}>
      {shown.map((step) => (
        <Tooltip
          key={step.id}
          relationship="label"
          content={`${step.title} · ${step.category || "step"} · ${step.state}`}
          withArrow
        >
          <button
            type="button"
            className={styles.chip}
            onClick={(event) => {
              event.stopPropagation();
              onOpenWorker(step.sessionId);
            }}
          >
            <Flow16Regular
              className={styles.dot}
              style={{ color: stepColor[step.state] ?? terminal.dim }}
              aria-hidden="true"
            />
            <span className={styles.label}>{step.title}</span>
          </button>
        </Tooltip>
      ))}
      {hidden > 0 &&
        (onOpenMore ? (
          <button
            type="button"
            className={styles.chip}
            onClick={(event) => {
              event.stopPropagation();
              onOpenMore();
            }}
          >
            <span className={styles.label}>+{hidden} more</span>
          </button>
        ) : (
          <span className={styles.more}>+{hidden} more</span>
        ))}
    </span>
  );
};
