import { useEffect, useState } from "react";
import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Tab,
  TabList,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Checkmark20Regular, Copy20Regular } from "@fluentui/react-icons";
import { api } from "../hooks/useFleet";
import {
  enrollCommand,
  isLocalOnlyHostUrl,
  nodeShells,
  type NodeShell,
} from "../lib/enroll-command";
import { terminal } from "../theme";

type Enrollment = { hostUrl: string; enrollmentToken: string };

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
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [hostUrl, setHostUrl] = useState("");
  const [urlDirty, setUrlDirty] = useState(false);
  const [shell, setShell] = useState<NodeShell>("bash");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      void api<Enrollment>("/api/enrollment")
        .then((result) => {
          if (cancelled) return;
          setEnrollment(result);
          setHostUrl((current) => (urlDirty ? current : result.hostUrl));
        })
        .catch(() => undefined);
    };
    pull();
    // Tunnel URLs can rotate while this card is open; keep the default in sync.
    const timer = setInterval(pull, 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [urlDirty]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!enrollment) return null;

  const command = enrollCommand(shell, hostUrl, enrollment.enrollmentToken);

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
          CLI. The node registers itself under the machine&apos;s own hostname.
        </Text>
      </div>

      <Field label="Host URL the node should dial" className={styles.urlField}>
        <Input
          value={hostUrl}
          onChange={(_, data) => {
            setUrlDirty(true);
            setHostUrl(data.value);
          }}
          aria-label="Host URL the node should dial"
        />
      </Field>

      {isLocalOnlyHostUrl(hostUrl) && (
        <MessageBar intent="warning">
          <MessageBarBody>
            This address only resolves on the Host itself. Point it at a tunnel or LAN
            address, or set FLEET_PUBLIC_URL to make it the default.
          </MessageBarBody>
        </MessageBar>
      )}

      <TabList
        selectedValue={shell}
        onTabSelect={(_, data) => setShell(data.value as NodeShell)}
        size="small"
      >
        {nodeShells.map(({ key, label }) => (
          <Tab key={key} value={key}>
            {label}
          </Tab>
        ))}
      </TabList>

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
