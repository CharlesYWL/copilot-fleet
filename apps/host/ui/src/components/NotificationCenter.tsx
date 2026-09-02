import {
  Badge,
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  Alert20Regular,
  Checkmark16Regular,
  Dismiss16Regular,
  ErrorCircle16Regular,
  Info16Regular,
  Open16Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import type {
  Notification,
  NotificationKind,
  NotificationSeverity,
} from "@fleet/protocol";
import { useMemo, useState } from "react";
import { statusVisuals } from "../theme";

const useStyles = makeStyles({
  bell: {
    minWidth: "auto",
    gap: "5px",
    ...shorthands.padding("4px", "8px"),
  },
  count: {
    color: statusVisuals.danger.foreground,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    pointerEvents: "none",
  },
  panel: {
    width: "min(440px, calc(100vw - 20px))",
    maxHeight: "min(620px, calc(100vh - 80px))",
    padding: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "14px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  headerCopy: {
    flexGrow: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  headerIcon: {
    width: "32px",
    height: "32px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  headerText: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "1px",
  },
  heading: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase400,
  },
  summary: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    overflowY: "auto",
    background: tokens.colorNeutralBackground1,
  },
  empty: {
    minHeight: "190px",
    padding: "32px 24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
  emptyIcon: {
    width: "40px",
    height: "40px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "2px",
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  emptyTitle: {
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  emptyBody: {
    maxWidth: "260px",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
  },
  item: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "8px",
    padding: "12px 10px 12px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    transitionProperty: "background-color",
    transitionDuration: tokens.durationFaster,
    "&:hover": {
      background: tokens.colorNeutralBackground1Hover,
    },
    "&:hover > span, &:focus-within > span": {
      opacity: 1,
    },
  },
  unread: {
    background: tokens.colorBrandBackground2,
    boxShadow: `inset 3px 0 ${tokens.colorBrandStroke1}`,
  },
  main: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "6px",
    padding: "1px 4px 1px 0",
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.borderStyle("none"),
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    "&:focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  titleRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "7px",
  },
  indicator: { flexShrink: 0, marginTop: "2px" },
  title: {
    flexGrow: 1,
    minWidth: 0,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase300,
  },
  openIcon: {
    flexShrink: 0,
    marginTop: "1px",
    color: tokens.colorNeutralForeground4,
  },
  body: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.45",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
  },
  itemActions: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    opacity: 0.45,
    transitionProperty: "opacity",
    transitionDuration: tokens.durationFaster,
    "@media (max-width: 767px)": { opacity: 1 },
  },
  resolved: {
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "10px 12px 10px 16px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  footerLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  warning: { color: statusVisuals.attention.foreground },
  error: { color: statusVisuals.danger.foreground },
  info: { color: statusVisuals.info.foreground },
});

const kindLabels: Record<NotificationKind, string> = {
  agent_completion: "Agent completed",
  agent_failure: "Agent failed",
  orchestration_needs_review: "Needs review",
  orchestration_step_failure: "Step failed",
  permission_request: "Permission required",
};

function severityIcon(severity: NotificationSeverity, resolved: boolean) {
  if (resolved) return <Checkmark16Regular />;
  if (severity === "error" || severity === "critical") {
    return <ErrorCircle16Regular />;
  }
  if (severity === "warning") return <Warning16Regular />;
  return <Info16Regular />;
}

function notificationKindLabel(notification: Notification): string {
  if (notification.status !== "resolved") return kindLabels[notification.kind];
  if (notification.kind === "permission_request") return "Permission";
  if (notification.kind === "orchestration_needs_review") return "Review";
  return kindLabels[notification.kind];
}

function notificationTitle(notification: Notification): string {
  if (notification.status !== "resolved") return notification.title;
  if (notification.kind === "permission_request") {
    return "Permission request resolved";
  }
  if (notification.kind === "orchestration_needs_review") {
    const subject = notification.subject.parentLabel || notification.subject.label;
    return `Review resolved: ${subject}`;
  }
  return notification.title;
}

function notificationBody(notification: Notification): string {
  if (
    notification.status === "resolved" &&
    (notification.kind === "permission_request" ||
      notification.kind === "orchestration_needs_review")
  ) {
    return "This item no longer needs action.";
  }
  return notification.body;
}

function timestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export type NotificationCenterProps = {
  notifications: readonly Notification[];
  unreadCount: number;
  browserEnabled: boolean;
  onToggleBrowser: () => void;
  onNavigate: (notification: Notification) => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onDismiss: (id: string) => void;
};

