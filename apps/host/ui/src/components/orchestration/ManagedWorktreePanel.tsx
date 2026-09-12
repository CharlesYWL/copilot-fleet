import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type {
  IntegrationPreview,
  ManagedWorktree,
  Placement,
  Run,
  RunWorkspaceBinding,
  WorktreeIntegration,
  WorktreeOperation,
} from "@fleet/protocol";
import { api } from "../../hooks/useFleet";

type WorktreeView = {
  binding?: RunWorkspaceBinding;
  worktree?: ManagedWorktree;
  source?: Placement;
  version: number;
  operations: WorktreeOperation[];
  integrations: WorktreeIntegration[];
  targets: Placement[];
};
type Confirmation = {
  action: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  operationId: string;
  phrase?: string;
  phraseLabel?: string;
  reviewed?: boolean;
};
const useStyles = makeStyles({
  panel: {
    padding: "16px",
    marginBottom: "22px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap", marginBlock: "10px" },
  metadata: {
    display: "grid",
    gridTemplateColumns: "minmax(80px, 120px) minmax(0, 1fr)",
    gap: "5px",
    "& dd": { margin: 0, overflowWrap: "anywhere" },
  },
  diff: {
    maxHeight: "320px",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    background: tokens.colorNeutralBackground2,
    padding: "10px",
  },
});
const status = (value: boolean | null | undefined) =>
  value == null ? "Unknown" : value ? "Yes" : "No";

