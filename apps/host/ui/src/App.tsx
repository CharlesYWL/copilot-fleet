import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Toast,
  ToastTitle,
  Toaster,
  makeStyles,
  tokens,
  useId,
  useToastController,
} from "@fluentui/react-components";
import {
  terminalSessionStates,
  type FleetSession,
  type SessionEvent,
} from "@fleet/protocol";
import { api, useFleet, type Notify } from "./hooks/useFleet";
import { CatalogProvider, useCatalogOperations } from "./hooks/useCatalog";
import { usePermissionAlerts } from "./hooks/usePermissionAlerts";
import { useSessionChimes } from "./hooks/useSessionChimes";
import { signOut } from "./lib/auth";
import { pendingPermissionRequests } from "./lib/terminal-blocks";
import { isDisposableSession, filterVisibleSessions } from "./lib/session-status";
import {
  draftFor,
  pruneDrafts,
  withDraft,
  type DraftsBySession,
  type SessionDraft,
} from "./lib/session-drafts";
import { EmptySessions } from "./components/EmptySessions";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SessionFocusDialog } from "./components/SessionFocusDialog";
import { SessionGrid } from "./components/SessionGrid";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar, type SidebarView } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { TopBar, type LayoutMode } from "./components/TopBar";

const noEvents: SessionEvent[] = [];

const useStyles = makeStyles({
  app: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
  },
  body: {
    flexGrow: 1,
    display: "flex",
    minHeight: 0,
  },
});

