import { useEffect, useRef, useState } from "react";
import {
  Button,
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
  useRestoreFocusTarget,
} from "@fluentui/react-components";
import {
  parsePrMaintenanceUrl,
  prMaintenanceProviderLabel,
  prMaintenanceUrl,
  type FleetSession,
  type PrMaintenanceRegistration,
  type PrMaintenanceProposal,
  type Run,
} from "@fleet/protocol";
import {
  actOnTaskMaintenance,
  authorizeTaskMaintenanceProposal,
  getTaskMaintenance,
  prepareTaskMaintenance,
  type TaskMaintenanceView,
} from "../../lib/pr-maintenance";
import {
  currentMaintenance,
  hasOutstandingWork,
  maintenanceNeedsPerson,
  maintenanceStatusOf,
} from "../../lib/task-overview";
import { PrMaintenanceFlow } from "./PrMaintenanceFlow";
import { PrMaintenanceProposalDialog } from "./PrMaintenanceProposalDialog";

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
  compact: {
    marginBottom: 0,
    borderRadius: "12px",
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
    "& h2": { fontSize: "14px", margin: "0 0 12px" },
  },
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
  compactDetails: { marginBlock: "8px" },
  refresh: { marginBlock: "4px 0" },
  historyJob: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    marginTop: tokens.spacingVerticalM,
    paddingTop: tokens.spacingVerticalS,
  },
  error: { color: tokens.colorPaletteRedForeground1 },
});

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

const readOnlyNotice =
  "Legacy observation-only maintenance is retired. History and ownership are retained; authenticated repair authorization is required. No writes are authorized.";

function PrLink({ record }: { record: Pick<PrMaintenanceRegistration, "identity"> }) {
  return (
    <Link href={prMaintenanceUrl(record.identity)} target="_blank" rel="noreferrer">
      {record.identity.repository} #{record.identity.prNumber}
    </Link>
  );
}

type PendingDecision = NonNullable<PrMaintenanceRegistration["decision"]>;
type DirectionDraft = { text: string; decisionKey: string };

const decisionKeyOf = (decision: PendingDecision) => `${decision.id}:${decision.version}`;

type DecisionDirectionProps = {
  decision: PendingDecision;
  draft: DirectionDraft;
  disabled: boolean;
  onDraftChange: (draft: DirectionDraft) => void;
  onSubmit: (decision: PendingDecision, text: string) => void;
};

/**
 * Answers the one pending design decision. A draft remembers the decision it
 * was written for; if the orchestrator replaces that decision, the draft is
 * kept but cannot be sent to the new one.
 */
const DecisionDirection = ({
  decision,
  draft,
  disabled,
  onDraftChange,
  onSubmit,
}: DecisionDirectionProps) => {
  const styles = useStyles();
  const decisionKey = decisionKeyOf(decision);
  const retargeted = Boolean(draft.text.trim()) && draft.decisionKey !== decisionKey;
  const handleDraftChange = (text: string) =>
    onDraftChange({
      text,
      decisionKey: draft.text.trim() ? draft.decisionKey : decisionKey,
    });
  const handleDiscardDraft = () => onDraftChange({ text: "", decisionKey });
  const handleSubmit = () => {
    const text = draft.text.trim();
    if (!text || retargeted) return;
    onSubmit(decision, text);
  };
  return (
    <section aria-label="Design decision" className={styles.attention}>
      <p>
        <strong>Waiting for Design Decision: </strong>
        {decision.proposal}
      </p>
      {retargeted ? (
        <p role="alert" className={styles.error}>
          The decision changed while you were writing. Your draft was not sent; read the
          new question, then discard the draft to answer it.
        </p>
      ) : null}
      <Field
        label="Your direction"
        hint="Name the chosen approach and its limits. Recording it resumes maintenance with a fresh review; you can also answer in the orchestrator conversation."
      >
        <Textarea
          rows={3}
          value={draft.text}
          disabled={disabled}
          onChange={(_, data) => handleDraftChange(data.value)}
        />
      </Field>
      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={disabled || retargeted || !draft.text.trim()}
          onClick={handleSubmit}
        >
          Record direction and continue
        </Button>
        {retargeted ? (
          <Button disabled={disabled} onClick={handleDiscardDraft}>
            Discard draft
          </Button>
        ) : null}
      </div>
    </section>
  );
};

