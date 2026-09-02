import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Toast,
  ToastBody,
  ToastTitle,
  Toaster,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
  useId,
  useToastController,
} from "@fluentui/react-components";
import {
  terminalRunStates,
  terminalSessionStates,
  type FleetSession,
  type Notification,
  type RunNote,
  type SessionEvent,
} from "@fleet/protocol";
import { api, useFleet, type Notify } from "./hooks/useFleet";
import { CatalogProvider, useCatalogOperations } from "./hooks/useCatalog";
import { useNotificationDelivery } from "./hooks/useNotificationDelivery";
import { useNotificationPreference } from "./hooks/useNotificationPreference";
import { useStickyFlag } from "./hooks/useStickyFlag";
import { signOut } from "./lib/auth";
import { notificationTarget } from "./lib/notification-navigation";
import { pendingPermissionRequests } from "./lib/terminal-blocks";
import {
  filterOrchestratorConversations,
  filterVisibleSessions,
  isDisposableSession,
} from "./lib/session-status";
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
import { SettingsPanel, type SettingsTab } from "./components/SettingsPanel";
import { DispatchedBanner } from "./components/orchestration/DispatchedBanner";
import { StartOrchestrator } from "./components/orchestration/StartOrchestrator";
import { OrchestratorPage } from "./components/orchestration/OrchestratorPage";
import { OrchestratorTaskDetail } from "./components/orchestration/OrchestratorTaskDetail";
import { ConversationTasks } from "./components/orchestration/ConversationTasks";
import { CreateOrchestrationDialog } from "./components/orchestration/CreateOrchestrationDialog";
import { readDismissedFailures } from "./components/orchestration/RunStatusIndicator";
import {
  buildRunViewModels,
  liveSteps,
  summarise,
  tasksAwaitingHuman,
} from "./lib/orchestration-view";
import type {
  OrchestratorViewMode,
  SessionLayoutMode,
} from "./components/navigation/ContextModeToggle";
import { Sidebar } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { TopBar } from "./components/TopBar";
import { LifecycleNotificationControl } from "./components/LifecycleNotificationControl";

const noEvents: SessionEvent[] = [];
const noNotes: RunNote[] = [];

/**
 * What the main area is showing.
 *
 * `overview` is its own view rather than a flag on `session` because it is the
 * one that hides the sidebar, and because the top bar's mode slot has to know
 * which pair of choices to offer. Keeping the orchestrator views in the same
 * union is what stops switching to the wall from silently dropping them, which
 * is what the old `layout === "grid" → view = "session"` line did.
 */
export type AppView =
  "session" | "overview" | "orchestrator" | "orchestrator-task" | "settings";

/**
 * Where a conversation was opened from, so leaving it goes back there.
 *
 * A worker's transcript is an ordinary session view; without this, closing one
 * landed on the orchestrator's front page rather than the task it belonged to,
 * which is a different place from the one the operator left.
 */
