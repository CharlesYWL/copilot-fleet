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
  type ReactNode,
} from "react";
import {
  Badge,
  Button,
  Input,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  ArrowDown16Regular,
  ArrowSwap16Regular,
  Clock16Regular,
  Attach20Regular,
  Brain16Regular,
  Checkmark16Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Delete16Regular,
  Dismiss20Regular,
  Document16Regular,
  Edit16Regular,
  ErrorCircle16Regular,
  Globe16Regular,
  Info16Regular,
  Rename20Regular,
  RecordStop20Regular,
  Search16Regular,
  Send20Regular,
  SpinnerIos16Regular,
  Stop20Regular,
  Warning16Regular,
  Window16Regular,
  Wrench16Regular,
} from "@fluentui/react-icons";
import {
  SESSION_NAME_MAX_LENGTH,
  isResumableSession,
  terminalSessionStates,
  type FleetSession,
  type SessionEvent,
  type PromptAttachment,
} from "@fleet/protocol";
import { blockColor, semanticColors, statusVisuals, terminal } from "../theme";
import { sessionLabel } from "../lib/session-label";
import { sessionAccent, sessionStatusLabel } from "../lib/session-status";
import { transcriptNotice } from "../lib/transcript-notice";
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
import { toPromptMarks } from "../lib/prompt-marks";
import { AttachmentStrip } from "./AttachmentStrip";
import { MarkdownBody } from "./MarkdownBody";
import { PermissionBanner } from "./PermissionBanner";
import { PromptRail } from "./PromptRail";
import { SessionConfigBar } from "./SessionConfigBar";
import { SessionAgentBadge } from "./SessionAgentBadge";
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
    // Below this the name and the actions cannot share a line without one of
    // them being squeezed into a column of single letters.
    "@media (max-width: 700px)": {
      flexWrap: "wrap",
      gap: "8px",
      padding: "10px 12px",
    },
  },
  headerText: {
    display: "flex",
    flexDirection: "column",
    marginRight: "auto",
    minWidth: 0,
    "@media (max-width: 700px)": { flexBasis: "100%", marginRight: 0 },
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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  state: {
    textTransform: "uppercase",
    letterSpacing: "1px",
    fontSize: "10px",
    fontWeight: tokens.fontWeightBold,
  },
  streamArea: {
    position: "relative",
    display: "flex",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  /** Floats over the stream, so appearing never shifts what is being read. */
  noticeSlot: {
    position: "absolute",
    left: 0,
    right: "28px",
    bottom: "10px",
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
    zIndex: 3,
  },
  notice: {
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
    minHeight: "30px",
    padding: "0 12px",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke1),
    borderRadius: "15px",
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    boxShadow: tokens.shadow8,
    pointerEvents: "auto",
  },
  noticeAction: {
    cursor: "pointer",
    color: semanticColors.interaction,
    font: "inherit",
    ":hover": { background: tokens.colorNeutralBackground1Hover },
  },
  noticeStalled: {
    ...shorthands.borderColor(statusVisuals.attention.border),
    color: statusVisuals.attention.foreground,
  },
  noticeDetail: { color: tokens.colorNeutralForeground3 },
  stream: {
    flexGrow: 1,
    overflowY: "auto",
    // The right margin belongs to the prompt rail, which replaces the
    // scrollbar: content stops short of the strip so nothing sits under the
    // marks, and the native bar is hidden because two position indicators on
    // one edge is one too many.
    padding: "16px 40px 24px 22px",
    display: "flex",
    flexDirection: "column",
    scrollbarWidth: "none",
    "::-webkit-scrollbar": {
      width: 0,
      height: 0,
    },
    // Steps carry their own (tiny) rhythm and messages their own margins, so
    // the stream itself adds almost nothing: a run of tool calls reads as one
    // quiet list rather than a stack of separated cards.
    gap: "1px",
  },
  message: {
    margin: "10px 0 12px",
    minWidth: 0,
    color: terminal.agent,
  },
  // The operator's own words sit on the right, the way every chat window has
  // taught people to read them; the agent's answer stays left and full width.
  userRow: {
    display: "flex",
    justifyContent: "flex-end",
    margin: "16px 0 10px",
    minWidth: 0,
  },
  userMessage: {
    minWidth: 0,
    maxWidth: "78%",
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px 13px",
    background: "rgba(127, 160, 255, 0.08)",
    border: "1px solid rgba(127, 160, 255, 0.18)",
    color: terminal.user,
  },
  /**
   * One middle step: a tool call, a thought, a state change.
   *
   * These outnumber the agent's own words several times over, so they are held
   * to a single 22px line with no card, no border and no timestamp — the shape
   * a reader skims past on the way to the prose, rather than the shape that
   * pushes the prose off the screen.
   */
  step: {
    display: "flex",
    alignItems: "center",
    gap: "9px",
    minWidth: 0,
    minHeight: "22px",
    padding: 0,
    background: "none",
    border: "none",
    textAlign: "left",
    width: "100%",
    fontFamily: '"DM Sans", system-ui, sans-serif',
    fontSize: "12.5px",
    lineHeight: "18px",
    color: tokens.colorNeutralForeground3,
  },
  stepClickable: {
    cursor: "pointer",
    ":hover": {
      color: tokens.colorNeutralForeground2,
    },
  },
  stepIcon: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "16px",
    color: tokens.colorNeutralForeground4,
  },
  stepTitle: {
    flexShrink: 0,
    // Capped so a long title cannot push the detail off the row entirely;
    // lifted by `stepTitleWide` when there is no detail to protect.
    maxWidth: "62%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground2,
  },
  stepTitleWide: {
    maxWidth: "100%",
  },
  stepDetail: {
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: terminal.dim,
    fontFamily: terminal.font,
    fontSize: "11.5px",
  },
  // A thought's preview is a sentence, not a command; the monospace face that
  // suits a path or an argv reads as output when the text is prose.
  stepDetailProse: {
    fontFamily: '"DM Sans", system-ui, sans-serif',
    fontSize: "12.5px",
    fontStyle: "italic",
  },
  stepFailed: {
    flexShrink: 0,
    color: terminal.error,
    fontFamily: '"DM Sans", system-ui, sans-serif',
    fontSize: "11.5px",
  },
  spin: {
    animationName: {
      from: { transform: "rotate(0deg)" },
      to: { transform: "rotate(360deg)" },
    },
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  // Expanded reasoning and raw agent output: still quiet, still off to the
  // side of the prose, but allowed to wrap because their whole value is text
  // a single truncated line would have hidden.
  stepBody: {
    margin: "2px 0 8px 25px",
    color: terminal.thought,
  },
  note: {
    margin: "0 0 0 25px",
    fontFamily: terminal.font,
    fontSize: "11.5px",
    lineHeight: "1.6",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  divider: {
    height: "1px",
    margin: "10px 0",
    background: tokens.colorNeutralStroke3,
  },
  working: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 0 0 25px",
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

/**
 * The icon a middle step is announced by, in place of its old text glyph.
 *
 * A 16px icon reads as "an event of this category happened" at a glance and
 * costs one line; the categories come from ACP's own `ToolKind`, so the icon
 * matches what the tool actually did rather than what its title happens to
 * start with. Anything unrecognised falls back to a generic tool.
 */
const toolKindIcons: Record<string, ReactNode> = {
  read: <Document16Regular />,
  edit: <Edit16Regular />,
  delete: <Delete16Regular />,
  move: <ArrowSwap16Regular />,
  search: <Search16Regular />,
  execute: <Window16Regular />,
  think: <Brain16Regular />,
  fetch: <Globe16Regular />,
  switch_mode: <ArrowSwap16Regular />,
  other: <Wrench16Regular />,
};

const kindIcons: Partial<Record<TerminalBlockKind, ReactNode>> = {
  thought: <Brain16Regular />,
  tool: <Wrench16Regular />,
  permission: <Warning16Regular />,
  permission_result: <Checkmark16Regular />,
  state: <Info16Regular />,
  system: <Info16Regular />,
  error: <ErrorCircle16Regular />,
};

/** Statuses that mean the call is still in flight, so it spins rather than sits. */
const runningStatuses = new Set(["pending", "in_progress"]);

/** How much of a thought is shown before the reader asks for the rest. */
const THOUGHT_PREVIEW_LENGTH = 150;

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
  /** Mirrors `pinnedRef` for rendering; the ref is what the scroll handler reads. */
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [lastEventAt, setLastEventAt] = useState(0);
  const [tick, setTick] = useState(() => Date.now());

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
  const promptMarks = useMemo(() => toPromptMarks(blocks), [blocks]);
  const [activePrompt, setActivePrompt] = useState<string>();

  /** The prompt elements, in order, so the rail and the stream stay in step. */
  const promptNodes = useCallback(
    (): HTMLElement[] => [
      ...(streamRef.current?.querySelectorAll<HTMLElement>("[data-prompt-key]") ?? []),
    ],
    [],
  );

  /**
   * Which turn the reader is currently inside.
   *
   * The last prompt whose top has passed the top of the viewport: scrolling
   * through an agent's answer keeps the mark for the prompt that asked for it
   * lit, rather than jumping ahead the moment the next prompt peeks in.
   */
  const updateActivePrompt = useCallback(() => {
    const element = streamRef.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const nodes = promptNodes();
    let current: string | undefined;
    for (const node of nodes) {
      if (node.getBoundingClientRect().top - top <= 24) current = node.dataset.promptKey;
    }
    setActivePrompt(current ?? nodes[0]?.dataset.promptKey);
  }, [promptNodes]);

  const scrollToPrompt = useCallback(
    (key: string) => {
      const element = streamRef.current;
      const node = promptNodes().find((candidate) => candidate.dataset.promptKey === key);
      if (!element || !node) return;
      // Left pinned, the next streamed chunk would yank the reader straight
      // back to the bottom of the very transcript they just left.
      pinnedRef.current = false;
      const offset =
        node.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const top = element.scrollTop + offset - 14;
      // `scrollTo` is what animates; the assignment is the fallback for hosts
      // that do not have it, which is also what keeps this testable.
      if (typeof element.scrollTo === "function") {
        element.scrollTo({ top, behavior: "smooth" });
      } else {
        element.scrollTop = top;
      }
      setActivePrompt(key);
    },
    [promptNodes],
  );

  const scrollToEnd = useCallback(() => {
    const element = streamRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  useEffect(() => {
    updateActivePrompt();
  }, [blocks, updateActivePrompt]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollToEnd();
  }, [blocks, scrollToEnd]);

  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    setUnseen(0);
    scrollToEnd();
  }, [session.id, scrollToEnd]);

  /*
   * How far behind the reader is, and how long the agent has been silent.
   *
   * Counted from events rather than blocks because a block can absorb many
   * events into one line, and "3 new lines" should mean three things arrived.
   */
  useEffect(() => {
    if (events.length === 0) return;
    setLastEventAt(Date.now());
    if (pinnedRef.current) {
      setUnseen(0);
      return;
    }
    setUnseen((count) => count + 1);
  }, [events.length]);

  // A clock, only while it could change the answer: a silent running session.
  useEffect(() => {
    const running = session.state === "running" || session.state === "starting";
    if (!running) return;
    const timer = setInterval(() => setTick(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [session.state]);

  const notice = transcriptNotice({
    session,
    pinned,
    unseen,
    lastEventAt,
    now: tick,
  });

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
    const atEnd = distance < 48;
    pinnedRef.current = atEnd;
    setPinned(atEnd);
    if (atEnd) setUnseen(0);
    updateActivePrompt();
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
            <SessionAgentBadge
              options={session.configOptions}
              disabled={!onConfigChange || isEnded}
              onChange={(configId, value) => onConfigChange?.(configId, value)}
            />
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

      <div className={styles.streamArea}>
        <div className={styles.stream} ref={streamRef} onScroll={handleScroll}>
          {blocks.length === 0 ? (
            <p className={styles.emptyStream}>Waiting for the first streamed event…</p>
          ) : (
            blocks.map((block) => <TerminalLine block={block} key={block.key} />)
          )}
          {session.state === "running" && <div className={styles.working}>working…</div>}
        </div>
        {/*
          Floated over the stream rather than inserted into it, so appearing
          never shifts the text someone is reading.
        */}
        {notice && (
          <div className={styles.noticeSlot} aria-live="polite">
            {notice.kind === "new-output" ? (
              <button
                type="button"
                className={mergeClasses(styles.notice, styles.noticeAction)}
                onClick={() => {
                  pinnedRef.current = true;
                  setPinned(true);
                  setUnseen(0);
                  scrollToEnd();
                }}
              >
                <ArrowDown16Regular aria-hidden="true" />
                {notice.label}
              </button>
            ) : (
              <span
                className={mergeClasses(
                  styles.notice,
                  notice.kind === "stalled" && styles.noticeStalled,
                )}
              >
                <Clock16Regular aria-hidden="true" />
                <strong>{notice.label}</strong>
                <span className={styles.noticeDetail}>· {notice.detail}</span>
              </span>
            )}
          </div>
        )}
        {promptMarks.length > 0 && (
          <PromptRail
            marks={promptMarks}
            activeKey={activePrompt}
            onSelect={scrollToPrompt}
          />
        )}
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
            session={session}
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

/**
 * One entry in the transcript, memoised.
 *
 * A transcript runs to hundreds of these, and each markdown line re-parses its
 * text when it renders. Without this, every keystroke in the composer re-rendered
 * the entire conversation, so typing got measurably slower the longer an
 * operator had been working — the exact opposite of what a long session needs.
 *
 * `block` comes from a memo over the event list, so its identity only changes
 * when the event it describes does.
 *
 * What is said splits from what was done: the agent's words and the operator's
 * prompts get prose treatment, and everything between them — tool calls,
 * reasoning, state changes — gets one dim line each. The middle steps used to
 * be bordered cards with a timestamp column, which meant a turn that ran ten
 * tools pushed its own answer off the screen.
 */
const TerminalLine = memo(function TerminalLine({ block }: { block: TerminalBlock }) {
  const styles = useStyles();
  const time = formatTime(block.createdAt);

  if (block.kind === "agent" || block.kind === "user") {
    const body = (
      <>
        <MarkdownBody text={block.text} copyable />
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
      </>
    );
    if (block.kind === "agent") {
      return (
        <div className={styles.message} title={time}>
          {body}
        </div>
      );
    }
    return (
      <div className={styles.userRow} data-prompt-key={block.key}>
        <div className={styles.userMessage} title={time}>
          {body}
        </div>
      </div>
    );
  }

  // An ordinary end of turn is the absence of news; only a stop reason worth
  // explaining earns a line, and even then it is a rule rather than a message.
  if (block.kind === "turn") {
    return block.text && block.text !== "end_turn" ? (
      <StepRow
        icon={<Info16Regular />}
        title={`Turn ended: ${block.text}`}
        time={time}
        color={terminal.dim}
      />
    ) : (
      <div className={styles.divider} aria-hidden="true" />
    );
  }

  if (block.kind === "thought") return <ThoughtLine block={block} time={time} />;

  if (block.kind === "wake") return <WakeLine block={block} time={time} />;

  // Raw agent stderr and errors are the two things a truncated line would
  // actively cost the reader, so they keep their full text under the row.
  if (block.kind === "error" || block.kind === "system") {
    const color = blockColor[block.kind];
    return (
      <div>
        <StepRow
          icon={kindIcons[block.kind]}
          title={block.kind === "error" ? "Error" : "Output"}
          time={time}
          color={color}
        />
        <p className={styles.note} style={{ color }}>
          {block.text}
        </p>
      </div>
    );
  }

  if (block.kind === "tool") {
    const failed = block.status === "failed";
    const running = block.status ? runningStatuses.has(block.status) : false;
    const icon = running ? (
      <SpinnerIos16Regular className={styles.spin} />
    ) : (
      (toolKindIcons[block.toolKind ?? ""] ?? kindIcons.tool)
    );
    return (
      <StepRow
        icon={icon}
        title={block.text}
        detail={block.detail}
        time={time}
        color={failed ? terminal.error : running ? terminal.tool : undefined}
        failed={failed}
      />
    );
  }

  return (
    <StepRow
      icon={kindIcons[block.kind]}
      title={block.text}
      time={time}
      color={blockColor[block.kind]}
    />
  );
});

/** A thought, folded to its first line until the reader asks for the rest. */
const ThoughtLine = ({ block, time }: { block: TerminalBlock; time: string }) => {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const preview = previewOf(block.text);

  return (
    <div>
      <StepRow
        icon={expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        title="Thinking"
        detail={expanded ? undefined : preview}
        proseDetail
        time={time}
        onClick={() => setExpanded((current) => !current)}
        expanded={expanded}
      />
      {expanded ? (
        <div className={styles.stepBody}>
          <MarkdownBody text={block.text} muted />
        </div>
      ) : null}
    </div>
  );
};

/**
 * A wake, folded to one line the way a tool call is.
 *
 * The Host delivers these down the prompt channel, so the transcript records
 * them as something the operator said — and a wake is a whole transcript of
 * everything that settled, which as a chat bubble pushed the orchestrator's own
 * reply off the screen. The row says what came back; the envelope is one click
 * away for the reader who wants to check the orchestrator's judgement of it.
 */
const WakeLine = ({ block, time }: { block: TerminalBlock; time: string }) => {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <StepRow
        icon={expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        title={block.text}
        detail={expanded ? undefined : block.detail}
        time={time}
        color={blockColor.wake}
        onClick={() => setExpanded((current) => !current)}
        expanded={expanded}
      />
      {expanded ? (
        <div className={styles.stepBody}>
          <MarkdownBody text={block.body ?? block.detail ?? ""} muted copyable />
        </div>
      ) : null}
    </div>
  );
};

type StepRowProps = {
  icon: ReactNode;
  title: string;
  detail?: string | undefined;
  /** Renders the detail as prose rather than as a command or a path. */
  proseDetail?: boolean;
  time: string;
  color?: string | undefined;
  /** Says so in words, because colour alone is not a state a reader can read. */
  failed?: boolean;
  onClick?: () => void;
  expanded?: boolean;
};

/** The single dim line every middle step is drawn as. */
const StepRow = ({
  icon,
  title,
  detail,
  proseDetail,
  time,
  color,
  failed,
  onClick,
  expanded,
}: StepRowProps) => {
  const styles = useStyles();
  const content = (
    <>
      <span className={styles.stepIcon} style={color ? { color } : undefined}>
        {icon}
      </span>
      <span className={mergeClasses(styles.stepTitle, !detail && styles.stepTitleWide)}>
        {title}
      </span>
      {detail ? (
        <span
          className={mergeClasses(
            styles.stepDetail,
            proseDetail && styles.stepDetailProse,
          )}
        >
          {detail}
        </span>
      ) : null}
      {failed ? <span className={styles.stepFailed}>failed</span> : null}
    </>
  );

  // The timestamp lives in the tooltip rather than a column of its own: it is
  // worth having and never worth 56px on every line of a long transcript.
  if (!onClick) {
    return (
      <div className={styles.step} title={time}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={mergeClasses(styles.step, styles.stepClickable)}
      title={time}
      onClick={onClick}
      aria-expanded={expanded}
    >
      {content}
    </button>
  );
};

/** First line of a block of reasoning, short enough to sit on one row. */
function previewOf(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > THOUGHT_PREVIEW_LENGTH
    ? `${flattened.slice(0, THOUGHT_PREVIEW_LENGTH)}…`
    : flattened;
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleTimeString(undefined, { hour12: false });
}