export function ManagedWorktreePanel({ run }: { run: Run }) {
  const styles = useStyles();
  const [view, setView] = useState<WorktreeView>();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<IntegrationPreview>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [phrase, setPhrase] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [commit, setCommit] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const focusRestoration = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (focusRestoration.current !== undefined)
        cancelAnimationFrame(focusRestoration.current);
    },
    [],
  );
  const targetId = useId();
  const managed = run.workspaceBinding?.effectiveMode === "managed";
  const refresh = useCallback(async () => {
    const next = await api<WorktreeView>(`/api/runs/${run.id}/worktree`);
    setView(next);
  }, [run.id]);
  useEffect(() => {
    if (!managed) return;
    let active = true;
    void refresh().catch((reason: unknown) => {
      if (active)
        setError(
          reason instanceof Error ? reason.message : "Worktree state unavailable.",
        );
    });
    return () => {
      active = false;
    };
  }, [managed, refresh, run.updatedAt]);
  const pending = view?.operations.some(
    (entry) => entry.state === "intent" || entry.state === "uncertain",
  );
  useEffect(() => {
    if (!managed || !pending) return;
    const timer = setTimeout(() => {
      void refresh().catch(() => undefined);
    }, 3_000);
    return () => clearTimeout(timer);
  }, [managed, pending, view, refresh]);

  const close = () => {
    setConfirmation(undefined);
    setPhrase("");
    setReviewed(false);
    setCommit(false);
    setDeleteBranch(false);
    if (focusRestoration.current !== undefined)
      cancelAnimationFrame(focusRestoration.current);
    const previousTrigger = trigger.current;
    focusRestoration.current = requestAnimationFrame(() => {
      focusRestoration.current = undefined;
      previousTrigger?.focus();
    });
  };
  const confirm = (
    event: React.MouseEvent<HTMLButtonElement>,
    value: Omit<Confirmation, "operationId">,
  ) => {
    // A previous dialog must not steal focus out of this new confirmation.
    if (focusRestoration.current !== undefined) {
      cancelAnimationFrame(focusRestoration.current);
      focusRestoration.current = undefined;
    }
    trigger.current = event.currentTarget;
    setError("");
    setConfirmation({ ...value, operationId: crypto.randomUUID() });
  };
  const execute = async (
    action: string,
    payload: Record<string, unknown> = {},
    operationId: string = crypto.randomUUID(),
  ) => {
    setBusy(true);
    setError("");
    setProgress(`Running ${action.replaceAll("-", " ")}…`);
    try {
      const result = await api<{ operation: WorktreeOperation }>(
        `/api/runs/${run.id}/worktree/${action}`,
        {
          method: "POST",
          body: JSON.stringify({
            operationId,
            expectedVersion: view?.version ?? 0,
            ...payload,
          }),
        },
      );
      if (result.operation.result?.preview) setPreview(result.operation.result.preview);
      setProgress(
        result.operation.result
          ? `${action.replaceAll("-", " ")} completed.`
          : "Awaiting Node acknowledgement. Ownership is not released by timeout.",
      );
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Worktree operation failed.");
      setProgress("");
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  };
  const binding = view?.binding ?? run.workspaceBinding;
  if (!managed)
    return (
      <section className={styles.panel} aria-label="Workspace isolation">
        <h2>Workspace isolation: Legacy</h2>
        <p>
          Requested: {binding?.requestedMode ?? "legacy"} · Source:{" "}
          {binding?.resolutionSource ?? "historical"}. Uses the source checkout and its
          existing writer serialization. No managed worktree is allocated.
        </p>
      </section>
    );
  const tree = view?.worktree;
  const observation = tree?.observation;
  const integration = view?.integrations[view.integrations.length - 1];
  const quarantined =
    binding?.initialization === "quarantined" || tree?.state === "quarantined";
  const available = Boolean(
    tree &&
    ["ready", "retained"].includes(tree.state) &&
    !tree.abandonedAt &&
    !quarantined,
  );
  const blocked = busy || quarantined || !available;
  const canAbandon =
    tree &&
    !quarantined &&
    !tree.abandonedAt &&
    !["removed", "unavailable", "needs_reconciliation"].includes(tree.state);
  const ongoingMerge =
    integration &&
    [
      "ready",
      "validating",
      "conflicted",
      "resolving",
      "uncertain",
      "needs_reconciliation",
      "integrating",
    ].includes(integration.state);
  const setupState =
    binding?.setupState && binding.setupState !== "not_required"
      ? binding.setupState
      : binding?.initialization === "ready"
        ? "succeeded"
        : binding?.initialization === "blocked"
          ? "failed"
          : binding?.initialization === "reserved"
            ? "running"
            : "pending";
  const sourceLabel =
    view?.source?.workspaceName ??
    view?.targets.find((entry) => entry.id === binding?.sourcePlacementId)
      ?.workspaceName ??
    "the selected repository";
  const baseLabel =
    binding?.baseRef ||
    tree?.baseRef ||
    (binding?.baseSha ? binding.baseSha.slice(0, 12) : "current committed HEAD");

  return (
    <section className={styles.panel} aria-label="Managed task worktree">
      <h2>Isolated workspace</h2>
      <p>
        An isolated workspace is created from {sourceLabel} at <code>{baseLabel}</code>.
      </p>
      <p role="status" aria-live="polite">
        <strong>Preparing isolated workspace:</strong>{" "}
        {setupState === "succeeded"
          ? "Ready"
          : setupState === "failed"
            ? "Failed"
            : "In progress"}
      </p>
      {setupState === "failed" && (
        <>
          <p role="alert">
            {binding?.setupSummary ||
              "Fleet could not prepare the isolated workspace. Review details and retry."}
          </p>
          <div className={styles.actions}>
            <Button
              disabled={busy || quarantined}
              onClick={() => void execute("retry-create")}
            >
              Retry workspace setup
            </Button>
            {!tree && binding?.error.includes("active Git hooks") && (
              <Button
                disabled={busy || quarantined}
                onClick={(event) =>
                  confirm(event, {
                    action: "retry-with-hooks",
                    title: "Allow repository Git hooks?",
                    detail:
                      "Fleet and task agents may execute this repository’s configured Git hooks. Hooks can run arbitrary repository-defined code and may change files or delay Git commands. This consent applies only to this managed task and does not change repository configuration.",
                    payload: { allowGitHooks: true },
                    phrase: "ALLOW REPOSITORY GIT HOOKS",
                    phraseLabel: "Type the exact Git hooks confirmation",
                  })
                }
              >
                Allow Git hooks and retry
              </Button>
            )}
          </div>
        </>
      )}
      <details>
        <summary>Workspace details</summary>
        <p>
          Requested: {binding?.requestedMode} · Effective: {binding?.effectiveMode} ·
          Resolution: {binding?.resolutionSource}
        </p>
        <p>
          Implementer, reviewer, tester and fixer share this binding, including
          uncommitted changes. Only one shell-capable session may hold it. Stop verifies
          process quiescence; idle is not sufficient.
        </p>
        <p role="status" aria-live="polite">
          {progress ||
            `Lifecycle: ${tree?.state ?? binding?.initialization ?? "Unknown"}`}
        </p>
        {!confirmation && error && <p role="alert">{error}</p>}
        {(binding?.error || tree?.error) && (
          <p role="alert">{binding?.error || tree?.error}</p>
        )}
        {quarantined && (
          <p>
            Restored metadata is quarantined. Backup contains no worktree files, locks or
            process ownership. Explicit reconciliation is required before resume,
            integration or cleanup.
          </p>
        )}
        {tree?.abandonedAt && (
          <p>
            Ownership abandoned. Files and branch were kept; Fleet will not adopt or clean
            them.
          </p>
        )}
        {tree && (
          <dl className={styles.metadata}>
            <dt>Node</dt>
            <dd>
              {view?.targets.find((entry) => entry.id === tree.sourcePlacementId)
                ?.nodeName ?? tree.nodeId}
            </dd>
            <dt>Branch</dt>
            <dd>
              <code>{tree.branchRef}</code>
            </dd>
            <dt>Path</dt>
            <dd>
              <code>{tree.path}</code>
            </dd>
            <dt>Base SHA</dt>
            <dd>
              <code>{tree.baseSha}</code>
            </dd>
            <dt>HEAD</dt>
            <dd>
              <code>{observation?.head || "Unknown"}</code>
            </dd>
            <dt>Generation</dt>
            <dd>
              {tree.generation} · revision {view?.version}
            </dd>
            <dt>Lock holder</dt>
            <dd>
              {observation?.lockHolder ||
                (observation?.locked == null ? "Unknown" : "None at observation")}
            </dd>
            <dt>Dirty</dt>
            <dd>{status(observation?.dirty)}</dd>
            <dt>Changes</dt>
            <dd>
              Staged: {status(observation?.staged)}; unstaged:{" "}
              {status(observation?.unstaged)}; untracked: {status(observation?.untracked)}
              ; ignored: {status(observation?.ignored)}
            </dd>
            <dt>Ahead / behind</dt>
            <dd>
              {observation?.ahead ?? "Unknown"} / {observation?.behind ?? "Unknown"}{" "}
              relative to pinned base
            </dd>
            <dt>Repository features</dt>
            <dd>
              {[
                tree.repositoryFeatures.sparseCheckout && "sparse checkout inherited",
                tree.repositoryFeatures.submodules && "submodules initialized",
                tree.repositoryFeatures.gitLfs && "Git LFS enabled",
                tree.repositoryFeatures.partialClone && "partial clone",
              ]
                .filter(Boolean)
                .join("; ") || "Standard checkout"}
            </dd>
            <dt>Observed</dt>
            <dd>
              {observation?.observedAt ?? "Never"} (not a current cleanliness guarantee)
            </dd>
            <dt>Retention</dt>
            <dd>
              {tree.orphanedAt
                ? `Retained orphan candidate since ${tree.orphanedAt}. ${tree.orphanReason} `
                : ""}
              {tree.expiresAt
                ? `Eligible after ${tree.expiresAt}, only if still clean, integrated and inactive.`
                : "Retained until explicit safe cleanup; no dirty eviction."}
            </dd>
            <dt>Integration</dt>
            <dd>{integration?.state ?? tree.integrationState}</dd>
          </dl>
        )}
        <div className={styles.actions}>
          <Button disabled={busy} onClick={() => void execute("reconcile")}>
            Reconcile worktree
          </Button>
          <Button disabled={blocked} onClick={() => void execute("observe")}>
            Refresh Git observation
          </Button>
          <Button disabled={blocked} onClick={() => void execute("retain")}>
            Retain worktree
          </Button>
          <Button
            disabled={blocked}
            onClick={(event) =>
              confirm(event, {
                action: "quiesce",
                title: "Stop checkout sessions?",
                detail:
                  "Stop this task’s processes and any sessions on the selected target. Conversations and all working files remain intact.",
                payload: {
                  confirm: "STOP TASK AND SELECTED TARGET SESSIONS",
                  ...(target ? { targetPlacementId: target } : {}),
                },
              })
            }
          >
            Stop checkout sessions
          </Button>
        </div>
        <h3>Explicit merge integration</h3>
        <p>
          Task approval and integration are separate. Choose the target yourself; Fleet
          never selects or switches main, pushes, or creates a PR.
        </p>
        <label htmlFor={targetId}>Target checkout on the owning Node</label>{" "}
        <select
          id={targetId}
          value={target}
          disabled={blocked || Boolean(ongoingMerge)}
          onChange={(event) => {
            setTarget(event.target.value);
            setPreview(undefined);
          }}
        >
          <option value="">Choose a target checkout</option>
          {view?.targets.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.workspaceName} · {entry.localPath}
            </option>
          ))}
        </select>
        <div className={styles.actions}>
          <Button
            disabled={blocked || !target || Boolean(ongoingMerge)}
            onClick={() =>
              void execute("integration-preview", { targetPlacementId: target })
            }
          >
            Preview integration
          </Button>
        </div>
        {preview && (
          <div aria-label="Integration preview">
            <p>
              Target path: <code>{preview.target.path}</code>
            </p>
            <p>
              Target branch: <code>{preview.targetRef}</code> · Target SHA:{" "}
              <code>{preview.targetSha}</code>
            </p>
            <p>
              Reviewed task SHA: <code>{preview.taskSha}</code>
            </p>
            <p>
              Diff identity: <code>{preview.diffIdentity}</code>
            </p>
            <p>
              Task dirty: {status(preview.taskDirty)} · Target dirty:{" "}
              {status(preview.targetDirty)}
            </p>
            <p>
              Committed task changes: {status(preview.hasCommittedChanges)} · Target
              baseline:{" "}
              {preview.targetAdvancedFromBase
                ? "advanced from the pinned base"
                : preview.baseContainedByTarget
                  ? "contains the pinned base"
                  : "does not contain the pinned base"}
              {preview.alreadyIntegrated
                ? " · Reviewed task commit already reachable from target"
                : ""}
            </p>
            <pre className={styles.diff} aria-label="Reviewed task diff">
              {preview.diff || "No committed diff from the pinned base."}
            </pre>
            <Button
              disabled={
                blocked ||
                preview.taskDirty ||
                preview.targetDirty ||
                Boolean(ongoingMerge)
              }
              onClick={(event) =>
                confirm(event, {
                  action: "integration-start",
                  title: preview.hasCommittedChanges
                    ? "Merge the reviewed task commit?"
                    : "Record that this task has no committed changes?",
                  reviewed: preview.hasCommittedChanges,
                  detail: preview.hasCommittedChanges
                    ? `Merge ${preview.taskSha} into ${preview.targetRef} at ${preview.target.path}. The preview and target HEAD are verified again under repository and checkout locks. Conflicts reserve the target; the task worktree is kept.`
                    : `The task has no committed diff from its pinned base. Revalidate ${preview.targetRef} and record a no-changes integration result without running git merge.`,
                  payload: {
                    previewId: preview.id,
                    reviewedTaskSha: preview.taskSha,
                    reviewedDiffIdentity: preview.diffIdentity,
                    confirm: preview.hasCommittedChanges
                      ? `MERGE ${preview.taskSha} INTO ${preview.targetRef}`
                      : `REVIEW NO CHANGES FOR ${preview.taskSha}`,
                  },
                })
              }
            >
              {preview.hasCommittedChanges
                ? "Merge reviewed commit"
                : "Record no committed changes"}
            </Button>
          </div>
        )}
        {integration && (
          <p>
            Validation: {integration.validationState}
            {integration.validationSummary ? ` — ${integration.validationSummary}` : ""}
          </p>
        )}
        {ongoingMerge && integration && (
          <div aria-label="Integration recovery">
            <p>
              Integration {integration.id}: {integration.state}. Target:{" "}
              <code>{integration.preview.target.path}</code>.
            </p>
            <p>
              The target remains reserved. Resolve conflicts in that target using your
              editor and stage the resolved files; Fleet does not resolve conflicts or
              reset files automatically.
            </p>
            {integration.error && <p role="alert">{integration.error}</p>}
            {integration.conflicts.length > 0 && (
              <ul aria-label="Conflicting paths">
                {integration.conflicts.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            )}
            <div className={styles.actions}>
              <Button
                disabled={blocked}
                onClick={(event) =>
                  confirm(event, {
                    action: "integration-continue",
                    title: "Commit the resolved merge?",
                    detail:
                      "Only staged, verified conflict resolution will be committed. Noninteractive identity and signing policy must be supported. No push is performed.",
                    payload: {
                      integrationId: integration.id,
                      confirm: `COMMIT MERGE ${integration.id}`,
                      commit: true,
                    },
                  })
                }
              >
                Continue resolved merge
              </Button>
              <Button
                disabled={blocked}
                onClick={(event) =>
                  confirm(event, {
                    action: "integration-abort",
                    title: "Abort this merge?",
                    detail: `Abort only operation ${integration.id} in ${integration.preview.target.path}. Resolution edits in that target merge are at risk. The task worktree and its branch remain intact.`,
                    payload: {
                      integrationId: integration.id,
                      confirm: `ABORT MERGE ${integration.id}`,
                    },
                  })
                }
              >
                Abort merge
              </Button>
            </div>
          </div>
        )}
        <h3>Cleanup</h3>
        <p>
          Stop, approval and archive retain the checkout. Removal requires fresh verified
          ownership, no active process or integration, and no staged, unstaged, untracked
          or ignored data. Cleanup never force-removes, recursively deletes or prunes the
          repository.
        </p>
        <div className={styles.actions}>
          <Button
            disabled={blocked || Boolean(ongoingMerge)}
            onClick={(event) =>
              confirm(event, {
                action: "cleanup",
                title: "Remove this clean worktree?",
                detail: `${tree!.branchRef} at ${tree!.path}. Git will refuse any dirty or active checkout. The task branch is kept by default.`,
                payload: {},
              })
            }
          >
            Remove clean worktree
          </Button>
          <Button
            disabled={busy || !canAbandon || Boolean(ongoingMerge)}
            onClick={(event) =>
              confirm(event, {
                action: "abandon",
                title: "Abandon Fleet ownership?",
                detail: `Keep all data and branch ${tree!.branchRef} at ${tree!.path}, but relinquish Fleet lifecycle management. Purging the task afterwards loses its conversation/history references. No files are deleted.`,
                phrase: `ABANDON ${tree!.branchRef} AT ${tree!.path}; KEEP FILES`,
                payload: {},
              })
            }
          >
            Abandon ownership
          </Button>
        </div>
      </details>
      {/* Do not reuse a closing portal's modal/aria-hidden ownership for a new operation. */}
      <Dialog
        key={confirmation?.operationId ?? "closed"}
        open={Boolean(confirmation)}
        onOpenChange={(_, data) => {
          if (!data.open && !busy) close();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogContent>
              <p>{confirmation?.detail}</p>
              {confirmation?.phrase && (
                <Field
                  label={
                    confirmation.phraseLabel ?? "Type the exact abandonment confirmation"
                  }
                  hint={confirmation.phrase}
                >
                  <Input value={phrase} onChange={(_, data) => setPhrase(data.value)} />
                </Field>
              )}
              {confirmation?.reviewed && (
                <>
                  <Checkbox
                    label="I approve this exact task SHA and reviewed diff for the selected target"
                    checked={reviewed}
                    onChange={(_, data) => setReviewed(data.checked === true)}
                  />
                  <Checkbox
                    label="Commit after a successful merge if identity and signing policy allow (otherwise leave staged)"
                    checked={commit}
                    onChange={(_, data) => setCommit(data.checked === true)}
                  />
                </>
              )}
              {confirmation?.action === "cleanup" && (
                <Checkbox
                  label="Also request safe branch deletion after reachability/integration checks"
                  checked={deleteBranch}
                  onChange={(_, data) => setDeleteBranch(data.checked === true)}
                />
              )}
              {error && <p role="alert">{error}</p>}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={
                  busy ||
                  Boolean(confirmation?.phrase && phrase !== confirmation.phrase) ||
                  Boolean(confirmation?.reviewed && !reviewed)
                }
                onClick={() =>
                  confirmation &&
                  void execute(
                    confirmation.action,
                    {
                      ...confirmation.payload,
                      ...(confirmation.phrase ? { confirm: phrase } : {}),
                      ...(confirmation.reviewed ? { commit } : {}),
                      ...(confirmation.action === "cleanup" ? { deleteBranch } : {}),
                    },
                    confirmation.operationId,
                  )
                }
              >
                Confirm {confirmation?.action.replaceAll("-", " ")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
