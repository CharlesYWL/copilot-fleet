import { useCallback, useEffect, useState } from "react";
import {
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { api } from "../hooks/useFleet";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    maxWidth: "720px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
  },
});

export const GeneralPanel = () => {
  const styles = useStyles();
  const [yolo, setYolo] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const defaults = await api<{ yolo: boolean }>("/api/defaults");
      setYolo(defaults.yolo);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = async (checked: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const defaults = await api<{ yolo: boolean }>("/api/defaults", {
        method: "POST",
        body: JSON.stringify({ yolo: checked }),
      });
      setYolo(defaults.yolo);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (yolo === undefined) {
    return (
      <div className={styles.panel}>
        <Spinner label="Loading defaults…" />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div>
        <Title3 as="h1">Session defaults</Title3>
        <br />
        <Text className={styles.caption}>
          Applied when you open the new-session dialog. Each session keeps the value
          it was created with, so changing this never affects a running agent.
        </Text>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <section className={styles.card}>
        <div className={styles.row}>
          <div>
            <Text weight="semibold">YOLO mode</Text>
            <br />
            <Text className={styles.caption}>
              Starts Copilot with --allow-all so it runs tools, reads paths, and
              fetches URLs without asking.
            </Text>
          </div>
          <Switch
            checked={yolo}
            disabled={busy}
            label={yolo ? "On" : "Off"}
            onChange={(_event, data) => void handleToggle(data.checked)}
          />
        </div>
      </section>

      {yolo && (
        <MessageBar intent="warning">
          <MessageBarBody>
            New sessions will execute commands on their node without approval. You can
            still turn this off for an individual session when starting it.
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
};
