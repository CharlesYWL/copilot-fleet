import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import {
  Badge,
  Button,
  Input,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  Attach20Regular,
  Dismiss20Regular,
  Rename20Regular,
  RecordStop20Regular,
  Send20Regular,
  Stop20Regular,
} from "@fluentui/react-icons";
import {
  SESSION_NAME_MAX_LENGTH,
  isResumableSession,
  terminalSessionStates,
  type FleetSession,
  type SessionEvent,
  type PromptAttachment,
} from "@fleet/protocol";
import { blockColor, terminal } from "../theme";
import { sessionLabel } from "../lib/session-label";
import { sessionAccent, sessionStatusLabel } from "../lib/session-status";
import {
  allowOnceOptionId,
  pendingPermission,
  permissionRequestId,
  permissionTitle,
  toTerminalBlocks,
  type TerminalBlock,
  type TerminalBlockKind,
} from "../lib/terminal-blocks";
import {
  applyCommand,
  matchCommands,
  moveHighlight,
  slashQuery,
} from "../lib/slash-commands";
import {
  acceptAttachment,
  base64FromDataUrl,
  toWireAttachments,
  type DraftAttachment,
} from "../lib/attachments";
import { EMPTY_DRAFT, type SessionDraft } from "../lib/session-drafts";
import { AttachmentStrip } from "./AttachmentStrip";
import { MarkdownBody } from "./MarkdownBody";
import { PermissionBanner } from "./PermissionBanner";
import { SessionConfigBar } from "./SessionConfigBar";
import { SlashMenu } from "./SlashMenu";
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
    minWidth: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  nameForm: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
  },
  nameInput: {
    minWidth: "220px",
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
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    margin: "10px 16px 14px",
    padding: "6px 8px 6px 10px",
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    // The box, not the textarea inside it, is what should look focused.
    ":focus-within": {
      border: `1px solid ${tokens.colorBrandStroke1}`,
    },
  },
  input: {
    width: "100%",
    maxWidth: "100%",
    // Fluent's Textarea draws its own border and background; inside the box
    // those would be a second frame around the first.
    "& textarea": {
      minHeight: "44px",
      // Matches COMPOSER_MAX_HEIGHT: the measured height is written inline, and
      // this is the ceiling it is clamped to. Past it the box scrolls rather
      // than eating the transcript above it.
      maxHeight: "220px",
      overflowY: "auto",
      padding: "4px 2px",
      background: "transparent",
      fontSize: "13px",
      lineHeight: "18px",
    },
    "&::after": { display: "none" },
    "&::before": { display: "none" },
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
  },
  toolbarSpacer: {
    flexGrow: 1,
  },
  send: {
    flexShrink: 0,
    minWidth: "28px",
    width: "28px",
    height: "28px",
    padding: 0,
    borderRadius: tokens.borderRadiusCircular,
  },
  attach: {
    flexShrink: 0,
    minWidth: "26px",
    width: "26px",
    height: "26px",
    padding: 0,
  },
  attachError: {
    padding: "0 2px 2px",
    color: tokens.colorPaletteRedForeground1,
    fontSize: "11px",
  },
  blockAttachments: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginTop: "6px",
  },
  blockAttachment: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 7px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
  },
  blockAttachmentIcon: {
    fontSize: "12px",
  },
});

/**
 * How tall the composer may grow before it starts scrolling instead.
 *
 * Kept beside the stylesheet's `max-height` on purpose: the measured height is
 * written as an inline style, so the two have to agree or the box would either
 * be clipped short of its own ceiling or never reach a scrollbar.
 */
const COMPOSER_MAX_HEIGHT = 220;

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
  onPrompt: (prompt: string, attachments?: PromptAttachment[]) => void;
  onCancel: () => void;
  onStop: () => void;
  onPermission: (
    requestId: string,
    outcome: "allow_once" | "deny",
    optionId?: string,
  ) => void;
  onRename?: (name: string) => void;
  onDismiss?: () => void;
  onResume?: () => void;
  onClose?: () => void;
  onConfigChange?: (configId: string, value: string) => void;
  draft: SessionDraft;
  onDraftChange: (update: (current: SessionDraft) => SessionDraft) => void;
};

