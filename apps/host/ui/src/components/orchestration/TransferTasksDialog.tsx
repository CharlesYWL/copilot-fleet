import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Option,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Add16Regular, ArrowForward20Regular } from "@fluentui/react-icons";
import { contextUsePercent, type FleetSession } from "@fleet/protocol";
import type { RunViewModel } from "../../lib/orchestration-view";
import { needsOrchestrator, taskStatusLabel } from "../../lib/orchestration-view";
import { sessionLabel } from "../../lib/session-label";

const useStyles = makeStyles({
  surface: { width: "min(600px, calc(100vw - 32px))" },
  content: { display: "flex", flexDirection: "column", gap: "14px" },
  lead: { margin: 0, lineHeight: "1.5" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    paddingBottom: "6px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  count: {
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    maxHeight: "36vh",
    overflowY: "auto",
  },
  task: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 8px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  taskText: { display: "flex", minWidth: 0, flexDirection: "column" },
  taskName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  taskMeta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  single: {
    margin: 0,
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
    overflowWrap: "anywhere",
  },
  empty: { margin: 0, color: tokens.colorNeutralForeground3 },
  target: { width: "100%" },
  newTarget: { alignSelf: "flex-start" },
});

export type TransferTasksDialogProps = {
  open: boolean;
  /** The conversation the tasks are assigned to now. */
  source?: FleetSession | undefined;
  models: readonly RunViewModel[];
  /** A single task from its own page: no list to choose from. */
  fixed?: boolean;
  /** Conversations able to take the work: running, not stopping, not dismissed. */
  targets: readonly FleetSession[];
  /** How many tasks each target is already responsible for, by session id. */
  assignedCounts?: Readonly<Record<string, number>>;
  onClose: () => void;
  onTransfer: (input: {
    runIds: string[];
    toSessionId: string;
    note: string;
  }) => Promise<boolean>;
  /** Starts a fresh conversation, which then appears as a target. */
  onStartOrchestrator?: (() => void) | undefined;
};

/**
 * The line a target reads as.
 *
 * Every conversation starts out called "Orchestrator", so the name alone does
 * not say which one; what the operator is choosing between is how busy each is
 * and how much room it has left.
 */
export function transferTargetLabel(target: FleetSession, assigned = 0): string {
  const used = contextUsePercent(target.usage);
  const context = used === undefined ? "" : ` · ${used}% context`;
  const started = new Date(target.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${sessionLabel(target)} · ${target.state} · ${assigned} ${
    assigned === 1 ? "task" : "tasks"
  }${context} · started ${started}`;
}

/**
 * Hands tasks from one orchestrator conversation to another.
 *
 * The way work outlives a conversation: an orchestrator has one context
 * window, and when it fills, a fresh conversation is only a way out if the work
 * in flight can follow. What moves is ownership — who is woken for the task and
 * who runs its PR-maintenance heartbeat — and nothing about the task itself.
 */
export const TransferTasksDialog = ({
  open,
  source,
  models,
  fixed = false,
  targets,
  assignedCounts = {},
  onClose,
  onTransfer,
  onStartOrchestrator,
}: TransferTasksDialogProps) => {
  const styles = useStyles();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const orderedTargets = useMemo(
    () => [...targets].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [targets],
  );

  useEffect(() => {
    if (!open) return;
    setSelected(
      new Set(
        (fixed ? models : models.filter(needsOrchestrator)).map((model) => model.run.id),
      ),
    );
    setNote("");
    setSubmitting(false);
    // Only on opening: a snapshot arriving mid-choice must not undo the choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The newest conversation is the usual destination: it is the one that was
    // just started to take this work.
    if (!orderedTargets.some((candidate) => candidate.id === target))
      setTarget(orderedTargets[0]?.id ?? "");
  }, [open, orderedTargets, target]);

  const setMany = (ids: readonly string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const chosen = models.filter((model) => selected.has(model.run.id));
  const allState =
    models.length > 0 && chosen.length === models.length
      ? true
      : chosen.length > 0
        ? "mixed"
        : false;
  const destination = orderedTargets.find((candidate) => candidate.id === target);
  const title =
    fixed && models.length === 1
      ? `Transfer “${models[0]!.run.name}”`
      : `Transfer tasks from ${source ? sessionLabel(source) : "this orchestrator"}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(_event, data) => !data.open && !submitting && onClose()}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent className={styles.content}>
            <p className={styles.lead}>
              The receiving orchestrator takes over each task — its workers, pending
              review and PR maintenance — and is briefed to continue from where it stands.
              This conversation stops seeing it; nothing about the work itself changes.
            </p>

            {fixed ? null : models.length === 0 ? (
              <p className={styles.empty}>This conversation has no tasks to transfer.</p>
            ) : (
              <section aria-label="Tasks to transfer">
                <div className={styles.toolbar}>
                  <Checkbox
                    checked={allState}
                    label="Select all tasks"
                    onChange={(_event, data) =>
                      setMany(
                        models.map((model) => model.run.id),
                        data.checked === true,
                      )
                    }
                  />
                  <span className={styles.count}>{chosen.length} selected</span>
                </div>
                <div className={styles.list}>
                  {models.map((model) => (
                    <div className={styles.task} key={model.run.id}>
                      <Checkbox
                        checked={selected.has(model.run.id)}
                        aria-label={`Select ${model.run.name}`}
                        onChange={(_event, data) =>
                          setMany([model.run.id], data.checked === true)
                        }
                      />
                      <span className={styles.taskText}>
                        <span className={styles.taskName}>{model.run.name}</span>
                        <span className={styles.taskMeta}>
                          {taskStatusLabel(model)}
                          {model.maintenance && model.attention
                            ? " · PR maintenance"
                            : ""}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {orderedTargets.length === 0 ? (
              <>
                <p className={styles.empty}>
                  No other running orchestrator can take these tasks. Start a new
                  conversation, then transfer them to it.
                </p>
                {onStartOrchestrator && (
                  <Button
                    className={styles.newTarget}
                    icon={<Add16Regular />}
                    onClick={onStartOrchestrator}
                  >
                    Start a new conversation
                  </Button>
                )}
              </>
            ) : (
              <Field label="Transfer to">
                <Dropdown
                  className={styles.target}
                  value={
                    destination
                      ? transferTargetLabel(destination, assignedCounts[destination.id])
                      : ""
                  }
                  selectedOptions={target ? [target] : []}
                  aria-label="Receiving orchestrator"
                  onOptionSelect={(_event, data) => setTarget(data.optionValue ?? "")}
                >
                  {orderedTargets.map((candidate) => (
                    <Option key={candidate.id} value={candidate.id}>
                      {transferTargetLabel(candidate, assignedCounts[candidate.id])}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            )}

            <Field
              label="Handoff note"
              hint="Optional. Kept on each task and given to the receiving orchestrator with its brief."
            >
              <Textarea
                value={note}
                disabled={submitting}
                resize="vertical"
                maxLength={8_000}
                onChange={(_event, data) => setNote(data.value)}
              />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={submitting} onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              icon={<ArrowForward20Regular />}
              disabled={submitting || chosen.length === 0 || !destination}
              onClick={() => {
                if (!destination) return;
                setSubmitting(true);
                void onTransfer({
                  runIds: chosen.map((model) => model.run.id),
                  toSessionId: destination.id,
                  note: note.trim(),
                })
                  .then((ok) => {
                    if (ok) onClose();
                  })
                  .finally(() => setSubmitting(false));
              }}
            >
              {fixed ? "Transfer task" : `Transfer ${chosen.length}`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
