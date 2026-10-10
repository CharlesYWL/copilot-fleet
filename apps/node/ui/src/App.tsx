import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { CONTEXT_TIER_CONFIG_ID, type PromptAttachment } from "@fleet/protocol";
import { TerminalView } from "../../../host/ui/src/components/TerminalView";
import { SessionMessageQueue } from "../../../host/ui/src/components/SessionMessageQueue";
import { NotificationContext } from "../../../host/ui/src/hooks/useAppNotifications";
import {
  draftFor,
  withDraft,
  type DraftsBySession,
} from "../../../host/ui/src/lib/session-drafts";
import { connectSession, type SessionView } from "./session-connection";
import { nodeApi, sessionPath } from "./api";

const safeConfig = new Set(["model", "reasoning_effort", CONTEXT_TIER_CONFIG_ID]);
const useStyles = makeStyles({
  root: { height: "100%", display: "flex", flexDirection: "column", minHeight: 0 },
  banner: {
    flexShrink: 0,
    padding: "8px 18px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    background: tokens.colorNeutralBackground2,
  },
});

export function App() {
  const styles = useStyles();
  const [sessionId, setSessionId] = useState("");
  const [view, setView] = useState<SessionView>({
    status: "syncing",
    offlineAllowed: false,
  });
  const [drafts, setDrafts] = useState<DraftsBySession>({});
  const [message, setMessage] = useState("");
  const connection = useRef<ReturnType<typeof connectSession> | undefined>(undefined);
  const notify = useCallback((text: string) => setMessage(text), []);

  useEffect(() => {
    const select = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== parent) return;
      if (event.data?.type !== "node-session" || typeof event.data.sessionId !== "string")
        return;
      setSessionId(event.data.sessionId);
    };
    window.addEventListener("message", select);
    parent.postMessage({ type: "node-session-ready" }, location.origin);
    return () => window.removeEventListener("message", select);
  }, []);

  useEffect(() => {
    setMessage("");
    setView({ status: "syncing", offlineAllowed: false });
    if (!sessionId) return;
    const selected = connectSession(sessionId, setView, notify);
    connection.current = selected;
    return () => {
      selected.close();
      connection.current = undefined;
    };
  }, [sessionId, notify]);

  const snapshot = view.snapshot?.session.id === sessionId ? view.snapshot : undefined;
  const allowed = Boolean(
    snapshot &&
    (view.status === "online" ||
      (view.status === "offline" &&
        view.offlineAllowed &&
        snapshot.session.runRole !== "lead")),
  );

  const act = async (suffix: string, body: Record<string, unknown> = {}) => {
    if (!allowed) return false;
    setMessage("");
    try {
      await nodeApi(sessionPath(sessionId, suffix), {
        method: "POST",
        body: JSON.stringify(body),
      });
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  if (!sessionId) return null;
  const statusText =
    view.status === "online"
      ? "Connected to Host"
      : view.status === "offline"
        ? allowed
          ? "Host offline · local worker continuation is available"
          : "Host offline · this session is read-only"
        : view.status === "conflict"
          ? "History conflict · this session is read-only"
          : "Synchronizing · session controls are temporarily unavailable";

  return (
    <NotificationContext.Provider value={notify}>
      <div className={styles.root}>
        <div className={styles.banner} role="status">
          <Text>
            {statusText}
            {view.detail ? ` · ${view.detail}` : ""}. Permissions are approved in Host
            only.
          </Text>
        </div>
        {message || view.error ? (
          <div className={styles.banner} role="alert">
            <Text>{message || view.error}</Text>
            {view.error ? (
              <Button size="small" onClick={() => void connection.current?.reload()}>
                Retry
              </Button>
            ) : (
              <Button size="small" onClick={() => setMessage("")}>
                Dismiss
              </Button>
            )}
          </div>
        ) : null}
        {snapshot ? (
          <TerminalView
            key={sessionId}
            session={{
              ...snapshot.session,
              configOptions: snapshot.session.configOptions.filter((option) =>
                safeConfig.has(option.id),
              ),
            }}
            node={snapshot.node}
            placement={snapshot.placement}
            transcript={view.transcript}
            activity={view.activity}
            pendingPermission={view.pendingPermission ?? null}
            controlsDisabled={!allowed}
            onLoadOlder={(toIndex) =>
              connection.current?.loadOlder(toIndex) ?? Promise.resolve()
            }
            onPrompt={(prompt: string, attachments?: PromptAttachment[]) =>
              act("prompt", { prompt, attachments: attachments ?? [] })
            }
            onCancel={() => {
              void act("cancel");
            }}
            onStop={() => {
              void act("stop");
            }}
            onResume={
              allowed
                ? () => {
                    void act("resume");
                  }
                : undefined
            }
            onConfigChange={
              allowed
                ? (configId, value) => {
                    if (safeConfig.has(configId)) void act("config", { configId, value });
                  }
                : undefined
            }
            messageQueue={
              <SessionMessageQueue session={snapshot.session} disabled={!allowed} />
            }
            draft={draftFor(drafts, sessionId)}
            onDraftChange={(update) =>
              setDrafts((current) => withDraft(current, sessionId, update))
            }
          />
        ) : (
          <div className={styles.banner}>Loading selected session…</div>
        )}
      </div>
    </NotificationContext.Provider>
  );
}
