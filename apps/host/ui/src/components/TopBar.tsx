import { useEffect, useState, type ReactElement } from "react";
import type { Notification } from "@fleet/protocol";
import {
  Button,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  Code20Regular,
  Navigation20Regular,
  PanelLeftContract20Regular,
  PanelLeftExpand20Regular,
  PlugConnected20Regular,
  PlugDisconnected20Regular,
  Pulse20Regular,
  Server20Regular,
  SignOut20Regular,
  Speaker220Regular,
  SpeakerMute20Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import { BrandMark } from "./BrandMark";
import { ContextModeToggle, type ContextMode } from "./navigation/ContextModeToggle";
import { fetchAuthStatus } from "../lib/auth";
import { permissionSurface, semanticColors, statusVisuals } from "../theme";
import { NotificationCenter } from "./NotificationCenter";
import type { useAppNotifications } from "../hooks/useAppNotifications";

const useStyles = makeStyles({
  /**
   * Three columns rather than a row with auto margins.
   *
   * Auto margins only centre the middle within whatever the sides leave, so
   * the mode switch drifted as the brand or the counts changed width. A fixed
   * centre column puts it in the middle of the window and keeps it there.
   */
  bar: {
    height: "56px",
    flexShrink: 0,
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    gap: "16px",
    padding: "0 20px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    "@media (max-width: 767px)": { gap: "8px", padding: "0 10px" },
  },
  left: { display: "flex", alignItems: "center", gap: "10px", minWidth: 0 },
  centre: { display: "flex", justifyContent: "center", minWidth: 0 },
  /** The drawer handle, which only exists at widths where there is a drawer. */
  navButton: {
    display: "none",
    "@media (max-width: 767px)": { display: "inline-flex" },
  },
  /**
   * The fold control for the tree, which only exists where the tree is a column.
   *
   * Deliberately a second button rather than the same one wearing two hats:
   * below 768px the tree is a drawer that opens over the content, and folding
   * away something that is already not taking any room is not a thing to offer.
   */
  collapseButton: {
    display: "inline-flex",
    "@media (max-width: 767px)": { display: "none" },
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    minWidth: 0,
    // The word goes before the mode switch does; the mark still says where you
    // are, and the switch is what the screen is for.
    "@media (max-width: 600px)": { display: "none" },
  },
  stats: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "2px",
    minWidth: 0,
  },
  /**
   * A count with its meaning in the icon rather than beside it.
   *
   * The words cost more room than they were worth: three labels pushed the
   * mode switch off centre and were the first thing to wrap on a narrow
   * window. The number is the information; the icon says which number it is,
   * and the tooltip and accessible name still spell it out.
   */
  stat: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    padding: "4px 8px",
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
    // Counts that are not about a person waiting can go; "needs you" stays.
    "@media (max-width: 767px)": { display: "none" },
  },
  statValue: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    fontVariantNumeric: "tabular-nums",
  },
  attentionButton: {
    minWidth: "auto",
    ...shorthands.padding("4px", "8px"),
  },
  commandButton: { minWidth: "auto" },
  commandAttention: {
    color: permissionSurface.accent,
    backgroundColor: permissionSurface.background,
    ...shorthands.borderColor(permissionSurface.border),
    animationName: {
      "0%,100%": { boxShadow: `0 0 0 0 ${statusVisuals.attention.surface}` },
      "50%": {
        backgroundColor: statusVisuals.attention.surface,
        boxShadow: `0 0 0 4px ${statusVisuals.attention.surface}`,
      },
    },
    animationDuration: "1.8s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  commandCount: {
    minWidth: "20px",
    padding: "1px 5px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: permissionSurface.accent,
    color: permissionSurface.onAccent,
    fontWeight: tokens.fontWeightBold,
    fontVariantNumeric: "tabular-nums",
  },
  commandLabel: { "@media (max-width: 900px)": { display: "none" } },
  warn: { color: semanticColors.permission },
  /** The connection state is reassurance, not information; a dot is enough. */
  connection: {
    display: "flex",
    alignItems: "center",
    padding: "4px 6px",
    color: semanticColors.completed,
  },
  connectionLost: { color: semanticColors.permission },
  soundButton: {
    "@media (max-width: 600px)": { display: "none" },
  },
  operator: {
    maxWidth: "180px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
    "@media (max-width: 900px)": { display: "none" },
  },
});

type StatProps = {
  label: string;
  value: number;
  icon: ReactElement;
  warn?: boolean;
};

