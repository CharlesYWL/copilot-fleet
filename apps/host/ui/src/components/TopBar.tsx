import {
  Text,
  ToggleButton,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { Grid20Regular, TextBulletListTree20Regular } from "@fluentui/react-icons";

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
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginRight: "auto",
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
  stats: {
    display: "flex",
    alignItems: "center",
    gap: "20px",
  },
  stat: {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
  },
  statValue: {
    fontSize: "15px",
    fontWeight: tokens.fontWeightSemibold,
  },
  warn: {
    color: "#f7bf61",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
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

/** Tree pairs the session list with one terminal; grid tiles every session. */
export type LayoutMode = "tree" | "grid";

type TopBarProps = {
  nodesOnline: number;
  liveSessions: number;
  waitingPermissions: number;
  connected: boolean;
  layout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
};

export const TopBar = ({
  nodesOnline,
  liveSessions,
  waitingPermissions,
  connected,
  layout,
  onLayoutChange,
}: TopBarProps) => {
  const styles = useStyles();
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <div className={styles.logo} aria-hidden="true">
          CF
        </div>
        <Text weight="semibold">Copilot Fleet</Text>
      </div>
      <div className={styles.modes} role="group" aria-label="Layout mode">
        <ToggleButton
          appearance="subtle"
          size="small"
          checked={layout === "tree"}
          icon={<TextBulletListTree20Regular />}
          onClick={() => onLayoutChange("tree")}
        >
          Tree
        </ToggleButton>
        <ToggleButton
          appearance="subtle"
          size="small"
          checked={layout === "grid"}
          icon={<Grid20Regular />}
          onClick={() => onLayoutChange("grid")}
        >
          View
        </ToggleButton>
      </div>
      <div className={styles.stats}>
        <Stat label="nodes online" value={nodesOnline} />
        <Stat label="live sessions" value={liveSessions} />
        <Stat
          label="permissions"
          value={waitingPermissions}
          warn={waitingPermissions > 0}
        />
        <Text className={styles.caption}>{connected ? "live" : "reconnecting…"}</Text>
      </div>
    </header>
  );
};
