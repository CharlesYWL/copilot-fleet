import { useState } from "react";
import {
  shorthands,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Textarea,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  ArrowCounterclockwise20Regular,
  Chat20Regular,
  Delete20Regular,
} from "@fluentui/react-icons";
import type { FleetSession, RunNote } from "@fleet/protocol";
import type { RunViewModel } from "../../lib/orchestration-view";
import { awaitingPlan, currentPhase } from "../../lib/orchestration-view";
import { semanticColors, statusVisuals, terminal } from "../../theme";
import { MarkdownBody } from "../MarkdownBody";
import { RunStatusIndicator } from "./RunStatusIndicator";
import { WorkerStepTimeline } from "./WorkerStepTimeline";

const useStyles = makeStyles({
  page: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: tokens.colorNeutralBackground1,
  },
  head: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "14px 20px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  crumbRow: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  crumb: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  },
  title: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
    minWidth: 0,
  },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap", marginLeft: "auto" },
  danger: {
    color: statusVisuals.danger.foreground,
  },
  body: { flexGrow: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 40px" },
  section: { marginBottom: "22px" },
  sectionLabel: {
    display: "block",
    marginBottom: "8px",
    color: tokens.colorNeutralForeground3,
    fontSize: "10px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    fontWeight: tokens.fontWeightSemibold,
  },
  phases: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  phase: {
    display: "flex",
    alignItems: "center",
    gap: "7px",
    padding: "6px 10px",
    borderRadius: tokens.borderRadiusSmall,
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    minHeight: "32px",
  },
  phaseDone: { color: semanticColors.completed },
  phaseNow: {
    color: tokens.colorNeutralForeground1,
    background: tokens.colorNeutralBackground3,
    boxShadow: `inset 2px 0 ${semanticColors.interaction}`,
  },
  pip: { width: "8px", height: "8px", borderRadius: "50%", background: "currentColor" },
  /*
   * The contract the orchestrator is held to, shown to the person in the same
   * words. It cannot hand the task over while an essential one is unmet, so
   * this is not a summary of intent — it is what will actually be enforced.
   */
  stopWhen: {
    margin: "0 0 10px",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    lineHeight: "1.5",
  },
  criteria: { display: "grid", gap: "6px", margin: 0, padding: 0, listStyle: "none" },
  criterion: {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    padding: "10px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  criterionPip: {
    flexShrink: 0,
    width: "6px",
    height: "6px",
    marginTop: "6px",
    borderRadius: "50%",
    background: tokens.colorNeutralForeground4,
  },
  criterionText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  criterionScenario: {
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.5",
  },
  criterionEvidence: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.5",
  },
  optional: {
    marginLeft: "6px",
    color: tokens.colorNeutralForeground4,
    fontFamily: terminal.font,
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  notes: { display: "grid", gap: "8px", margin: 0, padding: 0, listStyle: "none" },
  note: {
    padding: "10px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.55",
    whiteSpace: "pre-wrap",
  },
  /*
   * The same surface, for text the orchestrator wrote rather than text we did.
   *
   * Handover notes are markdown — headings, bullets, evidence — and a paragraph
   * of `pre-wrap` turns that into the wall of prose this exists to avoid. The
   * renderer supplies the line breaks, so this must not.
   */
  noteSurface: {
    padding: "12px 14px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
  },
  noteMarkdown: {
    fontSize: "13px",
    lineHeight: "1.6",
    color: "inherit",
  },
  noteLabel: {
    display: "block",
    marginBottom: "4px",
    color: tokens.colorNeutralForeground4,
    fontFamily: terminal.font,
    fontSize: "10px",
  },
  review: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "14px",
    ...shorthands.border("1px", "solid", statusVisuals.attention.border),
    borderRadius: tokens.borderRadiusMedium,
    background: statusVisuals.attention.surface,
  },
  reviewButtons: { display: "flex", gap: "8px", flexWrap: "wrap" },
  /*
   * A long handover scrolls inside the card rather than pushing Approve and
   * Send back off the fold. The decision is the point of this page; it should
   * never be further away than the report that argues for it.
   */
  reviewBody: {
    maxHeight: "min(48vh, 560px)",
    overflowY: "auto",
  },
  /**
   * Deliberately not the attention colour.
   *
   * Amber means a person is needed. This is the machine's turn, not theirs —
   * borrowing the interrupt colour for it would make every freshly opened task
   * look like a request.
   */
  pending: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "14px",
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontFamily: terminal.font,
    fontSize: "11px",
  },
});