const Stat = ({ label, value, icon, warn = false }: StatProps) => {
  const styles = useStyles();
  /*
   * Named explicitly rather than left to the tooltip.
   *
   * A tooltip labels a control; this is a plain box, so without a role and a
   * name of its own the count reached assistive tech as a bare "1" with no
   * hint of what was being counted. The words moved into the icon visually,
   * not out of the page.
   */
  const description = `${value} ${label}`;
  return (
    <Tooltip relationship="label" content={description} withArrow>
      <div
        className={mergeClasses(styles.stat, warn && styles.warn)}
        role="img"
        aria-label={description}
      >
        {icon}
        <span className={mergeClasses(styles.statValue, warn && styles.warn)}>
          {value}
        </span>
      </div>
    </Tooltip>
  );
};

/**
 * The fleet's own header.
 *
 * The mode slot is contextual: what it offers depends on what the main area is
 * showing, which is why it takes a `ContextMode` rather than a layout value.
 * A stat that reads zero is still worth its space — an operator scanning for
 * "is anything waiting on me" should find the answer in the same place whether
 * it is 0 or 4.
 */
type TopBarProps = {
  nodesOnline: number;
  liveSessions: number;
  waitingPermissions: number;
  connected: boolean;
  context: ContextMode;
  soundEnabled: boolean;
  onToggleSound: () => void;
  notifications?: readonly Notification[];
  appNotifications?: ReturnType<typeof useAppNotifications>;
  notificationUnreadCount?: number;
  browserNotificationsEnabled?: boolean;
  onToggleBrowserNotifications?: () => void;
  onNavigateNotification?: (notification: Notification) => void;
  onMarkNotificationRead?: (id: string) => void | Promise<unknown>;
  onMarkAllNotificationsRead?: () => void;
  onDismissAllNotifications?: () => void;
  onDismissNotification?: (id: string) => void | Promise<unknown>;
  onSignOut: () => void;
  onOpenCommandExecutions?: (() => void) | undefined;
  commandApprovalCount?: number;
  /** Jumps to whatever needs a person, when anything does. */
  onShowAttention?: (() => void) | undefined;
  /** Only meaningful below the width where the tree becomes a drawer. */
  onToggleNav?: (() => void) | undefined;
  navOpen?: boolean;
  /**
   * Folds the tree away on the widths where it is a column beside the content.
   *
   * Separate from `onToggleNav` because they are different gestures on
   * different layouts — one opens a drawer over the page, the other gives the
   * page the sidebar's width back — and a single handler would have to guess
   * which layout it was in.
   */
  onToggleNavCollapsed?: (() => void) | undefined;
  navCollapsed?: boolean;
};

