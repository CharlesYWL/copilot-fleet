import {
  Button,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  Navigation20Regular,
  SignOut20Regular,
  Speaker220Regular,
  SpeakerMute20Regular,
} from "@fluentui/react-icons";
import { ContextModeToggle, type ContextMode } from "./navigation/ContextModeToggle";
import { semanticColors } from "../theme";

const useStyles = makeStyles({
  bar: {
    height: "56px",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "16px",
    padding: "0 20px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    "@media (max-width: 767px)": { gap: "8px", padding: "0 10px" },
  },
  /** The drawer handle, which only exists at widths where there is a drawer. */
  navButton: {
    display: "none",
    "@media (max-width: 767px)": { display: "inline-flex" },
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginRight: "auto",
    // The word goes before the mode switch does; the mark still says where you
    // are, and the switch is what the screen is for.
    "@media (max-width: 600px)": { display: "none" },
  },
  logo: {
    width: "30px",
    height: "30px",
    display: "grid",
    placeItems: "center",
    borderRadius: tokens.borderRadiusMedium,
    fontWeight: tokens.fontWeightBold,
    fontSize: "13px",
    color: "#ffffff",
    background: "linear-gradient(145deg,#6c8cff,#8d67e8)",
    boxShadow: "0 6px 20px #6c8cff40",
  },
  modes: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "3px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
  },
  attentionButton: {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    minHeight: "32px",
  },
  stats: {
    display: "flex",
    alignItems: "center",
    gap: "20px",
    marginLeft: "auto",
    "@media (max-width: 900px)": { gap: "10px" },
  },
  stat: {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    // Counts that are not about a person waiting can go; "needs you" stays.
    "@media (max-width: 767px)": { display: "none" },
  },
  statValue: {
    fontSize: "15px",
    fontWeight: tokens.fontWeightSemibold,
  },
  warn: {
    color: semanticColors.permission,
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  /** The connection word is reassurance, not information; it goes first. */
  connection: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    "@media (max-width: 600px)": { display: "none" },
  },
  soundButton: {
    "@media (max-width: 600px)": { display: "none" },
  },
});

type StatProps = {
  label: string;
  value: number;
  warn?: boolean;
};

const Stat = ({ label, value, warn = false }: StatProps) => {
  const styles = useStyles();
  return (
    <div className={styles.stat}>
      <span className={mergeClasses(styles.statValue, warn && styles.warn)}>{value}</span>
      <Text className={styles.caption}>{label}</Text>
    </div>
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
  onSignOut: () => void;
  /** Jumps to whatever needs a person, when anything does. */
  onShowAttention?: (() => void) | undefined;
  /** Only meaningful below the width where the tree becomes a drawer. */
  onToggleNav?: (() => void) | undefined;
  navOpen?: boolean;
};

export const TopBar = ({
  nodesOnline,
  liveSessions,
  waitingPermissions,
  connected,
  context,
  soundEnabled,
  onToggleSound,
  onSignOut,
  onShowAttention,
  onToggleNav,
  navOpen = false,
}: TopBarProps) => {
  const styles = useStyles();
  return (
    <header className={styles.bar}>
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
      <div className={styles.brand}>
        <div className={styles.logo} aria-hidden="true">
          CF
        </div>
        <Text weight="semibold">Copilot Fleet</Text>
      </div>
      <ContextModeToggle context={context} />
      <div className={styles.stats}>
        <Stat label="nodes online" value={nodesOnline} />
        <Stat label="live sessions" value={liveSessions} />
        {waitingPermissions > 0 && onShowAttention ? (
          <Button
            appearance="subtle"
            size="small"
            className={styles.attentionButton}
            onClick={onShowAttention}
          >
            <span className={mergeClasses(styles.statValue, styles.warn)}>
              {waitingPermissions}
            </span>
            <Text className={styles.caption}>needs you</Text>
          </Button>
        ) : (
          <Stat
            label="needs you"
            value={waitingPermissions}
            warn={waitingPermissions > 0}
          />
        )}
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
        <Text className={styles.connection}>{connected ? "live" : "reconnecting…"}</Text>
        <Button
          appearance="subtle"
          size="small"
          icon={<SignOut20Regular />}
          title="Sign out"
          aria-label="Sign out"
          onClick={onSignOut}
        />
      </div>
    </header>
  );
};
