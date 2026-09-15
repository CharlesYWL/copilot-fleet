import { Button, makeStyles, mergeClasses } from "@fluentui/react-components";
import { Dismiss12Regular } from "@fluentui/react-icons";
import { useState } from "react";
import type { RunViewModel } from "../../lib/orchestration-view";
import {
  failedStepTokens,
  isOrchestratorStoppedRun,
  runStateLabel,
} from "../../lib/orchestration-view";
import { statusDescriptor, type StatusDescriptor } from "../../lib/status-visuals";
import { StatusIndicator } from "../StatusIndicator";

export const FAILED_STEP_DISMISS_PREFIX = "fleet.ui.run.failed-step.";

const useStyles = makeStyles({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
  },
  dismiss: {
    minWidth: "20px",
    width: "20px",
    height: "20px",
    color: "inherit",
  },
});

type DismissedFailure = {
  runId: string;
  tokens: string[];
};

export const readDismissedFailures = (runId: string): string[] => {
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
export function runVisual(model: RunViewModel): StatusDescriptor {
  if ((model.stoppingSteps ?? 0) > 0) {
    return {
      ...statusDescriptor("stopping"),
      label: model.stoppingUnavailable ? "Stopping · node offline" : "Stopping",
      icon: statusDescriptor(model.stoppingUnavailable ? "offline" : "stopping").icon,
      motion: model.stoppingUnavailable ? undefined : "spin",
    };
  }
  if (model.attention === "permission") {
    return {
      ...statusDescriptor("waiting-for-permission"),
      label: model.run.state === "awaiting_human" ? "Needs review" : "Needs you",
    };
  }
  if (model.attention === "workspace-setup") {
    return { ...statusDescriptor("failed"), label: "Setup failed" };
  }
  if (model.attention === "integration") {
    return {
      ...statusDescriptor("waiting-for-permission"),
      label: "Integration needs attention",
    };
  }
  if (model.attention === "failed-step") {
    return { ...statusDescriptor("failed"), label: "A step failed" };
  }
  if (model.attention === "offline-node") {
    return { ...statusDescriptor("offline"), label: "Node offline" };
  }
  if (model.liveSteps > 0) {
    return statusDescriptor("running");
  }
  if (model.run.state === "completed") {
    return statusDescriptor("done");
  }
  if (model.run.state === "cancelled") {
    return {
      ...statusDescriptor("stopped"),
      label: isOrchestratorStoppedRun(model.run) ? "Stopped" : "Abandoned",
    };
  }
  if (model.run.state === "failed") {
    return statusDescriptor("failed");
  }
  return {
    ...statusDescriptor(
      model.run.state === "awaiting_approval"
        ? "queued"
        : model.run.state === "blocked"
          ? "waiting-for-permission"
          : "running",
    ),
    label: runStateLabel(model.run),
  };
}

export const RunStatusIndicator = ({
  model,
  className,
  dismissible = false,
  onDismissFailure,
}: {
  model: RunViewModel;
  className?: string;
  dismissible?: boolean;
  onDismissFailure?: () => void;
}) => {
  const styles = useStyles();
  const [dismissedFailure, setDismissedFailure] = useState<DismissedFailure | undefined>(
    () => {
      const tokens = readDismissedFailures(model.run.id);
      return tokens.length > 0 ? { runId: model.run.id, tokens } : undefined;
    },
  );
  const failureTokens = failedStepTokens(model.steps);
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

  const dismissFailure = () => {
    const next = {
      runId: model.run.id,
      tokens: [...new Set([...dismissedTokens, ...failureTokens])],
    };
    setDismissedFailure(next);
    rememberDismissedFailures(next.runId, next.tokens);
    onDismissFailure?.();
  };

  return (
    <span
      className={mergeClasses(styles.root, className)}
      style={{ color: visual.color }}
    >
      <StatusIndicator descriptor={{ ...visual, shortLabel: visual.label }} />
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
