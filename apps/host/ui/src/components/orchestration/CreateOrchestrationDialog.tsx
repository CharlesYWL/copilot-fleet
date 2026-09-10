import { useEffect, useRef, useState } from "react";
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
import {
  DriClassificationSchema,
  errorMessage,
  type CreateOrchestration,
  type DriClassification,
  type Placement,
  type Workspace,
} from "@fleet/protocol";
import { api } from "../../hooks/useFleet";
import {
  completeOrchestrationRequest,
  orchestrationRequestKey,
} from "../../lib/orchestration-request";

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
  /** Online placements constrain regular tasks, not Host-executed DRI providers. */
  placements: Placement[];
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateOrchestration) => Promise<boolean>;
};

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
  const [workflow, setWorkflow] = useState<"auto" | "regular" | "dri">("auto");
  const [icm, setIcm] = useState("");
  const [artifactRef, setArtifactRef] = useState("");
  const [preview, setPreview] = useState<{ input: string; value: DriClassification }>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const submitting = useRef(false);
  const submission = useRef<{ input: string; requestId: string } | undefined>(undefined);
  const incidentInput = useRef<HTMLInputElement>(null);
  const hints =
    workflow !== "regular" && (icm.trim() || artifactRef.trim())
      ? {
          dri: {
            ...(icm.trim() ? { icm: icm.trim() } : {}),
            ...(artifactRef.trim() ? { artifactRef: artifactRef.trim() } : {}),
          },
        }
      : {};
  const routingInput = JSON.stringify({
    objective: objective.trim(),
    workflow,
    ...hints,
  });
  const classification = preview?.input === routingInput ? preview.value : undefined;
  const isDri = workflow === "dri" || classification?.route === "dri";
  const available =
    isDri || (workflow === "auto" && classification?.route !== "regular")
      ? workspaces
      : reachable;

  useEffect(() => {
    if (!open) return;
    setName("");
    setObjective("");
    setWorkflow("auto");
    setIcm("");
    setArtifactRef("");
    setPreview(undefined);
    setError("");
    submission.current = undefined;
    setWorkspaceId((current) =>
      reachable.some((workspace) => workspace.id === current)
        ? current
        : (reachable[0]?.id ?? workspaces[0]?.id ?? ""),
    );
    // Re-seeded each time it opens; the workspace list is read fresh then too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !objective.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError("");
      void api<unknown>("/api/orchestrations/preview", {
        method: "POST",
        body: routingInput,
        signal: controller.signal,
      })
        .then((raw) => {
          if (!controller.signal.aborted)
            setPreview({
              input: routingInput,
              value: DriClassificationSchema.parse(raw),
            });
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(
              errorMessage(
                reason,
                "Unable to classify this request. Retry or choose Regular explicitly.",
              ),
            );
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, objective, routingInput, retry]);

  const chosen = available.find((workspace) => workspace.id === workspaceId);
  const confirmed =
    workflow === "regular" ||
    (classification &&
      !classification.requiresConfirmation &&
      !classification.needsIncident);
  const canCreate =
    Boolean(chosen) && objective.trim().length > 0 && Boolean(confirmed) && !busy;

  const submit = async () => {
    if (!canCreate || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const input: CreateOrchestration = {
      workspaceId,
      name: name.trim() || objective.trim().slice(0, 60),
      objective: objective.trim(),
      workflow,
      ...hints,
    };
    const serialized = JSON.stringify(input);
    try {
      if (submission.current?.input !== serialized)
        submission.current = {
          input: serialized,
          requestId: await orchestrationRequestKey(serialized),
        };
      const created = await onCreate({
        ...input,
        requestId: submission.current.requestId,
      });
      if (created) {
        completeOrchestrationRequest(submission.current.requestId);
        onOpenChange(false);
      } else
        setError(
          "Task creation was not confirmed. Retry safely with the same request key.",
        );
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          "Unable to create task. The request key is retained for a safe retry.",
        ),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!busy) onOpenChange(data.open);
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New task</DialogTitle>
          <DialogContent>
            <Field label="Workflow">
              <select
                aria-label="Workflow"
                value={workflow}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "auto" || value === "regular" || value === "dri")
                    setWorkflow(value);
                }}
              >
                <option value="auto">Auto</option>
                <option value="regular">Regular</option>
                <option value="dri">DRI investigation</option>
              </select>
            </Field>
            <Field label="What should be done?" required>
              <Textarea
                value={objective}
                rows={4}
                maxLength={4_000}
                disabled={busy}
                placeholder="Describe the outcome. Auto detects read-only DRI investigations; other requests use the regular orchestrator."
                onChange={(_, data) => setObjective(data.value)}
              />
            </Field>
            {workflow === "auto" &&
              classification &&
              classification.route !== "regular" && (
                <div
                  role={classification.requiresConfirmation ? "alert" : "status"}
                  aria-live="polite"
                >
                  <p>
                    {classification.requiresConfirmation
                      ? "Confirm workflow"
                      : "Detected DRI investigation"}{" "}
                    ({Math.round(classification.confidence * 100)}%).{" "}
                    {classification.explanation}
                  </p>
                  {classification.incident && (
                    <p>
                      ICM {classification.incident.id}. Profile: Auto after verified
                      incident ingestion.
                    </p>
                  )}
                  {classification.requiresConfirmation && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setWorkflow("dri");
                        if (classification.candidateIncidentId)
                          setIcm(classification.candidateIncidentId);
                        incidentInput.current?.focus();
                      }}
                    >
                      Use DRI investigation
                    </Button>
                  )}{" "}
                  <Button disabled={busy} onClick={() => setWorkflow("regular")}>
                    Use Regular
                  </Button>
                </div>
              )}
            {(isDri || classification?.needsIncident) && (
              <>
                <Field
                  label="ICM URL or ID"
                  required={classification?.needsIncident ?? false}
                  hint="Confirm that this is an ICM incident. This never selects tools or a team profile."
                >
                  <Input
                    input={{ ref: incidentInput }}
                    aria-label="ICM URL or ID"
                    value={icm}
                    disabled={busy}
                    maxLength={512}
                    placeholder={classification?.incident?.id ?? ""}
                    onChange={(_, data) => setIcm(data.value)}
                  />
                </Field>
                <Field
                  label="HAR / attachment reference"
                  hint="Optional approved artifact reference, not a local path."
                >
                  <Input
                    value={artifactRef}
                    disabled={busy}
                    maxLength={160}
                    onChange={(_, data) => setArtifactRef(data.value)}
                  />
                </Field>
                <p className={styles.footnote}>
                  Read-only MCP providers are discovered automatically. Missing
                  capabilities create a blocked or partial investigation, never synthetic
                  success.
                </p>
              </>
            )}
            {objective.trim() && !classification && workflow !== "regular" && !error && (
              <p role="status">Checking workflow…</p>
            )}
            {error && (
              <p role="alert">
                {error}{" "}
                <Button disabled={busy} onClick={() => setRetry((value) => value + 1)}>
                  Retry classification
                </Button>
              </p>
            )}
            {available.length === 0 && (
              <p>
                No online node holds a workspace yet, so a regular task cannot run. Add a
                placement in Settings. DRI investigations run on the Host.
              </p>
            )}
            <Field label="Workspace">
              <Dropdown
                value={chosen?.name ?? ""}
                disabled={busy}
                selectedOptions={workspaceId ? [workspaceId] : []}
                onOptionSelect={(_, data) => setWorkspaceId(data.optionValue ?? "")}
              >
                {available.map((workspace) => (
                  <Option key={workspace.id} value={workspace.id} text={workspace.name}>
                    {workspace.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Name" hint="Optional. Taken from the objective if empty.">
              <Input
                value={name}
                maxLength={80}
                disabled={busy}
                onChange={(_, data) => setName(data.value)}
              />
            </Field>
            {!isDri && (
              <p className={styles.footnote}>
                This records the task, then asks the orchestrator — in its conversation —
                to plan it. You can ask for the same thing by talking to it directly;
                doing it here means the task is on the board either way, even if the
                orchestrator is busy or misreads you.
              </p>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              appearance="secondary"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
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
