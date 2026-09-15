import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import type { StatusDescriptor } from "../lib/status-visuals";

const useStyles = makeStyles({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
    flexShrink: 0,
  },
  icon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "16px",
    flexShrink: 0,
    fontSize: "16px",
    lineHeight: 1,
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: "nowrap",
  },
  spin: {
    animationName: {
      from: { transform: "rotate(0deg)" },
      to: { transform: "rotate(360deg)" },
    },
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    // Keep in-flight work visibly active when Windows disables UI animations.
    "@media (prefers-reduced-motion: reduce)": { animationDuration: "3s" },
  },
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
  descriptor: StatusDescriptor;
  /** `icon` for dense rows, `full` where there is room for the word. */
  variant?: "icon" | "full";
  className?: string;
};

/**
 * Shape and colour carry the same meaning even when the label is hidden.
 */
export const StatusIndicator = ({
  descriptor,
  variant = "full",
  className,
}: StatusIndicatorProps) => {
  const styles = useStyles();
  const Icon = descriptor.icon;

  return (
    <span
      role="img"
      aria-label={descriptor.label}
      title={descriptor.label}
      className={mergeClasses(styles.root, className)}
      style={{ color: descriptor.color }}
    >
      <span
        className={mergeClasses(
          styles.icon,
          descriptor.motion === "spin" && styles.spin,
          descriptor.motion === "pulse" && styles.pulse,
        )}
        aria-hidden="true"
      >
        <Icon />
      </span>
      {variant === "full" && (
        <span className={styles.label}>{descriptor.shortLabel}</span>
      )}
    </span>
  );
};
