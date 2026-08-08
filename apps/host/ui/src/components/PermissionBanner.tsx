import { Button, Text, makeStyles, mergeClasses } from "@fluentui/react-components";
import { Warning20Regular } from "@fluentui/react-icons";
import { permissionSurface } from "../theme";

const useStyles = makeStyles({
  banner: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px 16px",
    borderBottom: `1px solid ${permissionSurface.border}`,
    background: permissionSurface.background,
    color: permissionSurface.foreground,
  },
  // In a monitor tile the banner sits at the bottom of the card, so the rule
  // moves to the top edge and the controls shrink to fit a narrow column.
  compact: {
    gap: "8px",
    padding: "6px 10px",
    borderBottom: "none",
    borderTop: `1px solid ${permissionSurface.border}`,
  },
  body: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  title: {
    color: permissionSurface.accent,
    fontSize: "10px",
    letterSpacing: "1.2px",
    textTransform: "uppercase",
  },
  detail: {
    color: permissionSurface.detail,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  compactDetail: {
    fontSize: "11px",
  },
  allow: {
    background: permissionSurface.accent,
    color: permissionSurface.onAccent,
    border: "none",
  },
});

type PermissionBannerProps = {
  title: string;
  allowOptionId?: string | undefined;
  compact?: boolean;
  onDecide: (outcome: "allow_once" | "deny", optionId?: string) => void;
};

export const PermissionBanner = ({
  title,
  allowOptionId,
  compact = false,
  onDecide,
}: PermissionBannerProps) => {
  const styles = useStyles();
  const size = compact ? "small" : "medium";

  const handleAllow = () => onDecide("allow_once", allowOptionId);
  const handleDeny = () => onDecide("deny");

  return (
    <div className={mergeClasses(styles.banner, compact && styles.compact)} role="alert">
      {!compact && <Warning20Regular aria-hidden="true" />}
      <div className={styles.body}>
        {!compact && <Text className={styles.title}>Permission required</Text>}
        <Text className={mergeClasses(styles.detail, compact && styles.compactDetail)}>
          {title}
        </Text>
      </div>
      <Button className={styles.allow} size={size} onClick={handleAllow}>
        Allow once
      </Button>
      <Button appearance="secondary" size={size} onClick={handleDeny}>
        Deny
      </Button>
    </div>
  );
};
