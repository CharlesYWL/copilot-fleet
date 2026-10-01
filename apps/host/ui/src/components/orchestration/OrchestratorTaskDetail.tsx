import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Link,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  ArrowCounterclockwise20Regular,
  ArrowForward20Regular,
  Chat20Regular,
  Delete20Regular,
  Info20Regular,
  Open16Regular,
} from "@fluentui/react-icons";
import {
  prMaintenanceEvidenceCurrentUntil,
  prMaintenanceUrl,
  type FleetSession,
  type RunNote,
  type RunStep,
} from "@fleet/protocol";
import type { RunViewModel } from "../../lib/orchestration-view";
import { currentPhase } from "../../lib/orchestration-view";
import {
  blockedReview,
  currentMaintenance,
  latestReviewNote,
  taskOverview,
} from "../../lib/task-overview";
import type {
  MaintenanceReviewReference,
  TaskMaintenanceView,
} from "../../lib/pr-maintenance";
import { semanticColors, statusVisuals, terminal } from "../../theme";
import { MarkdownBody } from "../MarkdownBody";
import { RunStatusIndicator } from "./RunStatusIndicator";
import { WorkerStepTimeline } from "./WorkerStepTimeline";
import { ManagedWorktreePanel } from "./ManagedWorktreePanel";
import { PrMaintenancePanel } from "./PrMaintenancePanel";
import { TaskWorkflowHistory } from "./TaskWorkflowHistory";

const useStyles = makeStyles({
  page: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  head: {
    flexShrink: 0,
    padding: "16px 24px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  crumbRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    marginBottom: "12px",
  },
  crumb: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "11px",
  },
  actions: { display: "flex", gap: "4px", flexWrap: "wrap", marginLeft: "auto" },
  titleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
  },
  title: {
    margin: 0,
    fontSize: "22px",
    lineHeight: "1.3",
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "-0.02em",
    overflowWrap: "anywhere",
  },
  status: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
  },
  body: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "24px",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  content: { maxWidth: "1320px", marginInline: "auto", display: "grid", gap: "20px" },
  overview: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "20px",
    padding: "24px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "12px",
    backgroundColor: tokens.colorNeutralBackground1,
    "@media (max-width: 760px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  attention: {
    borderLeft: `3px solid ${semanticColors.permission}`,
    paddingLeft: "22px",
  },
  eyebrow: {
    margin: "0 0 8px",
    fontSize: "10px",
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: tokens.colorNeutralForeground3,
  },
  overviewTitle: {
    margin: 0,
    fontSize: "28px",
    lineHeight: "1.2",
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "-0.03em",
    overflowWrap: "anywhere",
  },
  overviewSummary: {
    margin: "10px 0 0",
    fontSize: "14px",
    lineHeight: "1.6",
    maxWidth: "740px",
    color: tokens.colorNeutralForeground2,
    overflowWrap: "anywhere",
  },
  split: {
    display: "flex",
    flexWrap: "wrap",
    gap: "20px",
    alignItems: "flex-start",
  },
  unsplit: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" },
  maintenanceColumn: { flexGrow: 1.55, flexShrink: 1, flexBasis: "400px", minWidth: 0 },
  inactiveMaintenance: { order: 2 },
  work: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "260px",
    minWidth: 0,
    padding: "20px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "12px",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  workHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginBottom: "16px",
  },
  sectionTitle: { margin: 0, fontSize: "14px", fontWeight: tokens.fontWeightSemibold },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  detailsSection: { marginBlock: "20px" },
  detailHeading: {
    margin: "0 0 10px",
    fontSize: "14px",
    fontWeight: tokens.fontWeightSemibold,
  },
  phases: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    listStyleType: "none",
    padding: 0,
    margin: 0,
  },
  phase: {
    padding: "8px 10px",
    borderRadius: "6px",
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: "12px",
  },
  phaseNow: { borderLeft: `2px solid ${semanticColors.interaction}` },
  phaseDone: { color: semanticColors.completed },
  phaseState: {
    display: "block",
    color: tokens.colorNeutralForeground3,
    fontSize: "10px",
    marginTop: "4px",
  },
  criteria: {
    listStyleType: "none",
    padding: 0,
    margin: 0,
    display: "grid",
    gap: "10px",
  },
  criterion: {
    padding: "12px",
    borderRadius: "8px",
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: "12px",
    lineHeight: "1.6",
  },
  evidence: { display: "block", color: tokens.colorNeutralForeground3 },
  optional: {
    marginLeft: "6px",
    color: tokens.colorNeutralForeground3,
    fontSize: "10px",
  },
  report: {
    marginBlock: "12px",
    "& summary": { cursor: "pointer", color: tokens.colorNeutralForeground2 },
    "& summary:focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "3px",
    },
  },
  reportBody: {
    marginTop: "12px",
    maxHeight: "min(36vh, 360px)",
    overflowY: "auto",
    padding: "12px 16px",
    borderRadius: "8px",
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: "13px",
    overflowWrap: "anywhere",
  },
  dialogSummary: {
    margin: "0 0 12px",
    color: tokens.colorNeutralForeground2,
    lineHeight: "1.6",
  },
  decision: {
    borderLeft: `3px solid ${semanticColors.permission}`,
    padding: "8px 12px",
    whiteSpace: "pre-wrap",
    maxHeight: "28vh",
    overflowY: "auto",
    overflowWrap: "anywhere",
  },
  error: { color: statusVisuals.danger.foreground },
});

