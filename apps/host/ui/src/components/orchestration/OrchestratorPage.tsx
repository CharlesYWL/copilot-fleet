import { Button, makeStyles, tokens } from "@fluentui/react-components";
import {
  isResumableSession,
  terminalRunStates,
  terminalSessionStates,
  type FleetSession,
} from "@fleet/protocol";
import type { OrchestratorViewMode } from "../navigation/ContextModeToggle";
import type { OrchestratorSummary, RunViewModel } from "../../lib/orchestration-view";
import { needsOrchestrator } from "../../lib/orchestration-view";
import { OrchestratorHeader } from "./OrchestratorHeader";
import { OrchestratorStageBoard } from "./OrchestratorStageBoard";
import { OrchestratorRunList } from "./OrchestratorRunList";
import { OrchestratorDependencyView } from "./OrchestratorDependencyView";

const useStyles = makeStyles({
  page: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: tokens.colorNeutralBackground1,
  },
  /*
   * The one place sideways scrolling is allowed. The board keeps four readable
   * columns, so on a narrow screen something has to give — but it gives here,
   * inside the task surface, and never at the page level.
   */
  surface: { flexGrow: 1, minHeight: 0, overflow: "auto", padding: "14px 20px 32px" },
  empty: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    padding: "40px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
  footer: {
    flexShrink: 0,
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "8px 20px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

export type OrchestratorPageProps = {
  conversation: FleetSession;
  models: RunViewModel[];
  summary: OrchestratorSummary;
  mode: OrchestratorViewMode;
  selectedRunId?: string | undefined;
  onOpenRun: (runId: string) => void;
  /**
   * Required, though a task may have no worker to open yet.
   *
   * Optional, this was omitted at the call site and the dependency view spent a
   * release rendering an enabled, hover-styled button that did nothing — the
   * only route from the graph to a worker's transcript.
   */
  onOpenWorker: (sessionId: string) => void;
  onOpenLead: () => void;
  onNewRun: () => void;
  activeAgentCount: number;
  onStopAgents: () => void;
  onStopOrchestrator: () => void;
  onResumeOrchestrator: () => void;
  onDismissOrchestrator: () => void;
  /** Hands this conversation's tasks to another one; absent when none can take them. */
  onTransferTasks?: (() => void) | undefined;
  onOpenCommands?: (() => void) | undefined;
  commandExecutionCount?: number;
};

/**
 * Everything the orchestrator has going on.
 *
 * Three arrangements of one list — the mode does not change what is shown, only
 * how it is grouped, and every one of them opens the same task detail. The rail
 * this replaced put a task's steps beside the conversation, which meant the
 * conversation was always the main thing even when the work was.
 */
export const OrchestratorPage = ({
  conversation,
  models,
  summary,
  mode,
  selectedRunId,
  onOpenRun,
  onOpenWorker,
  onOpenLead,
  onNewRun,
  activeAgentCount,
  onStopAgents,
  onStopOrchestrator,
  onResumeOrchestrator,
  onDismissOrchestrator,
  onTransferTasks,
  onOpenCommands,
  commandExecutionCount = 0,
}: OrchestratorPageProps) => {
  const styles = useStyles();
  const ended = terminalSessionStates.has(conversation.state);
  const stopping = Boolean(conversation.stopRequested);
  /*
   * Only this conversation's tasks, and only to decide whether it can be
   * dismissed. The board shows every conversation's work, and Stop no longer
   * ends a lead's tasks, so neither is a reason to keep offering Stop to a lead
   * that has already stopped instead of the Resume it needs.
   */
  const hasActiveWork = models.some(
    (model) =>
      model.run.leadSessionId === conversation.id &&
      (!terminalRunStates.has(model.run.state) || (model.stoppingSteps ?? 0) > 0),
  );
  const unhanded = models.filter(
    (model) => model.run.leadSessionId === conversation.id && needsOrchestrator(model),
  );
  const resumable = isResumableSession(conversation) && !stopping;

  return (
    <section className={styles.page} aria-label="Orchestrator">
      <OrchestratorHeader
        summary={summary}
        canCreateRun={!ended && !stopping}
        onNewRun={onNewRun}
        onOpenLead={onOpenLead}
      />

      {models.length === 0 ? (
        <div className={styles.empty}>
          <p>
            {ended
              ? "This orchestrator conversation is stopped. Resume it to continue, or dismiss it when you no longer need the transcript."
              : "Nothing dispatched yet. Ask the orchestrator for something in its conversation, or open a task here and it will plan the phases itself."}
          </p>
          <Button appearance="primary" disabled={ended || stopping} onClick={onNewRun}>
            New task
          </Button>
        </div>
      ) : (
        <div className={styles.surface}>
          {mode === "stage" && (
            <OrchestratorStageBoard
              models={models}
              selectedRunId={selectedRunId}
              onOpenRun={onOpenRun}
              onOpenWorker={onOpenWorker}
            />
          )}
          {mode === "list" && (
            <OrchestratorRunList
              models={models}
              selectedRunId={selectedRunId}
              onOpenRun={onOpenRun}
              onOpenWorker={onOpenWorker}
            />
          )}
          {mode === "dependency" && (
            <OrchestratorDependencyView
              models={models}
              selectedRunId={selectedRunId}
              onOpenRun={onOpenRun}
              onOpenStep={(_runId, sessionId) => onOpenWorker(sessionId)}
            />
          )}
        </div>
      )}

      <div className={styles.footer}>
        {onOpenCommands && (
          <Button size="small" onClick={onOpenCommands}>
            Commands ({commandExecutionCount})
          </Button>
        )}
        {onTransferTasks && unhanded.length > 0 && (
          <Button
            size="small"
            appearance="subtle"
            onClick={onTransferTasks}
            title="Hand this orchestrator's open and PR-maintaining tasks to another conversation, for example when its context is full"
          >
            Transfer tasks ({unhanded.length})
          </Button>
        )}
        {activeAgentCount > 0 && (
          <Button
            size="small"
            appearance="subtle"
            onClick={onStopAgents}
            title="Stop every worker and reviewer owned by this orchestrator"
          >
            Stop agents ({activeAgentCount})
          </Button>
        )}
        {ended && !stopping ? (
          <>
            {resumable && (
              <Button size="small" appearance="primary" onClick={onResumeOrchestrator}>
                Resume orchestrator
              </Button>
            )}
            {!hasActiveWork && (
              <Button size="small" appearance="secondary" onClick={onDismissOrchestrator}>
                Dismiss orchestrator
              </Button>
            )}
          </>
        ) : (
          <Button
            size="small"
            appearance="subtle"
            disabled={stopping && conversation.state !== "offline"}
            onClick={onStopOrchestrator}
            {...(stopping
              ? {}
              : {
                  title:
                    "Stop this orchestrator's conversation. Its tasks and agents keep running.",
                })}
          >
            {stopping
              ? conversation.state === "offline"
                ? "Mark orchestrator stopped"
                : "Stopping orchestrator"
              : "Stop orchestrator"}
          </Button>
        )}
      </div>
    </section>
  );
};
