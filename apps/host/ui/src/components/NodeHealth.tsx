import { Tooltip, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Clock16Regular } from "@fluentui/react-icons";
import type { FleetNode } from "@fleet/protocol";
import { nodeHealthColors } from "../theme";

export const HEALTH_STALE_AFTER_MS = 90_000;
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

const useStyles = makeStyles({
  health: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "12px",
    padding: "8px 10px",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
  },
  metric: {
    minWidth: 0,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    borderRadius: tokens.borderRadiusSmall,
    ":focus-visible": {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: "3px",
    },
  },
  heading: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "4px",
    marginBottom: "4px",
  },
  label: {
    fontWeight: tokens.fontWeightSemibold,
  },
  value: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontVariantNumeric: "tabular-nums",
  },
  warning: { width: "12px", height: "12px", flexShrink: 0 },
  track: {
    height: "5px",
    backgroundColor: tokens.colorNeutralBackground6,
    borderRadius: tokens.borderRadiusSmall,
    overflow: "hidden",
    "@media (forced-colors: active)": {
      outline: "1px solid CanvasText",
    },
  },
  fill: {
    display: "block",
    height: "100%",
    "@media (forced-colors: active)": {
      backgroundColor: "Highlight",
      forcedColorAdjust: "none",
    },
  },
  historical: {
    opacity: 0.65,
    backgroundImage:
      "repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0, 0, 0, 0.35) 3px, rgba(0, 0, 0, 0.35) 5px)",
  },
});

function bytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const index =
    value === 0 ? 0 : Math.min(5, Math.floor(Math.log(value) / Math.log(1024)));
  return `${Number((value / 1024 ** index).toFixed(1))} ${units[index]}`;
}

type MetricProps = {
  label: string;
  color: string;
  online: boolean;
  now: number;
  sample?: { sampledAt: string } | undefined;
  percent?: number | undefined;
  detail: string;
};

function Metric({ label, color, online, now, sample, percent, detail }: MetricProps) {
  const styles = useStyles();
  const measuredAt = sample ? Date.parse(sample.sampledAt) : NaN;
  const available = Number.isFinite(measuredAt) && percent !== undefined;
  const state = !online
    ? "Offline"
    : !available
      ? "Unavailable"
      : measuredAt > now + CLOCK_SKEW_TOLERANCE_MS
        ? "Clock skew"
        : now - measuredAt > HEALTH_STALE_AFTER_MS
          ? "Stale"
          : "Current";
  const value = available ? `${Math.round(percent!)}%` : "Unavailable";
  const freshness = available
    ? `${state === "Current" ? "Sampled" : `${state} · sampled`} ${new Date(measuredAt).toLocaleTimeString()}`
    : online
      ? "No measurement reported"
      : "Offline · no measurement reported";
  const title = [
    `${label}: ${value}${available ? " used" : ""}`,
    detail,
    freshness,
    sample?.sampledAt,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip content={title} relationship="description" positioning="above" withArrow>
      <div
        className={styles.metric}
        role="group"
        aria-label={`${label}: ${value} · ${state}`}
        tabIndex={0}
      >
        <div className={styles.heading}>
          <span className={styles.label}>{label}</span>
          <span className={styles.value}>
            {available && online && state !== "Current" && (
              <Clock16Regular
                className={styles.warning}
                aria-label={state}
                role="img"
                aria-hidden={false}
              />
            )}
            <span aria-label={available ? undefined : "Unavailable"}>
              {available ? value : "—"}
            </span>
          </span>
        </div>
        <div
          className={styles.track}
          role={available ? "meter" : undefined}
          aria-label={available ? `${label} usage · ${state}` : undefined}
          aria-valuemin={available ? 0 : undefined}
          aria-valuemax={available ? 100 : undefined}
          aria-valuenow={available ? percent : undefined}
          aria-valuetext={available ? title : undefined}
        >
          {available ? (
            <span
              className={mergeClasses(
                styles.fill,
                state !== "Current" && styles.historical,
              )}
              style={{ width: `${percent}%`, backgroundColor: color }}
            />
          ) : null}
        </div>
      </div>
    </Tooltip>
  );
}

/** Pure readout; the panel owns one clock for all Nodes, including silent ones. */
export function NodeHealth({ node, now }: { node: FleetNode; now: number }) {
  const styles = useStyles();
  const { cpu, memory, disk } = node.health ?? {};
  const capacityDetail = (sample: typeof memory) =>
    sample
      ? `${bytes(sample.availableBytes)} free / ${bytes(sample.totalBytes)} total`
      : "";
  const used = (sample: typeof memory) =>
    sample ? (1 - sample.availableBytes / sample.totalBytes) * 100 : undefined;
  return (
    <div
      className={styles.health}
      role="group"
      aria-label={`${node.name} machine health`}
    >
      <Metric
        label="CPU"
        color={nodeHealthColors.cpu}
        online={node.online}
        now={now}
        sample={cpu}
        percent={cpu?.usagePercent}
        detail="Machine-wide utilization"
      />
      <Metric
        label="RAM"
        color={nodeHealthColors.memory}
        online={node.online}
        now={now}
        sample={memory}
        percent={used(memory)}
        detail={capacityDetail(memory) || "Physical memory"}
      />
      <Metric
        label="Disk"
        color={nodeHealthColors.disk}
        online={node.online}
        now={now}
        sample={disk}
        percent={used(disk)}
        detail={`Home-directory volume${disk ? ` · ${capacityDetail(disk)}` : ""}`}
      />
    </div>
  );
}