export type ReturnContext =
  { kind: "orchestrator-task"; runId: string } | { kind: "orchestrator" } | undefined;

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
    minWidth: 0,
    position: "relative",
  },
  /** Stacks the dispatched-work banner above a worker's transcript. */
  session: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  },
  /**
   * Below this width the sidebar and the main area cannot both be useful.
   *
   * So the sidebar becomes a drawer over the content rather than a column
   * beside it: 240px of tree next to 120px of transcript is two unusable
   * panes, and squeezing the tree instead just moves the problem.
   */
  navDrawer: {
    /*
     * The drawer stretches with the body, but a block box does not pass that
     * height on — so the sidebar sized itself to its tree and its footer sat
     * wherever the last workspace ended instead of at the bottom.
     */
    display: "flex",
    minHeight: 0,
    /*
     * The fold is the wrapper's width, not the sidebar's.
     *
     * The sidebar keeps its 280px throughout, so folding it clips the tree
     * rather than reflowing it — a tree that reflows to 40px on the way out
     * spends the animation rewrapping every label, which reads as a glitch.
     * `visibility` rides along so that a folded sidebar is out of the tab order
     * and out of the accessibility tree, but only once it has finished leaving:
     * it flips to hidden at the end of the transition and back at the start of
     * the return, which is exactly what a discrete property does here.
     *
     * `flexShrink` is load-bearing. A flex item with a width is still free to
     * give it up, and a transcript is as wide as its widest line — so without
     * this the tree was squeezed to whatever a table of Chinese prose left it,
     * which was about 50px.
     */
    "@media (min-width: 768px)": {
      width: "280px",
      flexShrink: 0,
      overflow: "hidden",
      visibility: "visible",
      transitionProperty: "width, visibility",
      transitionDuration: "200ms",
      transitionTimingFunction: "cubic-bezier(0.33, 0, 0.13, 1)",
    },
    "@media (max-width: 767px)": {
      position: "absolute",
      insetBlockStart: 0,
      insetBlockEnd: 0,
      insetInlineStart: 0,
      zIndex: 20,
      boxShadow: tokens.shadow28,
    },
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "1ms" },
  },
  /**
   * The folded state, scoped to the widths that have a column to fold.
   *
   * Below 768px the sidebar is already a drawer over the content, so a
   * remembered fold from a wider window must not follow the operator down and
   * leave the drawer opening onto nothing.
   */
  navCollapsed: {
    "@media (min-width: 768px)": { width: 0, visibility: "hidden" },
  },
  navHidden: {
    "@media (max-width: 767px)": { display: "none" },
  },
  scrim: {
    display: "none",
    "@media (max-width: 767px)": {
      display: "block",
      position: "absolute",
      inset: 0,
      zIndex: 15,
      background: "rgba(0,0,0,0.5)",
      ...shorthands.borderStyle("none"),
      cursor: "pointer",
    },
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
    liveNotificationUpdates,
    events,
    runSteps,
    runNotes,
    connected,
    nodeUpdates,
    refresh,
    loadEvents,
    command,
    request,
    markNotificationRead,
    markAllNotificationsRead,
    dismissAllNotifications,
    dismissNotification,
  } = useFleet(notify);
  const catalog = useCatalogOperations({ request, refresh, notify });
  const [view, setView] = useState<AppView>("session");
  const [orchestratorViewMode, setOrchestratorViewMode] =
    useState<OrchestratorViewMode>("stage");
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  /**
   * The conversation a task was opened from, when one was.
   *
   * Only the task detail reads it, and only to decide where Back goes: reaching
   * a task from a thread and being returned to the fleet-wide board is a change
   * of place the operator did not ask for.
   */
  const [taskOrigin, setTaskOrigin] = useState<string>();
  const [returnContext, setReturnContext] = useState<ReturnContext>();
  const [focusOpen, setFocusOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [orchestrationDialogOpen, setOrchestrationDialogOpen] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  /** Narrow screens show the tree as a drawer; wide ones ignore this. */
  const [navOpen, setNavOpen] = useState(false);
  /** Wide screens can give the tree's column back to the content. */
  const [navCollapsed, setNavCollapsed] = useStickyFlag("nav.collapsed", false);
  /** The task list beside a conversation, folded away or not. */
  const [tasksOpen, setTasksOpen] = useStickyFlag("conversation.tasks", true);
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

  const terminalRunIds = useMemo(
    () =>
      new Set(
        snapshot.runs
          .filter((run) => terminalRunStates.has(run.state))
          .map((run) => run.id),
      ),
    [snapshot.runs],
  );
  const visibleSessions = useMemo(
    () =>
      filterVisibleSessions(
        snapshot.sessions,
        selectedSessionId,
        terminalRunIds,
        Boolean(returnContext),
      ),
    [snapshot.sessions, selectedSessionId, terminalRunIds, returnContext],
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
  const notificationPreference = useNotificationPreference(activeSession?.id, request);

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
    if (view !== "overview") return;
    for (const session of visibleSessions) {
      if (backfilled.current.has(session.id)) continue;
      backfilled.current.add(session.id);
      void loadEvents(session.id);
    }
  }, [view, visibleSessions, loadEvents]);

  /**
   * Opens a session's transcript.
   *
   * `from` records where the operator was, so that leaving the transcript
   * returns there instead of to whatever the app considers home.
   */
  const handleSelectSession = useCallback(
    (sessionId: string, from?: ReturnContext) => {
      setSelectedSessionId(sessionId);
      setReturnContext(from);
      setNavOpen(false);
      if (view === "overview" && !from) {
        setFocusOpen(true);
        return;
      }
      setView("session");
    },
    [view],
  );

  const handleSessionLayoutChange = (next: SessionLayoutMode) => {
    setFocusOpen(false);
    setView(next === "tree" ? "session" : "overview");
  };

  /** Opens one task's detail, from any of the three orchestrator views. */
  const handleOpenRun = useCallback((runId: string, fromConversationId?: string) => {
    setSelectedRunId(runId);
    // Cleared unless the task was opened from a conversation, so Back keeps
    // meaning "where I was" rather than "wherever I last came from".
    setTaskOrigin(fromConversationId);
    setView("orchestrator-task");
  }, []);

  /** Leaves a task for whatever opened it: a conversation, or the board. */
  const handleBackFromTask = () => {
    if (taskOrigin) {
      const conversation = taskOrigin;
      setTaskOrigin(undefined);
      handleSelectSession(conversation, { kind: "orchestrator" });
      return;
    }
    setView("orchestrator");
  };

  const handleBackFromSession = () => {
    if (returnContext?.kind === "orchestrator-task") {
      setSelectedRunId(returnContext.runId);
      setView("orchestrator-task");
    } else {
      setView("orchestrator");
    }
    setReturnContext(undefined);
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

  /**
   * Starts the session you talk to.
   *
   * It needs a workspace because its workers do — the orchestrator itself only
   * dispatches. The first workspace that an online node actually holds is the
   * one picked, since any other choice would produce an orchestrator that can
   * see nowhere to send work.
   */
  const handleStartOrchestrator = async () => {
    const reachable = snapshot.placements.find((placement) =>
      snapshot.nodes.some((node) => node.id === placement.nodeId && node.online),
    );
    if (!reachable) {
      notify(
        "No online node holds a workspace yet, so there is nowhere to work.",
        "error",
      );
      return false;
    }
    const created = await request<{ session: FleetSession }>("/api/orchestrators", {
      method: "POST",
      body: JSON.stringify({ workspaceId: reachable.workspaceId }),
    });
    if (!created.ok) return false;
    // Opened rather than merely created: starting a conversation and landing on
    // a different one is the kind of thing you only notice after typing into it.
    setOpenConversationId(created.data.session.id);
    await refresh();
    setView("orchestrator");
    return true;
  };

  /**
   * The orchestrator conversations, newest first, and which one is open.
   *
   * A list rather than one session: the Host has always accepted several leads
   * — it is only this that assumed one, by taking the first it found, so the
   * way to start a second conversation was to stop the first.
   *
   * Read from the snapshot rather than held in state so it survives a refresh
   * and a reconnect without a second source of truth. Stopped conversations
   * remain here until explicitly dismissed, so Stop never acts like Delete.
   * Only the *choice* of which is open is state.
   */
  const allOrchestrators = useMemo(
    () =>
      filterOrchestratorConversations(snapshot.sessions).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    [snapshot.sessions],
  );
  const orchestrators = useMemo(
    () => allOrchestrators.filter((session) => !session.dismissed),
    [allOrchestrators],
  );
  const dismissedOrchestrators = useMemo(
    () => allOrchestrators.filter((session) => session.dismissed),
    [allOrchestrators],
  );
  const liveOrchestrators = useMemo(
    () => orchestrators.filter((session) => !terminalSessionStates.has(session.state)),
    [orchestrators],
  );
  const [openConversationId, setOpenConversationId] = useState<string>();
  const orchestrator = useMemo(
    () =>
      orchestrators.find((session) => session.id === openConversationId) ??
      liveOrchestrators[0] ??
      orchestrators[0],
    [orchestrators, liveOrchestrators, openConversationId],
  );
  /**
   * Every task owned by a retained conversation, oldest first.
   *
   * Across all of them, not just the open one. The orchestrator page is the
   * fleet's board — its own row in the sidebar, separate from the conversation
   * rows — so it answers "what is the fleet doing", and filtering it to one
   * conversation made work invisible the moment a second conversation existed.
   * Keeping stopped conversations here also keeps their task history reachable
   * until the conversation itself is dismissed.
   */
  const orchestratorRuns = useMemo(() => {
    const retained = new Set(orchestrators.map((session) => session.id));
    return snapshot.runs
      .filter((run) => retained.has(run.leadSessionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [snapshot.runs, orchestrators]);
  const orchestratorSteps = useMemo(
    () => orchestratorRuns.flatMap((run) => runSteps[run.id] ?? []),
    [orchestratorRuns, runSteps],
  );
  const [dismissedFailures, setDismissedFailures] = useState<
    Record<string, readonly string[]>
  >({});
  const acknowledgedFailedSteps = useMemo(
    () =>
      Object.fromEntries(
        orchestratorRuns.map((run) => [
          run.id,
          dismissedFailures[run.id] ?? readDismissedFailures(run.id),
        ]),
      ),
    [orchestratorRuns, dismissedFailures],
  );

  /** Everything the three orchestrator views read, derived once. */
  const runModels = useMemo(
    () =>
      buildRunViewModels({
        runs: orchestratorRuns,
        stepsByRun: runSteps,
        sessions: snapshot.sessions,
        placements: snapshot.placements,
        waitingPermissions,
        acknowledgedFailedSteps,
      }),
    [
      orchestratorRuns,
      runSteps,
      snapshot.sessions,
      snapshot.placements,
      waitingPermissions,
      acknowledgedFailedSteps,
    ],
  );
  const orchestratorSummary = useMemo(() => summarise(runModels), [runModels]);
  /**
   * One number for "waiting on you", counting each thing once.
   *
   * A permission on a worker is already what makes its task need a person, so
   * adding the two totals reported one prompt as two. Only permissions on
   * sessions no task owns are counted separately.
   */
  const attentionCount = useMemo(() => {
    const ownedByATask = new Set(
      runModels.flatMap((model) =>
        model.steps.map((step) => step.sessionId).filter(Boolean),
      ),
    );
    const loose = waitingPermissions.filter(
      (event) => !ownedByATask.has(event.sessionId),
    ).length;
    return loose + orchestratorSummary.needsYou;
  }, [runModels, waitingPermissions, orchestratorSummary.needsYou]);
  const selectedRunModel = useMemo(
    () => runModels.find((model) => model.run.id === selectedRunId),
    [runModels, selectedRunId],
  );
  const handleNotificationNavigate = useCallback(
    (notification: Notification) => {
      void markNotificationRead(notification.id);
      const target = notificationTarget(
        notification,
        runSteps,
        snapshot.sessions,
        orchestratorRuns,
      );
      if (target.kind === "session") {
        if (target.returnRunId) {
          setSelectedRunId(target.returnRunId);
          handleSelectSession(target.sessionId, {
            kind: "orchestrator-task",
            runId: target.returnRunId,
          });
          return;
        }
        handleSelectSession(target.sessionId);
        return;
      }
      if (target.kind === "run") {
        handleOpenRun(target.runId);
        return;
      }
      if (target.kind === "node") {
        setSettingsTab("nodes");
        setView("settings");
        return;
      }
      if (target.kind === "orchestrator") {
        setView("orchestrator");
        return;
      }
      setView("overview");
    },
    [
      handleOpenRun,
      handleSelectSession,
      markNotificationRead,
      orchestratorRuns,
      runSteps,
      snapshot.sessions,
    ],
  );
  const isNotificationTargetVisible = useCallback(
    (notification: Notification) => {
      const target = notificationTarget(
        notification,
        runSteps,
        snapshot.sessions,
        orchestratorRuns,
      );
      if (target.kind === "session") {
        return (
          target.sessionId === selectedSessionId &&
          (view === "session" || (view === "overview" && focusOpen))
        );
      }
      if (target.kind === "run") {
        return view === "orchestrator-task" && selectedRunId === target.runId;
      }
      if (target.kind === "node") {
        return view === "settings" && settingsTab === "nodes";
      }
      if (target.kind === "orchestrator") return view === "orchestrator";
      return view === "overview";
    },
    [
      focusOpen,
      orchestratorRuns,
      runSteps,
      selectedRunId,
      selectedSessionId,
      settingsTab,
      snapshot.sessions,
      view,
    ],
  );
  const notifyDurable = useCallback(
    (notification: Notification) => {
      dispatchToast(
        <Toast>
          <ToastTitle>{notification.title}</ToastTitle>
          {notification.body && <ToastBody>{notification.body}</ToastBody>}
        </Toast>,
        {
          intent:
            notification.severity === "error" || notification.severity === "critical"
              ? "error"
              : notification.severity === "warning"
                ? "warning"
                : "info",
          position: "bottom-end",
        },
      );
    },
    [dispatchToast],
  );
  const delivery = useNotificationDelivery({
    notificationUpdates: liveNotificationUpdates,
    unreadCount: snapshot.notificationUnreadCount,
    isTargetVisible: isNotificationTargetVisible,
    onToast: notifyDurable,
    onNavigate: handleNotificationNavigate,
  });
  /**
   * The tasks of the conversation on screen, if the session on screen is one.
   *
   * A worker's transcript gets nothing: it *is* one task's work, so a list of
   * its siblings beside it would be answering a question nobody asked while
   * reading it. Only a lead session — a conversation — owns tasks.
   */
  const conversationModels = useMemo(() => {
    if (!activeSession || activeSession.runRole !== "lead") return [];
    return runModels.filter((model) => model.run.leadSessionId === activeSession.id);
  }, [runModels, activeSession]);

  /*
   * A task that no longer exists cannot stay open. Deleting or losing the run
   * underneath the detail page would otherwise leave a header with no body.
   */
  useEffect(() => {
    if (view !== "orchestrator-task") return;
    if (selectedRunId && runModels.some((model) => model.run.id === selectedRunId)) {
      return;
    }
    setView("orchestrator");
  }, [view, selectedRunId, runModels]);

  /*
   * The orchestrator's history, which nothing else asks for.
   *
   * Events are fetched for the *selected* session, and the orchestrator is
   * never that — it has a view of its own. So its transcript held only what
   * happened to stream while the tab was open, and reopening the view, or
   * reloading the page, showed an empty conversation that was in fact intact
   * on the Host.
   */
  const orchestratorId = orchestrator?.id;
  useEffect(() => {
    if (!orchestratorId) return;
    void loadEvents(orchestratorId);
  }, [orchestratorId, loadEvents]);

  /**
   * The person's answer to a task the orchestrator handed over.
   *
   * The one decision left to a human. Approving closes the task; sending it
   * back returns it to the orchestrator with the note, which it acts on.
   */
  const handleReviewTask = async (runId: string, approved: boolean, note: string) => {
    const answered = await request(`/api/runs/${runId}/review`, {
      method: "POST",
      body: JSON.stringify({ approved, note }),
    });
    if (!answered.ok) return false;
    await refresh();
    return true;
  };

  /** Ends the orchestrator and everything it started. */
  const handleStopOrchestrator = async (sessionId: string) => {
    const stopped = await request(`/api/orchestrators/${sessionId}/stop`, {
      method: "POST",
    });
    if (!stopped.ok) return false;
    // Keep the conversation that was just stopped in view so its new Resume and
    // Dismiss actions replace Stop instead of the board jumping to another lead.
    setOpenConversationId(sessionId);
    await refresh();
    return true;
  };

  const handleResumeOrchestrator = async (sessionId: string) => {
    const resumed = await request(`/api/orchestrators/${sessionId}/resume`, {
      method: "POST",
    });
    if (!resumed.ok) return false;
    await refresh();
    return true;
  };

  const handleDismissOrchestrator = async (sessionId: string) => {
    const dismissed = await request(`/api/orchestrators/${sessionId}`, {
      method: "DELETE",
    });
    if (!dismissed.ok) return false;
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(undefined);
      setFocusOpen(false);
    }
    setOpenConversationId((current) => (current === sessionId ? undefined : current));
    await refresh();
    return true;
  };

  const handleRestoreOrchestrator = async (sessionId: string) => {
    const restored = await request(`/api/orchestrators/${sessionId}/restore`, {
      method: "POST",
    });
    if (!restored.ok) return false;
    setOpenConversationId(sessionId);
    await refresh();
    return true;
  };

  /**
   * Archives a task.
   *
   * Not `DELETE`, which would remove the record and contradict the one thing
   * the confirmation promises: that what the task learned stays readable. The
   * archive route stops any live worker, closes unfinished steps, and clears
   * the sessions away — the run, its phases, its steps and its notes remain.
   */
  const handleArchiveRun = async (runId: string) => {
    const archived = await request(`/api/runs/${runId}/archive`, { method: "POST" });
    if (!archived.ok) return false;
    await refresh();
    return true;
  };

  /** Puts a finished task back to work, with what is still wanted. */
  const handleReopenRun = async (runId: string, note: string) => {
    const reopened = await request(`/api/runs/${runId}/reopen`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
    if (!reopened.ok) return false;
    await refresh();
    return true;
  };

  /** Removes a finished task and the sessions it started. */
  const handleDeleteRun = async (runId: string) => {
    const deleted = await request(`/api/runs/${runId}`, { method: "DELETE" });
    if (!deleted.ok) return false;
    // Back to the board: the page this was opened from no longer has a task.
    setView("orchestrator");
    await refresh();
    return true;
  };

  /**
   * Opens a new task on the orchestrator.
   *
   * One call: the Host creates the run bound to the lead and briefs it in the
   * same request. Doing it as two calls from here would leave a run with no
   * orchestrator aware of it whenever the second one failed.
   */
  const handleCreateRun = async (input: {
    workspaceId: string;
    name: string;
    objective: string;
  }) => {
    if (!orchestrator || terminalSessionStates.has(orchestrator.state)) return false;
    const created = await request<{ run: { id: string } }>(
      `/api/orchestrators/${orchestrator.id}/runs`,
      { method: "POST", body: JSON.stringify(input) },
    );
    if (!created.ok) return false;
    await refresh();
    setSelectedRunId(created.data.run.id);
    setView("orchestrator-task");
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
          waitingPermissions={attentionCount}
          connected={connected}
          context={
            view === "orchestrator"
              ? {
                  kind: "orchestrator",
                  mode: orchestratorViewMode,
                  onChange: setOrchestratorViewMode,
                }
              : view === "session" || view === "overview"
                ? {
                    kind: "session",
                    mode: view === "overview" ? "overview" : "tree",
                    onChange: handleSessionLayoutChange,
                  }
                : { kind: "none" }
          }
          soundEnabled={delivery.soundEnabled}
          onToggleSound={delivery.toggleSound}
          notifications={snapshot.notifications}
          notificationUnreadCount={snapshot.notificationUnreadCount}
          browserNotificationsEnabled={delivery.browserEnabled}
          onToggleBrowserNotifications={delivery.toggleBrowser}
          onNavigateNotification={handleNotificationNavigate}
          onMarkNotificationRead={markNotificationRead}
          onMarkAllNotificationsRead={() => void markAllNotificationsRead()}
          onDismissAllNotifications={() => void dismissAllNotifications()}
          onDismissNotification={dismissNotification}
          onSignOut={() => void signOut()}
          onToggleNav={view === "overview" ? undefined : () => setNavOpen((on) => !on)}
          navOpen={navOpen}
          onToggleNavCollapsed={view === "overview" ? undefined : () => setNavCollapsed()}
          navCollapsed={navCollapsed}
          onShowAttention={
            orchestratorSummary.needsYou > 0
              ? () => setView("orchestrator")
              : waitingPermissions.length > 0
                ? () => {
                    setAttentionOnly(true);
                    setView("overview");
                  }
                : undefined
          }
        />
        <div className={styles.body}>
          {view === "overview" ? (
            <SessionGrid
              sessions={visibleSessions}
              workspaces={snapshot.workspaces}
              nodes={snapshot.nodes}
              placements={snapshot.placements}
              events={events}
              waitingPermissions={waitingPermissions}
              attentionOnly={attentionOnly}
              onAttentionOnlyChange={setAttentionOnly}
              orchestrator={{
                started: Boolean(orchestrator),
                summary: orchestratorSummary,
                onOpen: () => setView("orchestrator"),
              }}
              onOpen={handleSelectSession}
              onPermission={handlePermission}
              onNewSession={() => setDialogOpen(true)}
            />
          ) : (
            <>
              {navOpen && (
                <button
                  type="button"
                  className={styles.scrim}
                  aria-label="Close navigation"
                  onClick={() => setNavOpen(false)}
                />
              )}
              <div
                className={mergeClasses(
                  styles.navDrawer,
                  !navOpen && styles.navHidden,
                  navCollapsed && styles.navCollapsed,
                )}
              >
                <Sidebar
                  nodes={snapshot.nodes}
                  workspaces={snapshot.workspaces}
                  sessions={visibleSessions}
                  placements={snapshot.placements}
                  selectedSessionId={selectedSessionId}
                  view={view}
                  endedCount={endedCount}
                  liveWorkCount={
                    // What is happening plus what is waiting on the person: both
                    // are reasons to look, and a task handed over is the more
                    // urgent of the two.
                    liveSteps(orchestratorSteps).length +
                    tasksAwaitingHuman(orchestratorRuns).length
                  }
                  attentionCount={orchestratorSummary.needsYou}
                  leadSessions={orchestrators}
                  dismissedLeadSessions={dismissedOrchestrators}
                  waitingPermissions={waitingPermissions}
                  onSelectSession={handleSelectSession}
                  onSelectLeadSession={(sessionId) => {
                    // Opening a conversation is also choosing it: the task views
                    // above it show that conversation's work, not the newest.
                    setOpenConversationId(sessionId);
                    handleSelectSession(sessionId, { kind: "orchestrator" });
                    setNavOpen(false);
                  }}
                  onRestoreLeadSession={(sessionId) => {
                    void handleRestoreOrchestrator(sessionId);
                  }}
                  onNewConversation={() => {
                    void handleStartOrchestrator();
                    setNavOpen(false);
                  }}
                  onNewSession={() => setDialogOpen(true)}
                  onSelectView={(next) => {
                    setView(next);
                    setNavOpen(false);
                  }}
                  onClearEnded={() => void handleClearEnded()}
                />
              </div>

              {view === "orchestrator" &&
                (orchestrator ? (
                  <OrchestratorPage
                    conversation={orchestrator}
                    models={runModels}
                    summary={orchestratorSummary}
                    mode={orchestratorViewMode}
                    selectedRunId={selectedRunId}
                    onOpenRun={handleOpenRun}
                    onOpenLead={() =>
                      handleSelectSession(orchestrator.id, { kind: "orchestrator" })
                    }
                    onOpenWorker={(sessionId) =>
                      handleSelectSession(sessionId, { kind: "orchestrator" })
                    }
                    onNewRun={() => setOrchestrationDialogOpen(true)}
                    onStopOrchestrator={() =>
                      void handleStopOrchestrator(orchestrator.id)
                    }
                    onResumeOrchestrator={() =>
                      void handleResumeOrchestrator(orchestrator.id)
                    }
                    onDismissOrchestrator={() =>
                      void handleDismissOrchestrator(orchestrator.id)
                    }
                  />
                ) : (
                  <StartOrchestrator
                    canStart={snapshot.placements.some((placement) =>
                      snapshot.nodes.some(
                        (node) => node.id === placement.nodeId && node.online,
                      ),
                    )}
                    onStart={() => void handleStartOrchestrator()}
                  />
                ))}

              {view === "orchestrator-task" && selectedRunModel && orchestrator && (
                <OrchestratorTaskDetail
                  model={selectedRunModel}
                  notes={runNotes[selectedRunModel.run.id] ?? noNotes}
                  sessions={snapshot.sessions}
                  onBack={handleBackFromTask}
                  backLabel={taskOrigin ? "Conversation" : "All tasks"}
                  onOpenLead={() => {
                    // The conversation that owns this task, not whichever one
                    // happens to be open: on a board that shows every
                    // conversation's work, those are routinely different.
                    const owner = selectedRunModel.run.leadSessionId;
                    setOpenConversationId(owner);
                    handleSelectSession(owner, {
                      kind: "orchestrator-task",
                      runId: selectedRunModel.run.id,
                    });
                  }}
                  onOpenWorker={(sessionId) =>
                    handleSelectSession(sessionId, {
                      kind: "orchestrator-task",
                      runId: selectedRunModel.run.id,
                    })
                  }
                  onReview={(approved, note) =>
                    handleReviewTask(selectedRunModel.run.id, approved, note)
                  }
                  onArchive={() => handleArchiveRun(selectedRunModel.run.id)}
                  onReopen={(note) => handleReopenRun(selectedRunModel.run.id, note)}
                  onDelete={() => handleDeleteRun(selectedRunModel.run.id)}
                  onDismissFailure={() =>
                    setDismissedFailures((current) => ({
                      ...current,
                      [selectedRunModel.run.id]: readDismissedFailures(
                        selectedRunModel.run.id,
                      ),
                    }))
                  }
                />
              )}

              {view === "settings" && (
                <SettingsPanel
                  workspaces={snapshot.workspaces}
                  placements={snapshot.placements}
                  nodes={snapshot.nodes}
                  sessions={snapshot.sessions}
                  hostRevision={snapshot.hostRevision}
                  nodeUpdates={nodeUpdates}
                  selectedTab={settingsTab}
                  onSelectedTabChange={setSettingsTab}
                />
              )}

              {view === "session" &&
                (activeSession ? (
                  <>
                    <div className={styles.session}>
                      {(activeSession.runRole !== "" || returnContext) && (
                        <DispatchedBanner
                          session={activeSession}
                          step={orchestratorSteps.find(
                            (step) => step.sessionId === activeSession.id,
                          )}
                          runName={
                            returnContext?.kind === "orchestrator-task"
                              ? runModels.find(
                                  (model) => model.run.id === returnContext.runId,
                                )?.run.name
                              : undefined
                          }
                          onBack={handleBackFromSession}
                        />
                      )}
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
                        onStop={() =>
                          void (activeSession.runRole === "lead"
                            ? handleStopOrchestrator(activeSession.id)
                            : command(`/api/sessions/${activeSession.id}/stop`))
                        }
                        onDismiss={() =>
                          void (activeSession.runRole === "lead"
                            ? handleDismissOrchestrator(activeSession.id)
                            : handleDismissSession(activeSession.id))
                        }
                        onResume={() =>
                          void (activeSession.runRole === "lead"
                            ? handleResumeOrchestrator(activeSession.id)
                            : command(`/api/sessions/${activeSession.id}/resume`))
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
                        notificationPreferenceControl={
                          <LifecycleNotificationControl
                            preference={notificationPreference.preference}
                            loading={notificationPreference.loading}
                            onSet={notificationPreference.setLifecycleEnabled}
                            onReset={notificationPreference.reset}
                          />
                        }
                        draft={draftFor(drafts, activeSession.id)}
                        onDraftChange={(update) => changeDraft(activeSession.id, update)}
                      />
                    </div>
                    {activeSession.runRole === "lead" && (
                      <ConversationTasks
                        models={conversationModels}
                        open={tasksOpen}
                        selectedRunId={selectedRunId}
                        onToggle={() => setTasksOpen()}
                        onOpenRun={(runId) => handleOpenRun(runId, activeSession.id)}
                        onOpenWorker={(sessionId) =>
                          handleSelectSession(sessionId, { kind: "orchestrator" })
                        }
                        onNewRun={() => {
                          // The dialog briefs whichever conversation is open, so
                          // opening it from a thread has to make that thread the
                          // open one — otherwise the task lands on whichever
                          // conversation was last chosen elsewhere.
                          setOpenConversationId(activeSession.id);
                          setOrchestrationDialogOpen(true);
                        }}
                      />
                    )}
                  </>
                ) : (
                  <EmptySessions onNewSession={() => setDialogOpen(true)} />
                ))}
            </>
          )}
        </div>

        {view === "overview" && activeSession && (
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
            onStop={() =>
              void (activeSession.runRole === "lead"
                ? handleStopOrchestrator(activeSession.id)
                : command(`/api/sessions/${activeSession.id}/stop`))
            }
            onDismiss={() =>
              void (activeSession.runRole === "lead"
                ? handleDismissOrchestrator(activeSession.id)
                : handleDismissSession(activeSession.id))
            }
            onResume={() =>
              void (activeSession.runRole === "lead"
                ? handleResumeOrchestrator(activeSession.id)
                : command(`/api/sessions/${activeSession.id}/resume`))
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
            notificationPreferenceControl={
              <LifecycleNotificationControl
                preference={notificationPreference.preference}
                loading={notificationPreference.loading}
                onSet={notificationPreference.setLifecycleEnabled}
                onReset={notificationPreference.reset}
              />
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
        <CreateOrchestrationDialog
          open={orchestrationDialogOpen}
          workspaces={snapshot.workspaces}
          placements={eligiblePlacements}
          onOpenChange={setOrchestrationDialogOpen}
          onCreate={handleCreateRun}
        />
        <Toaster toasterId={toasterId} />
      </div>
    </CatalogProvider>
  );
}