export function App() {
  const styles = useStyles();
  const toasterId = useId("fleet-toaster");
  const { dispatchToast } = useToastController(toasterId);

  const notify = useCallback<Notify>(
    (message, intent = "error") => {
      dispatchToast(
        <Toast>
          <ToastTitle>{message}</ToastTitle>
        </Toast>,
        { intent, position: "bottom-end" },
      );
    },
    [dispatchToast],
  );

  const {
    snapshot,
    events,
    connected,
    nodeUpdates,
    refresh,
    loadEvents,
    command,
    request,
  } = useFleet(notify);
  const catalog = useCatalogOperations({ request, refresh, notify });
  const [view, setView] = useState<SidebarView>("session");
  const [layout, setLayout] = useState<LayoutMode>("tree");
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [focusOpen, setFocusOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultYolo, setDefaultYolo] = useState(false);
  /**
   * Unsent composer text, per session.
   *
   * Owned here because the terminal view is unmounted by half the things an
   * operator does — switching sessions, opening Settings, moving between the
   * tree and the wall — and a draft that lives inside it disappears with it.
   */
  const [drafts, setDrafts] = useState<DraftsBySession>({});
  const backfilled = useRef(new Set<string>());

  // Read the Host default when the dialog opens so it reflects Settings edits.
  useEffect(() => {
    if (!dialogOpen) return;
    void api<{ yolo: boolean }>("/api/defaults")
      .then((defaults) => setDefaultYolo(defaults.yolo))
      .catch(() => undefined);
  }, [dialogOpen]);

  const visibleSessions = useMemo(
    () => filterVisibleSessions(snapshot.sessions, selectedSessionId),
    [snapshot.sessions, selectedSessionId],
  );
  const liveSessions = useMemo(
    () =>
      snapshot.sessions.filter((session) => !terminalSessionStates.has(session.state)),
    [snapshot.sessions],
  );
  // Only what Clear ended will actually remove: resumable sessions are kept, so
  // counting them here would promise a purge that does not happen.
  const endedCount = useMemo(
    () => snapshot.sessions.filter(isDisposableSession).length,
    [snapshot.sessions],
  );
  const waitingPermissions = useMemo(
    () => pendingPermissionRequests(Object.values(events).flat()),
    [events],
  );
  const eligiblePlacements = useMemo(
    () =>
      snapshot.placements.filter((placement) =>
        snapshot.nodes.some((node) => node.id === placement.nodeId && node.online),
      ),
    [snapshot.placements, snapshot.nodes],
  );
  const activeSession = snapshot.sessions.find(
    (session) => session.id === selectedSessionId,
  );

  // A dismissed or cleared session takes its unsent draft with it.
  useEffect(() => {
    const live = new Set(snapshot.sessions.map((session) => session.id));
    setDrafts((current) => pruneDrafts(current, live));
  }, [snapshot.sessions]);

  const changeDraft = useCallback(
    (sessionId: string, update: (current: SessionDraft) => SessionDraft) => {
      setDrafts((current) => withDraft(current, sessionId, update));
    },
    [],
  );

  useEffect(() => {
    const first = visibleSessions[0];
    if (selectedSessionId || !first) return;
    setSelectedSessionId(first.id);
  }, [selectedSessionId, visibleSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    void loadEvents(selectedSessionId);
  }, [selectedSessionId, loadEvents]);

  // Live updates only cover what streams while this tab is open, so every tile
  // needs its history once before the monitor wall can preview it.
  useEffect(() => {
    if (layout !== "grid") return;
    for (const session of visibleSessions) {
      if (backfilled.current.has(session.id)) continue;
      backfilled.current.add(session.id);
      void loadEvents(session.id);
    }
  }, [layout, visibleSessions, loadEvents]);

  const handleSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setView("session");
    if (layout === "grid") setFocusOpen(true);
  };

  const handleLayoutChange = (next: LayoutMode) => {
    setLayout(next);
    setFocusOpen(false);
    // Settings only exists beside the tree, so grid always lands on sessions.
    if (next === "grid") setView("session");
  };

  const handlePermission = (
    sessionId: string,
    requestId: string,
    outcome: "allow_once" | "deny",
    optionId?: string,
  ) =>
    void command(`/api/sessions/${sessionId}/permission`, {
      requestId,
      outcome,
      ...(optionId ? { optionId } : {}),
    });

  const handleDismissSession = async (sessionId: string) => {
    const result = await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
    if (!result.ok) return false;
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(undefined);
      setFocusOpen(false);
    }
    await refresh();
    return true;
  };

  const handleClearEnded = async () => {
    const selectedWasEnded =
      Boolean(activeSession) && terminalSessionStates.has(activeSession!.state);
    const result = await request("/api/sessions", { method: "DELETE" });
    if (!result.ok) return false;
    if (selectedWasEnded) {
      setSelectedSessionId(undefined);
      setFocusOpen(false);
    }
    await refresh();
    return true;
  };

  usePermissionAlerts(waitingPermissions, handleSelectSession);
  const sound = useSessionChimes(snapshot.sessions, waitingPermissions);

  const handleCreateSession = async (
    placementId: string,
    prompt: string,
    yolo: boolean,
    name: string,
  ) => {
    const result = await request<FleetSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ placementId, prompt, yolo, name }),
    });
    if (!result.ok) return false;
    setSelectedSessionId(result.data.id);
    setView("session");
    return true;
  };

  // The rename is broadcast back as a session update, so there is nothing to
  // re-read here.
  const handleRenameSession = (sessionId: string, name: string) =>
    void request(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });

  return (
    <CatalogProvider value={catalog}>
      <div className={styles.app}>
        <TopBar
          nodesOnline={snapshot.nodes.filter((node) => node.online).length}
          liveSessions={liveSessions.length}
          waitingPermissions={waitingPermissions.length}
          connected={connected}
          layout={layout}
          onLayoutChange={handleLayoutChange}
          soundEnabled={sound.enabled}
          onToggleSound={sound.toggle}
          onSignOut={() => void signOut()}
        />
        <div className={styles.body}>
          {layout === "grid" ? (
            <SessionGrid
              sessions={visibleSessions}
              workspaces={snapshot.workspaces}
              nodes={snapshot.nodes}
              placements={snapshot.placements}
              events={events}
              onOpen={handleSelectSession}
              onPermission={handlePermission}
              onNewSession={() => setDialogOpen(true)}
            />
          ) : (
            <>
              <Sidebar
                nodes={snapshot.nodes}
                workspaces={snapshot.workspaces}
                sessions={visibleSessions}
                placements={snapshot.placements}
                selectedSessionId={selectedSessionId}
                view={view}
                endedCount={endedCount}
                onSelectSession={handleSelectSession}
                onNewSession={() => setDialogOpen(true)}
                onSelectView={setView}
                onClearEnded={() => void handleClearEnded()}
              />

              {view === "settings" && (
                <SettingsPanel
                  workspaces={snapshot.workspaces}
                  placements={snapshot.placements}
                  nodes={snapshot.nodes}
                  hostRevision={snapshot.hostRevision}
                  nodeUpdates={nodeUpdates}
                />
              )}

              {view === "session" &&
                (activeSession ? (
                  <TerminalView
                    session={activeSession}
                    events={events[activeSession.id] ?? noEvents}
                    onPrompt={(prompt, attachments) =>
                      void command(`/api/sessions/${activeSession.id}/prompt`, {
                        prompt,
                        attachments,
                      })
                    }
                    onCancel={() =>
                      void command(`/api/sessions/${activeSession.id}/cancel`)
                    }
                    onStop={() => void command(`/api/sessions/${activeSession.id}/stop`)}
                    onDismiss={() => void handleDismissSession(activeSession.id)}
                    onResume={() =>
                      void command(`/api/sessions/${activeSession.id}/resume`)
                    }
                    onRename={(name) => handleRenameSession(activeSession.id, name)}
                    onPermission={(requestId, outcome, optionId) =>
                      handlePermission(activeSession.id, requestId, outcome, optionId)
                    }
                    onConfigChange={(configId, value) =>
                      void command(`/api/sessions/${activeSession.id}/config`, {
                        configId,
                        value,
                      })
                    }
                    draft={draftFor(drafts, activeSession.id)}
                    onDraftChange={(update) => changeDraft(activeSession.id, update)}
                  />
                ) : (
                  <EmptySessions onNewSession={() => setDialogOpen(true)} />
                ))}
            </>
          )}
        </div>

        {layout === "grid" && activeSession && (
          <SessionFocusDialog
            session={activeSession}
            events={events[activeSession.id] ?? noEvents}
            open={focusOpen}
            onOpenChange={setFocusOpen}
            onPrompt={(prompt, attachments) =>
              void command(`/api/sessions/${activeSession.id}/prompt`, {
                prompt,
                attachments,
              })
            }
            onCancel={() => void command(`/api/sessions/${activeSession.id}/cancel`)}
            onStop={() => void command(`/api/sessions/${activeSession.id}/stop`)}
            onDismiss={() => void handleDismissSession(activeSession.id)}
            onResume={() => void command(`/api/sessions/${activeSession.id}/resume`)}
            onRename={(name) => handleRenameSession(activeSession.id, name)}
            onPermission={(requestId, outcome, optionId) =>
              handlePermission(activeSession.id, requestId, outcome, optionId)
            }
            onConfigChange={(configId, value) =>
              void command(`/api/sessions/${activeSession.id}/config`, {
                configId,
                value,
              })
            }
            draft={draftFor(drafts, activeSession.id)}
            onDraftChange={(update) => changeDraft(activeSession.id, update)}
          />
        )}

        <NewSessionDialog
          open={dialogOpen}
          placements={eligiblePlacements}
          defaultYolo={defaultYolo}
          onOpenChange={setDialogOpen}
          onCreate={handleCreateSession}
        />
        <Toaster toasterId={toasterId} />
      </div>
    </CatalogProvider>
  );
}