export const NotificationCenter = ({
  notifications,
  unreadCount,
  browserEnabled,
  onToggleBrowser,
  onNavigate,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
}: NotificationCenterProps) => {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const ordered = useMemo(
    () =>
      [...notifications].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      ),
    [notifications],
  );
  const unreadLabel =
    unreadCount === 1 ? "1 unread notification" : `${unreadCount} unread notifications`;

  return (
    <Popover
      open={open}
      onOpenChange={(_event, data) => setOpen(data.open)}
      positioning="below-end"
      trapFocus
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          className={styles.bell}
          appearance="subtle"
          size="small"
          icon={<Alert20Regular />}
          aria-label={`Notifications, ${unreadLabel}`}
          aria-expanded={open}
        >
          {unreadCount > 0 && (
            <span className={styles.count} aria-hidden="true">
              {unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverSurface className={styles.panel} aria-label="Notifications">
        <div className={styles.header}>
          <div className={styles.headerCopy}>
            <span className={styles.headerIcon} aria-hidden="true">
              <Alert20Regular />
            </span>
            <span className={styles.headerText}>
              <Text className={styles.heading}>Notifications</Text>
              <Text className={styles.summary}>{unreadLabel}</Text>
            </span>
          </div>
          <Button
            appearance="subtle"
            size="small"
            disabled={unreadCount === 0}
            onClick={onMarkAllRead}
          >
            Mark all read
          </Button>
        </div>
        {ordered.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} aria-hidden="true">
              <Checkmark16Regular />
            </span>
            <Text className={styles.emptyTitle}>No notifications yet.</Text>
            <Text className={styles.emptyBody}>
              Updates that need your attention will appear here.
            </Text>
          </div>
        ) : (
          <ul className={styles.list}>
            {ordered.map((notification) => {
              const unread = !notification.readAt;
              const resolved = notification.status === "resolved";
              const title = notificationTitle(notification);
              const body = notificationBody(notification);
              return (
                <li
                  key={notification.id}
                  className={mergeClasses(
                    styles.item,
                    unread && styles.unread,
                    resolved && styles.resolved,
                  )}
                  data-notification-id={notification.id}
                >
                  <button
                    type="button"
                    className={styles.main}
                    aria-label={`Open ${title}`}
                    onClick={() => {
                      onNavigate(notification);
                      setOpen(false);
                    }}
                  >
                    <span className={styles.titleRow}>
                      <span
                        className={mergeClasses(
                          styles.indicator,
                          notification.severity === "warning" && styles.warning,
                          (notification.severity === "error" ||
                            notification.severity === "critical") &&
                            styles.error,
                          notification.severity === "info" && styles.info,
                        )}
                        role="img"
                        aria-label={
                          resolved
                            ? "resolved notification"
                            : `${notification.severity} severity`
                        }
                      >
                        {severityIcon(notification.severity, resolved)}
                      </span>
                      <span className={styles.title}>{title}</span>
                      <Open16Regular className={styles.openIcon} aria-hidden="true" />
                    </span>
                    {body && <span className={styles.body}>{body}</span>}
                    <span className={styles.meta}>
                      <Badge size="small" appearance="tint">
                        {notificationKindLabel(notification)}
                      </Badge>
                      {resolved && (
                        <Badge size="small" appearance="filled" color="success">
                          Resolved
                        </Badge>
                      )}
                      <time
                        dateTime={notification.createdAt}
                        title={notification.createdAt}
                      >
                        {timestamp(notification.createdAt)}
                      </time>
                      <span>{unread ? "Unread" : "Read"}</span>
                    </span>
                  </button>
                  <span className={styles.itemActions}>
                    {unread && (
                      <Tooltip relationship="label" content="Mark read" withArrow>
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<Checkmark16Regular />}
                          aria-label={`Mark ${title} read`}
                          onClick={() => onMarkRead(notification.id)}
                        />
                      </Tooltip>
                    )}
                    <Tooltip relationship="label" content="Dismiss" withArrow>
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<Dismiss16Regular />}
                        aria-label={`Dismiss ${title}`}
                        onClick={() => onDismiss(notification.id)}
                      />
                    </Tooltip>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className={styles.footer}>
          <Text className={styles.footerLabel}>Desktop notifications</Text>
          <Button
            appearance={browserEnabled ? "secondary" : "subtle"}
            size="small"
            aria-pressed={browserEnabled}
            onClick={onToggleBrowser}
          >
            {browserEnabled ? "Disable browser alerts" : "Enable browser alerts"}
          </Button>
        </div>
      </PopoverSurface>
    </Popover>
  );
};
