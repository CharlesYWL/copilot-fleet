import {
  Button,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  CircleRegular,
  Dismiss12Regular,
  ErrorCircleRegular,
  PlugDisconnectedRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import { useState } from "react";
import type { RunViewModel } from "../../lib/orchestration-view";
import { runStateLabel } from "../../lib/orchestration-view";
import { statusVisuals, type StatusTone } from "../../theme";

const FAILED_STEP_DISMISS_PREFIX = "fleet.ui.run.failed-step.";

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
  dismiss: {
    minWidth: "20px",
    width: "20px",
    height: "20px",
    color: "inherit",
  },
});

type Visual = {
  label: string;
  tone: StatusTone;
  icon: typeof WarningRegular;
};

type DismissedFailure = {
  runId: string;
  tokens: string[];
};

const failedStepTokens = (model: RunViewModel): string[] =>
  model.steps
    .filter((step) => step.state === "failed" || step.state === "cancelled")
    // A retry increments attempts. updatedAt is deliberately excluded because
    // bookkeeping edits to an already-failed step are not a new failure.
    .map((step) => JSON.stringify([step.id, step.attempts]))
    .sort();

const readDismissedFailures = (runId: string): string[] => {
  try {
    const stored = localStorage.getItem(FAILED_STEP_DISMISS_PREFIX + runId);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((token) => typeof token === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
};

const rememberDismissedFailures = (runId: string, tokens: readonly string[]) => {
  try {
    localStorage.setItem(FAILED_STEP_DISMISS_PREFIX + runId, JSON.stringify(tokens));
  } catch {
    // Storage may be blocked; React state still keeps the warning dismissed
    // until this view is closed.
  }
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
  dismissible = false,
}: {
  model: RunViewModel;
  className?: string;
  dismissible?: boolean;
}) => {
  const styles = useStyles();
  const [dismissedFailure, setDismissedFailure] = useState<DismissedFailure | undefined>(
    () => {
      const tokens = readDismissedFailures(model.run.id);
      return tokens.length > 0 ? { runId: model.run.id, tokens } : undefined;
    },
  );
  const failureTokens = failedStepTokens(model);
  const dismissedTokens =
    dismissedFailure?.runId === model.run.id
      ? dismissedFailure.tokens
      : readDismissedFailures(model.run.id);
  const acknowledgedFailures = new Set(dismissedTokens);
  const failureDismissed =
    model.attention === "failed-step" &&
    failureTokens.length > 0 &&
    failureTokens.every((token) => acknowledgedFailures.has(token));
  const visual = runVisual(failureDismissed ? { ...model, attention: undefined } : model);
  const Icon = visual.icon;

  const dismissFailure = () => {
    const next = {
      runId: model.run.id,
      tokens: [...new Set([...dismissedTokens, ...failureTokens])],
    };
    setDismissedFailure(next);
    rememberDismissedFailures(next.runId, next.tokens);
  };

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
      {dismissible && model.attention === "failed-step" && !failureDismissed ? (
        <Button
          appearance="subtle"
          size="small"
          shape="circular"
          className={styles.dismiss}
          icon={<Dismiss12Regular />}
          aria-label="Dismiss failed step warning"
          title="Dismiss until another step fails"
          onClick={dismissFailure}
        />
      ) : null}
    </span>
  );
};
