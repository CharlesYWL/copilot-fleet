import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Checkmark20Regular, Copy20Regular } from "@fluentui/react-icons";
import type {
  TunnelInfo,
  TunnelProvider,
  TunnelProviderInfo,
  TunnelState,
} from "@fleet/protocol";
import { useTunnel } from "../hooks/useTunnel";
import { orderTunnelProviders } from "../lib/tunnel-order";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    maxWidth: "760px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "18px 22px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  primaryCard: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
  },
  heading: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
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
    flexWrap: "wrap",
  },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: "13px",
    wordBreak: "break-all",
  },
});

const statusLabel = (status: TunnelState["status"]): string => {
  switch (status) {
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

type CardProps = {
  spec: TunnelProviderInfo;
  state: TunnelState;
  isPrimary: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onMakePrimary: () => void;
};

const ProviderCard = ({
  spec,
  state,
  isPrimary,
  busy,
  onToggle,
  onMakePrimary,
}: CardProps) => {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const switching = busy || state.status === "starting" || state.status === "stopping";
  const url = state.url;
  const online = state.status === "on" && Boolean(url);

  return (
    <section
      className={`${styles.card} ${isPrimary ? styles.primaryCard : ""}`}
      aria-label={spec.label}
    >
      <div className={styles.row}>
        <div>
          <div className={styles.heading}>
            <Text weight="semibold">{spec.label}</Text>
            {isPrimary && (
              <Badge appearance="filled" color="brand">
                Used for enrollment
              </Badge>
            )}
            {state.external && <Badge appearance="outline">External process</Badge>}
          </div>
          <Text className={styles.caption}>
            {spec.binaryPresent ? (
              <code>{spec.binary}</code>
            ) : (
              <>
                Not installed — <code>{spec.installHint}</code>
              </>
            )}
          </Text>
        </div>
        <Switch
          checked={state.enabled || state.status === "on"}
          disabled={!spec.binaryPresent || switching || state.external}
          label={state.enabled ? "On" : "Off"}
          onChange={(_event, data) => onToggle(data.checked)}
        />
      </div>

      {state.error && (
        <MessageBar intent="error">
          <MessageBarBody>{state.error}</MessageBarBody>
        </MessageBar>
      )}

      {online && spec.caveat && (
        <MessageBar intent="info">
          <MessageBarBody>{spec.caveat}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.status}>
        {(state.status === "starting" || state.status === "stopping") && (
          <Spinner size="tiny" />
        )}
        <Text className={styles.caption}>Status: {statusLabel(state.status)}</Text>
        {state.status === "error" && spec.binaryPresent && !busy && (
          <Button size="small" appearance="secondary" onClick={() => onToggle(true)}>
            Retry
          </Button>
        )}
      </div>

      {online && url && (
        <div className={styles.urlRow}>
          <code className={styles.mono}>{url}</code>
          <Button
            size="small"
            appearance="secondary"
            icon={copied ? <Checkmark20Regular /> : <Copy20Regular />}
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          {!isPrimary && (
            <Button size="small" appearance="subtle" onClick={onMakePrimary}>
              Use for enrollment
            </Button>
          )}
        </div>
      )}

      {online && state.tunnelId && (
        <Text className={styles.caption}>
          Tunnel id: <code className={styles.mono}>{state.tunnelId}</code>
        </Text>
      )}
    </section>
  );
};

const TunnelSummary = ({ info }: { info: TunnelInfo }) => {
  const styles = useStyles();
  const online = info.tunnels.filter((entry) => entry.status === "on");
  return (
    <MessageBar intent={online.length > 0 ? "success" : "info"}>
      <MessageBarBody>
        {online.length === 0
          ? "No tunnel is running. Nodes are told "
          : `${online.length} tunnel${online.length === 1 ? "" : "s"} online. Nodes are told `}
        <code className={styles.mono}>{info.publicUrl}</code>
        {info.primary ? "." : " — the configured fallback, since no tunnel is serving."}
      </MessageBarBody>
    </MessageBar>
  );
};

export const TunnelPanel = () => {
  const styles = useStyles();
  const { info, busy, error: actionError, setEnabled } = useTunnel();

  if (!info) {
    return (
      <div className={styles.panel}>
        <Spinner label="Loading tunnel status…" />
      </div>
    );
  }

  // A provider the Host has never started still needs a row, or the operator
  // cannot switch it on in the first place.
  const stateFor = (provider: TunnelProvider): TunnelState =>
    info.tunnels.find((entry) => entry.provider === provider) ?? {
      provider,
      enabled: false,
      status: "off",
      error: null,
      external: false,
    };

  /**
   * Active first, then installed, then the rest — see {@link orderTunnelProviders}.
   */
  const ordered = orderTunnelProviders(info.providers, (id) =>
    info.tunnels.find((entry) => entry.provider === id),
  );

  return (
    <div className={styles.panel}>
      <div>
        <Title3 as="h1">Remote access tunnels</Title3>
        <br />
        <Text className={styles.caption}>
          Each provider runs on its own, so more than one can be up at a time — a fixed
          public hostname for teammates, a private tunnel for just this account. The one
          marked for enrollment is the address handed to new nodes.
        </Text>
      </div>

      {actionError && (
        <MessageBar intent="error">
          <MessageBarBody>{actionError}</MessageBarBody>
        </MessageBar>
      )}

      <TunnelSummary info={info} />

      {ordered.map((spec) => (
        <ProviderCard
          key={spec.id}
          spec={spec}
          state={stateFor(spec.id)}
          isPrimary={info.primary === spec.id}
          busy={busy === spec.id}
          onToggle={(enabled) => void setEnabled(spec.id, enabled)}
          onMakePrimary={() => void setEnabled(spec.id, true, true)}
        />
      ))}
    </div>
  );
};
