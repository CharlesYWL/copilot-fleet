import { useMemo, type KeyboardEvent } from "react";
import {
  shorthands,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { Warning16Regular } from "@fluentui/react-icons";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
import { blockColor, statusVisuals, terminal } from "../theme";
import { toPreviewLines } from "../lib/session-preview";
import { sessionLabel } from "../lib/session-label";
import { sessionStatusDescriptor } from "../lib/session-status";
import {
  allowOnceOptionId,
  pendingPermission,
  permissionRequestId,
  permissionTitle,
  toTerminalBlocks,
} from "../lib/terminal-blocks";
import { PermissionBanner } from "./PermissionBanner";
import { StatusIndicator } from "./StatusIndicator";

const useStyles = makeStyles({
  tile: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    width: "100%",
    height: "220px",
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border("1px", "solid", "transparent"),
    background: terminal.background,
    overflow: "hidden",
  },
  /**
   * The one tile that cannot make progress without a person.
   *
   * Border, surface, icon and word all at once. A tile that differed only by
   * the colour of an 8px dot was easy to scan straight past, which is the one
   * failure mode this state cannot have.
   */
  blocked: {
    ...shorthands.borderWidth("2px"),
    ...shorthands.borderColor(statusVisuals.attention.border),
    background: `color-mix(in srgb, ${terminal.background} 88%, ${statusVisuals.attention.foreground} 12%)`,
  },
  attentionTag: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    color: statusVisuals.attention.foreground,
    fontSize: "10px",
    fontWeight: tokens.fontWeightSemibold,
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
    marginLeft: "auto",
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
  /** Passed in so the wall and the tile agree on what is blocked. */
  awaitingPermission?: boolean;
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
  awaitingPermission,
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
  const blocked = Boolean(permission) || Boolean(awaitingPermission);
  const descriptor = sessionStatusDescriptor(session, blocked);

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
    <article
      className={mergeClasses(styles.tile, blocked && styles.blocked)}
      style={blocked ? undefined : { borderColor: descriptor.color }}
    >
      <div
        className={styles.open}
        role="button"
        tabIndex={0}
        aria-label={`Open ${sessionLabel(session)} on ${session.nodeName} — ${descriptor.label}`}
        title={session.initialPrompt}
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.head}>
          <StatusIndicator descriptor={descriptor} variant="dot" />
          <Text weight="semibold" className={styles.name}>
            {sessionLabel(session)}
          </Text>
          {blocked ? (
            <span className={styles.attentionTag}>
              <Warning16Regular aria-hidden="true" />
              needs you
            </span>
          ) : (
            <span className={styles.state} style={{ color: descriptor.color }}>
              {descriptor.shortLabel}
            </span>
          )}
        </div>
        <Text className={styles.subtitle}>
          {session.nodeName} · {session.workspaceName}
        </Text>
        <div className={styles.preview}>
          {lines.length === 0 ? (
            <p className={mergeClasses(styles.line, styles.waiting)}>
              waiting for output…
            </p>
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
