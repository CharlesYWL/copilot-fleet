import type { ReactElement } from "react";
import { ToggleButton, makeStyles, tokens } from "@fluentui/react-components";
import {
  Board20Regular,
  Flowchart20Regular,
  Grid20Regular,
  List20Regular,
  TextBulletListTree20Regular,
} from "@fluentui/react-icons";

/** How ordinary sessions are arranged. */
export type SessionLayoutMode = "tree" | "overview";

/** How the same set of runs is arranged. */
export type OrchestratorViewMode = "stage" | "list" | "dependency";

/**
 * Which mode switch belongs in the top bar right now.
 *
 * These are different levels, not two values of one setting: one decides how
 * sessions are organised, the other how runs are. Collapsing them into a single
 * `LayoutMode` is what previously made switching to the wall silently drop the
 * orchestrator — there was no way to be in "overview" and "orchestrator" at
 * once, so the code forced the view back to sessions.
 */
export type ContextMode =
  | {
      kind: "session";
      mode: SessionLayoutMode;
      onChange: (mode: SessionLayoutMode) => void;
    }
  | {
      kind: "orchestrator";
      mode: OrchestratorViewMode;
      onChange: (mode: OrchestratorViewMode) => void;
    }
  | { kind: "none" };

const useStyles = makeStyles({
  group: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "3px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
  },
  /**
   * The word goes only where there is no room for it.
   *
   * The button keeps its accessible name and its tooltip, so nothing is lost
   * to a screen reader or to a hover — only the printed label, and only on a
   * screen where printing it would push the bar off the side.
   */
  label: {
    "@media (max-width: 600px)": { display: "none" },
  },
});

type Option<T extends string> = { value: T; label: string; icon: ReactElement };

const SESSION_MODES: Option<SessionLayoutMode>[] = [
  { value: "tree", label: "Tree", icon: <TextBulletListTree20Regular /> },
  { value: "overview", label: "Overview", icon: <Grid20Regular /> },
];

const ORCHESTRATOR_MODES: Option<OrchestratorViewMode>[] = [
  { value: "stage", label: "Stages", icon: <Board20Regular /> },
  { value: "list", label: "List", icon: <List20Regular /> },
  /*
   * "Dependency", not "Links".
   *
   * Every view links to the sessions a task dispatched now, so "Links" named
   * the wrong thing twice over — it read as hyperlinks, and the one thing only
   * this view shows is how the dispatched work depends on itself.
   */
  { value: "dependency", label: "Dependency", icon: <Flowchart20Regular /> },
];

/**
 * The single mode slot in the top bar.
 *
 * Every button keeps its visible label. Icon-only is smaller but leaves the
 * operator guessing which of three near-identical glyphs is the board, and
 * this control changes what the whole page is.
 */
export const ContextModeToggle = ({ context }: { context: ContextMode }) => {
  const styles = useStyles();
  if (context.kind === "none") return null;

  const options: {
    value: string;
    label: string;
    icon: ReactElement;
    checked: boolean;
    select: () => void;
  }[] =
    context.kind === "session"
      ? SESSION_MODES.map((option) => ({
          ...option,
          checked: context.mode === option.value,
          select: () => context.onChange(option.value),
        }))
      : ORCHESTRATOR_MODES.map((option) => ({
          ...option,
          checked: context.mode === option.value,
          select: () => context.onChange(option.value),
        }));

  return (
    <div
      className={styles.group}
      role="group"
      aria-label={context.kind === "session" ? "Session layout" : "Task view"}
    >
      {options.map((option) => (
        <ToggleButton
          key={option.value}
          appearance="subtle"
          size="small"
          checked={option.checked}
          aria-pressed={option.checked}
          aria-label={option.label}
          title={option.label}
          icon={option.icon}
          onClick={option.select}
        >
          <span className={styles.label}>{option.label}</span>
        </ToggleButton>
      ))}
    </div>
  );
};