export const TerminalView = ({
  session,
  events,
  onPrompt,
  onCancel,
  onStop,
  onPermission,
  onRename,
  onDismiss,
  onResume,
  onClose,
  onConfigChange,
  draft,
  onDraftChange,
}: TerminalViewProps) => {
  const styles = useStyles();
  const [draftName, setDraftName] = useState<string>();
  // Dismissal is remembered per keystroke, not per session: Escape closes the
  // menu, and typing another character is what asks for it back.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [attachError, setAttachError] = useState<string>();
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pinnedRef = useRef(true);

  const { prompt, attachments } = draft;
  const setPrompt = (value: string) =>
    onDraftChange((current) => ({ ...current, prompt: value }));
  const setAttachments = (
    update: (current: DraftAttachment[]) => DraftAttachment[],
  ): void =>
    onDraftChange((current) => ({
      ...current,
      attachments: update(current.attachments),
    }));

  const blocks = useMemo(() => toTerminalBlocks(events), [events]);
  const permission = useMemo(() => pendingPermission(events), [events]);

  const scrollToEnd = useCallback(() => {
    const element = streamRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollToEnd();
  }, [blocks, scrollToEnd]);

  useEffect(() => {
    pinnedRef.current = true;
    scrollToEnd();
  }, [session.id, scrollToEnd]);

  /**
   * The composer grows with what is typed, and scrolls once it has grown enough.
   *
   * A fixed box showed two lines of a long prompt with no way to see the rest:
   * `resize="none"` means the operator cannot drag it open either, and Fluent's
   * textarea takes its height from the `rows` attribute rather than from its
   * content. The height is measured rather than counted, because wrapped lines,
   * pasted text, and a draft restored on returning to a session all have to
   * arrive at the same answer.
   */
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    // Collapsing first is what lets the box shrink again; measured against its
    // current height, `scrollHeight` can only ever grow.
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    // The composer takes its extra height from the transcript above it, so a
    // reader sitting at the end would otherwise be pushed off it as they type.
    if (pinnedRef.current) scrollToEnd();
  }, [prompt, attachments.length, session.id, scrollToEnd]);

  // Switching sessions with the editor open would otherwise offer one session's
  // name as an edit to another's. The composer draft is deliberately not reset
  // here: it belongs to the session being left, and is restored on return.
  useEffect(() => {
    setDraftName(undefined);
    setMenuDismissed(false);
    setAttachError(undefined);
  }, [session.id]);

  const canPrompt = session.state === "idle";
  const isEnded = terminalSessionStates.has(session.state);
  // Offline and terminal sessions can be re-attached via Copilot's session/load.
  const canResume = Boolean(onResume) && isResumableSession(session);

  const query = slashQuery(prompt);
  const matches = useMemo(
    () => (query.open ? matchCommands(session.commands, query.term) : []),
    [query.open, query.term, session.commands],
  );
  // An agent that reports no commands gets no menu at all, rather than an empty
  // box over the composer telling the operator nothing matched.
  const menuOpen =
    query.open && canPrompt && !menuDismissed && session.commands.length > 0;
  const activeIndex = Math.min(highlight, Math.max(0, matches.length - 1));

  const submitPrompt = () => {
    const text = prompt.trim();
    // A file with no words is still a message: "look at this" is implied, and
    // refusing to send it would strand the attachment the operator just added.
    if ((!text && attachments.length === 0) || !canPrompt) return;
    onPrompt(text || "(see attachment)", toWireAttachments(attachments));
    onDraftChange(() => EMPTY_DRAFT);
    setAttachError(undefined);
    setMenuDismissed(false);
    // Sending is a request to watch what happens next, so it re-pins the
    // transcript. Scrolling back to read something older otherwise left the
    // operator staring at old output while the answer arrived below the fold.
    pinnedRef.current = true;
    scrollToEnd();
  };

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setAttachError(undefined);
    for (const file of files) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onerror = () => resolve("");
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsDataURL(file);
      });
      // Read one at a time and re-check against the list as it grows, so the
      // count and size limits hold for a multi-file drop as well as for adding
      // files one by one.
      let rejected: string | undefined;
      setAttachments((current) => {
        const result = acceptAttachment(file, base64FromDataUrl(dataUrl), current);
        if (!result.ok) {
          rejected = result.error;
          return current;
        }
        return [...current, result.attachment];
      });
      if (rejected) setAttachError(rejected);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    // Pasted text keeps its normal behaviour; only files are intercepted, or
    // copying an image out of a document would stop pasting its caption too.
    event.preventDefault();
    void addFiles(files);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitPrompt();
  };

  const changePrompt = (value: string) => {
    setPrompt(value);
    // Any edit re-offers the menu: dismissing it is about the text as it stood,
    // and the next keystroke is a new question.
    setMenuDismissed(false);
    setHighlight(0);
  };

  const pickCommand = (command: (typeof matches)[number]) => {
    const choice = applyCommand(command);
    setPrompt(choice.text);
    setMenuDismissed(true);
    setHighlight(0);
    if (choice.submit) {
      // The state update has not landed yet, so the text is passed rather than
      // read back off `prompt`.
      onPrompt(choice.text);
      onDraftChange(() => EMPTY_DRAFT);
      pinnedRef.current = true;
      scrollToEnd();
      return;
    }
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && matches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight(
          moveHighlight(activeIndex, event.key === "ArrowDown" ? 1 : -1, matches.length),
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pickCommand(matches[activeIndex]!);
        return;
      }
    }
    if (event.key === "Escape" && menuOpen) {
      event.preventDefault();
      setMenuDismissed(true);
      return;
    }
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

  const isEditingName = draftName !== undefined;

  const submitName = (event: FormEvent) => {
    event.preventDefault();
    if (draftName === undefined) return;
    // An unchanged value is a no-op rather than a write, so closing the editor
    // without touching it does not bump the session's updated time.
    if (draftName.trim() !== session.name) onRename?.(draftName.trim());
    setDraftName(undefined);
  };

  const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setDraftName(undefined);
  };

  return (
    <section className={styles.view} aria-label="Session terminal">
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.title}>
            <StatusDot state={session.state} color={sessionAccent(session)} />
            <span className={styles.state} style={{ color: sessionAccent(session) }}>
              {sessionStatusLabel(session)}
            </span>
            {isEditingName ? (
              <form className={styles.nameForm} onSubmit={submitName}>
                <Input
                  className={styles.nameInput}
                  value={draftName}
                  autoFocus
                  size="small"
                  maxLength={SESSION_NAME_MAX_LENGTH}
                  aria-label="Session name"
                  placeholder="Name this session"
                  onChange={(_event, data) => setDraftName(data.value)}
                  onKeyDown={handleNameKeyDown}
                />
                <Button size="small" appearance="primary" type="submit">
                  Save
                </Button>
                <Button
                  size="small"
                  appearance="subtle"
                  type="button"
                  onClick={() => setDraftName(undefined)}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <Text weight="semibold" className={styles.name}>
                  {sessionLabel(session)}
                </Text>
                {onRename && (
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Rename20Regular />}
                    aria-label="Rename session"
                    title="Rename session"
                    onClick={() => setDraftName(session.name)}
                  />
                )}
              </>
            )}
            {session.yolo && (
              <Badge appearance="tint" color="warning" size="small">
                YOLO
              </Badge>
            )}
          </span>
          <Text className={styles.subtitle}>
            {session.workspaceName} · {session.nodeName} · {session.id.slice(0, 8)} ·{" "}
            {session.currentActivity}
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
        {canResume && (
          <Button
            appearance="primary"
            icon={<ArrowClockwise20Regular />}
            onClick={onResume}
          >
            Resume
          </Button>
        )}
        {isEnded ? (
          <Button
            appearance="secondary"
            icon={<Dismiss20Regular />}
            onClick={onDismiss}
            disabled={!onDismiss}
          >
            Dismiss
          </Button>
        ) : (
          <Button appearance="secondary" icon={<Stop20Regular />} onClick={onStop}>
            Stop
          </Button>
        )}
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
        {menuOpen ? (
          <SlashMenu
            commands={matches}
            activeIndex={activeIndex}
            onPick={pickCommand}
            onHover={setHighlight}
          />
        ) : null}
        <AttachmentStrip
          attachments={attachments}
          onRemove={(id) =>
            setAttachments((current) => current.filter((entry) => entry.id !== id))
          }
        />
        <Textarea
          className={styles.input}
          textarea={{ ref: inputRef }}
          value={prompt}
          onChange={(_event, data) => changePrompt(data.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => setMenuDismissed(true)}
          disabled={!canPrompt}
          appearance="filled-lighter"
          resize="none"
          aria-label="Follow-up prompt"
          placeholder={
            canPrompt
              ? "Send a follow-up prompt. Type / for commands, paste or attach files · Enter sends"
              : "Available when the session is idle"
          }
        />
        {attachError ? (
          <Text className={styles.attachError} role="alert">
            {attachError}
          </Text>
        ) : null}
        <div className={styles.toolbar}>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])]);
              // Clearing it means picking the same file twice in a row still
              // raises a change event the second time.
              event.target.value = "";
            }}
          />
          <Button
            className={styles.attach}
            appearance="subtle"
            size="small"
            shape="circular"
            type="button"
            icon={<Attach20Regular />}
            title="Attach files"
            aria-label="Attach files"
            disabled={!canPrompt}
            onClick={() => fileRef.current?.click()}
          />
          <SessionConfigBar
            options={session.configOptions}
            disabled={!onConfigChange || isEnded}
            onChange={(configId, value) => onConfigChange?.(configId, value)}
          />
          <span className={styles.toolbarSpacer} />
          <Button
            className={styles.send}
            appearance="primary"
            shape="circular"
            type="submit"
            title="Send"
            aria-label="Send"
            icon={<Send20Regular />}
            disabled={
              !canPrompt || (prompt.trim().length === 0 && attachments.length === 0)
            }
          />
        </div>
      </form>
    </section>
  );
};

const markdownKinds = new Set<TerminalBlockKind>(["agent", "user", "thought"]);

/**
 * One line of the transcript, memoised.
 *
 * A transcript runs to hundreds of these, and each markdown line re-parses its
 * text when it renders. Without this, every keystroke in the composer re-rendered
 * the entire conversation, so typing got measurably slower the longer an
 * operator had been working — the exact opposite of what a long session needs.
 *
 * `block` comes from a memo over the event list, so its identity only changes
 * when the event it describes does.
 */
const TerminalLine = memo(function TerminalLine({ block }: { block: TerminalBlock }) {
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
          {block.attachments?.length ? (
            <div className={styles.blockAttachments}>
              {block.attachments.map((attachment) => (
                <span className={styles.blockAttachment} key={attachment.name}>
                  <Attach20Regular className={styles.blockAttachmentIcon} />
                  {attachment.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className={styles.plain} style={{ color }}>
          {text}
        </p>
      )}
    </div>
  );
});

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleTimeString(undefined, { hour12: false });
}
