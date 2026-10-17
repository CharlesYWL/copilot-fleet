import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Switch,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { QuestionCircle20Regular } from "@fluentui/react-icons";
import type {
  TunnelInfo,
  TunnelPolicyKind,
  TunnelProvider,
  TunnelProviderInfo,
  TunnelState,
} from "@fleet/protocol";
import { useTunnel } from "../hooks/useTunnel";
import { useMessageNotification } from "../hooks/useAppNotifications";
import { useSettingsActive } from "../hooks/useSettingsActivity";
import { orderTunnelProviders, visibleTunnelProviders } from "../lib/tunnel-order";
import { CopyButton } from "./CopyButton";
import { CorpDirectCard } from "./CorpDirectCard";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
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
  steps: {
    margin: "0 0 12px",
    paddingLeft: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  headingRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
  },
});

/** Setup steps and a link out, so a provider can be adopted without leaving. */
const ProviderHelpDialog = ({ spec }: { spec: TunnelProviderInfo }) => {
  const styles = useStyles();
  const active = useSettingsActive();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={active && open} onOpenChange={(_event, data) => setOpen(data.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button
          size="small"
          appearance="transparent"
          icon={<QuestionCircle20Regular />}
          aria-label={`How to set up ${spec.label}`}
          title={`How to set up ${spec.label}`}
        />
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{spec.label}</DialogTitle>
          <DialogContent>
            <ol className={styles.steps}>
              {spec.setupSteps.map((step) => (
                <li key={step}>
                  <Text>{step}</Text>
                </li>
              ))}
            </ol>
            {spec.caveat && (
              <MessageBar intent="warning">
                <MessageBarBody>{spec.caveat}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            {spec.docsUrl && (
              <Link href={spec.docsUrl} target="_blank" rel="noreferrer">
                Provider documentation
              </Link>
            )}
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};

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
  policyKind: TunnelPolicyKind;
  onToggle: (enabled: boolean) => void;
  onMakePrimary: () => void;
};

/** Why the Host refuses this provider, phrased for the policy in force. */
const refusalText = (spec: TunnelProviderInfo, policyKind: TunnelPolicyKind) => {
  if (spec.externalScheme !== "https") {
    return (
      <>
        {spec.label} publishes plain HTTP with no TLS, so the operator session cookie and
        every transcript behind it would cross it readable. Fleet will not expose the
        console through it.
      </>
    );
  }
  if (policyKind === "microsoft-corp") {
    return `${spec.label} is not approved for Microsoft corporate use, so this Host will not run it. Switch it off.`;
  }
  return `${spec.label} is public. Enable Microsoft sign-in in Settings → Security first, or use private Dev Tunnels.`;
};

const ProviderCard = ({
  spec,
  state,
  isPrimary,
  busy,
  policyKind,
  onToggle,
  onMakePrimary,
}: CardProps) => {
  const styles = useStyles();
  useMessageNotification(state.error ? `${spec.label}: ${state.error}` : undefined);

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
            <ProviderHelpDialog spec={spec} />
            {isPrimary && (
              <Badge appearance="filled" color="brand">
                Used for enrollment
              </Badge>
            )}
            {spec.access === "creator-private" && spec.controlPlaneEligible && (
              <Badge appearance="outline" color="success">
                Private — recommended
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
          // A provider with no TLS is never offered for the console. The Host
          // refuses it too — this only saves the operator the round trip.
          disabled={
            !spec.binaryPresent ||
            switching ||
            state.external ||
            (!spec.controlPlaneEligible && !state.enabled)
          }
          label={state.enabled ? "On" : "Off"}
          onChange={(_event, data) => onToggle(data.checked)}
        />
      </div>

      {/* The Host's own refusal, when it has one, already says this. */}
      {!spec.controlPlaneEligible && !state.error && (
        <MessageBar intent="error">
          <MessageBarBody>{refusalText(spec, policyKind)}</MessageBarBody>
        </MessageBar>
      )}

      {spec.controlPlaneEligible && spec.access === "public" && (
        <MessageBar intent="warning">
          <MessageBarBody>
            Anyone with the URL reaches the sign-in page. That page grants nothing on its
            own — a Microsoft account still has to be an administrator here — but a
            private tunnel keeps strangers off it entirely.
          </MessageBarBody>
        </MessageBar>
      )}

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
          <CopyButton text={url} size="small" showText />
          {!isPrimary && (
            <Button size="small" appearance="subtle" onClick={onMakePrimary}>
              Use for enrollment
            </Button>
          )}
        </div>
      )}

      {online && state.inspectUrl && (
        <Text className={styles.caption}>
          Inspect traffic:{" "}
          <Link href={state.inspectUrl} target="_blank" rel="noreferrer">
            <span className={styles.mono}>{state.inspectUrl}</span>
          </Link>{" "}
          — opens the provider&apos;s request inspector; sign in with the same account.
        </Text>
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
          ? "No remote access provider is running. New Nodes are told "
          : `${online.length} remote access provider${online.length === 1 ? "" : "s"} online. New Nodes are told `}
        <code className={styles.mono}>{info.publicUrl}</code>
        {info.primary ? "." : " — the configured fallback, since no provider is serving."}
      </MessageBarBody>
    </MessageBar>
  );
};

export const TunnelPanel = () => {
  const styles = useStyles();
  const { info, busy, error: actionError, refreshError, setEnabled } = useTunnel();
  useMessageNotification(actionError);

  if (!info) {
    return (
      <div className={styles.panel}>
        {refreshError ? (
          <MessageBar intent="error">
            <MessageBarBody>{refreshError}</MessageBarBody>
          </MessageBar>
        ) : (
          <Spinner label="Loading tunnel status…" />
        )}
      </div>
    );
  }

  const stateOf = (provider: TunnelProvider): TunnelState | undefined =>
    info.tunnels.find((entry) => entry.provider === provider);
  // A provider the Host has never started still needs a row, or the operator
  // cannot switch it on in the first place.
  const stateFor = (provider: TunnelProvider): TunnelState =>
    stateOf(provider) ?? {
      provider,
      enabled: false,
      status: "off",
      error: null,
      external: false,
    };

  /**
   * Active first, then installed, then the rest — see {@link orderTunnelProviders}.
   * A corp Host does not list providers it refuses — see {@link visibleTunnelProviders}.
   */
  const policyKind = info.policy?.kind ?? "open";
  const ordered = orderTunnelProviders(
    visibleTunnelProviders(info.providers, info.policy, stateOf),
    stateOf,
  );
  const labelsOf = (ids: readonly TunnelProvider[]) =>
    info.providers
      .filter((spec) => ids.includes(spec.id))
      .map((spec) => spec.label)
      .join(", ");
  const corpAllowed = labelsOf(info.policy?.allowedProviders ?? []);
  const corpHidden = labelsOf(
    info.providers
      .map((spec) => spec.id)
      .filter((id) => !info.policy?.allowedProviders.includes(id)),
  );

  return (
    <div className={styles.panel}>
      <div>
        <Title3 as="h1">Remote access</Title3>
        <br />
        <Text className={styles.caption}>
          The provider marked for enrollment supplies the address and connection command
          handed to new nodes. Corp direct uses a private-IP HTTPS listener without an
          external tunnel. Existing HTTPS tunnel providers can run independently. With
          Microsoft sign-in enabled, Fleet separately checks who may operate it. Without
          Microsoft sign-in, anyone who can reach the Host can operate it: keep the
          listener on loopback and use private Dev Tunnels, never anonymous tunnel access.
        </Text>
      </div>

      {policyKind === "microsoft-corp" && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Microsoft corporate account</MessageBarTitle>
            This Host is administered by an @microsoft.com account, so it only offers
            corporate-account remote access: {corpAllowed || "none"}. Corp direct still
            requires approval for your network's source scope and firewall configuration.
            {corpHidden &&
              ` Public tunnel providers (${corpHidden}) are hidden and the Host refuses to start them, so this corp machine is never published to the internet by accident.`}
          </MessageBarBody>
        </MessageBar>
      )}

      {actionError && (
        <MessageBar intent="error">
          <MessageBarBody>{actionError}</MessageBarBody>
        </MessageBar>
      )}
      {refreshError && (
        <MessageBar intent="error">
          <MessageBarBody>{refreshError}</MessageBarBody>
        </MessageBar>
      )}

      <TunnelSummary info={info} />

      {ordered.map((spec) =>
        spec.id === "corp-direct" && info.corpDirect ? (
          <CorpDirectCard
            key={spec.id}
            info={info.corpDirect}
            state={stateFor(spec.id)}
            isPrimary={info.primary === spec.id}
            busy={busy === spec.id}
            onSetEnabled={(enabled, configuration, primary) =>
              setEnabled(spec.id, enabled, primary, configuration)
            }
          />
        ) : (
          <ProviderCard
            key={spec.id}
            spec={spec}
            state={stateFor(spec.id)}
            isPrimary={info.primary === spec.id}
            busy={busy === spec.id}
            policyKind={policyKind}
            onToggle={(enabled) => void setEnabled(spec.id, enabled)}
            onMakePrimary={() => void setEnabled(spec.id, true, true)}
          />
        ),
      )}
    </div>
  );
};
