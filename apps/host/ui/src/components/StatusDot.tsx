import { makeStyles, mergeClasses } from "@fluentui/react-components";
import { stateAccent } from "../theme";

const useStyles = makeStyles({
  dot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-block",
  },
  glow: {
    boxShadow: "0 0 8px currentColor",
  },
});

type StatusDotProps = {
  state: string;
  /** Overrides the state colour, for a status the state alone misreports. */
  color?: string;
  className?: string;
};

export const StatusDot = ({ state, color, className }: StatusDotProps) => {
  const styles = useStyles();
  const resolved = color ?? stateAccent[state] ?? stateAccent.queued;
  const isLive = state === "running" || state === "starting";
  return (
    <span
      aria-hidden="true"
      className={mergeClasses(styles.dot, isLive && styles.glow, className)}
      style={{ background: resolved, color: resolved }}
    />
  );
};