export function PrMaintenancePanel({
  run,
  sessions,
  onChange,
  snapshotRevision = 0,
  compact = false,
  nowMs = Date.now(),
}: {
  run: Run;
  sessions: readonly FleetSession[];
  onChange: (view: TaskMaintenanceView | undefined) => void;
  snapshotRevision?: number;
  compact?: boolean;
  nowMs?: number;
}) {
  const styles = useStyles();
  const restoreFocusTarget = useRestoreFocusTarget();
  const Disclosure = compact ? "details" : "div";
  const [view, setView] = useState<TaskMaintenanceView>();
  const loadedTaskId = useRef<string | undefined>(undefined);
  const lastView = useRef<TaskMaintenanceView | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [prUrl, setPrUrl] = useState("");
  const [proposal, setProposal] = useState<PrMaintenanceProposal>();
  const [confirmed, setConfirmed] = useState(false);
  const [release, setRelease] = useState<PrMaintenanceRegistration>();
  const [releaseReason, setReleaseReason] = useState("");
  const [message, setMessage] = useState("");
  const [routineWork, setRoutineWork] = useState("");
  /** The draft and the exact decision it answers, so a draft never retargets. */
  const [direction, setDirection] = useState({ text: "", decisionKey: "" });
  const pendingAction = useRef(false);
  /** One stable key per intent, so an uncertain HTTP retry is idempotent. */
  const requestKeys = useRef(new Map<string, string>());
  const requestKey = (intent: string) => {
    const existing = requestKeys.current.get(intent);
    if (existing) return existing;
    const key = crypto.randomUUID();
    requestKeys.current.set(intent, key);
    return key;
  };

  useEffect(() => {
    let active = true;
    if (loadedTaskId.current !== run.id) {
      lastView.current = undefined;
      setView(undefined);
      setProposal(undefined);
      setRelease(undefined);
      setConfirmed(false);
      setMessage("");
      setPrUrl("");
      setRoutineWork("");
      setDirection({ text: "", decisionKey: "" });
      requestKeys.current.clear();
      onChange(undefined);
    }
    void getTaskMaintenance(run.id)
      .then((next) => {
        if (!active) return;
        loadedTaskId.current = run.id;
        lastView.current = next;
        setView(next);
        onChange(next);
        setError("");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const statusError =
          reason instanceof Error ? reason.message : "Maintenance status unavailable.";
        const unavailable: TaskMaintenanceView = {
          ...lastView.current,
          records: lastView.current?.records ?? [],
          canAuthorize: false,
          statusError,
        };
        setError(statusError);
        setView(unavailable);
        onChange(unavailable);
      });
    return () => {
      active = false;
    };
  }, [run.id, run.updatedAt, refreshKey, snapshotRevision, onChange]);

  const execute = async (
    action: () => Promise<unknown>,
    successMessage = "Maintenance action recorded.",
  ) => {
    if (pendingAction.current || busy || !view?.canAuthorize) return;
    pendingAction.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setProposal(undefined);
      setRelease(undefined);
      setConfirmed(false);
      setMessage(successMessage);
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Maintenance action failed.");
      // A failed approval must be reviewed again, never silently replayed.
      setConfirmed(false);
    } finally {
      pendingAction.current = false;
      setBusy(false);
    }
  };

  const records = view?.records ?? [];
  const current = records.find(
    (record) =>
      !record.ownershipReleasedAt &&
      (record.lifecycle === "active" || hasOutstandingWork(record)),
  );
  const history = records.filter((record) => record !== current);
  const retained = records.some((record) => !record.ownershipReleasedAt);
  const legacyRetained = current && !current.authorization.scope.publicationAuthorized;
  const blocksPreparation = retained && !legacyRetained;
  const graphRecord = currentMaintenance(records);
  const status = current ? maintenanceStatusOf(current, view) : undefined;
  const latestBatch = current?.batches.reduce<
    PrMaintenanceRegistration["batches"][number] | undefined
  >(
    (latest, batch) => (!latest || batch.updatedAt >= latest.updatedAt ? batch : latest),
    undefined,
  );
  /** Settled worker executions, once per step; never reservations or undispatched batches. */
  const completedRounds = current
    ? new Set(
        current.batches
          .filter(
            (batch) =>
              batch.stepId && batch.executionSettled && !batch.executionNotDispatched,
          )
          .map((batch) => batch.stepId),
      ).size
    : 0;
  void nowMs;
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
    const recordStatus = maintenanceStatusOf(record, view);
    const active = record.lifecycle === "active";
    const canAct = !busy && Boolean(view?.canAuthorize);
    return (
      <div className={styles.actions}>
        {active && !record.hold ? (
          <Button
            appearance={recordStatus.phase === "idle" ? "primary" : "secondary"}
            disabled={
              !canAct ||
              !record.authorization.scope.publicationAuthorized ||
              recordStatus.phase === "waiting_for_decision"
            }
            onClick={() =>
              void execute(
                () =>
                  actOnTaskMaintenance(run.id, record, {
                    action: "review",
                    requestId: requestKey(`review:${record.id}:${record.version}`),
                  }),
                "Review requested. The orchestrator refreshes the PR and decides what to do next.",
              )
            }
          >
            Review now
          </Button>
        ) : null}
        {record.hold ? (
          <Button
            appearance="primary"
            disabled={!canAct || !record.authorization.scope.publicationAuthorized}
            onClick={() =>
              void execute(
                () => actOnTaskMaintenance(run.id, record, { action: "resume" }),
                "Maintenance resumed. A fresh review starts now.",
              )
            }
          >
            Resume maintenance
          </Button>
        ) : active ? (
          <Button
            disabled={!canAct}
            onClick={() =>
              void execute(() =>
                actOnTaskMaintenance(run.id, record, {
                  action: "pause",
                  reason: "Paused by the operator",
                }),
              )
            }
          >
            Pause maintenance
          </Button>
        ) : null}
        <Button
          {...restoreFocusTarget}
          disabled={!canAct || outstanding}
          onClick={() => {
            setError("");
            setRelease(record);
            setReleaseReason("");
          }}
        >
          Release maintenance
        </Button>
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
        <dt>Activity</dt>
        <dd>
          {record.counters.repairBatches} repair and {record.counters.answerBatches}{" "}
          answer batches · {record.counters.dispatchesSinceDirection} since the last
          direction (no limit; repeated no-progress work becomes a design decision)
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
    <section
      className={mergeClasses(styles.panel, compact && styles.compact)}
      aria-label="PR maintenance"
    >
      <h2>PR maintenance</h2>
      {status ? (
        <p
          role="status"
          className={maintenanceNeedsPerson(status) ? styles.attention : undefined}
        >
          <strong>{status.label}</strong>
          {" — "}
          {status.reason} {status.action}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {!view && !error ? <p role="status">Loading maintenance status…</p> : null}
      {status ? <PrMaintenanceFlow status={status} /> : null}
      {current && status?.phase === "waiting_for_decision" && current.decision ? (
        <DecisionDirection
          decision={current.decision}
          draft={direction}
          disabled={busy || !view?.canAuthorize}
          onDraftChange={setDirection}
          onSubmit={(decision, text) =>
            void execute(async () => {
              await actOnTaskMaintenance(run.id, current, {
                action: "direction",
                decisionId: decision.id,
                decisionVersion: decision.version,
                direction: text,
              });
              setDirection({ text: "", decisionKey: "" });
            }, "Direction recorded. Maintenance resumes with a fresh review.")
          }
        />
      ) : null}
      {compact && view && !graphRecord && !error ? (
        <p className={styles.muted}>
          {view.proposal
            ? "A proposal is ready for your review; maintenance is not enabled."
            : "Not enabled for this task."}
        </p>
      ) : null}
      <Disclosure
        className={mergeClasses(styles.details, compact && styles.compactDetails)}
      >
        {compact ? (
          <summary>
            {view?.proposal && !current
              ? "Review maintenance proposal"
              : graphRecord
                ? "Routine work, controls and evidence"
                : "Set up PR maintenance"}
          </summary>
        ) : null}
        <p className={styles.muted}>
          Routine fixes on the retained worker. Ready is not merged; maintenance never
          merges or force-pushes.
        </p>
        {view?.unsupportedReason ? <p role="status">{view.unsupportedReason}</p> : null}
        {view && !view.canAuthorize ? (
          <p>
            Sign in to authorize maintenance. Node and MCP credentials cannot approve it.
          </p>
        ) : null}

        {current && status ? (
          <section aria-label="Current maintained PR">
            <p className={styles.muted}>Current maintained PR</p>
            <h3>
              <PrLink record={current} />
            </h3>
            {!current.authorization.scope.publicationAuthorized ? (
              <p>
                <strong>Repair authorization required</strong> — {readOnlyNotice}
              </p>
            ) : null}
            {controls(current)}
            {current.authorization.scope.publicationAuthorized &&
            current.lifecycle === "active" &&
            !current.hold ? (
              <>
                <Field
                  label="Routine work"
                  hint="Ask the retained worker for code, tests, docs, CI, generated artifacts or a straightforward conflict within the accepted intent. A review starts immediately; only design changes need a decision."
                >
                  <Textarea
                    rows={3}
                    value={routineWork}
                    disabled={busy || !view?.canAuthorize}
                    onChange={(_, data) => setRoutineWork(data.value)}
                  />
                </Field>
                <Button
                  disabled={busy || !view?.canAuthorize || !routineWork.trim()}
                  onClick={() => {
                    const text = routineWork.trim();
                    const requestId = requestKey(`work:${current.id}:${text}`);
                    void execute(async () => {
                      await actOnTaskMaintenance(run.id, current, {
                        action: "work",
                        requestId,
                        direction: text,
                      });
                      setRoutineWork("");
                    }, "Routine work queued; a review starts now.");
                  }}
                >
                  Queue routine work
                </Button>
              </>
            ) : null}
            <dl className={styles.metadata}>
              <dt>Completed rounds</dt>
              <dd>{completedRounds} settled worker batches</dd>
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
                  ? " · complete"
                  : current.lastAttempt
                    ? " · incomplete; the next review refreshes it"
                    : ""}
              </dd>
              <dt>Next heartbeat</dt>
              <dd>
                {status.phase === "idle" && !status.hold ? (
                  <>
                    <time dateTime={current.nextCheckAt}>
                      {checkTime(current.nextCheckAt)}
                    </time>{" "}
                    · or use Review now
                  </>
                ) : (
                  "Not scheduled while reviewing, working, waiting or on hold."
                )}
              </dd>
            </dl>
            {current.manualControl && !current.manualControl.endedAt ? (
              <p role="status">
                Manual control: a person is driving the retained worker. Choose one-turn
                handback in the prompt composer to resume automatically after that turn,
                or Resume maintenance when done.
              </p>
            ) : null}
            {hasOutstandingWork(current) ? (
              <p>
                Work or effects are still settling. Release waits until they are
                reconciled; nothing is replayed.
              </p>
            ) : null}
            {details(current)}
          </section>
        ) : null}

        {(!current || legacyRetained) && view ? (
          <section aria-label="Prepare PR maintenance">
            {view.proposal && !view.proposal.registration.scope.publicationAuthorized ? (
              <p role="status">
                This legacy observation proposal cannot be authorized. Its evidence is
                preserved; ask the Orchestrator to prepare a repair proposal using
                existing task authority.
              </p>
            ) : null}
            {view.proposal?.registration.scope.publicationAuthorized ? (
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
                  The Orchestrator prepared a proposal. Maintenance is not enabled until
                  you review and authorize it.
                </p>
                <Button
                  {...restoreFocusTarget}
                  appearance="primary"
                  disabled={
                    busy ||
                    !view.canAuthorize ||
                    Boolean(view.unsupportedReason) ||
                    blocksPreparation
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
                  Ask the Orchestrator to prepare a proposal for this task’s PR. You
                  review its scope before any maintenance is authorized.
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
                      blocksPreparation ||
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
                      blocksPreparation
                    }
                    onClick={() =>
                      void execute(
                        () =>
                          prepareTaskMaintenance(
                            run.id,
                            legacyRetained
                              ? prMaintenanceUrl(current.identity)
                              : prUrl.trim() || undefined,
                          ),
                        "Preparation requested. Review the Orchestrator’s proposal when it arrives; maintenance is not enabled.",
                      )
                    }
                  >
                    {legacyRetained || view.proposal
                      ? "Prepare repair authorization"
                      : "Ask Orchestrator to prepare"}
                  </Button>
                </div>
              </>
            )}
            {blocksPreparation ? (
              <p>
                Release the prior retained job in history before preparing another PR.
              </p>
            ) : null}
          </section>
        ) : null}

        {history.length ? (
          <details className={styles.details}>
            <summary>Prior PR jobs ({history.length})</summary>
            {history.map((record) => {
              const recordStatus = maintenanceStatusOf(record, view);
              return (
                <section
                  className={styles.historyJob}
                  key={record.id}
                  aria-label={`Prior PR job: ${record.identity.repository} #${record.identity.prNumber}`}
                >
                  <h3>
                    <PrLink record={record} />
                  </h3>
                  <p>{recordStatus.label}</p>
                  {!record.authorization.scope.publicationAuthorized ? (
                    <p>Legacy observation grant; no repair authorization.</p>
                  ) : null}
                  {controls(record)}
                  {details(record)}
                </section>
              );
            })}
          </details>
        ) : null}
      </Disclosure>
      <div className={mergeClasses(styles.actions, compact && styles.refresh)}>
        <Button
          size={compact ? "small" : "medium"}
          appearance={compact ? "subtle" : "secondary"}
          aria-label="Refresh maintenance status"
          disabled={busy}
          onClick={() => setRefreshKey((value) => value + 1)}
        >
          {compact ? "Refresh status" : "Refresh maintenance status"}
        </Button>
      </div>

      {proposal ? (
        <PrMaintenanceProposalDialog
          proposal={proposal}
          currentProposal={view?.proposal}
          taskId={run.id}
          sessions={sessions}
          canAuthorize={view?.canAuthorize ?? false}
          busy={busy}
          error={error || view?.unsupportedReason || ""}
          confirmed={confirmed}
          onConfirmedChange={setConfirmed}
          onClose={() => setProposal(undefined)}
          onAuthorize={() =>
            void execute(() =>
              authorizeTaskMaintenanceProposal(run.id, {
                id: proposal.id,
                version: proposal.version,
              }),
            )
          }
        />
      ) : null}

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
