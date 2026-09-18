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
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  PrMaintenanceEnableSchema,
  type FleetSession,
  type PrMaintenanceRegistration,
  type PrMaintenanceProposal,
  type Run,
} from "@fleet/protocol";
import {
  actOnTaskMaintenance,
  authorizeTaskMaintenanceProposal,
  enableTaskMaintenance,
  getTaskMaintenance,
  type TaskMaintenanceView,
} from "../../lib/pr-maintenance";

const useStyles = makeStyles({
  panel: {
    padding: "16px",
    marginBottom: "22px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap", marginBlock: "10px" },
  metadata: {
    display: "grid",
    gridTemplateColumns: "minmax(90px, 140px) minmax(0, 1fr)",
    gap: "5px",
    "& dd": { margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
  },
  error: { color: tokens.colorPaletteRedForeground1 },
});

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
  const [enableOpen, setEnableOpen] = useState(false);
  const [proposal, setProposal] = useState("");
  const [proposalReference, setProposalReference] =
    useState<Pick<PrMaintenanceProposal, "id" | "version">>();
  const [confirmed, setConfirmed] = useState(false);
  const [release, setRelease] = useState<PrMaintenanceRegistration>();
  const [renew, setRenew] = useState<PrMaintenanceRegistration>();
  const [releaseReason, setReleaseReason] = useState("");
  const [progress, setProgress] = useState("");
  useEffect(() => {
    let active = true;
    if (loadedTaskId.current !== run.id) {
      setView(undefined);
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

  const execute = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setProgress("");
    try {
      await action();
      setEnableOpen(false);
      setProposalReference(undefined);
      setRelease(undefined);
      setRenew(undefined);
      setConfirmed(false);
      setProgress(
        "Maintenance action recorded. Unknown effects remain reserved until reconciled.",
      );
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Maintenance action failed.");
      // Do not replay a stale approval against a silently refreshed version.
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  };

  let parsed: ReturnType<typeof PrMaintenanceEnableSchema.safeParse> | undefined;
  try {
    parsed = PrMaintenanceEnableSchema.safeParse(JSON.parse(proposal));
  } catch {
    /* The incomplete proposal is not an authorization. */
  }
  const candidate = parsed?.success ? parsed.data : undefined;
  const candidateWorker = sessions.find(
    (entry) => entry.id === candidate?.workerSessionId,
  );
  const proposalMatchesTask =
    candidate?.taskId === run.id &&
    candidateWorker?.runId === run.id &&
    candidateWorker.runRole === "worker";
  const baseline = [
    run.objective,
    ...run.successCriteria.map(
      (entry) => `${entry.scenario} — ${entry.expectedEvidence}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  const pending = view?.records.find(
    (entry) => !entry.ownershipReleasedAt && entry.decision?.state === "pending",
  );
  const proposalChanged = Boolean(
    proposalReference &&
    (view?.proposal?.id !== proposalReference.id ||
      view?.proposal?.version !== proposalReference.version),
  );
  const startEnable = () => {
    setError("");
    if (view?.proposal) {
      setProposalReference({ id: view.proposal.id, version: view.proposal.version });
      setProposal(JSON.stringify(view.proposal.registration, null, 2));
      setConfirmed(false);
      setEnableOpen(true);
      return;
    }
    setProposalReference(undefined);
    setProposal(
      JSON.stringify(
        {
          taskId: run.id,
          workerSessionId:
            sessions.find((entry) => entry.runId === run.id && entry.runRole === "worker")
              ?.id ?? "",
          identity: {
            host: "github.com",
            repositoryId: "",
            repository: "",
            prNumber: 0,
            headRepositoryId: "",
            headRepository: "",
            headRef: "refs/heads/",
            baseRepositoryId: "",
            baseRepository: "",
            baseRef: "refs/heads/",
          },
          scope: {
            baseline,
            verification: "",
            publicationAuthorized: true,
            replies: true,
            resolveThreads: true,
            reviewers: [],
            retryChecks: false,
          },
          budgets: { repairBatches: 3, answerBatches: 3, mutationAttempts: 100 },
          headSha: "",
          eligibilityEvidence: "",
        },
        null,
        2,
      ),
    );
    setConfirmed(false);
    setEnableOpen(true);
  };

  return (
    <section className={styles.panel} aria-label="PR maintenance">
      <h2>PR maintenance</h2>
      <p>
        Opt-in local repairs on the retained worker. Design choices need human direction.
        Ready is not merged; maintenance never merges or force-pushes.
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {progress ? <p role="status">{progress}</p> : null}
      {!view && !error ? <p role="status">Loading maintenance status…</p> : null}
      {view?.unsupportedReason ? <p role="status">{view.unsupportedReason}</p> : null}
      {view && !view.canAuthorize ? (
        <p>
          Sign in to authorize maintenance. Node and MCP credentials cannot approve it.
        </p>
      ) : null}
      {view?.proposal ? (
        <p role="status">
          The Orchestrator proposed maintenance for{" "}
          {view.proposal.registration.identity.repository} #
          {view.proposal.registration.identity.prNumber}. It is not enabled. Review and
          authorize the proposal below; ordinary task approval does not enable
          maintenance.
        </p>
      ) : null}
      {view?.records.map((record) => {
        const identity = record.identity;
        const outstanding =
          record.batches.some(
            (batch) =>
              ["prepared", "accepted", "reconciling", "uncertain"].includes(
                batch.state,
              ) ||
              batch.effects.some((effect) =>
                ["reserved", "uncertain"].includes(effect.state),
              ),
          ) ||
          record.actions.some((action) =>
            ["reserved", "uncertain"].includes(action.state),
          );
        const held = record.decision?.state === "pending";
        return (
          <div key={record.id}>
            <h3>
              <a
                href={`https://${identity.host}/${identity.repository}/pull/${identity.prNumber}`}
                target="_blank"
                rel="noreferrer"
              >
                {identity.repository} #{identity.prNumber}
              </a>
            </h3>
            <dl className={styles.metadata}>
              <dt>Status</dt>
              <dd>
                {record.lifecycle}
                {record.ownershipReleasedAt ? " · released" : ""}
                {record.readyFingerprint ? " · ready, not merged" : ""}
              </dd>
              {record.pauseReason ? (
                <>
                  <dt>Reason</dt>
                  <dd>{record.pauseReason}</dd>
                </>
              ) : null}
              <dt>Worker</dt>
              <dd>
                {sessions.find((entry) => entry.id === record.workerSessionId)?.name ||
                  record.workerSessionId}{" "}
                · {record.workerSessionId}
              </dd>
              <dt>Last successful check</dt>
              <dd>{record.lastSuccessAt || "Unknown — no successful observation"}</dd>
              {!record.lastAttempt?.complete ? (
                <>
                  <dt>Current evidence</dt>
                  <dd>
                    {record.lastAttempt
                      ? "Incomplete or failed observation — prior success is not current validation."
                      : "Awaiting a fresh observation — historical success is not current validation."}
                  </dd>
                </>
              ) : null}
              <dt>Next due</dt>
              <dd>{record.nextCheckAt} · best-effort lead wake</dd>
              <dt>Remaining budget</dt>
              <dd>
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
                answer batches ·{" "}
                {Math.max(
                  0,
                  record.authorization.budgets.mutationAttempts -
                    record.counters.mutationAttempts,
                )}{" "}
                mutation attempts
              </dd>
              {record.decision ? (
                <>
                  <dt>Decision</dt>
                  <dd>
                    {record.decision.id} v{record.decision.version} ·{" "}
                    {record.decision.state}: {record.decision.proposal}
                  </dd>
                </>
              ) : null}
            </dl>
            <details>
              <summary>Exact scope, binding and prerequisite evidence</summary>
              <dl className={styles.metadata}>
                <dt>Binding</dt>
                <dd>
                  {record.placementId} · {record.checkoutKey} · generation{" "}
                  {record.bindingGeneration}
                </dd>
                <dt>Provider</dt>
                <dd>
                  {identity.host} · repository ID {identity.repositoryId}
                </dd>
                <dt>Head</dt>
                <dd>
                  {identity.headRepository} ({identity.headRepositoryId}) ·{" "}
                  {identity.headRef}
                </dd>
                <dt>Base</dt>
                <dd>
                  {identity.baseRepository} ({identity.baseRepositoryId}) ·{" "}
                  {identity.baseRef}
                </dd>
                <dt>Scope / baseline</dt>
                <dd>{record.authorization.scope.baseline}</dd>
                <dt>Authorized HEAD</dt>
                <dd>{record.authorization.headSha}</dd>
                <dt>Verification</dt>
                <dd>{record.authorization.scope.verification}</dd>
                <dt>Allowed responses</dt>
                <dd>
                  Replies: {record.authorization.scope.replies ? "yes" : "no"} · resolve
                  evidenced threads:{" "}
                  {record.authorization.scope.resolveThreads ? "yes" : "no"} · CI retry:{" "}
                  {record.authorization.scope.retryChecks ? "yes" : "no"}
                </dd>
                <dt>Review requests</dt>
                <dd>
                  {record.authorization.scope.reviewers.join(", ") ||
                    "External-review-only; no requests"}
                </dd>
                <dt>Prerequisite evidence</dt>
                <dd>{record.eligibilityEvidence}</dd>
              </dl>
            </details>
            {outstanding ? (
              <p role="status">
                Cancellation or effects may still be pending. Ownership and history remain
                reserved; cleanup is blocked.
              </p>
            ) : null}
            {!record.ownershipReleasedAt ? (
              <div className={styles.actions}>
                <Button
                  disabled={busy || !view.canAuthorize || record.lifecycle !== "active"}
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
                <Button
                  disabled={
                    busy || !view.canAuthorize || record.lifecycle !== "paused" || held
                  }
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
                <Button
                  disabled={busy || !view.canAuthorize || outstanding}
                  onClick={() => {
                    setRelease(record);
                    setReleaseReason("");
                  }}
                >
                  Release maintenance
                </Button>
                <Button
                  disabled={
                    busy ||
                    !view.canAuthorize ||
                    outstanding ||
                    held ||
                    !["active", "paused"].includes(record.lifecycle)
                  }
                  onClick={() => setRenew(record)}
                >
                  Renew maintenance budgets
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      {pending ? (
        <p>
          Maintenance design hold: use Send back with instructions below. Approve task and
          generic Reopen cannot authorize this change.
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          disabled={
            busy ||
            !view?.canAuthorize ||
            Boolean(view.unsupportedReason) ||
            view.records.some((record) => !record.ownershipReleasedAt)
          }
          onClick={startEnable}
        >
          {view?.proposal ? "Review PR maintenance proposal" : "Enable PR maintenance"}
        </Button>
        <Button disabled={busy} onClick={() => setRefreshKey((current) => current + 1)}>
          Refresh maintenance status
        </Button>
      </div>
      <Dialog
        open={enableOpen}
        onOpenChange={(_, data) => !busy && setEnableOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Authorize bounded PR maintenance</DialogTitle>
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
              {proposalReference ? (
                <p>
                  Prepared by the Orchestrator. Review the exact scope below; ask it to
                  revise the proposal if changes are needed.
                </p>
              ) : (
                <Field
                  label="Registration proposal"
                  hint="Paste the Orchestrator's proposal backed by current helper, credential and publication evidence. The task baseline is seeded below; unknown prerequisites cannot enable maintenance."
                >
                  <Textarea
                    value={proposal}
                    rows={8}
                    resize="vertical"
                    disabled={busy}
                    onChange={(_, data) => {
                      setProposal(data.value);
                      setConfirmed(false);
                    }}
                  />
                </Field>
              )}
              {candidate ? (
                <>
                  <p>
                    {candidate.identity.host} · {candidate.identity.repository} #
                    {candidate.identity.prNumber}
                  </p>
                  <p>
                    Worker: {candidateWorker?.name || candidate.workerSessionId} ·{" "}
                    {candidate.workerSessionId}
                  </p>
                  <p>
                    Binding: {candidateWorker?.placementId} ·{" "}
                    {candidateWorker?.executionBinding?.checkoutKey ||
                      "existing source placement"}{" "}
                    · Node {candidateWorker?.nodeId}
                  </p>
                  <p>
                    Push only to {candidate.identity.headRepository}{" "}
                    {candidate.identity.headRef}; base {candidate.identity.baseRepository}{" "}
                    {candidate.identity.baseRef}.
                  </p>
                  <p>
                    Stable repository IDs: PR {candidate.identity.repositoryId}; head{" "}
                    {candidate.identity.headRepositoryId}; base{" "}
                    {candidate.identity.baseRepositoryId}. HEAD {candidate.headSha}.
                  </p>
                  <p>Baseline: {candidate.scope.baseline}</p>
                  <p>Verify: {candidate.scope.verification}</p>
                  <p>Evidence: {candidate.eligibilityEvidence}</p>
                  <p>
                    Reviewers:{" "}
                    {candidate.scope.reviewers.join(", ") ||
                      "External reviews only; no review requests"}
                    .
                  </p>
                  <p>
                    Replies: {candidate.scope.replies ? "yes" : "no"}; resolve evidenced
                    threads: {candidate.scope.resolveThreads ? "yes" : "no"}; bounded CI
                    retry: {candidate.scope.retryChecks ? "yes" : "no"}.
                  </p>
                  <p>
                    Budgets: {candidate.budgets.repairBatches} repairs,{" "}
                    {candidate.budgets.answerBatches} answers,{" "}
                    {candidate.budgets.mutationAttempts} mutation attempts.
                  </p>
                  {!proposalMatchesTask ? (
                    <p role="alert">
                      The proposal must name this task and one of its existing workers.
                    </p>
                  ) : null}
                </>
              ) : (
                <p>
                  Supply a complete, valid proposal before approving. Stable repository
                  IDs and full refs are required.
                </p>
              )}
              <Checkbox
                checked={confirmed}
                disabled={!candidate || !proposalMatchesTask || proposalChanged || busy}
                onChange={(_, data) => setConfirmed(data.checked === true)}
                label="I verified the exact PR, worker, approved design baseline, helper access, credentials and permitted publication path. I authorize only this bounded scope, never merge, force-push or unapproved design changes."
              />
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setEnableOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={
                  busy ||
                  !candidate ||
                  !proposalMatchesTask ||
                  proposalChanged ||
                  !confirmed
                }
                onClick={() =>
                  proposalReference
                    ? void execute(() =>
                        authorizeTaskMaintenanceProposal(run.id, proposalReference),
                      )
                    : candidate &&
                      void execute(() => enableTaskMaintenance(run.id, candidate))
                }
              >
                Authorize maintenance
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
              <p>
                This starts a new allowance for the exact existing PR, worker and scope;
                it does not broaden design or publication authority and does not resume a
                pause.
              </p>
              <p>
                {renew?.identity.repository} #{renew?.identity.prNumber} ·{" "}
                {renew?.identity.headRef}
              </p>
              <p>
                Worker {renew?.workerSessionId} · {renew?.authorization.scope.baseline}
              </p>
              <p>
                Renew to {renew?.authorization.budgets.repairBatches} repair batches,{" "}
                {renew?.authorization.budgets.answerBatches} answer batches and{" "}
                {renew?.authorization.budgets.mutationAttempts} mutation attempts.
              </p>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setRenew(undefined)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
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
              <p>
                Only settled work can be released. Later cleanup can remove continuity;
                resuming requires a new authorized registration. This does not approve a
                design change or mark a defect fixed.
              </p>
              <Field label="Release reason and decision disposition">
                <Textarea
                  value={releaseReason}
                  rows={3}
                  onChange={(_, data) => setReleaseReason(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setRelease(undefined)}>
                Keep ownership
              </Button>
              <Button
                disabled={busy || !releaseReason.trim()}
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
