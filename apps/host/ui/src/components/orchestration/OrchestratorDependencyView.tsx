import { useMemo, useState } from "react";
import {
  shorthands,
  Button,
  Dropdown,
  Option,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type { RunStep } from "@fleet/protocol";
import type { RunViewModel } from "../../lib/orchestration-view";
import { semanticColors, statusVisuals, terminal } from "../../theme";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 74;
const COLUMN_GAP = 70;
const ROW_GAP = 18;

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 },
  controls: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  canvasWrap: { overflow: "auto", paddingBottom: "4px" },
  canvas: {
    position: "relative",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    background: terminal.background,
  },
  edges: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  node: {
    position: "absolute",
    width: `${NODE_WIDTH}px`,
    minHeight: `${NODE_HEIGHT}px`,
    display: "flex",
    flexDirection: "column",
    gap: "5px",
    padding: "10px",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusSmall,
    background: tokens.colorNeutralBackground1,
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    ":hover": { ...shorthands.borderColor(tokens.colorNeutralStroke1) },
  },
  nodeTitle: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  nodeMeta: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  /** The same graph as a list, which is the version a keyboard can read. */
  list: { display: "grid", gap: "6px" },
  listRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    padding: "8px 10px",
    borderRadius: tokens.borderRadiusSmall,
    background: tokens.colorNeutralBackground2,
    width: "100%",
    ...shorthands.borderStyle("none"),
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    minHeight: "44px",
    ":hover": { background: tokens.colorNeutralBackground1Hover },
  },
  deps: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  empty: {
    padding: "40px 12px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
});

const stateColour = (step: RunStep): string => {
  if (step.state === "succeeded") return statusVisuals.success.foreground;
  if (step.state === "failed" || step.state === "cancelled") {
    return statusVisuals.danger.foreground;
  }
  if (step.state === "running" || step.state === "starting") {
    return semanticColors.interaction;
  }
  return statusVisuals.neutral.foreground;
};

/**
 * Which steps can only start after which.
 *
 * Only what `RunStep.dependsOn` actually says. Runs have no dependencies on
 * each other in this protocol, so a graph of tasks would be drawing edges that
 * do not exist — the honest picture is one task's steps at a time.
 */
export function layoutSteps(steps: readonly RunStep[]): {
  nodes: { step: RunStep; column: number; row: number }[];
  edges: { from: string; to: string }[];
  columns: number;
  rows: number;
} {
  const byKey = new Map(steps.map((step) => [step.stepKey, step]));
  const depth = new Map<string, number>();

  const depthOf = (step: RunStep, seen: Set<string>): number => {
    const cached = depth.get(step.stepKey);
    if (cached !== undefined) return cached;
    // A cycle cannot be laid out and should not hang the page; the plan route
    // rejects them, so this only guards a row written by something else.
    if (seen.has(step.stepKey)) return 0;
    seen.add(step.stepKey);
    let best = 0;
    for (const key of step.dependsOn) {
      const parent = byKey.get(key);
      if (!parent) continue;
      best = Math.max(best, depthOf(parent, seen) + 1);
    }
    seen.delete(step.stepKey);
    depth.set(step.stepKey, best);
    return best;
  };

  const perColumn = new Map<number, number>();
  const nodes = steps.map((step) => {
    const column = depthOf(step, new Set());
    const row = perColumn.get(column) ?? 0;
    perColumn.set(column, row + 1);
    return { step, column, row };
  });

  const edges = steps.flatMap((step) =>
    step.dependsOn
      .filter((key) => byKey.has(key))
      .map((key) => ({ from: key, to: step.stepKey })),
  );

  return {
    nodes,
    edges,
    columns: Math.max(1, ...nodes.map((node) => node.column + 1)),
    rows: Math.max(1, ...[...perColumn.values()]),
  };
}

export type OrchestratorDependencyViewProps = {
  models: RunViewModel[];
  selectedRunId?: string | undefined;
  onOpenRun: (runId: string) => void;
  onOpenStep: (runId: string, sessionId: string) => void;
};

/**
 * One task's step graph.
 *
 * A task has to be chosen first, because the edges only exist inside one. The
 * picker is the honest way to say that; drawing every task on one canvas would
 * imply an ordering between them that nothing enforces.
 */
