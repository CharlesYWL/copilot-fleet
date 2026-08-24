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
  Input,
  Select,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { SESSION_NAME_MAX_LENGTH, type Placement } from "@fleet/protocol";

const useStyles = makeStyles({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    // A placement option spells out a full path, and the Select sizes itself to
    // that text; without this the dialog grows a horizontal scrollbar instead of
    // letting the control shrink to the surface.
    minWidth: 0,
  },
  placementField: {
    minWidth: 0,
  },
  // The Select's own wrapper defaults to min-width:auto, so it sizes to the
  // longest option — a full placement path — and pushes past the dialog no
  // matter how narrow its Field is. Constraining the Field alone is not enough
  // because the overflow happens one level deeper.
  placementSelect: {
    minWidth: 0,
    maxWidth: "100%",
    "& select": {
      minWidth: 0,
      width: "100%",
    },
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
  onCreate: (
    placementId: string,
    prompt: string,
    yolo: boolean,
    name: string,
  ) => Promise<boolean>;
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
  const [name, setName] = useState("");
  const [yolo, setYolo] = useState(defaultYolo);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setName("");
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
    const created = await onCreate(placementId, prompt.trim(), yolo, name.trim());
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
                label="Where to run"
                required
                className={styles.placementField}
                {...(placements.length === 0
                  ? {
                      hint: "No online node has a placement yet. Add one under Workspaces.",
                    }
                  : {
                      hint: "Chats runs in the node's home directory, for questions and research that need no checkout.",
                    })}
              >
                <Select
                  className={styles.placementSelect}
                  value={placementId}
                  disabled={placements.length === 0}
                  onChange={(_event, data) => setPlacementId(data.value)}
                >
                  {placements.map((placement) => (
                    <option key={placement.id} value={placement.id}>
                      {placement.workspaceName} · {placement.nodeName} ·{" "}
                      {placement.localPath}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Session name"
                hint="Optional. Without one the session is listed by its prompt."
              >
                <Input
                  value={name}
                  maxLength={SESSION_NAME_MAX_LENGTH}
                  placeholder="Router cleanup"
                  onChange={(_event, data) => setName(data.value)}
                />
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
              <Button
                appearance="secondary"
                type="button"
                onClick={() => onOpenChange(false)}
              >
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
