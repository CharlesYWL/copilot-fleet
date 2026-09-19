import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Link,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  prMaintenanceProgress,
  parsePrMaintenanceUrl,
  prMaintenanceProviderLabel,
  prMaintenanceUrl,
  type FleetSession,
  type PrMaintenanceRegistration,
  type PrMaintenanceProposal,
  type PrMaintenanceStage,
  type Run,
} from "@fleet/protocol";
import {
  actOnTaskMaintenance,
  authorizeTaskMaintenanceProposal,
  getTaskMaintenance,
  prepareTaskMaintenance,
  type TaskMaintenanceView,
} from "../../lib/pr-maintenance";

const useStyles = makeStyles({
  panel: {
    padding: tokens.spacingHorizontalL,
    marginBottom: "22px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    overflowWrap: "anywhere",
    "& h2": { marginTop: 0, fontSize: tokens.fontSizeBase500 },
    "& h3": { fontSize: tokens.fontSizeBase400, marginBlock: tokens.spacingVerticalM },
  },
  muted: { color: tokens.colorNeutralForeground2 },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    marginBlock: tokens.spacingVerticalM,
  },
  metadata: {
    display: "grid",
    gridTemplateColumns: "minmax(90px, 140px) minmax(0, 1fr)",
    gap: tokens.spacingVerticalS,
    "& dt": { color: tokens.colorNeutralForeground2 },
    "& dd": { margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
    "@media (max-width: 480px)": { gridTemplateColumns: "1fr" },
  },
  rail: {
    listStyleType: "none",
    padding: 0,
    marginBlock: tokens.spacingVerticalL,
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
  },
  stage: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `2px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  currentStage: {
    borderBottomColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  attention: {
    borderLeft: `3px solid ${tokens.colorPaletteMarigoldBorderActive}`,
    paddingLeft: tokens.spacingHorizontalM,
  },
  details: {
    marginBlock: tokens.spacingVerticalM,
    "& summary": { cursor: "pointer", color: tokens.colorNeutralForeground2 },
    "& summary:focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  historyJob: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    marginTop: tokens.spacingVerticalM,
    paddingTop: tokens.spacingVerticalS,
  },
  error: { color: tokens.colorPaletteRedForeground1 },
});

const stageLabels: Record<PrMaintenanceStage, string> = {
  released: "Released",
  merged: "Merged",
  closed: "Closed",
  human_hold: "Needs human direction",
  reconciling: "Reconciling unknown effects",
  paused: "Paused",
  recovering: "Recovering access",
  blocked: "Blocked",
  checking: "Awaiting current evidence",
  addressing_review: "Addressing feedback",
  triage: "Triaging feedback",
  waiting_checks: "Waiting for checks",
  waiting_review: "Waiting for review",
  ready: "Ready · not merged",
} as const;

const nextActions: Record<PrMaintenanceStage, string> = {
  released: "No further maintenance. Start a new proposal to maintain another PR.",
  merged: "No further repairs. Release ownership after all work settles.",
  closed: "No further repairs. Release ownership after all work settles.",
  human_hold: "Send back with instructions to resolve the design decision.",
  reconciling: "Reconcile pending work and effects before any further changes.",
  paused: "Review the pause reason before resuming maintenance.",
  recovering:
    "Try a bounded alternate observation path; no repairs until evidence is complete.",
  blocked: "Resolve the blocker and collect a complete, current observation.",
  checking: "Collect a complete, current observation of the PR.",
  addressing_review: "Finish the retained worker batch, then verify its changes.",
  triage: "Review new feedback against the authorized scope.",
  waiting_checks: "Wait for checks, then observe the current PR again.",
  waiting_review: "Wait for review, then observe the current PR again.",
  ready: "Monitor new commits and feedback. Merging remains a human action.",
};

function stageLabel(stage: PrMaintenanceStage, record: PrMaintenanceRegistration) {
  if (stage === "blocked") {
    const incident = record.incidents.find((entry) => !entry.resolvedAt);
    if (incident?.kind === "provider_denial") return "Provider access denied";
    if (incident?.kind === "identity") return "Identity mismatch";
    if (incident?.kind === "capability") return "Recovery limit reached";
    if (record.lastAttempt?.draft) return "Draft PR";
    if (record.lastAttempt?.mergeability === "conflicting") return "Merge conflict";
    if (record.lastAttempt?.failure || !record.lastAttempt?.complete)
      return "Check incomplete";
  }
  return stageLabels[stage];
}

function attentionReason(record: PrMaintenanceRegistration, stage: PrMaintenanceStage) {
  if (["merged", "closed"].includes(record.lifecycle) && hasOutstandingWork(record))
    return "The PR is terminal, but work or effects remain unsettled. Ownership is retained until reconciliation completes.";
  if (stage === "reconciling")
    return "Effects are not yet known. Do not repeat the action or release ownership.";
  if (record.pauseReason) return record.pauseReason;
  if (stage === "recovering")
    return "The normal observation path is unavailable. Recovery is bounded.";
  if (stage !== "blocked") return undefined;
  const incident = record.incidents.find((entry) => !entry.resolvedAt);
  if (incident?.kind === "provider_denial")
    return "The provider denied access. Restore the existing authorized access before continuing.";
  if (incident?.kind === "identity")
    return "Provider evidence does not match the authorized PR. Human review is required.";
  if (incident?.kind === "capability")
    return "Bounded recovery attempts are exhausted. Review the last error before continuing.";
  if (record.lastAttempt?.draft)
    return "Draft PRs are not ready for maintenance repairs.";
  if (record.lastAttempt?.mergeability === "conflicting")
    return "The PR conflicts with its base branch.";
  return "The latest check is incomplete or failed; historical success is not current validation.";
}

const batchStates = {
  prepared: "prepared, not dispatched",
  accepted: "in progress",
  reconciling: "awaiting reconciliation",
  uncertain: "has unknown effects",
  succeeded: "completed",
  partial: "partially completed",
  failed: "failed",
  cancelled: "cancelled",
  superseded: "superseded",
};

function checkTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const loopStages = [
  "triage",
  "addressing_review",
  "waiting_checks",
  "waiting_review",
  "ready",
] as const;

const readOnlyNotice =
  "No repairs, pushes, replies, thread resolution, reviewer requests or CI retries are authorized.";

function hasOutstandingWork(record: PrMaintenanceRegistration) {
  return (
    record.incidents.some(
      (incident) => incident.kind === "effects" && !incident.resolvedAt,
    ) ||
    record.batches.some(
      (batch) =>
        ["prepared", "accepted", "reconciling", "uncertain"].includes(batch.state) ||
        (Boolean(batch.stepId) && !batch.executionSettled) ||
        batch.effects.some((effect) => ["reserved", "uncertain"].includes(effect.state)),
    ) ||
    record.actions.some((action) => ["reserved", "uncertain"].includes(action.state))
  );
}

function PrLink({ record }: { record: Pick<PrMaintenanceRegistration, "identity"> }) {
  return (
    <Link href={prMaintenanceUrl(record.identity)} target="_blank" rel="noreferrer">
      {record.identity.repository} #{record.identity.prNumber}
    </Link>
  );
}

export function PrMaintenancePanel({
  run,
  sessions,
  onChange,
  snapshotRevision = 0,
}: {
  run: Run;
  sessions: readonly FleetSession[];
  onChange: (view: TaskMaintenanceView | undefined) => void;
  snapshotRevision?: number;
}) {
  const styles = useStyles();
  const [view, setView] = useState<TaskMaintenanceView>();
  const loadedTaskId = useRef<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [prUrl, setPrUrl] = useState("");
  const [proposal, setProposal] = useState<PrMaintenanceProposal>();
  const [confirmed, setConfirmed] = useState(false);
  const [release, setRelease] = useState<PrMaintenanceRegistration>();
  const [renew, setRenew] = useState<PrMaintenanceRegistration>();
  const [releaseReason, setReleaseReason] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    if (loadedTaskId.current !== run.id) {
      setView(undefined);
      setProposal(undefined);
      setRelease(undefined);
      setRenew(undefined);
      setConfirmed(false);
      setMessage("");
      setPrUrl("");
      onChange(undefined);
    }
    void getTaskMaintenance(run.id)
      .then((next) => {
        if (!active) return;
        loadedTaskId.current = run.id;
        setView(next);
        onChange(next);
        setError("");
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "Maintenance status unavailable.",
          );
      });
    return () => {
      active = false;
    };
  }, [run.id, run.updatedAt, refreshKey, snapshotRevision, onChange]);

  const execute = async (
    action: () => Promise<unknown>,
    successMessage = "Maintenance action recorded.",
  ) => {
    if (busy || !view?.canAuthorize) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setProposal(undefined);
      setRelease(undefined);
      setRenew(undefined);
      setConfirmed(false);
      setMessage(successMessage);
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Maintenance action failed.");
      // A failed approval must be reviewed again, never silently replayed.
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  };

  const records = view?.records ?? [];
  const current = records.find(
    (record) =>
      !record.ownershipReleasedAt &&
      (["active", "paused"].includes(record.lifecycle) || hasOutstandingWork(record)),
  );
  const history = records.filter((record) => record !== current);
  const retained = records.some((record) => !record.ownershipReleasedAt);
  const currentProgress = current ? prMaintenanceProgress(current) : undefined;
  const displayedScope =
    current?.authorization.scope ?? view?.proposal?.registration.scope;
  const readOnly = displayedScope && !displayedScope.publicationAuthorized;
  const latestBatch = current?.batches.reduce<
    PrMaintenanceRegistration["batches"][number] | undefined
  >(
    (latest, batch) => (!latest || batch.updatedAt >= latest.updatedAt ? batch : latest),
    undefined,
  );
  const attention =
    current && currentProgress
      ? attentionReason(current, currentProgress.stage)
      : undefined;
  const candidate = proposal?.registration;
  const candidateWorker = sessions.find(
    (entry) => entry.id === candidate?.workerSessionId,
  );
  const proposalMatchesTask =
    candidate?.taskId === run.id &&
    candidateWorker?.runId === run.id &&
    candidateWorker.runRole === "worker";
  const proposalChanged = Boolean(
    proposal &&
    (view?.proposal?.id !== proposal.id || view?.proposal?.version !== proposal.version),
  );
  const changed = (record: PrMaintenanceRegistration) =>
    !records.some((entry) => entry.id === record.id && entry.version === record.version);
  let invalidUrl = false;
  if (prUrl.trim()) {
    try {
      parsePrMaintenanceUrl(prUrl.trim());
    } catch {
      invalidUrl = true;
    }
  }

  const controls = (record: PrMaintenanceRegistration) => {
    if (record.ownershipReleasedAt) return null;
    const outstanding = hasOutstandingWork(record);
    const held = record.decision?.state === "pending";
    return (
      <div className={styles.actions}>
        {record.lifecycle === "active" ? (
          <Button
            disabled={busy || !view?.canAuthorize}
            onClick={() =>
              void execute(() =>
                actOnTaskMaintenance(run.id, record, {
                  action: "pause",
                  reason: "Paused by the authenticated task operator",
                }),
              )
            }
          >
            Pause maintenance
          </Button>
        ) : null}
        {record.lifecycle === "paused" ? (
          <Button
            disabled={busy || !view?.canAuthorize || held || outstanding}
            onClick={() =>
              void execute(() =>
                actOnTaskMaintenance(run.id, record, {
                  action: "resume",
                  ...(record.decision?.state === "directed"
                    ? {
                        decisionId: record.decision.id,
                        decisionVersion: record.decision.version,
                      }
                    : {}),
                }),
              )
            }
          >
            Resume maintenance
          </Button>
        ) : null}
        <Button
          disabled={busy || !view?.canAuthorize || outstanding}
          onClick={() => {
            setError("");
            setRelease(record);
            setReleaseReason("");
          }}
        >
          Release maintenance
        </Button>
        {record.authorization.scope.publicationAuthorized &&
        ["active", "paused"].includes(record.lifecycle) ? (
          <Button
            disabled={busy || !view?.canAuthorize || outstanding || held}
            onClick={() => {
              setError("");
              setRenew(record);
            }}
          >
            Renew maintenance budgets
          </Button>
        ) : null}
      </div>
    );
  };

  const details = (record: PrMaintenanceRegistration) => (
    <details className={styles.details}>
      <summary>Technical details</summary>
      <dl className={styles.metadata}>
        <dt>Registration</dt>
        <dd>
          {record.id} · version {record.version} · generation {record.generation}
        </dd>
        <dt>Worker</dt>
        <dd>
          {sessions.find((entry) => entry.id === record.workerSessionId)?.name ||
            "Retained worker"}{" "}
          · {record.workerSessionId}
        </dd>
        <dt>Binding</dt>
        <dd>
          {record.placementId} · {record.checkoutKey} · generation{" "}
          {record.bindingGeneration}
        </dd>
        <dt>Provider</dt>
        <dd>
          {prMaintenanceProviderLabel(record.identity)} · repository ID{" "}
          {record.identity.repositoryId}
          {record.identity.provider === "azure-devops"
            ? ` · project ID ${record.identity.projectId}`
            : ""}
        </dd>
        <dt>Head / base</dt>
        <dd>
          {record.identity.headRef} → {record.identity.baseRef}
        </dd>
        <dt>Authorized HEAD</dt>
        <dd>{record.authorization.headSha}</dd>
        <dt>
          {record.authorization.scope.publicationAuthorized ? "Scope" : "Review baseline"}
        </dt>
        <dd>{record.authorization.scope.baseline}</dd>
        <dt>
          {record.authorization.scope.publicationAuthorized
            ? "Verification"
            : "Verification reference"}
        </dt>
        <dd>{record.authorization.scope.verification}</dd>
        <dt>Remaining limits</dt>
        <dd>
          {!record.authorization.scope.publicationAuthorized ? (
            "Read-only observation; no mutation allowance."
          ) : (
            <>
              {Math.max(
                0,
                record.authorization.budgets.repairBatches -
                  record.counters.repairBatches,
              )}{" "}
              repairs ·{" "}
              {Math.max(
                0,
                record.authorization.budgets.answerBatches -
                  record.counters.answerBatches,
              )}{" "}
              answers ·{" "}
              {Math.max(
                0,
                record.authorization.budgets.mutationAttempts -
                  record.counters.mutationAttempts,
              )}{" "}
              mutation attempts
            </>
          )}
        </dd>
        <dt>Prior successful check</dt>
        <dd>{record.lastSuccessAt || "Unknown — no successful observation"}</dd>
        <dt>Prerequisite evidence</dt>
        <dd>{record.eligibilityEvidence}</dd>
        {record.lastError ? (
          <>
            <dt>Last error</dt>
            <dd>{record.lastError}</dd>
          </>
        ) : null}
        {record.decision ? (
          <>
            <dt>Decision reference</dt>
            <dd>
              {record.decision.id} v{record.decision.version} · {record.decision.state}
            </dd>
          </>
        ) : null}
      </dl>
    </details>
  );

  return (
    <section className={styles.panel} aria-label="PR maintenance">
      <h2>PR maintenance</h2>
      <p className={styles.muted}>
        {readOnly
          ? "Observe the retained PR without changing code or provider state. Maintenance never merges or force-pushes."
          : "Bounded repairs on the retained worker. Ready is not merged; maintenance never merges or force-pushes."}
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {!view && !error ? <p role="status">Loading maintenance status…</p> : null}
      {view?.unsupportedReason ? <p role="status">{view.unsupportedReason}</p> : null}
      {view && !view.canAuthorize ? (
        <p>
          Sign in to authorize maintenance. Node and MCP credentials cannot approve it.
        </p>
      ) : null}

      {current && currentProgress ? (
        <section aria-label="Current maintained PR">
          <p className={styles.muted}>Current maintained PR</p>
          <h3>
            <PrLink record={current} />
          </h3>
          {!current.authorization.scope.publicationAuthorized ? (
            <p>
              <strong>Read-only observation</strong> — {readOnlyNotice}
            </p>
          ) : null}
          <ol className={styles.rail} aria-label="Maintenance loop stages">
            {[
              ...(!loopStages.some((stage) => stage === currentProgress.stage)
                ? [currentProgress.stage]
                : []),
              ...loopStages.filter(
                (stage) =>
                  current.authorization.scope.publicationAuthorized ||
                  stage !== "addressing_review" ||
                  currentProgress.stage === stage,
              ),
            ].map((stage) => (
              <li
                key={stage}
                aria-current={stage === currentProgress.stage ? "step" : undefined}
                className={mergeClasses(
                  styles.stage,
                  stage === currentProgress.stage && styles.currentStage,
                )}
              >
                {stageLabel(stage, current)}
              </li>
            ))}
          </ol>
          <p>
            {currentProgress.completedIterations} completed maintenance rounds · settled
            worker batches
          </p>
          <dl className={styles.metadata}>
            <dt>Last action</dt>
            <dd>
              {latestBatch
                ? `${latestBatch.kind === "repair" ? "Repair" : "Answer"} batch ${batchStates[latestBatch.state]} · ${checkTime(latestBatch.updatedAt)}`
                : "No worker batch yet."}
            </dd>
            <dt>Latest check</dt>
            <dd>
              {current.lastAttempt ? (
                <time dateTime={current.lastAttempt.attemptedAt}>
                  {checkTime(current.lastAttempt.attemptedAt)}
                </time>
              ) : (
                "Not checked yet"
              )}
              {current.lastAttempt?.complete && !current.lastAttempt.failure
                ? " · complete observation"
                : " · incomplete or unavailable; prior success is not current validation"}
            </dd>
            <dt>Next action</dt>
            <dd>
              {!current.authorization.scope.publicationAuthorized &&
              ![
                "human_hold",
                "reconciling",
                "paused",
                "blocked",
                "merged",
                "closed",
                "released",
              ].includes(currentProgress.stage)
                ? "Observe the PR and report findings. Changes require a separately reviewed authorization."
                : nextActions[currentProgress.stage]}
            </dd>
            <dt>Next check</dt>
            <dd>
              {["human_hold", "reconciling", "paused", "merged", "closed"].includes(
                currentProgress.stage,
              ) ? (
                "On hold until the current blocker is resolved."
              ) : (
                <>
                  <time dateTime={current.nextCheckAt}>
                    {checkTime(current.nextCheckAt)}
                  </time>{" "}
                  · best-effort lead wake
                </>
              )}
            </dd>
          </dl>
          {attention ? (
            <p className={styles.attention}>
              <strong>Needs attention: </strong>
              {attention}
            </p>
          ) : null}
          {current.decision?.state === "pending" ? (
            <p className={styles.attention}>
              {current.decision.proposal} Use Send back with instructions below. Approve
              task and generic Reopen cannot authorize this design change.
            </p>
          ) : null}
          {hasOutstandingWork(current) ? (
            <p>
              Work or effects are still pending. Resume, release and renewal stay blocked
              until reconciled.
            </p>
          ) : null}
          {controls(current)}
          {details(current)}
        </section>
      ) : null}

      {!current && view ? (
        <section aria-label="Prepare PR maintenance">
          {view.proposal ? (
            <>
              <h3>
                <PrLink record={view.proposal.registration} />
              </h3>
              {!view.proposal.registration.scope.publicationAuthorized ? (
                <p>
                  <strong>Read-only observation</strong> — {readOnlyNotice}
                </p>
              ) : null}
              <p>
                The Orchestrator prepared a proposal. Maintenance is not enabled until you
                review and authorize it.
              </p>
              <Button
                appearance="primary"
                disabled={
                  busy ||
                  !view.canAuthorize ||
                  Boolean(view.unsupportedReason) ||
                  retained
                }
                onClick={() => {
                  setError("");
                  setProposal(view.proposal);
                  setConfirmed(false);
                }}
              >
                Review PR maintenance proposal
              </Button>
            </>
          ) : (
            <>
              <p>
                Ask the Orchestrator to prepare a proposal for this task’s PR. You review
                its scope before any maintenance is authorized.
              </p>
              <Field
                label="PR URL (optional)"
                hint="Leave blank to use the task’s PR. Azure DevOps and GitHub are supported."
                validationState={invalidUrl ? "error" : "none"}
                validationMessage={
                  invalidUrl ? "Enter an exact HTTPS pull request URL." : null
                }
              >
                <Input
                  type="url"
                  value={prUrl}
                  disabled={
                    busy ||
                    retained ||
                    !view.canAuthorize ||
                    Boolean(view.unsupportedReason)
                  }
                  onChange={(_, data) => setPrUrl(data.value)}
                />
              </Field>
              <div className={styles.actions}>
                <Button
                  appearance="primary"
                  disabled={
                    busy ||
                    invalidUrl ||
                    !view.canAuthorize ||
                    Boolean(view.unsupportedReason) ||
                    retained
                  }
                  onClick={() =>
                    void execute(
                      () => prepareTaskMaintenance(run.id, prUrl.trim() || undefined),
                      "Preparation requested. Review the Orchestrator’s proposal when it arrives; maintenance is not enabled.",
                    )
                  }
                >
                  Ask Orchestrator to prepare
                </Button>
              </div>
            </>
          )}
          {retained ? (
            <p>Release the prior retained job in history before preparing another PR.</p>
          ) : null}
        </section>
      ) : null}

      {history.length ? (
        <details className={styles.details}>
          <summary>Prior PR jobs ({history.length})</summary>
          {history.map((record) => {
            const progress = prMaintenanceProgress(record);
            return (
              <section
                className={styles.historyJob}
                key={record.id}
                aria-label={`Prior PR job: ${record.identity.repository} #${record.identity.prNumber}`}
              >
                <h3>
                  <PrLink record={record} />
                </h3>
                <p>
                  {stageLabel(progress.stage, record)} · {progress.completedIterations}{" "}
                  completed maintenance rounds
                </p>
                {!record.authorization.scope.publicationAuthorized ? (
                  <p>Read-only observation</p>
                ) : null}
                {record.pauseReason ? <p>{record.pauseReason}</p> : null}
                {controls(record)}
                {details(record)}
              </section>
            );
          })}
        </details>
      ) : null}
      <div className={styles.actions}>
        <Button disabled={busy} onClick={() => setRefreshKey((value) => value + 1)}>
          Refresh maintenance status
        </Button>
      </div>

      <Dialog
        open={Boolean(proposal)}
        onOpenChange={(_, data) => !busy && !data.open && setProposal(undefined)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {candidate && !candidate.scope.publicationAuthorized
                ? "Authorize read-only PR observation"
                : "Authorize bounded PR maintenance"}
            </DialogTitle>
            <DialogContent>
              {proposalChanged ? (
                <p role="alert">
                  This proposal changed or was already handled. Close this dialog and
                  review the current proposal before authorizing.
                </p>
              ) : null}
              {error ? (
                <p role="alert">
                  {error} Close this dialog and refresh before authorizing again.
                </p>
              ) : null}
              {candidate ? (
                <>
                  <p>
                    <PrLink record={candidate} />
                  </p>
                  <p className={styles.muted}>
                    Prepared by the Orchestrator. Only you can authorize it; ask for a
                    revised proposal if changes are needed.
                  </p>
                  {!candidate.scope.publicationAuthorized ? (
                    <p>
                      <strong>Read-only observation</strong> — {readOnlyNotice}
                    </p>
                  ) : null}
                  <dl className={styles.metadata}>
                    <dt>
                      {candidate.scope.publicationAuthorized
                        ? "Scope"
                        : "Review baseline"}
                    </dt>
                    <dd>{candidate.scope.baseline}</dd>
                    <dt>
                      {candidate.scope.publicationAuthorized
                        ? "Verification"
                        : "Verification reference"}
                    </dt>
                    <dd>{candidate.scope.verification}</dd>
                    <dt>Limits</dt>
                    <dd>
                      {!candidate.scope.publicationAuthorized ? (
                        "Observation only; no mutation allowance."
                      ) : (
                        <>
                          {candidate.budgets.repairBatches} repairs ·{" "}
                          {candidate.budgets.answerBatches} answers ·{" "}
                          {candidate.budgets.mutationAttempts} mutation attempts
                        </>
                      )}
                    </dd>
                    <dt>Allowed responses</dt>
                    <dd>
                      {!candidate.scope.publicationAuthorized ? (
                        "Read-only findings only; no provider mutations."
                      ) : (
                        <>
                          Replies: {candidate.scope.replies ? "yes" : "no"} · resolve
                          evidenced threads:{" "}
                          {candidate.scope.resolveThreads ? "yes" : "no"} · CI retry:{" "}
                          {candidate.scope.retryChecks ? "yes" : "no"}
                        </>
                      )}
                    </dd>
                  </dl>
                  <details className={styles.details}>
                    <summary>Technical details</summary>
                    <p>{prMaintenanceProviderLabel(candidate.identity)}</p>
                    <p>
                      Worker: {candidateWorker?.name || "Retained worker"} ·{" "}
                      {candidate.workerSessionId}
                    </p>
                    <p>
                      Binding: {candidateWorker?.placementId} ·{" "}
                      {candidateWorker?.executionBinding?.checkoutKey ||
                        "existing source placement"}{" "}
                      · Node {candidateWorker?.nodeId}
                    </p>
                    <p>
                      {candidate.scope.publicationAuthorized
                        ? "Push only to"
                        : "Observe head"}{" "}
                      {candidate.identity.headRepository} {candidate.identity.headRef};
                      base {candidate.identity.baseRepository}{" "}
                      {candidate.identity.baseRef}.
                    </p>
                    <p>
                      Repository IDs: PR {candidate.identity.repositoryId}; head{" "}
                      {candidate.identity.headRepositoryId}; base{" "}
                      {candidate.identity.baseRepositoryId}. HEAD {candidate.headSha}.
                    </p>
                    <p>Evidence: {candidate.eligibilityEvidence}</p>
                    <p>
                      Reviewers:{" "}
                      {candidate.scope.publicationAuthorized
                        ? candidate.scope.reviewers.join(", ") ||
                          "External reviews only; no review requests"
                        : "External reviews only; review requests are not authorized"}
                      .
                    </p>
                    <p>
                      Proposal {proposal?.id} · version {proposal?.version}
                    </p>
                  </details>
                  {!proposalMatchesTask ? (
                    <p role="alert">
                      The proposal must name this task and one of its existing workers.
                    </p>
                  ) : null}
                </>
              ) : null}
              <Checkbox
                checked={confirmed}
                disabled={
                  !candidate ||
                  !proposalMatchesTask ||
                  proposalChanged ||
                  busy ||
                  !view?.canAuthorize
                }
                onChange={(_, data) => setConfirmed(data.checked === true)}
                label={
                  candidate && !candidate.scope.publicationAuthorized
                    ? "I authorize read-only PR observation only. No repairs, pushes, replies, thread resolution, reviewer requests, CI retries, merge or force-push."
                    : "I authorize these bounded repairs and responses only. No merge, force-push or unapproved design changes."
                }
              />
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setProposal(undefined)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={
                  busy ||
                  !view?.canAuthorize ||
                  !proposalMatchesTask ||
                  proposalChanged ||
                  !confirmed
                }
                onClick={() =>
                  proposal &&
                  void execute(() =>
                    authorizeTaskMaintenanceProposal(run.id, {
                      id: proposal.id,
                      version: proposal.version,
                    }),
                  )
                }
              >
                {candidate && !candidate.scope.publicationAuthorized
                  ? "Authorize read-only observation"
                  : "Authorize maintenance"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={Boolean(renew)}
        onOpenChange={(_, data) => !busy && !data.open && setRenew(undefined)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Renew the same maintenance scope?</DialogTitle>
            <DialogContent>
              {error ? (
                <p role="alert">
                  {error} Close this dialog and refresh before authorizing again.
                </p>
              ) : null}
              {renew && changed(renew) ? (
                <p role="alert">
                  This job changed. Close and review its current state before renewing.
                </p>
              ) : null}
              <p>
                This starts a new allowance for the exact existing PR, worker and scope.
                It does not broaden design or publication authority, erase iteration
                history, or resume a pause.
              </p>
              {renew ? (
                <>
                  <p>
                    <PrLink record={renew} />
                  </p>
                  <p>{renew.authorization.scope.baseline}</p>
                  <p>
                    Renew to {renew.authorization.budgets.repairBatches} repair batches,{" "}
                    {renew.authorization.budgets.answerBatches} answer batches and{" "}
                    {renew.authorization.budgets.mutationAttempts} mutation attempts.
                  </p>
                </>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setRenew(undefined)}>
                Cancel
              </Button>
              <Button
                disabled={busy || !view?.canAuthorize || !renew || changed(renew)}
                appearance="primary"
                onClick={() =>
                  renew &&
                  void execute(() =>
                    actOnTaskMaintenance(run.id, renew, { action: "renew" }),
                  )
                }
              >
                Authorize budget renewal
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={Boolean(release)}
        onOpenChange={(_, data) => !busy && !data.open && setRelease(undefined)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Release maintenance ownership?</DialogTitle>
            <DialogContent>
              {error ? (
                <p role="alert">
                  {error} Close this dialog and refresh before authorizing again.
                </p>
              ) : null}
              {release && changed(release) ? (
                <p role="alert">
                  This job changed. Close and review its current state before releasing.
                </p>
              ) : null}
              {release ? (
                <p>
                  <PrLink record={release} />
                </p>
              ) : null}
              <p>
                Only settled work can be released. Later cleanup can remove continuity;
                resuming requires a new authorized proposal. This does not approve a
                design change or mark a defect fixed.
              </p>
              <Field label="Release reason and decision disposition">
                <Textarea
                  value={releaseReason}
                  rows={3}
                  disabled={busy}
                  onChange={(_, data) => setReleaseReason(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setRelease(undefined)}>
                Keep ownership
              </Button>
              <Button
                disabled={
                  busy ||
                  !view?.canAuthorize ||
                  !releaseReason.trim() ||
                  !release ||
                  changed(release)
                }
                onClick={() =>
                  release &&
                  void execute(() =>
                    actOnTaskMaintenance(run.id, release, {
                      action: "release",
                      reason: releaseReason.trim(),
                      ...(release.decision
                        ? {
                            decisionId: release.decision.id,
                            decisionVersion: release.decision.version,
                          }
                        : {}),
                    }),
                  )
                }
              >
                Release maintenance
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
