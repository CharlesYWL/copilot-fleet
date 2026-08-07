import { Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

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

type TopBarProps = {
  nodesOnline: number;
  liveSessions: number;
  waitingPermissions: number;
  connected: boolean;
};

export const TopBar = ({
  nodesOnline,
  liveSessions,
  waitingPermissions,
  connected,
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
