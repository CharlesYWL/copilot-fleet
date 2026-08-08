import { useEffect, useState } from "react";
import {
  Button,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Switch,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Checkmark20Regular, Copy20Regular } from "@fluentui/react-icons";
import type { TunnelInfo, TunnelProvider } from "@fleet/protocol";
import { useTunnel } from "../hooks/useTunnel";

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
  status: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  urlRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: "13px",
    wordBreak: "break-all",
  },
});

const statusLabel = (info: TunnelInfo): string => {
  switch (info.status) {
    case "off":
      return "Off";
    case "starting":
      return "Starting…";
    case "on":
      return "Online";
    case "stopping":
      return "Stopping…";
    case "error":
      return "Error";
  }
};

export const TunnelPanel = () => {
  const styles = useStyles();
  const { info, busy, error: actionError, setEnabled } = useTunnel();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleToggle = (enabled: boolean, provider?: TunnelProvider) =>
    void setEnabled(enabled, provider);

  const handleRetry = () => handleToggle(true);

  if (!info) {
    return (
      <div className={styles.panel}>
        <Spinner label="Loading tunnel status…" />
      </div>
    );
  }

  const switching = busy || info.status === "starting" || info.status === "stopping";
  const showTunnelUrl = info.status === "on";
  const isOn = info.enabled || info.status === "on";
  const current = info.providers.find((entry) => entry.id === info.provider);

  return (
    <div className={styles.panel}>
      <div>
        <Title3 as="h1">Remote access tunnel</Title3>
        <br />
        <Text className={styles.caption}>
          Expose this Host so remote nodes can enroll over the public internet. Pick
          whichever provider you already have installed.
        </Text>
      </div>

      {current && !current.binaryPresent && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <code>{current.binary}</code> was not found on PATH. Install it with{" "}
            <code>{current.installHint}</code>.
          </MessageBarBody>
        </MessageBar>
      )}

      {(actionError || info.error) && (
        <MessageBar intent="error">
          <MessageBarBody>{actionError ?? info.error}</MessageBarBody>
        </MessageBar>
      )}

      {showTunnelUrl && current?.caveat && (
        <MessageBar intent="info">
          <MessageBarBody>
            {current.caveat} Remote nodes must update <code>FLEET_HOST_URL</code> and
            restart after a new URL appears.
          </MessageBarBody>
        </MessageBar>
      )}

      <section className={styles.card}>
        {info.external && (
          <MessageBar intent="info">
            <MessageBarBody>
              This tunnel runs as its own process, so its URL survives Host restarts. Stop
              it in the terminal that started it.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={styles.row}>
          <div>
            <Text weight="semibold">Provider</Text>
            <br />
            <Text className={styles.caption}>
              Switching providers restarts the tunnel.
            </Text>
          </div>
          <Dropdown
            aria-label="Tunnel provider"
            disabled={switching || info.external}
            selectedOptions={[info.provider]}
            value={current?.label ?? info.provider}
            onOptionSelect={(_event, data) => {
              const next = data.optionValue as TunnelProvider | undefined;
              if (!next || next === info.provider) return;
              handleToggle(isOn, next);
            }}
          >
            {info.providers.map((entry) => (
              <Option key={entry.id} value={entry.id} text={entry.label}>
                {entry.binaryPresent ? entry.label : `${entry.label} (not installed)`}
              </Option>
            ))}
          </Dropdown>
        </div>

        <div className={styles.row}>
          <div>
            <Text weight="semibold">Remote access</Text>
            <br />
            <Text className={styles.caption}>
              {info.external
                ? "Managed by the tunnel process, not the Host."
                : "Reconnects automatically if the tunnel drops."}
            </Text>
          </div>
          <Switch
            checked={isOn || info.status === "starting"}
            disabled={!info.binaryPresent || switching || info.external}
            label={isOn ? "On" : "Off"}
            onChange={(_event, data) => handleToggle(data.checked)}
          />
        </div>

        <div className={styles.status}>
          {(info.status === "starting" || info.status === "stopping") && (
            <Spinner size="tiny" />
          )}
          <Text>Status: {statusLabel(info)}</Text>
          {info.status === "error" && info.binaryPresent && (
            <Button
              size="small"
              appearance="secondary"
              onClick={handleRetry}
              disabled={busy}
            >
              Retry
            </Button>
          )}
        </div>

        {showTunnelUrl && (
          <div className={styles.urlRow}>
            <code className={styles.mono}>{info.publicUrl}</code>
            <Button
              size="small"
              appearance="secondary"
              icon={copied ? <Checkmark20Regular /> : <Copy20Regular />}
              onClick={() => {
                void navigator.clipboard
                  .writeText(info.publicUrl)
                  .then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}

        {!showTunnelUrl && (
          <Text className={styles.caption}>
            Public URL when off: <code className={styles.mono}>{info.publicUrl}</code>
          </Text>
        )}
      </section>
    </div>
  );
};
