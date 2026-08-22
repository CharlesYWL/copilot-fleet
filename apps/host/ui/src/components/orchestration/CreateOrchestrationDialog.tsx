import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { Placement, Workspace } from "@fleet/protocol";

const useStyles = makeStyles({
  /** What pressing the button does, said once, where the decision is made. */
  footnote: {
    margin: "4px 0 0",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
});

export type CreateOrchestrationDialogProps = {
  open: boolean;
  workspaces: Workspace[];
  /** Only placements on an online node; a task needs somewhere to run. */
  placements: Placement[];
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    workspaceId: string;
    name: string;
    objective: string;
  }) => Promise<boolean>;
};

/**
 * Opening a task on the orchestrator.
 *
 * The objective is the only required field: it is what the orchestrator reads
 * to decide the phases, so a vague one produces a vague plan. The name is
 * optional because it is a label for the person, and the orchestrator will
 * pick a reasonable one from the objective if none is given.
 *
 * Creating is a single Host call. Doing it here as "create the run, then tell
 * the lead" would leave a task nothing is working on whenever the second half
 * failed, and the operator would have no way to tell.
 */
export const CreateOrchestrationDialog = ({
  open,
  workspaces,
  placements,
  onOpenChange,
  onCreate,
}: CreateOrchestrationDialogProps) => {
  const styles = useStyles();
  const reachable = workspaces.filter((workspace) =>
    placements.some((placement) => placement.workspaceId === workspace.id),
  );
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setObjective("");
    setWorkspaceId((current) =>
      reachable.some((workspace) => workspace.id === current)
        ? current
        : (reachable[0]?.id ?? ""),
    );
    // Re-seeded each time it opens; the workspace list is read fresh then too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chosen = reachable.find((workspace) => workspace.id === workspaceId);
  const canCreate = Boolean(workspaceId) && objective.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    const created = await onCreate({
      workspaceId,
      name: name.trim() || objective.trim().slice(0, 60),
      objective: objective.trim(),
    });
    setBusy(false);
    if (created) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New task</DialogTitle>
          <DialogContent>
            {reachable.length === 0 ? (
              <p>
                No online node holds a workspace yet, so there is nowhere for a task to
                run. Add a placement in Settings first.
              </p>
            ) : (
              <>
                <Field label="What should be done?" required>
                  <Textarea
                    value={objective}
                    rows={4}
                    placeholder="Describe the outcome. The orchestrator decides the phases and dispatches the work."
                    onChange={(_, data) => setObjective(data.value)}
                  />
                </Field>
                <Field label="Workspace">
                  <Dropdown
                    value={chosen?.name ?? ""}
                    selectedOptions={workspaceId ? [workspaceId] : []}
                    onOptionSelect={(_, data) => setWorkspaceId(data.optionValue ?? "")}
                  >
                    {reachable.map((workspace) => (
                      <Option
                        key={workspace.id}
                        value={workspace.id}
                        text={workspace.name}
                      >
                        {workspace.name}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Name" hint="Optional. Taken from the objective if empty.">
                  <Input value={name} onChange={(_, data) => setName(data.value)} />
                </Field>
                <p className={styles.footnote}>
                  This records the task, then asks the orchestrator — in its conversation
                  — to plan it. You can ask for the same thing by talking to it directly;
                  doing it here means the task is on the board either way, even if the
                  orchestrator is busy or misreads you.
                </p>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!canCreate}
              onClick={() => void submit()}
            >
              Create task
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
