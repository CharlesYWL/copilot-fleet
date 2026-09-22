import { useId, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Link,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
  useRestoreFocusTarget,
} from "@fluentui/react-components";
import {
  prMaintenanceProgress,
  prMaintenanceUrl,
  type PrMaintenanceRegistration,
  type PrMaintenanceStage,
} from "@fleet/protocol";
import { hasOutstandingWork, maintenanceStageLabels } from "../../lib/task-overview";
import { semanticColors, terminal } from "../../theme";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
    padding: "4px 0 0",
    fontSize: "12px",
  },
  status: { fontSize: "11px", color: tokens.colorNeutralForeground2 },
  graph: {
    position: "relative",
    boxSizing: "border-box",
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gridTemplateRows: "repeat(2, 72px)",
    columnGap: "6%",
    rowGap: "64px",
    padding: "24px 2% 8px",
    height: "240px",
    minWidth: 0,
    "@media (max-width: 640px)": {
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      gridTemplateRows: "repeat(3, 72px)",
      columnGap: "8%",
      rowGap: "24px",
      paddingInline: "3%",
      height: "296px",
    },
  },
  lines: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    color: tokens.colorNeutralStroke1,
  },
  desktopLines: { "@media (max-width: 640px)": { display: "none" } },
  mobileLines: { display: "none", "@media (max-width: 640px)": { display: "block" } },
  linked: { gridColumnStart: "1", gridRowStart: "1" },
  review: { gridColumnStart: "2", gridRowStart: "1" },
  ready: {
    gridColumnStart: "3",
    gridRowStart: "1",
    "@media (max-width: 640px)": { gridColumnStart: "2", gridRowStart: "2" },
  },
  repair: {
    gridColumnStart: "2",
    gridRowStart: "2",
    "@media (max-width: 640px)": { gridColumnStart: "1" },
  },
  terminal: {
    gridColumnStart: "3",
    gridRowStart: "2",
    "@media (max-width: 640px)": { gridColumnStart: "2", gridRowStart: "3" },
  },
  node: {
    position: "relative",
    boxSizing: "border-box",
    width: "100%",
    height: "72px",
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "4px",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: "10px",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "3px",
    },
  },
  current: {
    ...shorthands.borderColor(semanticColors.interaction),
    backgroundColor: tokens.colorBrandBackground2,
  },
  held: { ...shorthands.borderColor(semanticColors.permission) },
  title: { fontSize: "12px", fontWeight: tokens.fontWeightSemibold, lineHeight: "1.25" },
  label: { fontSize: "10px", color: tokens.colorNeutralForeground3, lineHeight: "1.25" },
  now: {
    position: "absolute",
    top: "-9px",
    right: "8px",
    borderRadius: "3px",
    padding: "0 5px",
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontFamily: terminal.font,
    fontSize: "9px",
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "8px",
    color: tokens.colorNeutralForeground3,
    fontSize: "10px",
    margin: "0 0 8px",
  },
});

type GraphNode = "linked" | "review" | "repair" | "ready" | "terminal";
const stageNode: Record<PrMaintenanceStage, GraphNode> = {
  checking: "review",
  triage: "review",
  waiting_checks: "review",
  waiting_review: "review",
  addressing_review: "repair",
  ready: "ready",
  human_hold: "review",
  reconciling: "review",
  paused: "review",
  recovering: "review",
  blocked: "review",
  merged: "terminal",
  closed: "terminal",
  released: "terminal",
};
const descriptions: Record<GraphNode, string> = {
  linked:
    "Maintenance is bound to this exact PR and an existing worker. A proposal alone does not enable it.",
  review:
    "Observe reviews, required checks and mergeability for the current head. Missing, stale or incomplete evidence is not a passing check.",
  repair:
    "Use only the eligible retained worker and approved scope. Design decisions and permission blockers pause work; repairs return to observation.",
  ready:
    "Readiness requires complete, current evidence. Ready is not merged, and new changes can invalidate it.",
  terminal:
    "A provider-observed merge or closure stops new repairs. Releasing maintenance does not merge the PR or prove deployment.",
};

