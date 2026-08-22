import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { type SessionStatusDescriptor } from "../lib/session-status";
import { statusVisuals } from "../theme";

const useStyles = makeStyles({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
    flexShrink: 0,
  },
  icon: { flexShrink: 0, fontSize: "14px", lineHeight: 1 },
  label: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: "nowrap",
  },
  dot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-block",
    background: "currentColor",
  },
  /** Only for work actually in flight, so a glowing dot always means motion. */
  glow: { boxShadow: "0 0 8px currentColor" },
  pulse: {
    animationName: {
      "0%,100%": { opacity: 1 },
      "50%": { opacity: 0.35 },
    },
    animationDuration: "1.8s",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
});

export type StatusIndicatorProps = {
  descriptor: SessionStatusDescriptor;
  /** `dot` for dense rows, `full` where there is room for the word. */
  variant?: "dot" | "full";
  className?: string;
};

/**
 * One session's state, shown the same way everywhere.
 *
 * Always more than a colour. A dot alone cannot say "this is waiting on you"
 * to someone who cannot separate amber from green, and that is precisely the
 * state that must never be missed — so the dense form carries the word in its
 * accessible name even when it has no room to print it.
 */
export const StatusIndicator = ({
  descriptor,
  variant = "full",
  className,
}: StatusIndicatorProps) => {
  const styles = useStyles();
  const Icon = descriptor.icon;
  const live = descriptor.state === "running";
  const attention = descriptor.state === "waiting-for-permission";

  if (variant === "dot") {
    return (
      <span
        role="img"
        aria-label={descriptor.label}
        title={descriptor.label}
        className={mergeClasses(
          styles.dot,
          live && styles.glow,
          attention && styles.pulse,
          className,
        )}
        style={{ color: descriptor.color }}
      />
    );
  }

  return (
    <span
      className={mergeClasses(styles.root, className)}
      style={{ color: descriptor.color }}
    >
      <Icon className={styles.icon} aria-hidden="true" />
      <span className={styles.label}>{descriptor.shortLabel}</span>
    </span>
  );
};

export { statusVisuals };
