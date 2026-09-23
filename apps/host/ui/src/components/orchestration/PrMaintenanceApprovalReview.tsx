import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
} from "@fluentui/react-components";
import {
  errorMessage,
  type FleetSession,
  type PrMaintenanceApproval,
  type PrMaintenanceProposal,
} from "@fleet/protocol";
import {
  authorizeTaskMaintenanceProposal,
  getTaskMaintenance,
  type TaskMaintenanceView,
} from "../../lib/pr-maintenance";
import { PrMaintenanceProposalDialog } from "./PrMaintenanceProposalDialog";

export function PrMaintenanceApprovalReview({
  approval,
  currentApproval,
  sessions,
  connected,
  snapshotRevision,
  onClose,
  onAuthorized,
}: {
  approval: PrMaintenanceApproval;
  currentApproval: PrMaintenanceApproval | undefined;
  sessions: readonly FleetSession[];
  connected: boolean;
  snapshotRevision: number;
  onClose: () => void;
  onAuthorized: () => void;
}) {
  const [view, setView] = useState<TaskMaintenanceView>();
  const [proposal, setProposal] = useState<PrMaintenanceProposal>();
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void getTaskMaintenance(approval.taskId)
      .then((next) => {
        if (!active) return;
        setView(next);
        if (
          next.proposal?.id === approval.proposalId &&
          next.proposal.version === approval.version
        ) {
          const candidate = next.proposal;
          setProposal((captured) => captured ?? candidate);
        }
        setReadError("");
      })
      .catch((failure: unknown) => {
        if (!active) return;
        setReadError(errorMessage(failure));
        setConfirmed(false);
      });
    return () => {
      active = false;
    };
  }, [approval.taskId, approval.proposalId, approval.version, snapshotRevision, reload]);

  const stale =
    currentApproval?.proposalId !== approval.proposalId ||
    currentApproval.version !== approval.version ||
    (view !== undefined &&
      (view.proposal?.id !== approval.proposalId ||
        view.proposal.version !== approval.version));

  async function authorize() {
    if (
      stale ||
      busy ||
      !confirmed ||
      !connected ||
      !view?.canAuthorize ||
      !proposal?.registration.scope.publicationAuthorized ||
      view.unsupportedReason ||
      readError ||
      error
    )
      return;
    setBusy(true);
    try {
      await authorizeTaskMaintenanceProposal(approval.taskId, {
        id: approval.proposalId,
        version: approval.version,
      });
      onAuthorized();
    } catch (failure) {
      setError(errorMessage(failure));
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  }

  if ((!proposal || readError || stale) && !busy) {
    return (
      <Dialog open onOpenChange={(_, data) => !data.open && onClose()}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Review PR maintenance approval</DialogTitle>
            <DialogContent>
              {stale ? (
                <p role="alert">
                  This proposal changed or was already handled. Close this dialog and
                  review the current request in Commands.
                </p>
              ) : readError ? (
                <p role="alert">{readError}</p>
              ) : (
                <Spinner label="Loading the current maintenance proposal" />
              )}
            </DialogContent>
            <DialogActions>
              {readError && !stale ? (
                <Button onClick={() => setReload((value) => value + 1)}>
                  Retry loading proposal
                </Button>
              ) : null}
              <Button onClick={onClose}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    );
  }
  if (!proposal) return null;
  return (
    <PrMaintenanceProposalDialog
      proposal={proposal}
      currentProposal={stale ? undefined : proposal}
      taskId={approval.taskId}
      sessions={sessions}
      canAuthorize={view?.canAuthorize ?? false}
      connected={connected}
      busy={busy}
      error={error || view?.unsupportedReason || ""}
      confirmed={confirmed}
      onConfirmedChange={setConfirmed}
      onAuthorize={() => void authorize()}
      onClose={onClose}
    />
  );
}