export const TopBar = ({
  nodesOnline,
  liveSessions,
  waitingPermissions,
  connected,
  context,
  soundEnabled,
  onToggleSound,
  notifications = [],
  appNotifications,
  notificationUnreadCount = 0,
  browserNotificationsEnabled = false,
  onToggleBrowserNotifications = () => undefined,
  onNavigateNotification = () => undefined,
  onMarkNotificationRead = () => undefined,
  onMarkAllNotificationsRead = () => undefined,
  onDismissAllNotifications = () => undefined,
  onDismissNotification = () => undefined,
  onSignOut,
  onOpenCommandExecutions,
  commandApprovalCount = 0,
  onShowAttention,
  onToggleNav,
  navOpen = false,
  onToggleNavCollapsed,
  navCollapsed = false,
}: TopBarProps) => {
  const styles = useStyles();
  const collapseLabel = navCollapsed ? "Show sidebar" : "Hide sidebar";
  const [operator, setOperator] = useState<{
    username: string;
    displayName: string;
  }>();
  const [noAuth, setNoAuth] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthStatus().then((status) => {
      if (!cancelled) {
        setOperator(status.identity);
        setNoAuth(status.state === "no-auth");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className={styles.bar} data-tour="fleet-header" tabIndex={-1}>
      <div className={styles.left}>
        {onToggleNav && (
          <Button
            appearance="subtle"
            size="small"
            className={styles.navButton}
            icon={<Navigation20Regular />}
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            onClick={onToggleNav}
          />
        )}
        {onToggleNavCollapsed && (
          <Tooltip relationship="label" content={collapseLabel} withArrow>
            <Button
              appearance="subtle"
              size="small"
              className={styles.collapseButton}
              icon={
                navCollapsed ? (
                  <PanelLeftExpand20Regular />
                ) : (
                  <PanelLeftContract20Regular />
                )
              }
              aria-label={collapseLabel}
              aria-expanded={!navCollapsed}
              onClick={onToggleNavCollapsed}
            />
          </Tooltip>
        )}
        <div className={styles.brand} data-tour="fleet-brand">
          <BrandMark size={30} />
          <Text weight="semibold">Copilot Fleet</Text>
        </div>
      </div>

      <div className={styles.centre} data-tour="view-controls">
        <ContextModeToggle context={context} />
      </div>

      <div className={styles.stats}>
        <Stat
          label={nodesOnline === 1 ? "node online" : "nodes online"}
          value={nodesOnline}
          icon={<Server20Regular />}
        />
        <Stat
          label={liveSessions === 1 ? "live session" : "live sessions"}
          value={liveSessions}
          icon={<Pulse20Regular />}
        />
        {waitingPermissions > 0 && onShowAttention ? (
          <Tooltip
            relationship="label"
            content={`${waitingPermissions} waiting for you`}
            withArrow
          >
            <Button
              appearance="subtle"
              size="small"
              className={mergeClasses(styles.attentionButton, styles.warn)}
              icon={<Warning20Regular />}
              aria-label={`${waitingPermissions} waiting for you`}
              onClick={onShowAttention}
            >
              <span className={mergeClasses(styles.statValue, styles.warn)}>
                {waitingPermissions}
              </span>
            </Button>
          </Tooltip>
        ) : (
          <Stat
            label="waiting for you"
            value={waitingPermissions}
            icon={<Warning20Regular />}
            warn={waitingPermissions > 0}
          />
        )}
        {onOpenCommandExecutions && (
          <Button
            appearance={commandApprovalCount > 0 ? "secondary" : "subtle"}
            size="small"
            className={mergeClasses(
              styles.commandButton,
              commandApprovalCount > 0 && styles.commandAttention,
            )}
            icon={<Code20Regular />}
            onClick={onOpenCommandExecutions}
            aria-label={`Command executions${commandApprovalCount ? `, ${commandApprovalCount} awaiting approval` : ""}`}
          >
            <span className={styles.commandLabel}>Commands</span>
            {commandApprovalCount > 0 && (
              <span className={styles.commandCount}>{commandApprovalCount}</span>
            )}
          </Button>
        )}
        <NotificationCenter
          notifications={[...notifications, ...(appNotifications?.notifications ?? [])]}
          unreadCount={notificationUnreadCount + (appNotifications?.unreadCount ?? 0)}
          browserEnabled={browserNotificationsEnabled}
          onToggleBrowser={onToggleBrowserNotifications}
          onNavigate={(notification) => {
            if (notification.kind === "app_message") {
              appNotifications?.markRead(notification.id);
              return;
            }
            onNavigateNotification(notification);
          }}
          onMarkRead={(id) =>
            appNotifications?.notifications.some((item) => item.id === id)
              ? appNotifications.markRead(id)
              : onMarkNotificationRead(id)
          }
          onMarkAllRead={() => {
            appNotifications?.markAllRead();
            if (notificationUnreadCount > 0) onMarkAllNotificationsRead();
          }}
          onDismissAll={() => {
            appNotifications?.dismissAll();
            if (notifications.length > 0 || notificationUnreadCount > 0) {
              onDismissAllNotifications();
            }
          }}
          onDismiss={(id) =>
            appNotifications?.notifications.some((item) => item.id === id)
              ? appNotifications.dismiss(id)
              : onDismissNotification(id)
          }
        />
        <Button
          appearance="subtle"
          size="small"
          className={styles.soundButton}
          icon={soundEnabled ? <Speaker220Regular /> : <SpeakerMute20Regular />}
          title={soundEnabled ? "Mute alerts" : "Play a sound on alerts"}
          aria-label={soundEnabled ? "Mute alerts" : "Play a sound on alerts"}
          aria-pressed={soundEnabled}
          onClick={onToggleSound}
        />
        <Tooltip
          relationship="label"
          content={connected ? "Connected to the Host" : "Reconnecting to the Host…"}
          withArrow
        >
          <span
            className={mergeClasses(
              styles.connection,
              !connected && styles.connectionLost,
            )}
            role="img"
          >
            {connected ? <PlugConnected20Regular /> : <PlugDisconnected20Regular />}
          </span>
        </Tooltip>
        {operator && (
          <Text
            className={styles.operator}
            title={operator.displayName || operator.username}
          >
            {operator.displayName || operator.username}
          </Text>
        )}
        {noAuth ? (
          <Text className={styles.operator}>Microsoft sign-in off</Text>
        ) : (
          <Button
            appearance="subtle"
            size="small"
            icon={<SignOut20Regular />}
            title="Sign out"
            aria-label="Sign out"
            onClick={onSignOut}
          />
        )}
      </div>
    </header>
  );
};
