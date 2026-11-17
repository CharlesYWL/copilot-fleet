import {
  ProgressBar,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type { NodeConsoleSync } from "@fleet/protocol";

/** Long enough for a large replay batch; a quieter sync is called out as stalled. */
const STALLED_AFTER_MS = 30_000;

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minWidth: 0,
    maxWidth: "420px",
  },
  text: {
    color: tokens.colorNeutralForeground3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  failed: {
    color: tokens.colorPaletteRedForeground1,
  },
});

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** One line for the Nodes table: what synchronization is doing and for how long. */
export function syncSummary(sync: NodeConsoleSync, now: number): string {
  if (sync.phase === "failed")
    return `History sync failed${sync.error ? `: ${sync.error}` : ""}`;
  const parts = [
    sync.phase === "waiting"
      ? "waiting for the Node"
      : sync.totalEvents === undefined
        ? `${sync.sentEvents.toLocaleString()} events received`
        : `${sync.sentEvents.toLocaleString()} of ${Math.max(sync.totalEvents, sync.sentEvents).toLocaleString()} events`,
    elapsed(now - Date.parse(sync.since)),
  ];
  if (sync.attempts > 1) parts.push(`attempt ${sync.attempts}`);
  const quiet = now - Date.parse(sync.updatedAt);
  if (quiet > STALLED_AFTER_MS) parts.push(`no progress for ${elapsed(quiet)}`);
  return `Syncing history: ${parts.join(" · ")}`;
}

/** Pure readout; the panel owns the clock, as it does for NodeHealth. */
export function NodeSyncStatus({ sync, now }: { sync: NodeConsoleSync; now: number }) {
  const styles = useStyles();
  const details = [
    `Started ${new Date(sync.since).toLocaleTimeString()}`,
    `last progress ${new Date(sync.updatedAt).toLocaleTimeString()}`,
    ...(sync.phase !== "failed" && sync.error ? [`previous attempt: ${sync.error}`] : []),
    "new work on this Node waits until its session history is reconciled",
  ].join(" · ");
  return (
    <div className={styles.root} title={details}>
      <Text
        size={200}
        className={mergeClasses(styles.text, sync.phase === "failed" && styles.failed)}
      >
        {syncSummary(sync, now)}
      </Text>
      {sync.phase !== "failed" && (
        <ProgressBar
          thickness="medium"
          aria-label="Session history synchronization"
          // Indeterminate until the Node has said how much it holds.
          {...(sync.phase === "replaying" && sync.totalEvents
            ? { value: Math.min(1, sync.sentEvents / sync.totalEvents) }
            : {})}
        />
      )}
    </div>
  );
}
