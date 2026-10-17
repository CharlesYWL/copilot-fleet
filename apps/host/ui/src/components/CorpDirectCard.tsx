import { useState } from "react";
import {
  Badge,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  CorpDirectConfigSchema,
  type CorpDirectConfig,
  type CorpDirectInfo,
  type TunnelState,
} from "@fleet/protocol";
import { CopyButton } from "./CopyButton";
import { useMessageNotification } from "../hooks/useAppNotifications";

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "18px 22px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  primaryCard: { border: `1px solid ${tokens.colorBrandStroke1}` },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
  },
  heading: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  fields: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "12px",
  },
  caption: { color: tokens.colorNeutralForeground3 },
  code: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    margin: "0",
  },
});

type Draft = { hostIp: string; port: string; sources: string };
type Props = {
  info: CorpDirectInfo;
  state: TunnelState;
  isPrimary: boolean;
  busy: boolean;
  onSetEnabled: (
    enabled: boolean,
    configuration?: CorpDirectConfig,
    primary?: boolean,
  ) => Promise<void>;
};

/** Private networking is explicit configuration, not a binary to install. */
export const CorpDirectCard = ({ info, state, isPrimary, busy, onSetEnabled }: Props) => {
  const styles = useStyles();
  const [draft, setDraft] = useState<Draft>();
  const [validationError, setValidationError] = useState<string>();
  useMessageNotification(state.error ? `Corp direct: ${state.error}` : undefined);
  const values = draft ?? {
    hostIp: info.configuration?.hostIp ?? info.addresses[0] ?? "",
    port: String(info.configuration?.port ?? 8787),
    sources: info.configuration?.allowedSources.join(", ") ?? "",
  };
  const online = state.status === "on" && Boolean(state.url);
  const switching = busy || state.status === "starting" || state.status === "stopping";
  const enabled = state.enabled || state.status === "on";
  const locked = enabled || switching || !info.supported;
  const handleEdit = (field: keyof Draft, value: string) => {
    setDraft({ ...values, [field]: value });
    setValidationError(undefined);
  };
  const handleToggle = async (next: boolean) => {
    setValidationError(undefined);
    if (!next) {
      await onSetEnabled(false);
      return;
    }
    const allowedSources = values.sources.split(/[\s,]+/).filter(Boolean);
    if (allowedSources.length === 0) {
      setValidationError("Add at least one allowed worker IP address or private CIDR.");
      return;
    }
    const parsed = CorpDirectConfigSchema.safeParse({
      hostIp: values.hostIp,
      port: Number(values.port),
      allowedSources,
    });
    if (!parsed.success) {
      setValidationError(
        parsed.error.issues[0]?.message ?? "Check the private network configuration.",
      );
      return;
    }
    if (!info.addresses.includes(parsed.data.hostIp)) {
      setValidationError(
        "Choose a private IPv4 address currently assigned to this Host.",
      );
      return;
    }
    await onSetEnabled(true, parsed.data, true);
  };

  return (
    <section
      className={`${styles.card} ${isPrimary ? styles.primaryCard : ""}`}
      aria-label="Corp direct (private IP)"
    >
      <div className={styles.row}>
        <div className={styles.heading}>
          <Text weight="semibold">Corp direct (private IP)</Text>
          <Badge appearance="outline">Private network</Badge>
          {isPrimary && (
            <Badge appearance="filled" color="brand">
              Used for enrollment
            </Badge>
          )}
        </div>
        <Switch
          aria-label="Enable Corp direct"
          label={enabled ? "On" : "Off"}
          checked={enabled}
          disabled={!info.supported || switching}
          onChange={(_event, data) => void handleToggle(data.checked)}
        />
      </div>
      <Text className={styles.caption}>
        Direct HTTPS/WSS between reachable private IPs. No Dev Tunnels CLI, tunnel login,
        or external relay is used. Available only to verified Microsoft corporate
        administrators.
      </Text>
      {!info.supported && (
        <MessageBar intent="info">
          <MessageBarBody>
            Automatic Corp direct certificate setup requires Windows. Existing tunnel
            modes remain available.
          </MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.fields}>
        <Field label="Host private IPv4 address" required>
          <Input
            aria-label="Host private IPv4 address"
            value={values.hostIp}
            disabled={locked}
            onChange={(_event, data) => handleEdit("hostIp", data.value)}
          />
        </Field>
        <Field label="Corp direct HTTPS port" required>
          <Input
            aria-label="Corp direct HTTPS port"
            type="number"
            min={1}
            max={65535}
            value={values.port}
            disabled={locked}
            onChange={(_event, data) => handleEdit("port", data.value)}
          />
        </Field>
      </div>
      <Field
        label="Allowed worker IPs or CIDRs"
        required
        hint="Comma- or whitespace-separated private addresses/ranges. Use only the source scope approved for your network."
      >
        <Textarea
          aria-label="Allowed worker IPs or CIDRs"
          value={values.sources}
          disabled={locked}
          resize="vertical"
          onChange={(_event, data) => handleEdit("sources", data.value)}
        />
      </Field>
      <Text className={styles.caption}>
        Detected private addresses: {info.addresses.join(", ") || "none"}. Switch off
        before editing. An address change requires an explicit update and new Node
        connection command.
      </Text>
      {info.configuration && !info.addresses.includes(info.configuration.hostIp) && (
        <MessageBar intent="error">
          <MessageBarBody>
            The configured private IP is no longer assigned to this Host. Switch Corp
            direct off, update the address and generate a new Node command.
          </MessageBarBody>
        </MessageBar>
      )}
      {validationError && (
        <MessageBar intent="error">
          <MessageBarBody>{validationError}</MessageBarBody>
        </MessageBar>
      )}
      {state.error && (
        <MessageBar intent="error">
          <MessageBarBody>{state.error}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.row}>
        <div className={styles.heading}>
          {switching && <Spinner size="tiny" />}
          <Text className={styles.caption}>
            Status: {online ? "Online" : state.status}
          </Text>
        </div>
        {state.status === "error" && !switching && (
          <Button size="small" onClick={() => void handleToggle(true)}>
            Retry Corp direct
          </Button>
        )}
      </div>
      {online && state.url && (
        <div className={styles.row}>
          <code className={styles.code}>{state.url}</code>
          <CopyButton text={state.url} showText />
          {!isPrimary && (
            <Button
              appearance="subtle"
              onClick={() => void onSetEnabled(true, undefined, true)}
            >
              Use for enrollment
            </Button>
          )}
        </div>
      )}
      {info.firewallCommand && (
        <>
          <Text weight="semibold">One-time Host firewall setup</Text>
          <Text className={styles.caption}>
            Run this on the Host in Administrator PowerShell only if permitted by your
            network policy. Fleet and the Node login-start task remain unelevated.
            Existing broader firewall rules still apply.
          </Text>
          <pre className={styles.code}>{info.firewallCommand}</pre>
          <CopyButton
            text={info.firewallCommand}
            label="Copy Host firewall command"
            showText
          />
        </>
      )}
      <MessageBar intent="info">
        <MessageBarBody>
          Once online, generate a command under Nodes → Connect a machine. It includes
          public certificate trust for the Node; private keys stay on the Host. Keep using
          the Host-local browser UI unless you explicitly configure browser certificate
          trust. Enabling this does not move existing Nodes or disable other providers.
        </MessageBarBody>
      </MessageBar>
    </section>
  );
};
