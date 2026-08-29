import { useEffect, useState } from "react";
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
import { Checkmark20Regular, Copy20Regular } from "@fluentui/react-icons";
import { errorMessage, type ConnectCommand } from "@fleet/protocol";
import { useEnrollment } from "../hooks/useEnrollment";
import { api } from "../hooks/useFleet";
import {
  devTunnelLoginCommand,
  isDevTunnelUrl,
  isLocalOnlyHostUrl,
  keyEnrollCommand,
} from "../lib/enroll-command";
import { terminal } from "../theme";

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
  commandRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
  },
  command: {
    flexGrow: 1,
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
  const [copied, setCopied] = useState<string>();

  // Until the field is touched it tracks the polled value, so a rotated tunnel
  // URL reaches the command without wiping out whatever was typed over it.
  const hostUrl = editedUrl ?? grant?.command.hostUrl ?? enrollment?.hostUrl ?? "";

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

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

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(key);
  };

  return (
    <section className={styles.card} aria-label="Connect a machine">
      <div>
        <Title3 as="h2">Connect a machine</Title3>
        <br />
        <Text className={styles.caption}>
          Run this from a Copilot Fleet checkout that has Node.js and a signed-in Copilot
          CLI — the same lines work in bash and PowerShell. The node registers itself
          under the machine&apos;s own hostname, generates its own key, and pins this
          Host&apos;s fingerprint.
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
          <Text className={styles.caption}>One machine, one use, fifteen minutes.</Text>
        </div>
      ) : (
        <>
          <div className={styles.commandRow}>
            <pre className={styles.command} aria-label="Connect command">
              {keyEnrollCommand({
                ...grant.command,
                hostUrl,
                ...(grant.command.tunnelId ? { tunnelId: grant.command.tunnelId } : {}),
              })}
            </pre>
            <Button
              appearance={copied === "enroll" ? "subtle" : "primary"}
              icon={copied === "enroll" ? <Checkmark20Regular /> : <Copy20Regular />}
              aria-label="Copy the connect command"
              onClick={() =>
                void copy(
                  "enroll",
                  keyEnrollCommand({
                    ...grant.command,
                    hostUrl,
                    ...(grant.command.tunnelId
                      ? { tunnelId: grant.command.tunnelId }
                      : {}),
                  }),
                )
              }
            >
              {copied === "enroll" ? "Copied" : "Copy"}
            </Button>
          </div>
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
