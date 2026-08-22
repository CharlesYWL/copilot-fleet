import { Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  CircleRegular,
  ErrorCircleRegular,
  PlugDisconnectedRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import type { RunViewModel } from "../../lib/orchestration-view";
import { runStateLabel } from "../../lib/orchestration-view";
import { statusVisuals, type StatusTone } from "../../theme";

const useStyles = makeStyles({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
  },
  icon: { flexShrink: 0, fontSize: "14px" },
  label: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: "nowrap",
  },
  pulse: {
    animationName: { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.4 } },
    animationDuration: "1.8s",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
});

type Visual = {
  label: string;
  tone: StatusTone;
  icon: typeof WarningRegular;
};

/**
 * What a task's state looks like, in words first.
 *
 * Attention is not the same thing as failure, and neither is the same as a
 * node that went quiet — an operator triaging three amber cards needs to know
 * which one is blocking an agent right now.
 */
export function runVisual(model: RunViewModel): Visual {
  if (model.attention === "permission") {
    return {
      label: model.run.state === "awaiting_human" ? "Needs review" : "Needs you",
      tone: "attention",
      icon: WarningRegular,
    };
  }
  if (model.attention === "failed-step") {
    return { label: "A step failed", tone: "danger", icon: ErrorCircleRegular };
  }
  if (model.attention === "offline-node") {
    return { label: "Node offline", tone: "danger", icon: PlugDisconnectedRegular };
  }
  if (model.liveSteps > 0) {
    return { label: "Running", tone: "success", icon: ArrowClockwiseRegular };
  }
  if (model.run.state === "completed") {
    return { label: "Done", tone: "neutral", icon: CheckmarkCircleRegular };
  }
  if (model.run.state === "cancelled") {
    return { label: "Abandoned", tone: "neutral", icon: CircleRegular };
  }
  if (model.run.state === "failed") {
    return { label: "Failed", tone: "danger", icon: ErrorCircleRegular };
  }
  return { label: runStateLabel(model.run), tone: "info", icon: CircleRegular };
}

export const RunStatusIndicator = ({
  model,
  className,
}: {
  model: RunViewModel;
  className?: string;
}) => {
  const styles = useStyles();
  const visual = runVisual(model);
  const Icon = visual.icon;
  return (
    <span
      className={mergeClasses(
        styles.root,
        visual.tone === "attention" && styles.pulse,
        className,
      )}
      style={{ color: statusVisuals[visual.tone].foreground }}
    >
      <Icon className={styles.icon} aria-hidden="true" />
      <Text className={styles.label}>{visual.label}</Text>
    </span>
  );
};