export type OrchestratorTaskDetailProps = {
  model: RunViewModel;
  notes: RunNote[];
  sessions: readonly FleetSession[];
  onBack: () => void;
  /**
   * What Back goes back to, when it is not the board.
   *
   * A task reached from a conversation returns to that conversation, and a
   * button that still reads "All tasks" while doing so is describing a place
   * the operator is not about to arrive at.
   */
  backLabel?: string;
  onOpenLead: () => void;
  onOpenWorker: (sessionId: string) => void;
  onReview: (approved: boolean, note: string) => Promise<boolean>;
  onArchive: () => Promise<boolean>;
  /** Puts a finished task back to work, with what is still wanted. */
  onReopen: (note: string) => Promise<boolean>;
  /** Removes a finished task and the sessions it started. */
  onDelete: () => Promise<boolean>;
};

/**
 * One task, in full.
 *
 * A page rather than an inspector panel, because this is where a person makes
 * the only decision the orchestrator cannot: whether the work is good. That
 * deserves the whole width, not a 320px column beside a conversation.
 */
export const OrchestratorTaskDetail = ({
  model,
  notes,
  sessions,
  onBack,
  backLabel = "All tasks",
  onOpenLead,
  onOpenWorker,
  onReview,
  onArchive,
  onReopen,
  onDelete,
}: OrchestratorTaskDetailProps) => {
  const styles = useStyles();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reopenNote, setReopenNote] = useState("");
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const { run } = model;
  const finished =
    run.state === "completed" || run.state === "cancelled" || run.state === "failed";

  const answer = async (approved: boolean, text: string) => {
    setBusy(true);
    const ok = await onReview(approved, text);
    setBusy(false);
    if (ok) {
      setSendBackOpen(false);
      setNote("");
    }
  };

  return (
    <section className={styles.page} aria-label={`Task ${run.name}`}>
      <header className={styles.head}>
        <div className={styles.crumbRow}>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowLeft20Regular />}
            onClick={onBack}
          >
            {backLabel}
          </Button>
          <Text className={styles.crumb}>
            Orchestrator / {run.name}
            {currentPhase(run) ? ` / ${currentPhase(run)}` : ""}
          </Text>
        </div>
        <div className={styles.titleRow}>
          <Text as="h1" className={styles.title}>
            {run.name}
          </Text>
          <RunStatusIndicator model={model} />
          <div className={styles.actions}>
            <Button appearance="subtle" icon={<Chat20Regular />} onClick={onOpenLead}>
              Conversation
            </Button>
            {/*
              What you can do with a task depends on whether it is over.

              A finished one is either wrong — reopen it, and the orchestrator
              carries on next to the criteria and notes it already has — or done
              with, and then archiving it would keep a record nobody wants.
              A live one is neither: archiving stops it and keeps what it found.
            */}
            {finished ? (
              <>
                <Button
                  appearance="subtle"
                  icon={<ArrowCounterclockwise20Regular />}
                  onClick={() => setReopenOpen(true)}
                >
                  Reopen
                </Button>
                <Button
                  appearance="subtle"
                  className={styles.danger}
                  icon={<Delete20Regular />}
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete
                </Button>
              </>
            ) : (
              <Button
                appearance="subtle"
                className={styles.danger}
                onClick={() => setArchiveOpen(true)}
              >
                Archive
              </Button>
            )}
          </div>
        </div>
        {run.objective && run.objective !== run.name && (
          <Text className={styles.meta}>{run.objective}</Text>
        )}
      </header>

      <div className={styles.body}>
        {run.state === "awaiting_human" && (
          <section className={mergeClasses(styles.section, styles.review)}>
            <Text weight="semibold">Ready for you</Text>
            {notes.length > 0 && (
              <div className={mergeClasses(styles.noteSurface, styles.reviewBody)}>
                <MarkdownBody
                  text={notes[notes.length - 1]?.body ?? ""}
                  className={styles.noteMarkdown}
                  copyable
                />
              </div>
            )}
            <div className={styles.reviewButtons}>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => void answer(true, "")}
              >
                Approve
              </Button>
              <Button disabled={busy} onClick={() => setSendBackOpen(true)}>
                Send back
              </Button>
            </div>
          </section>
        )}

        {awaitingPlan(model) && (
          <section className={mergeClasses(styles.section, styles.pending)}>
            <Text weight="semibold">Waiting for the orchestrator to plan this</Text>
            <Text className={styles.note}>
              The task was recorded first and the orchestrator has been asked, in its
              conversation, to break it into phases. It will pick them up on its next free
              turn — it takes one at a time. Nothing is lost if it is busy.
            </Text>
            <div className={styles.reviewButtons}>
              <Button appearance="subtle" icon={<Chat20Regular />} onClick={onOpenLead}>
                Open the conversation
              </Button>
            </div>
          </section>
        )}

        {run.phases.length > 0 && (
          <section className={styles.section}>
            <Text className={styles.sectionLabel}>Phases</Text>
            <div className={styles.phases}>
              {run.phases.map((phase, index) => (
                <span
                  key={phase + String(index)}
                  className={mergeClasses(
                    styles.phase,
                    index < run.phaseIndex && styles.phaseDone,
                    index === run.phaseIndex && !finished && styles.phaseNow,
                  )}
                >
                  <span className={styles.pip} aria-hidden="true" />
                  {phase}
                </span>
              ))}
            </div>
          </section>
        )}

        {run.successCriteria.length > 0 && (
          <section className={styles.section}>
            <Text className={styles.sectionLabel}>What done means</Text>
            {run.stopWhen && (
              <p className={styles.stopWhen}>Finished when {run.stopWhen}</p>
            )}
            <ul className={styles.criteria}>
              {run.successCriteria.map((criterion) => (
                <li key={criterion.id} className={styles.criterion}>
                  <span className={styles.criterionPip} aria-hidden="true" />
                  <div className={styles.criterionText}>
                    <span className={styles.criterionScenario}>
                      {criterion.scenario}
                      {!criterion.essential && (
                        <span className={styles.optional}>optional</span>
                      )}
                    </span>
                    <span className={styles.criterionEvidence}>
                      shown by {criterion.expectedEvidence}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {notes.length > 0 && (
          <section className={styles.section}>
            <Text className={styles.sectionLabel}>What happened</Text>
            <ul className={styles.notes}>
              {notes.map((entry) => (
                <li key={entry.id} className={styles.noteSurface}>
                  {run.phases[entry.phaseIndex] && (
                    <span className={styles.noteLabel}>
                      {run.phases[entry.phaseIndex]}
                    </span>
                  )}
                  <MarkdownBody text={entry.body} className={styles.noteMarkdown} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.section}>
          <Text className={styles.sectionLabel}>Dispatched work</Text>
          <WorkerStepTimeline
            steps={model.steps}
            phases={run.phases}
            sessions={sessions}
            onOpenWorker={onOpenWorker}
          />
        </section>
      </div>

      <Dialog open={sendBackOpen} onOpenChange={(_, data) => setSendBackOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Send this task back</DialogTitle>
            <DialogContent>
              <Field
                label="What needs changing?"
                hint="This goes to the orchestrator as an instruction, and it will dispatch the work it calls for."
              >
                <Textarea
                  value={note}
                  rows={4}
                  onChange={(_, data) => setNote(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSendBackOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={busy || note.trim().length === 0}
                onClick={() => void answer(false, note.trim())}
              >
                Send back
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={archiveOpen} onOpenChange={(_, data) => setArchiveOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Archive “{run.name}”?</DialogTitle>
            {/*
              Says exactly what happens, because the difference between this and
              deleting is the whole reason it is safe: what the task and its
              workers learned stays, while the machinery releases its slots.
            */}
            <DialogContent>
              <p>
                Any worker still running for this task is stopped, and its sessions are
                parked outside the active fleet.
              </p>
              <p>
                The task keeps its phases, its steps, its notes and everything they
                produced. Reopen the task to resume one of its worker conversations.
              </p>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setArchiveOpen(false)}>
                Keep going
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onArchive().then((ok) => {
                    setBusy(false);
                    if (ok) setArchiveOpen(false);
                  });
                }}
              >
                Archive task
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={reopenOpen} onOpenChange={(_, data) => setReopenOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Reopen “{run.name}”?</DialogTitle>
            <DialogContent>
              {/*
                A reason rather than a confirmation, for the same reason sending
                a task back needs one: this wakes the orchestrator to act, and
                "not done" is not something anyone can act on.
              */}
              <Field
                label="What is still wanted?"
                hint="The orchestrator is woken with this. It keeps the task's criteria, notes and steps."
              >
                <Textarea
                  value={reopenNote}
                  disabled={busy}
                  resize="vertical"
                  onChange={(_, data) => setReopenNote(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setReopenOpen(false)}>
                Leave it closed
              </Button>
              <Button
                appearance="primary"
                disabled={busy || reopenNote.trim().length === 0}
                onClick={() => {
                  setBusy(true);
                  void onReopen(reopenNote.trim()).then((ok) => {
                    setBusy(false);
                    if (ok) {
                      setReopenOpen(false);
                      setReopenNote("");
                    }
                  });
                }}
              >
                Reopen task
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(_, data) => setDeleteOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete “{run.name}”?</DialogTitle>
            <DialogContent>
              {/*
                Named against archiving, since that is the choice being made:
                one keeps what the work found, this keeps nothing.
              */}
              <p>
                The task goes, along with its phases, steps, notes and the sessions it
                started. Nothing about it is kept.
              </p>
              <p>Archive it instead if the record is worth having.</p>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleteOpen(false)}>
                Keep it
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onDelete().then((ok) => {
                    setBusy(false);
                    if (ok) setDeleteOpen(false);
                  });
                }}
              >
                Delete task
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
};
