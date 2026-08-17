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
import { useEnrollment } from "../hooks/useEnrollment";
import { enrollCommand, isDevTunnelUrl, isLocalOnlyHostUrl } from "../lib/enroll-command";
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
});

export const ConnectNodeCard = () => {
  const styles = useStyles();
  const enrollment = useEnrollment();
  const [editedUrl, setEditedUrl] = useState<string>();
  const [copied, setCopied] = useState(false);

  // Until the field is touched it tracks the polled value, so a rotated tunnel
  // URL reaches the command without wiping out whatever was typed over it.
  const hostUrl = editedUrl ?? enrollment?.hostUrl ?? "";

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!enrollment) return null;

  const devTunnel = isDevTunnelUrl(hostUrl);
  const command = enrollCommand(hostUrl, enrollment.enrollmentToken, enrollment.tunnelId);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };

  return (
    <section className={styles.card} aria-label="Connect a machine">
      <div>
        <Title3 as="h2">Connect a machine</Title3>
        <br />
        <Text className={styles.caption}>
          Run this from a Copilot Fleet checkout that has Node.js and a signed-in Copilot
          CLI — the same three lines work in bash and PowerShell. The node registers
          itself under the machine&apos;s own hostname.
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
            This tunnel is private, so a node cannot dial the URL directly — it would
            be redirected to a Microsoft login it has no way to answer. The commands
            below sign the node&apos;s machine in with <code>devtunnel</code> and reach
            the Host over a forwarded local port instead.
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

      <div className={styles.commandRow}>
        <pre className={styles.command}>{command}</pre>
        <Button
          appearance={copied ? "subtle" : "primary"}
          icon={copied ? <Checkmark20Regular /> : <Copy20Regular />}
          onClick={() => void handleCopy()}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </section>
  );
};
