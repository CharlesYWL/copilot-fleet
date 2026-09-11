import { useState } from "react";
import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { errorMessage, type ConnectCommand } from "@fleet/protocol";
import { useEnrollment } from "../hooks/useEnrollment";
import { useMessageNotification } from "../hooks/useAppNotifications";
import { api } from "../hooks/useFleet";
import {
  devTunnelLoginCommand,
  isDevTunnelUrl,
  isLocalOnlyHostUrl,
  keyEnrollCommand,
  type NodeLaunchMode,
} from "../lib/enroll-command";
import { terminal } from "../theme";
import { CopyButton } from "./CopyButton";

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "20px 24px",
    marginBottom: "24px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  urlField: {
    maxWidth: "520px",
  },
  commandBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    minWidth: 0,
    padding: "14px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  commandHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "12px",
  },
  commandTitle: {
    margin: 0,
    fontFamily: terminal.font,
  },
  command: {
    minWidth: 0,
    margin: 0,
    padding: "14px 16px",
    borderRadius: tokens.borderRadiusMedium,
    background: terminal.background,
    color: terminal.agent,
    fontFamily: terminal.font,
    fontSize: "12px",
    lineHeight: "1.7",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    overflowX: "auto",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  },
  fingerprint: {
    fontFamily: terminal.font,
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    wordBreak: "break-all",
  },
});

const launchMethods: readonly {
  mode: NodeLaunchMode;
  label: string;
  invocation: string;
  description: string;
}[] = [
  {
    mode: "direct",
    label: "npm start",
    invocation: "npm run start:node",
    description:
      "Run in this terminal. Works in PowerShell and bash; keep the terminal open. Ctrl+C stops the Node.",
  },
  {
    mode: "service",
    label: "npm service",
    invocation: "npm run service -- node",
    description:
      "Windows service mode: builds, enrolls, and starts now, then starts automatically at Windows sign-in. No terminal needs to stay open.",
  },
];

type IssuedGrant = {
  id: string;
  grant: string;
  expiresAt: string;
  command: ConnectCommand;
};

/** Local time: the operator is deciding whether they have time to walk over. */
function expiryLabel(expiresAt: string): string {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return "shortly";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The command that joins one machine to this fleet.
 *
 * Nothing is minted until somebody asks. A grant is a live credential with a
 * fifteen-minute life and a single use, so creating one on every render would
 * spend them on nobody, fill the audit log, and leave a usable credential on
 * screen for anyone who walked past a console left open on the Nodes tab.
 *
 * What it prints is not the old fleet-wide token. That token was reusable, it
 * authorised any machine, and a Node sent it to whatever answered the URL
 * before it had any way to tell that from the Host. This command carries the
 * Host's id and fingerprint — so the machine can refuse an impostor — and a
 * grant that authorises exactly the key it is about to generate.
 */
export const ConnectNodeCard = () => {
  const styles = useStyles();
  const enrollment = useEnrollment();
  const [editedUrl, setEditedUrl] = useState<string>();
  const [grant, setGrant] = useState<IssuedGrant>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useMessageNotification(error);

  // Until the field is touched it tracks the polled value, so a rotated tunnel
  // URL reaches the command without wiping out whatever was typed over it.
  const hostUrl = editedUrl ?? grant?.command.hostUrl ?? enrollment?.hostUrl ?? "";

  if (!enrollment) return null;

  const devTunnel = isDevTunnelUrl(hostUrl);

  const issue = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setGrant(await api<IssuedGrant>("/api/enrollment-grants", { method: "POST" }));
    } catch (reason) {
      setGrant(undefined);
      setError(errorMessage(reason, "Could not create a connect command"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Connect a machine">
      <div>
        <Title3 as="h2" data-tour="connect-node">
          Connect a machine
        </Title3>
        <br />
        <Text className={styles.caption}>
          Run this from a Copilot Fleet checkout that has Node.js and a signed-in Copilot
          CLI. The node registers itself under the machine&apos;s own hostname, generates
          its own key, and pins this Host&apos;s fingerprint.
        </Text>
      </div>

      <Field label="Host URL the node should dial" className={styles.urlField}>
        <Input
          value={hostUrl}
          onChange={(_, data) => setEditedUrl(data.value)}
          aria-label="Host URL the node should dial"
        />
      </Field>

      {devTunnel && (
        <MessageBar intent="info">
          <MessageBarBody>
            This tunnel is private, so a node cannot dial the URL directly — it would be
            redirected to a Microsoft login it has no way to answer. Sign the machine in
            once with <code>{devTunnelLoginCommand()}</code>, then start the node: it
            opens the tunnel itself and finds the forwarded port, so no second terminal is
            needed.
          </MessageBarBody>
        </MessageBar>
      )}

      {!devTunnel && isLocalOnlyHostUrl(hostUrl) && (
        <MessageBar intent="warning">
          <MessageBarBody>
            This address only resolves on the Host itself. Point it at a tunnel or LAN
            address, or set FLEET_PUBLIC_URL to make it the default.
          </MessageBarBody>
        </MessageBar>
      )}

      <Text className={styles.caption}>
        Host fingerprint{" "}
        <span className={styles.fingerprint}>{enrollment.hostFingerprint}</span>
      </Text>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {!grant ? (
        <div className={styles.actions}>
          <Button appearance="primary" disabled={busy} onClick={() => void issue()}>
            {busy ? "Creating…" : "Generate a connect command"}
          </Button>
          <Text className={styles.caption}>
            Includes npm start and npm service commands. One machine, one use, fifteen
            minutes.
          </Text>
        </div>
      ) : (
        <>
          <Text weight="semibold">Choose and copy one command</Text>
          <Text className={styles.caption}>
            Both options use the same one-use grant for one machine. Copy the launch
            method you want; you do not need to run both.
          </Text>
          {launchMethods.map((method) => {
            const command = keyEnrollCommand({ ...grant.command, hostUrl }, method.mode);
            return (
              <section
                className={styles.commandBlock}
                aria-label={method.label}
                key={method.mode}
              >
                <div className={styles.commandHeader}>
                  <Text
                    as="h3"
                    size={400}
                    weight="semibold"
                    className={styles.commandTitle}
                  >
                    {method.invocation}
                  </Text>
                  <CopyButton
                    text={command}
                    label={`Copy ${method.label} command`}
                    appearance={method.mode === "service" ? "primary" : "secondary"}
                    showText
                  />
                </div>
                <Text className={styles.caption}>{method.description}</Text>
                <pre className={styles.command} aria-label={`${method.label} command`}>
                  {command}
                </pre>
              </section>
            );
          })}
          <div className={styles.actions}>
            <Text className={styles.caption}>
              Expires at {expiryLabel(grant.expiresAt)}, or as soon as one machine uses
              it.
            </Text>
            <Button
              appearance="secondary"
              size="small"
              disabled={busy}
              onClick={() => void issue()}
            >
              {busy ? "Creating…" : "New command"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
};
