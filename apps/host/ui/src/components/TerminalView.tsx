import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  Button,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { RecordStop20Regular, Send20Regular, Stop20Regular } from "@fluentui/react-icons";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
import { stateAccent, terminal } from "../theme";
import {
  pendingPermission,
  toTerminalBlocks,
  type TerminalBlock,
  type TerminalBlockKind,
} from "../lib/terminal-blocks";
import { PermissionBanner, type PermissionOption } from "./PermissionBanner";
import { StatusDot } from "./StatusDot";

const useStyles = makeStyles({
  view: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    background: terminal.background,
  },
  header: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 18px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  headerText: {
    display: "flex",
    flexDirection: "column",
    marginRight: "auto",
    minWidth: 0,
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  subtitle: {
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase200,
  },
  state: {
    textTransform: "uppercase",
    letterSpacing: "1px",
    fontSize: "10px",
    fontWeight: tokens.fontWeightBold,
  },
  stream: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "18px 20px 24px",
    fontFamily: terminal.font,
    fontSize: "12.5px",
    lineHeight: "1.65",
  },
  line: {
    display: "grid",
    gridTemplateColumns: "64px 14px 1fr",
    gap: "8px",
    padding: "1px 0",
  },
  time: {
    color: terminal.dim,
    fontSize: "10px",
    paddingTop: "3px",
    userSelect: "none",
  },
  glyph: {
    userSelect: "none",
    textAlign: "center",
  },
  text: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: 0,
  },
  thought: {
    fontStyle: "italic",
  },
  divider: {
    color: terminal.dim,
  },
  working: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 0 0 86px",
    color: terminal.tool,
    fontSize: "11px",
  },
  emptyStream: {
    color: terminal.dim,
    textAlign: "center",
    marginTop: "80px",
  },
  composer: {
    flexShrink: 0,
    display: "flex",
    alignItems: "flex-end",
    gap: "10px",
    padding: "12px 16px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  input: {
    flexGrow: 1,
  },
  hint: {
    color: tokens.colorNeutralForeground4,
    fontSize: "10px",
    padding: "0 16px 10px",
    background: tokens.colorNeutralBackground2,
  },
});

const glyphs: Record<TerminalBlockKind, string> = {
  user: "\u276f",
  agent: "",
  thought: "\u00b7",
  tool: "\u23fa",
  permission: "\u26a0",
  permission_result: "\u2713",
  turn: "\u2500",
  state: "\u25a0",
  error: "\u2716",
  system: "\u203a",
};

const colors: Record<TerminalBlockKind, string> = {
  user: terminal.user,
  agent: terminal.agent,
  thought: terminal.thought,
  tool: terminal.tool,
  permission: terminal.permission,
  permission_result: terminal.dim,
  turn: terminal.dim,
  state: terminal.dim,
  error: terminal.error,
  system: terminal.dim,
};

type TerminalViewProps = {
  session: FleetSession;
  events: SessionEvent[];
  onPrompt: (prompt: string) => void;
  onCancel: () => void;
  onStop: () => void;
  onPermission: (
    requestId: string,
    outcome: "allow_once" | "deny",
    optionId?: string,
  ) => void;
};

export const TerminalView = ({
  session,
  events,
  onPrompt,
  onCancel,
  onStop,
  onPermission,
}: TerminalViewProps) => {
  const styles = useStyles();
  const [prompt, setPrompt] = useState("");
  const streamRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const blocks = useMemo(() => toTerminalBlocks(events), [events]);
  const permission = useMemo(() => pendingPermission(events), [events]);

  useEffect(() => {
    const element = streamRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [blocks]);

  useEffect(() => {
    pinnedRef.current = true;
    const element = streamRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [session.id]);

  const canPrompt = session.state === "idle";

  const submitPrompt = () => {
    const text = prompt.trim();
    if (!text || !canPrompt) return;
    onPrompt(text);
    setPrompt("");
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitPrompt();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submitPrompt();
  };

  const handleScroll = () => {
    const element = streamRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedRef.current = distance < 48;
  };

  const handleDecide = (outcome: "allow_once" | "deny", optionId?: string) => {
    const requestId = permission?.payload.requestId;
    if (typeof requestId !== "string") return;
    onPermission(requestId, outcome, optionId);
  };

  return (
    <section className={styles.view} aria-label="Session terminal">
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.title}>
            <StatusDot state={session.state} />
            <span
              className={styles.state}
              style={{ color: stateAccent[session.state] ?? terminal.dim }}
            >
              {session.state}
            </span>
            <Text weight="semibold">{session.workspaceName}</Text>
          </span>
          <Text className={styles.subtitle}>
            {session.nodeName} · {session.id.slice(0, 8)} · {session.currentActivity}
          </Text>
        </div>
        <Button
          appearance="secondary"
          icon={<RecordStop20Regular />}
          disabled={session.state !== "running"}
          onClick={onCancel}
        >
          Cancel turn
        </Button>
        <Button appearance="secondary" icon={<Stop20Regular />} onClick={onStop}>
          Stop
        </Button>
      </div>

      {permission && (
        <PermissionBanner
          title={asTitle(permission.payload.title)}
          options={asOptions(permission.payload.options)}
          onDecide={handleDecide}
        />
      )}

      <div className={styles.stream} ref={streamRef} onScroll={handleScroll}>
        {blocks.length === 0 ? (
          <p className={styles.emptyStream}>Waiting for the first streamed event…</p>
        ) : (
          blocks.map((block) => <TerminalLine block={block} key={block.key} />)
        )}
        {session.state === "running" && <div className={styles.working}>working…</div>}
      </div>

      <form className={styles.composer} onSubmit={handleSubmit}>
        <Textarea
          className={styles.input}
          value={prompt}
          onChange={(_event, data) => setPrompt(data.value)}
          onKeyDown={handleKeyDown}
          disabled={!canPrompt}
          resize="vertical"
          aria-label="Follow-up prompt"
          placeholder={
            canPrompt ? "Send a follow-up prompt…" : "Available when the session is idle"
          }
        />
        <Button
          appearance="primary"
          type="submit"
          icon={<Send20Regular />}
          disabled={!canPrompt || prompt.trim().length === 0}
        >
          Send
        </Button>
      </form>
      <Text className={styles.hint}>Enter sends · Shift+Enter adds a newline</Text>
    </section>
  );
};

const TerminalLine = ({ block }: { block: TerminalBlock }) => {
  const styles = useStyles();
  const color = colors[block.kind];
  const text =
    block.kind === "turn"
      ? `turn complete (${block.text})`
      : block.kind === "tool" && block.status
        ? `${block.text} · ${block.status}`
        : block.text;

  return (
    <div className={styles.line}>
      <span className={styles.time}>{formatTime(block.createdAt)}</span>
      <span className={styles.glyph} style={{ color }} aria-hidden="true">
        {glyphs[block.kind]}
      </span>
      <p
        className={block.kind === "thought" ? `${styles.text} ${styles.thought}` : styles.text}
        style={{ color }}
      >
        {text}
      </p>
    </div>
  );
};

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleTimeString(undefined, { hour12: false });
}

function asTitle(value: unknown): string {
  return typeof value === "string" ? value : "Tool request";
}

function asOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PermissionOption =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as PermissionOption).optionId === "string" &&
      typeof (item as PermissionOption).kind === "string",
  );
}
