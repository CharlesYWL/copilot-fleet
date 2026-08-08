import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Add20Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  empty: {
    flexGrow: 1,
    display: "grid",
    placeContent: "center",
    justifyItems: "center",
    gap: "10px",
    background: tokens.colorNeutralBackground1,
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    maxWidth: "360px",
    textAlign: "center",
  },
});

type EmptySessionsProps = {
  onNewSession: () => void;
};

export const EmptySessions = ({ onNewSession }: EmptySessionsProps) => {
  const styles = useStyles();
  return (
    <div className={styles.empty}>
      <Text size={500} weight="semibold">
        No live sessions
      </Text>
      <Text className={styles.caption}>
        Register a node, add a workspace placement, then launch an agent to watch its
        stream here.
      </Text>
      <Button appearance="primary" icon={<Add20Regular />} onClick={onNewSession}>
        New session
      </Button>
    </div>
  );
};