export function PrMaintenanceGraph({
  record,
  nowMs,
  unavailable = false,
}: {
  record: PrMaintenanceRegistration;
  nowMs: number;
  unavailable?: boolean;
}) {
  const styles = useStyles();
  const restoreFocusTarget = useRestoreFocusTarget();
  const markerId = useId().replace(/:/g, "");
  const [selected, setSelected] = useState<GraphNode>();
  const { stage } = prMaintenanceProgress(record, nowMs);
  const active = unavailable ? "review" : stageNode[stage];
  const readOnly = !record.authorization.scope.publicationAuthorized;
  const unsettled =
    ["merged", "closed"].includes(record.lifecycle) && hasOutstandingWork(record);
  const label = unavailable
    ? "Status unavailable"
    : stage === "paused" && record.manualControl && !record.manualControl.endedAt
      ? "Manual control"
      : `${maintenanceStageLabels[stage]}${unsettled ? " / settling effects" : ""}`;
  const nodes: { id: GraphNode; title: string }[] = [
    { id: "linked", title: "PR linked" },
    { id: "review", title: "Reviews & checks" },
    { id: "ready", title: "Ready" },
    ...(!readOnly || active === "repair"
      ? [{ id: "repair" as const, title: "Fix feedback" }]
      : []),
    {
      id: "terminal",
      title: stage === "closed" ? "Closed" : stage === "released" ? "Released" : "Merged",
    },
  ];
  const arrows = (mobile: boolean) => {
    const id = `${markerId}-${mobile ? "mobile" : "desktop"}`;
    const edges = mobile
      ? ["M147 60H165", "M242 96V113", "M242 192V209"]
      : ["M180 60H208", "M384 60H412", "M504 96V153"];
    const loop = mobile
      ? ["M173 76H159V152H154", "M109 120V108H218V103"]
      : ["M278 96V153", "M326 160V104"];
    return (
      <svg
        className={mergeClasses(
          styles.lines,
          mobile ? styles.mobileLines : styles.desktopLines,
        )}
        viewBox={mobile ? "0 0 320 296" : "0 0 600 240"}
        preserveAspectRatio="none"
        aria-hidden
      >
        <defs>
          <marker
            id={id}
            markerWidth="5"
            markerHeight="5"
            refX="4"
            refY="2.5"
            orient="auto"
          >
            <path d="M0 0 5 2.5 0 5Z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map((edge) => (
          <path
            key={edge}
            d={edge}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            markerEnd={`url(#${id})`}
          />
        ))}
        {!readOnly
          ? loop.map((edge) => (
              <path
                key={edge}
                d={edge}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                markerEnd={`url(#${id})`}
              />
            ))
          : null}
      </svg>
    );
  };
  return (
    <div>
      <div className={styles.header}>
        <Link href={prMaintenanceUrl(record.identity)} target="_blank" rel="noreferrer">
          {record.identity.repository} #{record.identity.prNumber}
        </Link>
        <span className={styles.status}>{label}</span>
      </div>
      <div
        className={styles.graph}
        role="group"
        aria-label="PR maintenance progress graph"
      >
        {arrows(false)}
        {arrows(true)}
        {nodes.map((node) => (
          <button
            {...restoreFocusTarget}
            key={node.id}
            type="button"
            className={mergeClasses(
              styles.node,
              styles[node.id],
              node.id === active && styles.current,
              node.id === active &&
                (unavailable ||
                  unsettled ||
                  ["human_hold", "blocked", "paused", "reconciling"].includes(stage)) &&
                styles.held,
            )}
            aria-current={node.id === active ? "step" : undefined}
            aria-label={`${node.title}: ${node.id === active ? label : "Stage details"}`}
            onClick={() => setSelected(node.id)}
          >
            {node.id === active ? <span className={styles.now}>NOW</span> : null}
            <span className={styles.title}>{node.title}</span>
            {node.id === active || node.id === "linked" || node.id === "repair" ? (
              <span className={styles.label}>
                {node.id === active
                  ? unsettled && !unavailable
                    ? "Settling effects"
                    : label
                  : node.id === "linked"
                    ? "Bound to this task"
                    : "Only if authorized"}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <p className={styles.footer}>
        <span>
          {["merged", "closed", "released"].includes(stage)
            ? unsettled
              ? "No new repairs; reconciliation pending"
              : "Maintenance ended; no new repairs"
            : readOnly
              ? "Read-only maintenance; no unattended repairs"
              : "Bounded repairs; never auto-merges"}
        </span>
        <span>Select a stage for details</span>
      </p>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(_, data) => !data.open && setSelected(undefined)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{nodes.find((node) => node.id === selected)?.title}</DialogTitle>
            <DialogContent>{selected ? descriptions[selected] : ""}</DialogContent>
            <DialogActions>
              <Button onClick={() => setSelected(undefined)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
