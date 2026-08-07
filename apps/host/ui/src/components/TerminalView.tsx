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
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  Dismiss20Regular,
  RecordStop20Regular,
  Send20Regular,
  Stop20Regular,
} from "@fluentui/react-icons";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
import { blockColor, stateAccent, terminal } from "../theme";
import {
  allowOnceOptionId,
  pendingPermission,
  permissionRequestId,
  permissionTitle,
  toTerminalBlocks,
  type TerminalBlock,
  type TerminalBlockKind,
} from "../lib/terminal-blocks";
import { MarkdownBody } from "./MarkdownBody";
import { PermissionBanner } from "./PermissionBanner";
import { StatusDot } from "./StatusDot";

const useStyles = makeStyles({
  view: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    // Stacked inside the focus dialog this is a column flex item, where the
    // default min-height:auto would grow past the surface and leave the
    // stream unscrollable. Beside the sidebar it is a row item, so this is a
    // no-op there.
    minHeight: 0,
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
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  line: {
    display: "grid",
    gridTemplateColumns: "56px 14px minmax(0, 1fr)",
    gap: "8px",
    alignItems: "start",
  },
  message: {
    borderRadius: tokens.borderRadiusMedium,
    padding: "10px 14px",
    background: "rgba(255, 255, 255, 0.03)",
    border: `1px solid ${tokens.colorNeutralStroke3}`,
    minWidth: 0,
  },
  userMessage: {
    background: "rgba(127, 160, 255, 0.08)",
    border: "1px solid rgba(127, 160, 255, 0.18)",
  },
  time: {
    color: terminal.dim,
    fontFamily: terminal.font,
    fontSize: "10px",
    paddingTop: "12px",
    userSelect: "none",
  },
  glyph: {
    userSelect: "none",
    textAlign: "center",
    fontFamily: terminal.font,
    paddingTop: "12px",
  },
  plain: {
    fontFamily: terminal.font,
    fontSize: "12.5px",
    lineHeight: "1.65",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: 0,
    paddingTop: "10px",
  },
  working: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 0 0 78px",
    color: terminal.tool,
    fontFamily: terminal.font,
    fontSize: "11px",
  },
  emptyStream: {
    color: terminal.dim,
    textAlign: "center",
    marginTop: "80px",
    fontFamily: terminal.font,
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
  onClose?: () => void;
};

export const TerminalView = ({
  session,
  events,
  onPrompt,
  onCancel,
  onStop,
  onPermission,
  onClose,
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
    const requestId = permission && permissionRequestId(permission);
    if (!requestId) return;
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
        {onClose && (
          <Button
            appearance="subtle"
            icon={<Dismiss20Regular />}
            onClick={onClose}
            aria-label="Close session"
            title="Close"
          />
        )}
      </div>

      {permission && (
        <PermissionBanner
          title={permissionTitle(permission)}
          allowOptionId={allowOnceOptionId(permission)}
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

const markdownKinds = new Set<TerminalBlockKind>(["agent", "user", "thought"]);

const TerminalLine = ({ block }: { block: TerminalBlock }) => {
  const styles = useStyles();
  const color = blockColor[block.kind];
  const text =
    block.kind === "turn"
      ? `turn complete (${block.text})`
      : block.kind === "tool" && block.status
        ? `${block.text} · ${block.status}`
        : block.text;
  const asMarkdown = markdownKinds.has(block.kind);

  return (
    <div className={styles.line}>
      <span className={styles.time}>{formatTime(block.createdAt)}</span>
      <span className={styles.glyph} style={{ color }} aria-hidden="true">
        {glyphs[block.kind]}
      </span>
      {asMarkdown ? (
        <div
          className={mergeClasses(
            styles.message,
            block.kind === "user" && styles.userMessage,
          )}
          style={{ color }}
        >
          <MarkdownBody
            text={text}
            muted={block.kind === "thought"}
            copyable={block.kind !== "thought"}
          />
        </div>
      ) : (
        <p className={styles.plain} style={{ color }}>
          {text}
        </p>
      )}
    </div>
  );
};

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleTimeString(undefined, { hour12: false });
}
