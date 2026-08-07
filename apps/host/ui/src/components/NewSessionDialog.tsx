import { useEffect, useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Select,
  Textarea,
  makeStyles,
} from "@fluentui/react-components";
import type { Placement } from "@fleet/protocol";

const useStyles = makeStyles({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
});

type NewSessionDialogProps = {
  open: boolean;
  placements: Placement[];
  onOpenChange: (open: boolean) => void;
  onCreate: (placementId: string, prompt: string) => Promise<boolean>;
};

export const NewSessionDialog = ({
  open,
  placements,
  onOpenChange,
  onCreate,
}: NewSessionDialogProps) => {
  const styles = useStyles();
  const [placementId, setPlacementId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPrompt("");
  }, [open]);

  // Node heartbeats hand down a fresh placements array every few seconds, so
  // only correct the selection when it actually stopped being valid.
  useEffect(() => {
    if (!open) return;
    setPlacementId((current) =>
      placements.some((placement) => placement.id === current)
        ? current
        : (placements[0]?.id ?? ""),
    );
  }, [open, placements]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!placementId || prompt.trim().length === 0) return;
    setSubmitting(true);
    const created = await onCreate(placementId, prompt.trim());
    setSubmitting(false);
    if (created) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(_event, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <form onSubmit={handleSubmit}>
          <DialogBody>
            <DialogTitle>Start a session</DialogTitle>
            <DialogContent className={styles.form}>
              <Field
                label="Workspace placement"
                required
                {...(placements.length === 0
                  ? { hint: "No online node has a placement yet. Add one under Workspaces." }
                  : {})}
              >
                <Select
                  value={placementId}
                  disabled={placements.length === 0}
                  onChange={(_event, data) => setPlacementId(data.value)}
                >
                  {placements.map((placement) => (
                    <option key={placement.id} value={placement.id}>
                      {placement.workspaceName} · {placement.nodeName} · {placement.localPath}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Initial prompt" required>
                <Textarea
                  value={prompt}
                  onChange={(_event, data) => setPrompt(data.value)}
                  placeholder="Describe the first task for this agent…"
                  resize="vertical"
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                type="submit"
                disabled={submitting || !placementId || prompt.trim().length === 0}
              >
                Start session
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
};
