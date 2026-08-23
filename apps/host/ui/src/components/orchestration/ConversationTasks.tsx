import {
  Button,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  Add16Regular,
  PanelRightContract20Regular,
  PanelRightExpand20Regular,
} from "@fluentui/react-icons";
import type { RunViewModel } from "../../lib/orchestration-view";
import { statusVisuals, terminal } from "../../theme";
import { RunCard } from "./RunCard";

/** How wide the list is when it is open; the rail beside it is always there. */
const WIDTH_VAR = "--fleet-conversation-tasks-width";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    minHeight: 0,
    flexShrink: 0,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    /*
     * The open width as a variable rather than as a rule on the list.
     *
     * The closed state has to beat it, and a plain `width: 0` cannot beat a
     * width set inside a media query — Griffel writes at-rules after the rules
     * they would override. Moving the responsive part onto a custom property
     * leaves both states as plain declarations, so the last class simply wins.
     */
    [WIDTH_VAR]: "300px",
    "@media (max-width: 1100px)": { [WIDTH_VAR]: "240px" },
  },
  /**
   * The one part that never folds away.
   *
   * A panel whose only way back is a control that went with it is a panel an
   * operator closes once and then reports as missing, so the handle keeps its
   * own column in both states and the list is what moves.
   */
  handle: {
    flexShrink: 0,
    width: "36px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "8px",
    padding: "8px 0",
  },
  /**
   * The collapsed rail's caption.
   *
   * Sideways because 36px is not enough for the word any other way, and a rail
   * with nothing but a chevron on it does not say what opening it would give
   * you.
   */
  railLabel: {
    writingMode: "vertical-rl",
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    userSelect: "none",
  },
  railCount: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
  },
  /** Amber only, and only for what a person has to act on. */
  attentionBadge: {
    minWidth: "18px",
    height: "18px",
    display: "grid",
    placeItems: "center",
    padding: "0 5px",
    borderRadius: "9px",
    background: statusVisuals.attention.surface,
    color: statusVisuals.attention.foreground,
    ...shorthands.border("1px", "solid", statusVisuals.attention.border),
    fontSize: "10px",
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
  },
  /**
   * The folding half.
   *
   * Its width is what animates, while the content inside keeps the open width
   * throughout — a list that reflows on the way out spends the animation
   * rewrapping every card, which reads as a glitch rather than as a fold.
   * `visibility` rides along so a closed list leaves the tab order, and because
   * it is discrete it only does so once the fold has finished.
   */
  body: {
    minHeight: 0,
    width: `var(${WIDTH_VAR})`,
    overflow: "hidden",
    visibility: "visible",
    transitionProperty: "width, visibility",
    transitionDuration: "200ms",
    transitionTimingFunction: "cubic-bezier(0.33, 0, 0.13, 1)",
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "1ms" },
  },
  bodyClosed: { width: 0, visibility: "hidden" },
  inner: {
    width: `var(${WIDTH_VAR})`,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  header: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "12px 12px 8px 4px",
  },
  count: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
  },
  list: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "0 12px 12px 4px",
  },
  empty: {
    margin: 0,
    padding: "8px 0",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.45",
  },
  footer: {
    flexShrink: 0,
    padding: "8px 12px 12px 4px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  newTask: { width: "100%" },
});

export type ConversationTasksProps = {
  /** This conversation's tasks, already filtered to the one on screen. */
  models: readonly RunViewModel[];
  open: boolean;
  selectedRunId?: string | undefined;
  onToggle: () => void;
  onOpenRun: (runId: string) => void;
  onOpenWorker: (sessionId: string) => void;
  onNewRun: () => void;
};

/**
 * What this conversation has out on the fleet, beside the conversation itself.
 *
 * The orchestrator board answers "what is the fleet doing" across every
 * conversation, which is the right question from the board and the wrong one
 * while reading a thread: a task named in a message was three clicks away, and
 * the only way to see whether what you just asked for actually started was to
 * leave the conversation and find it among everyone else's work.
 */
export const ConversationTasks = ({
  models,
  open,
  selectedRunId,
  onToggle,
  onOpenRun,
  onOpenWorker,
  onNewRun,
}: ConversationTasksProps) => {
  const styles = useStyles();
  const attention = models.filter((model) => model.attention).length;
  const label = open
    ? "Hide this conversation's tasks"
    : "Show this conversation's tasks";

  return (
    <aside className={styles.panel} aria-label="Conversation tasks">
      <div className={styles.handle}>
        <Tooltip relationship="label" content={label} withArrow>
          <Button
            appearance="subtle"
            size="small"
            icon={open ? <PanelRightContract20Regular /> : <PanelRightExpand20Regular />}
            aria-label={label}
            aria-expanded={open}
            onClick={onToggle}
          />
        </Tooltip>
        {!open && (
          <>
            {attention > 0 && (
              <span
                className={styles.attentionBadge}
                title={`${attention} waiting for you`}
              >
                {attention}
              </span>
            )}
            <span className={styles.railLabel} aria-hidden="true">
              Tasks
            </span>
            {models.length > 0 && (
              <span className={styles.railCount} aria-hidden="true">
                {models.length}
              </span>
            )}
          </>
        )}
      </div>

      <div className={mergeClasses(styles.body, !open && styles.bodyClosed)}>
        <div className={styles.inner}>
          <header className={styles.header}>
            <Text weight="semibold">Tasks</Text>
            <span className={styles.count}>{models.length}</span>
          </header>

          <div className={styles.list}>
            {models.length === 0 ? (
              <p className={styles.empty}>
                Nothing dispatched from this conversation yet. Ask for something here, or
                open a task and the orchestrator will plan it.
              </p>
            ) : (
              models.map((model) => (
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

          <div className={styles.footer}>
            <Button
              className={styles.newTask}
              size="small"
              appearance="secondary"
              icon={<Add16Regular />}
              onClick={onNewRun}
            >
              New task
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
};
