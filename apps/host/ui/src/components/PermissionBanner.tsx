import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Warning20Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  banner: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px 16px",
    borderBottom: "1px solid #7c653b",
    background: "#241d10",
    color: "#f2dcae",
  },
  body: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  title: {
    color: "#f7bf61",
    fontSize: "10px",
    letterSpacing: "1.2px",
    textTransform: "uppercase",
  },
  detail: {
    color: "#e2d3b2",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  allow: {
    background: "#f7bf61",
    color: "#20180a",
    border: "none",
  },
});

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: string;
};

type PermissionBannerProps = {
  title: string;
  options: PermissionOption[];
  onDecide: (outcome: "allow_once" | "deny", optionId?: string) => void;
};

export const PermissionBanner = ({ title, options, onDecide }: PermissionBannerProps) => {
  const styles = useStyles();
  const allowOption = options.find((option) => option.kind === "allow_once");

  const handleAllow = () => onDecide("allow_once", allowOption?.optionId);
  const handleDeny = () => onDecide("deny");

  return (
    <div className={styles.banner} role="alert">
      <Warning20Regular aria-hidden="true" />
      <div className={styles.body}>
        <Text className={styles.title}>Permission required</Text>
        <Text className={styles.detail}>{title}</Text>
      </div>
      <Button className={styles.allow} onClick={handleAllow}>
        Allow once
      </Button>
      <Button appearance="secondary" onClick={handleDeny}>
        Deny
      </Button>
    </div>
  );
};
