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
import type { FleetSession, SessionEvent } from "@fleet/protocol";
import { api, useFleet, type Notify } from "./hooks/useFleet";
import { usePermissionAlerts } from "./hooks/usePermissionAlerts";
import { pendingPermissionRequests } from "./lib/terminal-blocks";
import { EmptySessions } from "./components/EmptySessions";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SessionFocusDialog } from "./components/SessionFocusDialog";
import { SessionGrid } from "./components/SessionGrid";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar, type SidebarView } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { TopBar, type LayoutMode } from "./components/TopBar";

const terminalStates = new Set(["stopped", "completed", "failed"]);
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

  const { snapshot, events, connected, refresh, loadEvents, command } = useFleet(notify);
  const [view, setView] = useState<SidebarView>("session");
  const [layout, setLayout] = useState<LayoutMode>("tree");
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [focusOpen, setFocusOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultYolo, setDefaultYolo] = useState(true);
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
    () => snapshot.sessions.filter((session) => !terminalStates.has(session.state)),
    [snapshot.sessions],
  );
  const endedCount = useMemo(
    () => snapshot.sessions.filter((session) => terminalStates.has(session.state)).length,
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
    try {
      await api(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(undefined);
        setFocusOpen(false);
      }
      await refresh();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  const handleClearEnded = async () => {
    const selectedWasEnded =
      Boolean(activeSession) && terminalStates.has(activeSession!.state);
    try {
      await api<{ removed: number }>("/api/sessions", { method: "DELETE" });
      if (selectedWasEnded) {
        setSelectedSessionId(undefined);
        setFocusOpen(false);
      }
      await refresh();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  usePermissionAlerts(waitingPermissions, handleSelectSession);

  const handleCreateSession = async (
    placementId: string,
    prompt: string,
    yolo: boolean,
  ) => {
    try {
      const session = await api<FleetSession>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ placementId, prompt, yolo }),
      });
      setSelectedSessionId(session.id);
      setView("session");
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  const handleRenameNode = async (nodeId: string, name: string) => {
    try {
      await api(`/api/nodes/${nodeId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  const handleDeleteNode = async (nodeId: string) => {
    try {
      await api(`/api/nodes/${nodeId}`, { method: "DELETE" });
      await refresh();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  const handleCreateWorkspace = async (name: string, description: string) => {
    const created = await command("/api/workspaces", { name, description });
    if (created) await refresh();
    return created;
  };

  const handleUpdateWorkspace = async (
    workspaceId: string,
    name: string,
    description: string,
  ) => {
    try {
      await api(`/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description }),
      });
      await refresh();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  const handleDeleteWorkspace = async (workspaceId: string) => {
    try {
      await api(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
      await refresh();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  const handleCreatePlacement = async (
    workspaceId: string,
    nodeId: string,
    localPath: string,
  ) => {
    const created = await command("/api/placements", { workspaceId, nodeId, localPath });
    if (created) await refresh();
    return created;
  };

  const handleUpdatePlacement = async (placementId: string, localPath: string) => {
    try {
      await api(`/api/placements/${placementId}`, {
        method: "PATCH",
        body: JSON.stringify({ localPath }),
      });
      await refresh();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  const handleDeletePlacement = async (placementId: string) => {
    try {
      await api(`/api/placements/${placementId}`, { method: "DELETE" });
      await refresh();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  return (
    <div className={styles.app}>
      <TopBar
        nodesOnline={snapshot.nodes.filter((node) => node.online).length}
        liveSessions={liveSessions.length}
        waitingPermissions={waitingPermissions.length}
        connected={connected}
        layout={layout}
        onLayoutChange={handleLayoutChange}
      />
      <div className={styles.body}>
        {layout === "grid" ? (
          <SessionGrid
            sessions={visibleSessions}
            nodes={snapshot.nodes}
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
                onRenameNode={handleRenameNode}
                onDeleteNode={handleDeleteNode}
                onCreateWorkspace={handleCreateWorkspace}
                onUpdateWorkspace={handleUpdateWorkspace}
                onDeleteWorkspace={handleDeleteWorkspace}
                onCreatePlacement={handleCreatePlacement}
                onUpdatePlacement={handleUpdatePlacement}
                onDeletePlacement={handleDeletePlacement}
              />
            )}

            {view === "session" &&
              (activeSession ? (
                <TerminalView
                  session={activeSession}
                  events={events[activeSession.id] ?? noEvents}
                  onPrompt={(prompt) =>
                    void command(`/api/sessions/${activeSession.id}/prompt`, { prompt })
                  }
                  onCancel={() =>
                    void command(`/api/sessions/${activeSession.id}/cancel`)
                  }
                  onStop={() => void command(`/api/sessions/${activeSession.id}/stop`)}
                  onDismiss={() => void handleDismissSession(activeSession.id)}
                  onResume={() =>
                    void command(`/api/sessions/${activeSession.id}/resume`)
                  }
                  onPermission={(requestId, outcome, optionId) =>
                    handlePermission(activeSession.id, requestId, outcome, optionId)
                  }
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
          onPrompt={(prompt) =>
            void command(`/api/sessions/${activeSession.id}/prompt`, { prompt })
          }
          onCancel={() => void command(`/api/sessions/${activeSession.id}/cancel`)}
          onStop={() => void command(`/api/sessions/${activeSession.id}/stop`)}
          onDismiss={() => void handleDismissSession(activeSession.id)}
          onResume={() => void command(`/api/sessions/${activeSession.id}/resume`)}
          onPermission={(requestId, outcome, optionId) =>
            handlePermission(activeSession.id, requestId, outcome, optionId)
          }
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
  );
}

function filterVisibleSessions(
  sessions: FleetSession[],
  selectedSessionId: string | undefined,
): FleetSession[] {
  // Ended sessions stay visible only while selected, so a failure mid-watch
  // does not yank the transcript; Dismiss / Clear ended remove them for good.
  return sessions.filter(
    (session) => !terminalStates.has(session.state) || session.id === selectedSessionId,
  );
}
