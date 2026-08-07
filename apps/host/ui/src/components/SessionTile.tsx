import { useMemo, type KeyboardEvent } from "react";
import { Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
import { blockColor, stateAccent, terminal } from "../theme";
import { toPreviewLines } from "../lib/session-preview";
import {
  allowOnceOptionId,
  pendingPermission,
  permissionRequestId,
  permissionTitle,
  toTerminalBlocks,
} from "../lib/terminal-blocks";
import { PermissionBanner } from "./PermissionBanner";
import { StatusDot } from "./StatusDot";

const useStyles = makeStyles({
  tile: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    height: "220px",
    borderRadius: tokens.borderRadiusLarge,
    border: "1px solid transparent",
    background: terminal.background,
    overflow: "hidden",
  },
  open: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    gap: "6px",
    padding: "10px 12px",
    cursor: "pointer",
    textAlign: "left",
    ":hover": {
      background: "rgba(255, 255, 255, 0.03)",
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: "-2px",
    },
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
  },
  state: {
    flexShrink: 0,
    textTransform: "uppercase",
    letterSpacing: "1px",
    fontSize: "9px",
    fontWeight: tokens.fontWeightBold,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  subtitle: {
    color: tokens.colorNeutralForeground4,
    fontSize: "10px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // Lines are pinned to the bottom so the newest output sits where a terminal
  // tail would put it, however few lines the session has produced.
  preview: {
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    fontFamily: terminal.font,
    fontSize: "10.5px",
    lineHeight: "1.55",
  },
  line: {
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  waiting: {
    color: terminal.dim,
  },
});

type SessionTileProps = {
  session: FleetSession;
  events: SessionEvent[];
  onOpen: (sessionId: string) => void;
  onPermission: (
    sessionId: string,
    requestId: string,
    outcome: "allow_once" | "deny",
    optionId?: string,
  ) => void;
};

export const SessionTile = ({
  session,
  events,
  onOpen,
  onPermission,
}: SessionTileProps) => {
  const styles = useStyles();
  const blocks = useMemo(() => toTerminalBlocks(events), [events]);
  const lines = useMemo(
    () => toPreviewLines(blocks, session.lastText),
    [blocks, session.lastText],
  );
  const permission = useMemo(() => pendingPermission(events), [events]);

  // A waiting request outranks the run state: it is the only tile the operator
  // has to act on, so it gets the alert colour.
  const accent = permission
    ? terminal.permission
    : (stateAccent[session.state] ?? terminal.dim);

  const handleOpen = () => onOpen(session.id);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen(session.id);
  };

  const handleDecide = (outcome: "allow_once" | "deny", optionId?: string) => {
    const requestId = permission && permissionRequestId(permission);
    if (!requestId) return;
    onPermission(session.id, requestId, outcome, optionId);
  };

  return (
    <article className={styles.tile} style={{ borderColor: accent }}>
      <div
        className={styles.open}
        role="button"
        tabIndex={0}
        aria-label={`Open session ${session.workspaceName} on ${session.nodeName}`}
        title={session.initialPrompt}
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.head}>
          <StatusDot state={session.state} />
          <span className={styles.state} style={{ color: accent }}>
            {session.state}
          </span>
          <Text weight="semibold" className={styles.name}>
            {session.workspaceName}
          </Text>
        </div>
        <Text className={styles.subtitle}>
          {session.nodeName} · {session.currentActivity || session.initialPrompt}
        </Text>
        <div className={styles.preview}>
          {lines.length === 0 ? (
            <p className={mergeClasses(styles.line, styles.waiting)}>waiting for output…</p>
          ) : (
            lines.map((line) => (
              <p
                className={styles.line}
                key={line.key}
                style={{ color: blockColor[line.kind] }}
              >
                {line.text}
              </p>
            ))
          )}
        </div>
      </div>

      {permission && (
        <PermissionBanner
          compact
          title={permissionTitle(permission)}
          allowOptionId={allowOnceOptionId(permission)}
          onDecide={handleDecide}
        />
      )}
    </article>
  );
};
