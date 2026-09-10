import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Delete20Regular } from "@fluentui/react-icons";
import type { FleetSession } from "@fleet/protocol";
import { sessionLabel } from "../lib/session-label";

const useStyles = makeStyles({
  surface: { width: "min(520px, calc(100vw - 32px))" },
  intro: { marginTop: 0, color: tokens.colorNeutralForeground3 },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: "8px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  count: { color: tokens.colorNeutralForeground3, fontVariantNumeric: "tabular-nums" },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "50vh",
    overflowY: "auto",
    paddingTop: "8px",
  },
  item: {
    padding: "6px 8px",
    borderRadius: tokens.borderRadiusMedium,
    ":hover": { background: tokens.colorNeutralBackground2 },
  },
});

export type OrchestratorCleanupDialogProps = {
  open: boolean;
  orchestrators: readonly FleetSession[];
  onClose: () => void;
  onCleanup: (sessionIds: string[]) => Promise<boolean>;
};

export const OrchestratorCleanupDialog = ({
  open,
  orchestrators,
  onClose,
  onCleanup,
}: OrchestratorCleanupDialogProps) => {
  const styles = useStyles();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(orchestrators.map((session) => session.id)));
    setSubmitting(false);
  }, [open, orchestrators]);

  const setAll = (checked: boolean) =>
    setSelected(
      checked ? new Set(orchestrators.map((session) => session.id)) : new Set(),
    );
  const allSelected = orchestrators.length > 0 && selected.size === orchestrators.length;

  return (
    <Dialog open={open} onOpenChange={(_event, data) => !data.open && onClose()}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Clean up orchestrators</DialogTitle>
          <DialogContent>
            <p className={styles.intro}>
              Move stopped conversations to Dismissed. Transcripts and task history are
              preserved and can be restored later.
            </p>
            <div className={styles.toolbar}>
              <Checkbox
                checked={allSelected ? true : selected.size > 0 ? "mixed" : false}
                label="Select all orchestrators"
                onChange={(_event, data) => setAll(data.checked === true)}
              />
              <span className={styles.count}>{selected.size} selected</span>
            </div>
            <div className={styles.list}>
              {orchestrators.map((orchestrator) => (
                <Checkbox
                  className={styles.item}
                  key={orchestrator.id}
                  checked={selected.has(orchestrator.id)}
                  label={sessionLabel(orchestrator)}
                  onChange={(_event, data) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (data.checked === true) next.add(orchestrator.id);
                      else next.delete(orchestrator.id);
                      return next;
                    })
                  }
                />
              ))}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={submitting} onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              icon={<Delete20Regular />}
              disabled={selected.size === 0 || submitting}
              onClick={() => {
                setSubmitting(true);
                void onCleanup([...selected]).then((ok) => {
                  setSubmitting(false);
                  if (ok) onClose();
                });
              }}
            >
              Clean up selected ({selected.size})
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
