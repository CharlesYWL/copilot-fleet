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
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { Placement } from "@fleet/protocol";

const useStyles = makeStyles({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  yoloHint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    marginTop: "2px",
  },
});

type NewSessionDialogProps = {
  open: boolean;
  placements: Placement[];
  defaultYolo: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (placementId: string, prompt: string, yolo: boolean) => Promise<boolean>;
};

export const NewSessionDialog = ({
  open,
  placements,
  defaultYolo,
  onOpenChange,
  onCreate,
}: NewSessionDialogProps) => {
  const styles = useStyles();
  const [placementId, setPlacementId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [yolo, setYolo] = useState(defaultYolo);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setYolo(defaultYolo);
  }, [open, defaultYolo]);

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
    const created = await onCreate(placementId, prompt.trim(), yolo);
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
              <Field label="YOLO mode">
                <Switch
                  checked={yolo}
                  label={yolo ? "Allow all tools without asking" : "Ask before each tool"}
                  onChange={(_event, data) => setYolo(data.checked)}
                />
                <span className={styles.yoloHint}>
                  Runs Copilot with --allow-all, so it executes commands on{" "}
                  {placements.find((item) => item.id === placementId)?.nodeName ??
                    "the node"}{" "}
                  without waiting for approval.
                </span>
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