export const OrchestratorDependencyView = ({
  models,
  selectedRunId,
  onOpenRun,
  onOpenStep,
}: OrchestratorDependencyViewProps) => {
  const styles = useStyles();
  const [chosen, setChosen] = useState<string | undefined>(selectedRunId);
  const model =
    models.find((entry) => entry.run.id === (chosen ?? selectedRunId)) ?? models[0];

  const layout = useMemo(() => layoutSteps(model?.steps ?? []), [model]);

  if (models.length === 0) {
    return <p className={styles.empty}>No tasks yet.</p>;
  }

  const positionOf = (column: number, row: number) => ({
    left: column * (NODE_WIDTH + COLUMN_GAP),
    top: row * (NODE_HEIGHT + ROW_GAP),
  });
  const width = layout.columns * NODE_WIDTH + (layout.columns - 1) * COLUMN_GAP;
  const height = layout.rows * NODE_HEIGHT + (layout.rows - 1) * ROW_GAP;
  const nodeByKey = new Map(layout.nodes.map((node) => [node.step.stepKey, node]));

  return (
    <div className={styles.root}>
      <div className={styles.controls}>
        <Dropdown
          aria-label="Task to show dependencies for"
          value={model?.run.name ?? ""}
          selectedOptions={model ? [model.run.id] : []}
          onOptionSelect={(_, data) => setChosen(data.optionValue)}
        >
          {models.map((entry) => (
            <Option key={entry.run.id} value={entry.run.id} text={entry.run.name}>
              {entry.run.name}
            </Option>
          ))}
        </Dropdown>
        {model && (
          <Button appearance="subtle" onClick={() => onOpenRun(model.run.id)}>
            Open task
          </Button>
        )}
      </div>

      {!model || model.steps.length === 0 ? (
        <p className={styles.empty}>Nothing has been dispatched in this task yet.</p>
      ) : layout.edges.length === 0 ? (
        <>
          <Text className={styles.hint}>
            These steps do not depend on each other — the orchestrator dispatched them as
            it went.
          </Text>
          <StepList
            model={model}
            styles={styles}
            onOpenStep={(sessionId) => onOpenStep(model.run.id, sessionId)}
          />
        </>
      ) : (
        <>
          <div className={styles.canvasWrap}>
            <div
              className={styles.canvas}
              style={{ width: `${width + 24}px`, height: `${height + 24}px` }}
              aria-hidden="true"
            >
              <svg className={styles.edges} viewBox={`0 0 ${width + 24} ${height + 24}`}>
                {layout.edges.map((edge) => {
                  const from = nodeByKey.get(edge.from);
                  const to = nodeByKey.get(edge.to);
                  if (!from || !to) return null;
                  const a = positionOf(from.column, from.row);
                  const b = positionOf(to.column, to.row);
                  const x1 = a.left + NODE_WIDTH + 12;
                  const y1 = a.top + NODE_HEIGHT / 2 + 12;
                  const x2 = b.left + 12;
                  const y2 = b.top + NODE_HEIGHT / 2 + 12;
                  const mid = (x1 + x2) / 2;
                  return (
                    <path
                      key={`${edge.from}->${edge.to}`}
                      d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
                      fill="none"
                      /*
                       * The links are the only thing this view adds over the
                       * list underneath it, so they have to read clearly at a
                       * glance rather than sit at the edge of visible.
                       */
                      stroke={semanticColors.neutral}
                      strokeWidth="1.5"
                    />
                  );
                })}
              </svg>
              {layout.nodes.map(({ step, column, row }) => {
                const at = positionOf(column, row);
                return (
                  <span
                    key={step.id}
                    className={styles.node}
                    style={{ left: `${at.left + 12}px`, top: `${at.top + 12}px` }}
                  >
                    <span className={styles.nodeTitle}>{step.title}</span>
                    <span
                      className={styles.nodeMeta}
                      style={{ color: stateColour(step) }}
                    >
                      {step.category || "step"} · {step.state}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
          <Text className={styles.hint}>The same steps, in order:</Text>
          <StepList
            model={model}
            styles={styles}
            onOpenStep={(sessionId) => onOpenStep(model.run.id, sessionId)}
          />
        </>
      )}
    </div>
  );
};

/**
 * The graph as a list.
 *
 * Not a fallback — it is always rendered, because a canvas of absolutely
 * positioned boxes is not something a keyboard or a screen reader can walk,
 * and the dependencies are the point of the view.
 */
const StepList = ({
  model,
  styles,
  onOpenStep,
}: {
  model: RunViewModel;
  styles: Record<string, string>;
  onOpenStep: (sessionId: string) => void;
}) => (
  <ul className={styles.list} style={{ listStyle: "none", margin: 0, padding: 0 }}>
    {model.steps.map((step) => (
      <li key={step.id}>
        <button
          type="button"
          className={mergeClasses(styles.listRow)}
          disabled={!step.sessionId}
          onClick={() => step.sessionId && onOpenStep(step.sessionId)}
        >
          <span style={{ color: stateColour(step) }}>●</span>
          <span style={{ fontWeight: 600 }}>{step.title}</span>
          <span className={styles.deps}>
            {step.category || "step"} · {step.state}
            {step.dependsOn.length > 0 ? ` · after ${step.dependsOn.join(", ")}` : ""}
          </span>
        </button>
      </li>
    ))}
  </ul>
);
