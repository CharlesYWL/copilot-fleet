import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { History20Regular } from "@fluentui/react-icons";
import type { UsageBackfillPreview, UsageBackfillResult } from "@fleet/protocol";
import { api } from "../hooks/useFleet";
import { exactUsageAmount, formatUsageAmount } from "../lib/usage-format";

const useStyles = makeStyles({
  content: { display: "flex", flexDirection: "column", gap: "12px", lineHeight: "1.7" },
  paragraph: { margin: 0 },
  counts: { margin: 0, paddingLeft: "20px", color: tokens.colorNeutralForeground2 },
  notice: { fontSize: "12px", color: tokens.colorNeutralForeground3, margin: 0 },
  error: { color: tokens.colorPaletteRedForeground1, overflowWrap: "anywhere" },
  receipt: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground2,
    maxWidth: "320px",
    overflowWrap: "anywhere",
  },
  control: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    alignItems: "flex-start",
  },
});
const skippedLabels: Record<keyof UsageBackfillPreview["skipped"], string> = {
  active: "Active sessions or conversations with an active alias",
  otherBackend: "Non-Copilot sessions",
  missingIdentity: "Missing or invalid native conversation identity",
  missingCredits: "Missing or invalid credit readings",
  conflicting: "Conflicting balances or task attribution",
  alreadyRecorded: "Already included in credit history",
};

export const UsageBackfillButton = ({ onCompleted }: { onCompleted: () => void }) => {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<UsageBackfillPreview>();
  const [receipt, setReceipt] = useState<UsageBackfillResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  const handlePreview = async () => {
    if (busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    setOpen(true);
    setLoading(true);
    setPreview(undefined);
    setError(undefined);
    try {
      const next = await api<UsageBackfillPreview>("/api/usage/backfill", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPreview(next);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Could not preview old credits.",
        );
    } finally {
      if (request.current === controller) {
        busy.current = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  };
  const handleClose = () => {
    if (applying) return;
    request.current?.abort();
    busy.current = false;
    setLoading(false);
    setOpen(false);
  };
  const handleImport = async () => {
    if (!preview?.eligibleConversations || busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    setApplying(true);
    setError(undefined);
    try {
      const result = await api<UsageBackfillResult>("/api/usage/backfill", {
        method: "POST",
        body: JSON.stringify({ previewId: preview.previewId }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setReceipt(result);
        setOpen(false);
        setPreview(undefined);
        onCompleted();
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not import old credits. Preview again before retrying.",
        );
        setPreview(undefined);
      }
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setApplying(false);
    }
  };

  return (
    <div className={styles.control}>
      <Button
        icon={<History20Regular aria-hidden="true" />}
        onClick={handlePreview}
        disabled={loading || applying}
      >
        Backfill old credits
      </Button>
      {receipt && (
        <div role="status" className={styles.receipt}>
          Imported {formatUsageAmount(receipt.aiCredits)} AI credits from{" "}
          {receipt.importedConversations} conversations. Showing all recorded Copilot
          history.
          {receipt.backupFile && <> Backup saved on the Host: {receipt.backupFile}.</>}
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(_, data) => {
          if (!data.open) handleClose();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Backfill old Copilot credits</DialogTitle>
            <DialogContent className={styles.content}>
              <p className={styles.paragraph}>
                Import saved AI credits from stopped, completed, or failed Copilot
                sessions across all machines and tasks. Current page filters do not limit
                this import.
              </p>
              <p className={styles.paragraph}>
                Credits become undated opening balances in All recorded history, not
                spending today. No sessions are started or resumed, and token totals are
                unchanged.
              </p>
              <p className={styles.notice}>
                Each native conversation is imported at most once. Repeating this action
                skips recorded balances. Running and idle sessions need updated Nodes for
                live history.
              </p>
              {loading && <Spinner size="small" label="Previewing old credits" />}
              {error && (
                <div role="alert" className={styles.error}>
                  {error}
                </div>
              )}
              {preview && (
                <>
                  <p className={styles.paragraph}>
                    {preview.eligibleConversations > 0 ? (
                      <>
                        <strong
                          title={`${exactUsageAmount(preview.aiCredits)} AI credits`}
                        >
                          {formatUsageAmount(preview.aiCredits)} AI credits
                        </strong>{" "}
                        from {preview.eligibleConversations} native conversations (
                        {preview.eligibleSessions} saved sessions) are eligible.
                      </>
                    ) : (
                      "No eligible old credits remain. Existing history will not be imported twice."
                    )}
                  </p>
                  <ul className={styles.counts}>
                    {(Object.keys(skippedLabels) as Array<keyof typeof skippedLabels>)
                      .filter((key) => preview.skipped[key] > 0)
                      .map((key) => (
                        <li key={key}>
                          {skippedLabels[key]}: {preview.skipped[key]}
                        </li>
                      ))}
                  </ul>
                </>
              )}
              <p className={styles.notice}>
                Before importing, Fleet creates a consistent database backup in the Host's
                protected data directory. Large databases may take a while. An import
                failure can be retried after a fresh preview.
              </p>
              {applying && (
                <Spinner size="small" label="Backing up and importing credits" />
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={handleClose} disabled={applying}>
                Cancel
              </Button>
              {error && (
                <Button onClick={handlePreview} disabled={loading || applying}>
                  Preview again
                </Button>
              )}
              <Button
                appearance="primary"
                onClick={handleImport}
                disabled={loading || applying || !preview?.eligibleConversations}
              >
                Import credits
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
};
