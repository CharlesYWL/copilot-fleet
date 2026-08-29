import { Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { semanticColors } from "../../theme";

const useStyles = makeStyles({
  rail: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    rowGap: "8px",
  },
  stage: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
  },
  dot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flexShrink: 0,
    background: semanticColors.dim,
    boxShadow: "none",
  },
  done: {
    background: semanticColors.running,
  },
  // A ring rather than a fill for the step in progress, so the three states
  // differ in shape as well as in colour.
  active: {
    background: "transparent",
    boxShadow: `inset 0 0 0 2px ${semanticColors.permission}`,
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  activeLabel: {
    color: tokens.colorNeutralForeground1,
  },
  arrow: {
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase200,
    userSelect: "none",
  },
});

export type TrustStageState = "done" | "active" | "todo";

export type TrustStage = {
  name: string;
  /** What this link of the chain currently is, in a few words. */
  detail: string;
  state: TrustStageState;
};

/**
 * The three things that have to be true before anyone can drive this fleet,
 * and which of them are.
 *
 * Not decoration. Fleet's whole authorization model is that reaching the Host,
 * being authenticated by Microsoft, and being trusted by these Nodes are
 * separate facts — so the sign-in screen says so, and an operator who is stuck
 * can see which link is missing rather than inferring it from an error.
 */
export const TrustRail = ({ stages }: { stages: readonly TrustStage[] }) => {
  const styles = useStyles();
  return (
    <ol className={styles.rail} aria-label="Fleet trust chain">
      {stages.map((stage, index) => (
        <li key={stage.name} className={styles.stage}>
          <span
            className={mergeClasses(
              styles.dot,
              stage.state === "done" && styles.done,
              stage.state === "active" && styles.active,
            )}
            aria-hidden="true"
          />
          <Text
            className={mergeClasses(
              styles.label,
              stage.state === "active" && styles.activeLabel,
            )}
          >
            {stage.name} — {stage.detail}
          </Text>
          {index < stages.length - 1 && (
            <span className={styles.arrow} aria-hidden="true">
              →
            </span>
          )}
        </li>
      ))}
    </ol>
  );
};
