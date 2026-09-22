import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Link,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  prMaintenanceProviderLabel,
  prMaintenanceUrl,
  type FleetSession,
  type PrMaintenanceProposal,
} from "@fleet/protocol";

const useStyles = makeStyles({
  metadata: {
    display: "grid",
    gridTemplateColumns: "minmax(90px, 140px) minmax(0, 1fr)",
    gap: tokens.spacingVerticalS,
    "& dt": { color: tokens.colorNeutralForeground2 },
    "& dd": { margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
    "@media (max-width: 480px)": { gridTemplateColumns: "1fr" },
  },
  muted: { color: tokens.colorNeutralForeground2 },
  details: {
    marginBlock: tokens.spacingVerticalM,
    "& summary": { cursor: "pointer", color: tokens.colorNeutralForeground2 },
    "& summary:focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
});

export function PrMaintenanceProposalDialog({
  proposal,
  currentProposal,
  taskId,
  sessions,
  canAuthorize,
  connected = true,
  busy,
  error,
  confirmed,
  onConfirmedChange,
  onAuthorize,
  onClose,
}: {
  proposal: PrMaintenanceProposal;
  currentProposal: PrMaintenanceProposal | undefined;
  taskId: string;
  sessions: readonly FleetSession[];
  canAuthorize: boolean;
  connected?: boolean;
  busy: boolean;
  error: string;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onAuthorize: () => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const candidate = proposal.registration;
  const worker = sessions.find((entry) => entry.id === candidate.workerSessionId);
  const matchesTask =
    candidate.taskId === taskId &&
    worker?.runId === taskId &&
    worker.runRole === "worker";
  const changed =
    currentProposal?.id !== proposal.id || currentProposal.version !== proposal.version;
  const disabled =
    busy || !connected || !canAuthorize || !matchesTask || changed || Boolean(error);
  const readOnly = !candidate.scope.publicationAuthorized;
  return (
    <Dialog open onOpenChange={(_, data) => !busy && !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {readOnly
              ? "Authorize read-only PR observation"
              : "Authorize bounded PR maintenance"}
          </DialogTitle>
          <DialogContent>
            {changed && !busy ? (
              <p role="alert">
                This proposal changed or was already handled. Close this dialog and review
                the current proposal before authorizing.
              </p>
            ) : null}
            {error ? (
              <p role="alert">
                {error} Close this dialog and refresh before authorizing again.
              </p>
            ) : null}
            {!connected ? (
              <p role="status">
                Disconnected from the Host. Reconnect before authorizing maintenance.
              </p>
            ) : null}
            {!canAuthorize ? (
              <p role="status">
                Sign in to authorize maintenance. Node, MCP and no-login credentials
                cannot approve it.
              </p>
            ) : null}
            <p>
              <Link
                href={prMaintenanceUrl(candidate.identity)}
                target="_blank"
                rel="noreferrer"
              >
                {candidate.identity.repository} #{candidate.identity.prNumber}
              </Link>
            </p>
            <p className={styles.muted}>
              Prepared by the Orchestrator. Only you can authorize it; ask for a revised
              proposal if changes are needed.
            </p>
            {readOnly ? (
              <p>
                <strong>Read-only observation</strong> — No repairs, pushes, replies,
                thread resolution, reviewer requests or CI retries are authorized.
              </p>
            ) : null}
            <dl className={styles.metadata}>
              <dt>{readOnly ? "Review baseline" : "Scope"}</dt>
              <dd>{candidate.scope.baseline}</dd>
              <dt>{readOnly ? "Verification reference" : "Verification"}</dt>
              <dd>{candidate.scope.verification}</dd>
              <dt>Limits</dt>
              <dd>
                {readOnly ? (
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
                {readOnly ? (
                  "Read-only findings only; no provider mutations."
                ) : (
                  <>
                    Replies: {candidate.scope.replies ? "yes" : "no"} · resolve evidenced
                    threads: {candidate.scope.resolveThreads ? "yes" : "no"} · CI retry:{" "}
                    {candidate.scope.retryChecks ? "yes" : "no"}
                  </>
                )}
              </dd>
            </dl>
            <details className={styles.details}>
              <summary>Technical details</summary>
              <p>{prMaintenanceProviderLabel(candidate.identity)}</p>
              <p>
                Worker: {worker?.name || "Retained worker"} · {candidate.workerSessionId}
              </p>
              <p>
                Binding: {worker?.placementId} ·{" "}
                {worker?.executionBinding?.checkoutKey || "existing source placement"} ·
                Node {worker?.nodeId}
              </p>
              <p>
                {readOnly ? "Observe head" : "Push only to"}{" "}
                {candidate.identity.headRepository} {candidate.identity.headRef}; base{" "}
                {candidate.identity.baseRepository} {candidate.identity.baseRef}.
              </p>
              <p>
                Repository IDs: PR {candidate.identity.repositoryId}; head{" "}
                {candidate.identity.headRepositoryId}; base{" "}
                {candidate.identity.baseRepositoryId}. HEAD {candidate.headSha}.
              </p>
              <p>Evidence: {candidate.eligibilityEvidence}</p>
              <p>
                Reviewers:{" "}
                {readOnly
                  ? "External reviews only; review requests are not authorized"
                  : candidate.scope.reviewers.join(", ") ||
                    "External reviews only; no review requests"}
                .
              </p>
              <p>
                Proposal {proposal.id} · version {proposal.version}
              </p>
            </details>
            {!matchesTask ? (
              <p role="alert">
                The proposal must name this task and one of its existing workers.
              </p>
            ) : null}
            <Checkbox
              checked={confirmed}
              disabled={disabled}
              onChange={(_, data) => onConfirmedChange(data.checked === true)}
              label={
                readOnly
                  ? "I authorize read-only PR observation only. No repairs, pushes, replies, thread resolution, reviewer requests, CI retries, merge or force-push."
                  : "I authorize these bounded repairs and responses only. No merge, force-push or unapproved design changes."
              }
            />
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={disabled || !confirmed}
              onClick={onAuthorize}
            >
              {readOnly ? "Authorize read-only observation" : "Authorize maintenance"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