export type OrchestratorTaskDetailProps = {
  model: RunViewModel;
  notes: RunNote[];
  sessions: readonly FleetSession[];
  snapshotRevision?: number;
  onBack: () => void;
  backLabel?: string;
  /** The conversation the task is assigned to, as the operator knows it. */
  ownerLabel?: string | undefined;
  onOpenLead: () => void;
  /** Hands the task to another orchestrator conversation. */
  onTransfer?: (() => void) | undefined;
  onOpenWorker: (sessionId: string) => void;
  /** "Resume now" for a queued follow-up; the Host decides whether approval is needed. */
  onResumeNow?: ((step: RunStep) => Promise<unknown> | void) | undefined;
  onReviewApproval?: ((requestId: string) => void) | undefined;
  onReview: (
    approved: boolean,
    note: string,
    maintenance?: MaintenanceReviewReference,
  ) => Promise<boolean>;
  onArchive: () => Promise<boolean>;
  onReopen: (note: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onDismissFailure?: () => void;
};

type ReviewContext = {
  taskId: string;
  reviewSeq: number;
  reportId: string | undefined;
  body: string;
  summary: string;
  blocked: boolean;
  reference: MaintenanceReviewReference | undefined;
  proposal: string;
};

export const OrchestratorTaskDetail = ({
  model,
  notes,
  sessions,
  snapshotRevision = 0,
  onBack,
  backLabel = "All tasks",
  ownerLabel,
  onOpenLead,
  onTransfer,
  onOpenWorker,
  onResumeNow,
  onReviewApproval,
  onReview,
  onArchive,
  onReopen,
  onDelete,
  onDismissFailure,
}: OrchestratorTaskDetailProps) => {
  const styles = useStyles();
  const restoreFocusTarget = useRestoreFocusTarget();
  const { run } = model;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewContext, setReviewContext] = useState<ReviewContext>();
  const [reopenNote, setReopenNote] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [freshnessRevision, setFreshnessRevision] = useState(0);
  const nowMs = Date.now();
  const [maintenanceState, setMaintenanceState] = useState<{
    taskId: string;
    view: TaskMaintenanceView | undefined;
  }>();
  const onMaintenanceChange = useCallback(
    (view: TaskMaintenanceView | undefined) => {
      setMaintenanceState({ taskId: run.id, view });
    },
    [run.id],
  );
  const maintenance =
    maintenanceState?.taskId === run.id ? maintenanceState.view : undefined;

  const record = currentMaintenance(maintenance?.records ?? []);
  const observedAt = record?.observationHostAt ?? record?.observation?.attemptedAt;
  const currentUntil = record ? prMaintenanceEvidenceCurrentUntil(record) : undefined;
  useEffect(() => {
    if (!observedAt || currentUntil === undefined) return;
    const observed = Date.parse(observedAt);
    const now = Date.now();
    const nextBoundary = observed > now ? observed : currentUntil + 1;
    const delay = nextBoundary - now;
    if (!Number.isFinite(delay) || delay <= 0) return;
    // Evidence can expire without a socket update; re-render at that boundary, not on a poll.
    const timer = window.setTimeout(
      () => setFreshnessRevision((value) => value + 1),
      Math.min(delay, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [observedAt, currentUntil, freshnessRevision]);
  const maintenanceHold = maintenance?.records.find(
    (entry) =>
      entry.taskId === run.id &&
      !entry.ownershipReleasedAt &&
      entry.decision?.state === "pending",
  );
  const maintenanceReference = maintenanceHold?.decision
    ? {
        recordId: maintenanceHold.id,
        expectedVersion: maintenanceHold.version,
        decisionId: maintenanceHold.decision.id,
        decisionVersion: maintenanceHold.decision.version,
      }
    : undefined;
  const report = latestReviewNote(notes);
  const overview = taskOverview(model, notes, maintenance, nowMs);
  const finished = ["completed", "cancelled", "failed"].includes(run.state);
  const needsReview = run.state === "awaiting_human" || Boolean(maintenanceHold);
  const reviewChanged = Boolean(
    reviewContext &&
    (reviewContext.taskId !== run.id ||
      reviewContext.reviewSeq !== run.reviewSeq ||
      reviewContext.reportId !== report?.id ||
      JSON.stringify(reviewContext.reference) !== JSON.stringify(maintenanceReference) ||
      reviewContext.proposal !== (maintenanceHold?.decision?.proposal ?? "")),
  );
  const reviewUnavailable = !maintenance || Boolean(maintenance.statusError);

  const openReview = () => {
    setReviewContext({
      taskId: run.id,
      reviewSeq: run.reviewSeq,
      reportId: report?.id,
      body: report?.body ?? "",
      summary: overview.summary,
      blocked: blockedReview(report),
      reference: maintenanceReference,
      proposal: maintenanceHold?.decision?.proposal ?? "",
    });
    setNote("");
    setActionError("");
    setReviewOpen(true);
  };
  const answer = async (approved: boolean) => {
    if (busy || reviewChanged || reviewUnavailable || !reviewContext || actionError)
      return;
    if (reviewContext.reference && (approved || !maintenance?.canAuthorize)) return;
    setBusy(true);
    try {
      const ok = reviewContext.reference
        ? await onReview(false, note.trim(), reviewContext.reference)
        : await onReview(approved, note.trim());
      if (ok) {
        setReviewOpen(false);
        setNote("");
      } else {
        setActionError(
          "The decision could not be confirmed. Refresh the task before retrying.",
        );
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "The decision could not be confirmed.",
      );
    } finally {
      setBusy(false);
    }
  };
  const phaseState = (index: number) => {
    if (index < run.phaseIndex) return "Complete";
    if (index > run.phaseIndex)
      return finished || run.state === "awaiting_human" ? "Not reached" : "Planned";
    if (run.state === "completed" && run.phaseIndex >= run.phases.length - 1)
      return "Complete";
    if (finished) return "Stopped here";
    return run.state === "awaiting_human" ? "Waiting here" : "Current";
  };

  return (
    <section className={styles.page} aria-label={`Task ${run.name}`}>
      <header className={styles.head}>
        <div className={styles.crumbRow}>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowLeft20Regular />}
            onClick={onBack}
          >
            {backLabel}
          </Button>
          <span className={styles.crumb}>
            {ownerLabel || "Orchestrator"}
            {currentPhase(run) ? ` / ${currentPhase(run)}` : ""}
          </span>
          <div className={styles.actions}>
            <Button
              size="small"
              appearance="subtle"
              icon={<Chat20Regular />}
              {...(ownerLabel
                ? {
                    title: `Open ${ownerLabel}, the conversation this task is assigned to`,
                  }
                : {})}
              onClick={onOpenLead}
            >
              Conversation
            </Button>
            {onTransfer && (
              <Button
                {...restoreFocusTarget}
                size="small"
                appearance="subtle"
                icon={<ArrowForward20Regular />}
                title="Hand this task to another orchestrator conversation"
                onClick={onTransfer}
              >
                Transfer
              </Button>
            )}
            <Button
              {...restoreFocusTarget}
              size="small"
              appearance="subtle"
              icon={<Info20Regular />}
              onClick={() => setDetailsOpen(true)}
            >
              Task details
            </Button>
          </div>
        </div>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{run.name}</h1>
          <span className={styles.status}>
            Task:
            <RunStatusIndicator
              model={model}
              dismissible
              {...(onDismissFailure ? { onDismissFailure } : {})}
            />
          </span>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.content}>
          <section
            className={mergeClasses(
              styles.overview,
              overview.attention && styles.attention,
            )}
            aria-label="Current task stage"
          >
            <div>
              <p className={styles.eyebrow}>
                {overview.attention
                  ? "Needs your attention"
                  : currentPhase(run) || "Current stage"}
              </p>
              <h2 className={styles.overviewTitle}>{overview.title}</h2>
              <p className={styles.overviewSummary}>{overview.summary}</p>
            </div>
            {needsReview ? (
              <Button {...restoreFocusTarget} appearance="primary" onClick={openReview}>
                {maintenanceHold || blockedReview(report)
                  ? "Review decision"
                  : "Review result"}
              </Button>
            ) : model.attentionSessionId ? (
              <Button
                appearance="primary"
                onClick={() => onOpenWorker(model.attentionSessionId)}
              >
                Review permission
              </Button>
            ) : model.attention === "workspace-setup" ||
              model.attention === "integration" ? (
              <Button
                {...restoreFocusTarget}
                appearance="primary"
                onClick={() => setDetailsOpen(true)}
              >
                Review workspace
              </Button>
            ) : record ? (
              <Link
                href={prMaintenanceUrl(record.identity)}
                target="_blank"
                rel="noreferrer"
              >
                View PR <Open16Regular aria-hidden />
              </Link>
            ) : null}
          </section>

          <div
            className={mergeClasses(styles.split, !record && styles.unsplit)}
            data-layout="split"
          >
            <div
              className={mergeClasses(
                styles.maintenanceColumn,
                !record && styles.inactiveMaintenance,
              )}
            >
              <PrMaintenancePanel
                key={run.id}
                run={run}
                sessions={sessions}
                onChange={onMaintenanceChange}
                snapshotRevision={snapshotRevision}
                compact
                nowMs={nowMs}
              />
            </div>
            <section className={styles.work} aria-label="Dispatched work">
              <div className={styles.workHead}>
                <h2 className={styles.sectionTitle}>Dispatched work</h2>
                <span className={styles.meta}>
                  {model.steps.length}{" "}
                  {model.steps.length === 1 ? "work item" : "work items"}
                </span>
              </div>
              <WorkerStepTimeline
                awaitingPermissionSessionId={model.attentionSessionId}
                steps={model.steps}
                phases={run.phases}
                sessions={sessions}
                onOpenWorker={onOpenWorker}
                onResumeNow={onResumeNow}
                onReviewApproval={onReviewApproval}
              />
            </section>
          </div>

          <TaskWorkflowHistory
            key={run.id}
            notes={notes}
            phases={run.phases}
            sessions={sessions}
            onOpenWorker={onOpenWorker}
          />
        </div>
      </div>

      <Dialog
        open={reviewOpen}
        onOpenChange={(_, data) => !busy && setReviewOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {reviewContext?.reference
                ? "Direct PR maintenance"
                : reviewContext?.blocked
                  ? "Review decision"
                  : "Review task"}
            </DialogTitle>
            <DialogContent>
              {reviewChanged ? (
                <p role="alert" className={styles.error}>
                  This decision or task changed. Close this dialog and review the current
                  version before sending instructions.
                </p>
              ) : null}
              {reviewUnavailable ? (
                <p role="status">
                  Current maintenance status is needed before recording a decision.
                  Refresh maintenance status if it cannot be loaded.
                </p>
              ) : null}
              {actionError ? (
                <p role="alert" className={styles.error}>
                  {actionError}
                </p>
              ) : null}
              <p className={styles.dialogSummary}>{reviewContext?.summary}</p>
              {reviewContext?.reference ? (
                <>
                  <p className={styles.decision}>{reviewContext.proposal}</p>
                  <p>
                    Task approval cannot authorize this design change. Your direction
                    applies only to this exact proposal; it does not resume a stopped
                    worker, resolve defects, or merge the PR.
                  </p>
                </>
              ) : null}
              {reviewContext?.body ? (
                <details className={styles.report} open={!report?.summary || undefined}>
                  <summary>Full report and evidence</summary>
                  <div className={styles.reportBody}>
                    <MarkdownBody text={reviewContext.body} copyable />
                  </div>
                </details>
              ) : null}
              <Field
                label="What needs changing?"
                hint={
                  reviewContext?.reference
                    ? "Name the chosen approach and its limits. Changed assumptions need a new decision."
                    : "Guidance goes to the existing Orchestrator. It is required when sending work back."
                }
              >
                <Textarea
                  value={note}
                  rows={3}
                  disabled={busy || reviewChanged}
                  onChange={(_, data) => setNote(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setReviewOpen(false)}>
                Cancel
              </Button>
              {!reviewContext?.reference ? (
                <Button
                  appearance={reviewContext?.blocked ? "secondary" : "primary"}
                  disabled={
                    busy || reviewChanged || reviewUnavailable || Boolean(actionError)
                  }
                  onClick={() => void answer(true)}
                >
                  {reviewContext?.blocked ? "Accept incomplete result" : "Approve"}
                </Button>
              ) : null}
              <Button
                appearance={
                  reviewContext?.blocked || reviewContext?.reference
                    ? "primary"
                    : "secondary"
                }
                disabled={
                  busy ||
                  reviewChanged ||
                  reviewUnavailable ||
                  Boolean(actionError) ||
                  !note.trim() ||
                  Boolean(reviewContext?.reference && !maintenance?.canAuthorize)
                }
                onClick={() => void answer(false)}
              >
                {reviewContext?.reference ? "Send back with instructions" : "Send back"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={detailsOpen} onOpenChange={(_, data) => setDetailsOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Task details</DialogTitle>
            <DialogContent>
              {run.objective ? (
                <p className={styles.dialogSummary}>{run.objective}</p>
              ) : null}
              <ManagedWorktreePanel run={run} />
              {run.phases.length ? (
                <section className={styles.detailsSection}>
                  <h3 className={styles.detailHeading}>Phases</h3>
                  <ol className={styles.phases}>
                    {run.phases.map((phase, index) => (
                      <li
                        key={`${index}:${phase}`}
                        className={mergeClasses(
                          styles.phase,
                          index < run.phaseIndex && styles.phaseDone,
                          index === run.phaseIndex && styles.phaseNow,
                        )}
                      >
                        {phase}
                        <span className={styles.phaseState}>{phaseState(index)}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {run.successCriteria.length ? (
                <section className={styles.detailsSection}>
                  <h3 className={styles.detailHeading}>What done means</h3>
                  {run.stopWhen ? <p>Finished when {run.stopWhen}</p> : null}
                  <ul className={styles.criteria}>
                    {run.successCriteria.map((criterion) => (
                      <li className={styles.criterion} key={criterion.id}>
                        {criterion.scenario}
                        {!criterion.essential ? (
                          <span className={styles.optional}>optional</span>
                        ) : null}
                        <span className={styles.evidence}>
                          shown by {criterion.expectedEvidence}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </DialogContent>
            <DialogActions>
              {finished ? (
                <>
                  <Button
                    {...restoreFocusTarget}
                    appearance="subtle"
                    icon={<ArrowCounterclockwise20Regular />}
                    disabled={Boolean(maintenanceHold)}
                    onClick={() => {
                      setDetailsOpen(false);
                      setReopenOpen(true);
                    }}
                  >
                    Reopen
                  </Button>
                  <Button
                    {...restoreFocusTarget}
                    appearance="subtle"
                    icon={<Delete20Regular />}
                    onClick={() => {
                      setDetailsOpen(false);
                      setDeleteOpen(true);
                    }}
                  >
                    Delete
                  </Button>
                </>
              ) : (
                <Button
                  {...restoreFocusTarget}
                  appearance="subtle"
                  onClick={() => {
                    setDetailsOpen(false);
                    setArchiveOpen(true);
                  }}
                >
                  Archive
                </Button>
              )}
              <Button onClick={() => setDetailsOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={archiveOpen}
        onOpenChange={(_, data) => !busy && setArchiveOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Archive “{run.name}”?</DialogTitle>
            <DialogContent>
              <p>
                Any worker still running for this task is stopped. Linked PR maintenance
                is paused; cancellation and remote effects may still need reconciliation.
              </p>
              <p>
                The task keeps its phases, steps, notes and everything they produced.
                Reopen it to resume an existing worker conversation.
              </p>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setArchiveOpen(false)}>
                Keep going
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onArchive()
                    .then((ok) => {
                      if (ok) setArchiveOpen(false);
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Archive task
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={reopenOpen}
        onOpenChange={(_, data) => !busy && setReopenOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Reopen “{run.name}”?</DialogTitle>
            <DialogContent>
              <Field
                label="What is still wanted?"
                hint="The Orchestrator keeps this task's criteria, notes and existing workers."
              >
                <Textarea
                  value={reopenNote}
                  disabled={busy}
                  resize="vertical"
                  onChange={(_, data) => setReopenNote(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setReopenOpen(false)}>
                Leave it closed
              </Button>
              <Button
                appearance="primary"
                disabled={busy || !reopenNote.trim()}
                onClick={() => {
                  setBusy(true);
                  void onReopen(reopenNote.trim())
                    .then((ok) => {
                      if (ok) {
                        setReopenOpen(false);
                        setReopenNote("");
                      }
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Reopen task
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(_, data) => !busy && setDeleteOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete “{run.name}”?</DialogTitle>
            <DialogContent>
              <p>
                The task goes, along with its phases, steps, notes and the sessions it
                started. Nothing about it is kept.
              </p>
              <p>
                Archive instead if the record is worth keeping. Retained PR ownership or
                unsettled effects block deletion until explicitly released.
              </p>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setDeleteOpen(false)}>
                Keep it
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onDelete()
                    .then((ok) => {
                      if (ok) setDeleteOpen(false);
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Delete task
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
};
