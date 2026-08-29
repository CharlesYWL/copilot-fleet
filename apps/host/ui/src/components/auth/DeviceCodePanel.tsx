import {
  Button,
  Link,
  MessageBar,
  MessageBarBody,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Checkmark20Regular, Copy20Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import type { DeviceFlow } from "../../lib/device-login";
import { terminal } from "../../theme";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  codeRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  },
  code: {
    margin: 0,
    padding: "10px 14px",
    borderRadius: tokens.borderRadiusMedium,
    background: terminal.background,
    color: terminal.agent,
    fontFamily: terminal.font,
    fontSize: "20px",
    letterSpacing: "0.14em",
    // Selectable on purpose: the code is meant to be read aloud or copied, and
    // a value a person cannot select is a value they have to transcribe.
    userSelect: "all",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

/** Local time, because the operator is deciding whether they have time to act. */
function expiryLabel(expiresAt: string): string {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return "shortly";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export type DeviceCodePanelProps = {
  flow: DeviceFlow;
  /** Shown under the code; a denial or an expiry, in the Host's own words. */
  error?: string | undefined;
};

/**
 * The code Microsoft is waiting for, and the warning that goes with it.
 *
 * Device sign-in is the one flow an attacker can start on someone else's
 * behalf: they begin a flow, send their code to an administrator, and collect
 * the session it produces. Nothing in the protocol prevents that, so the page
 * that displays a code says plainly that a code from anywhere else is an
 * attack — and Fleet still requires an authorization-code sign-in for the
 * decisions that cannot be undone.
 */
export const DeviceCodePanel = ({ flow, error }: DeviceCodePanelProps) => {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className={styles.panel}>
      <Text>
        Open{" "}
        <Link href={flow.verificationUri} target="_blank" rel="noreferrer">
          {flow.verificationUri.replace(/^https?:\/\//, "")}
        </Link>{" "}
        and enter this code:
      </Text>
      <div className={styles.codeRow}>
        <pre className={styles.code}>{flow.userCode}</pre>
        <Button
          appearance={copied ? "subtle" : "secondary"}
          icon={copied ? <Checkmark20Regular /> : <Copy20Regular />}
          aria-label="Copy the device code"
          onClick={() => {
            void navigator.clipboard
              .writeText(flow.userCode)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Text className={styles.caption}>Expires at {expiryLabel(flow.expiresAt)}.</Text>
      <MessageBar intent="warning">
        <MessageBarBody>
          Only enter a code this page is showing you. A code sent by anyone else — in a
          message, a ticket, or an email — signs them into this fleet, not you.
        </MessageBarBody>
      </MessageBar>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
};
