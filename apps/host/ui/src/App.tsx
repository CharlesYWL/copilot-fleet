import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Text,
  Toast,
  ToastTitle,
  Toaster,
  makeStyles,
  tokens,
  useId,
  useToastController,
} from "@fluentui/react-components";
import { Add20Regular } from "@fluentui/react-icons";
import type { FleetSession } from "@fleet/protocol";
import { api, useFleet, type Notify } from "./hooks/useFleet";
import { usePermissionAlerts } from "./hooks/usePermissionAlerts";
import { pendingPermissionRequests } from "./lib/terminal-blocks";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar, type SidebarView } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { TopBar } from "./components/TopBar";

const terminalStates = new Set(["stopped", "completed", "failed"]);
const FAILED_VISIBLE_MS = 120_000;

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
  empty: {
    flexGrow: 1,
    display: "grid",
    placeContent: "center",
    justifyItems: "center",
    gap: "10px",
    background: tokens.colorNeutralBackground1,
  },
  emptyCaption: {
    color: tokens.colorNeutralForeground3,
    maxWidth: "360px",
    textAlign: "center",
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
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);

  const visibleSessions = useMemo(
    () => filterVisibleSessions(snapshot.sessions, selectedSessionId),
    [snapshot.sessions, selectedSessionId],
  );
  const liveSessions = useMemo(
    () => snapshot.sessions.filter((session) => !terminalStates.has(session.state)),
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
  const activeSession = snapshot.sessions.find((session) => session.id === selectedSessionId);

  useEffect(() => {
    const first = visibleSessions[0];
    if (selectedSessionId || !first) return;
    setSelectedSessionId(first.id);
  }, [selectedSessionId, visibleSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    void loadEvents(selectedSessionId);
  }, [selectedSessionId, loadEvents]);

  const handleSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setView("session");
  };

  usePermissionAlerts(waitingPermissions, handleSelectSession);

  const handleCreateSession = async (placementId: string, prompt: string) => {
    try {
      const session = await api<FleetSession>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ placementId, prompt }),
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
      />
      <div className={styles.body}>
        <Sidebar
          nodes={snapshot.nodes}
          sessions={visibleSessions}
          selectedSessionId={selectedSessionId}
          view={view}
          onSelectSession={handleSelectSession}
          onNewSession={() => setDialogOpen(true)}
          onSelectView={setView}
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
              events={events[activeSession.id] ?? []}
              onPrompt={(prompt) =>
                void command(`/api/sessions/${activeSession.id}/prompt`, { prompt })
              }
              onCancel={() => void command(`/api/sessions/${activeSession.id}/cancel`)}
              onStop={() => void command(`/api/sessions/${activeSession.id}/stop`)}
              onPermission={(requestId, outcome, optionId) =>
                void command(`/api/sessions/${activeSession.id}/permission`, {
                  requestId,
                  outcome,
                  ...(optionId ? { optionId } : {}),
                })
              }
            />
          ) : (
            <div className={styles.empty}>
              <Text size={500} weight="semibold">
                No live sessions
              </Text>
              <Text className={styles.emptyCaption}>
                Register a node, add a workspace placement, then launch an agent to watch its
                stream here.
              </Text>
              <Button
                appearance="primary"
                icon={<Add20Regular />}
                onClick={() => setDialogOpen(true)}
              >
                New session
              </Button>
            </div>
          ))}
      </div>

      <NewSessionDialog
        open={dialogOpen}
        placements={eligiblePlacements}
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
  const now = Date.now();
  return sessions.filter(
    (session) =>
      !terminalStates.has(session.state) ||
      session.id === selectedSessionId ||
      (session.state === "failed" &&
        now - Date.parse(session.updatedAt) < FAILED_VISIBLE_MS),
  );
}
