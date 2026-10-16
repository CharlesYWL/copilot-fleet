import { useEffect, useRef, useState } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { ChevronDown16Regular, ChevronRight16Regular } from "@fluentui/react-icons";
import {
  errorMessage,
  PendingSessionMessageSchema,
  type FleetSession,
  type PendingSessionMessage,
} from "@fleet/protocol";
import { sessionApiPath, sessionRequest as api } from "../lib/session-transport";

const useStyles = makeStyles({
  root: { flexShrink: 0, minWidth: 0, padding: "4px 18px" },
  summary: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    cursor: "pointer",
    padding: "3px 10px",
    borderRadius: "16px",
    border: `1px solid ${tokens.colorBrandStroke1}`,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    listStyleType: "none",
    ":focus-visible": {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: "2px",
    },
    "::-webkit-details-marker": { display: "none" },
  },
  list: { maxHeight: "220px", overflowY: "auto", marginTop: "8px" },
  message: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, padding: "8px 0" },
  text: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    margin: "4px 0",
    fontSize: tokens.fontSizeBase200,
  },
  actions: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" },
  detail: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100 },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
});

export function SessionMessageQueue({
  session,
  disabled = false,
  onReconcile,
}: {
  session: FleetSession;
  disabled?: boolean;
  /**
   * Asks the session's Node to reconcile its session history, resolving true
   * when it was accepted. Left out where no Host is in reach (the Node's own
   * page), which hides the button rather than offering one that cannot work.
   */
  onReconcile?: (sessionId: string) => Promise<boolean>;
}) {
  const styles = useStyles();
  const [messages, setMessages] = useState<PendingSessionMessage[]>([]);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState("");
  const [expanded, setExpanded] = useState(false);
  const busy = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const path = sessionApiPath(session.id, "messages");

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const result = await api<unknown>(path, { signal: controller.signal });
        const next = PendingSessionMessageSchema.array().parse(result);
        if (!controller.signal.aborted) {
          setMessages(next);
          setError("");
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(errorMessage(reason, "Could not load queued messages."));
      } finally {
        loading = false;
      }
    };
    refresh.current = load;
    void load();
    const timer = setInterval(() => {
      if (!busy.current) void load();
    }, 2_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, session.state]);

  const act = async (message: PendingSessionMessage, action: "cancel" | "send-now") => {
    if (busy.current || disabled) return;
    busy.current = true;
    setPending(message.id);
    setActionError("");
    try {
      await api(`${path}/${encodeURIComponent(message.id)}/${action}`, {
        method: "POST",
      });
      await refresh.current();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      busy.current = false;
      setPending("");
    }
  };

  /**
   * Reconciles the Node, then sends the refused message again.
   *
   * The Host answers a resync request as soon as the Node has been asked, not
   * when it has finished, so the retry is the same Send now an operator would
   * press next. If the Node is still catching up the Host refuses again and the
   * button simply reappears, rather than this loop retrying in the background.
   */
  const handleReconcile = async (message: PendingSessionMessage) => {
    if (!onReconcile || busy.current || disabled) return;
    busy.current = true;
    setPending(message.id);
    setActionError("");
    try {
      if (!(await onReconcile(session.id))) return;
      await api(`${path}/${encodeURIComponent(message.id)}/send-now`, {
        method: "POST",
      });
      await refresh.current();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      busy.current = false;
      setPending("");
    }
  };

  if (!messages.length && !error && !actionError) return null;
  return (
    <div className={styles.root}>
      {messages.length ? (
        <details
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className={styles.summary}>
            <span aria-live="polite">
              {messages.length} queued {messages.length === 1 ? "message" : "messages"}
            </span>
            {expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          </summary>
          <div className={styles.list} role="region" aria-label="Queued messages">
            {messages.map((message) => (
              <article className={styles.message} key={message.id}>
                <span className={styles.detail}>
                  {message.source === "fleet" ? "Fleet" : "You"} · {message.state}
                </span>
                <p className={styles.text}>{message.prompt}</p>
                {message.attachments.map((attachment, index) => (
                  <p className={styles.detail} key={`${index}:${attachment.name}`}>
                    {attachment.name}
                  </p>
                ))}
                <div className={styles.actions}>
                  {message.recovery === "console_resync" && onReconcile ? (
                    <Button
                      size="small"
                      appearance="primary"
                      disabled={disabled || !!pending}
                      aria-label="Reconcile now"
                      title="Reconcile this Node's session history with the Host, then send this message again"
                      onClick={() => void handleReconcile(message)}
                    >
                      Reconcile now
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    disabled={disabled || !!pending || !message.canSendNow}
                    title="Interrupt the current turn and send this message when the agent is idle"
                    onClick={() => void act(message, "send-now")}
                  >
                    Send now
                  </Button>
                  <Button
                    size="small"
                    appearance="subtle"
                    disabled={disabled || !!pending || !message.canCancel}
                    onClick={() => void act(message, "cancel")}
                  >
                    Cancel
                  </Button>
                  <span className={styles.detail}>{message.detail}</span>
                </div>
              </article>
            ))}
          </div>
        </details>
      ) : null}
      {error || actionError ? (
        <p className={styles.error} role="alert">
          {actionError || error}
        </p>
      ) : null}
    </div>
  );
}
