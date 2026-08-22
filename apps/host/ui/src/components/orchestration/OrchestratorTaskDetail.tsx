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
import { ArrowLeft20Regular, Chat20Regular } from "@fluentui/react-icons";
import type { FleetSession, RunNote } from "@fleet/protocol";
import type { RunViewModel } from "../../lib/orchestration-view";
import { awaitingPlan, currentPhase } from "../../lib/orchestration-view";
import { semanticColors, statusVisuals, terminal } from "../../theme";
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
  onOpenLead: () => void;
  onOpenWorker: (sessionId: string) => void;
  onReview: (approved: boolean, note: string) => Promise<boolean>;
  onAbandon: () => Promise<boolean>;
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
  onOpenLead,
  onOpenWorker,
  onReview,
  onAbandon,
}: OrchestratorTaskDetailProps) => {
  const styles = useStyles();
  const [abandonOpen, setAbandonOpen] = useState(false);
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
            All tasks
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
            {!finished && (
              <Button
                appearance="subtle"
                className={styles.danger}
                onClick={() => setAbandonOpen(true)}
              >
                Abandon
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
              <Text className={styles.note}>{notes[notes.length - 1]?.body}</Text>
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

        {notes.length > 0 && (
          <section className={styles.section}>
            <Text className={styles.sectionLabel}>What happened</Text>
            <ul className={styles.notes}>
              {notes.map((entry) => (
                <li key={entry.id} className={styles.note}>
                  {run.phases[entry.phaseIndex] && (
                    <span className={styles.noteLabel}>
                      {run.phases[entry.phaseIndex]}
                    </span>
                  )}
                  {entry.body}
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

      <Dialog open={abandonOpen} onOpenChange={(_, data) => setAbandonOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Abandon “{run.name}”?</DialogTitle>
            {/*
              Says exactly what happens, because the difference between this and
              deleting is the whole reason it is safe: the record stays.
            */}
            <DialogContent>
              <p>Any worker still running for this task is stopped.</p>
              <p>
                The task and everything it has already produced stay here to read. Nothing
                further will be dispatched, and it cannot be resumed.
              </p>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAbandonOpen(false)}>
                Keep going
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onAbandon().then((ok) => {
                    setBusy(false);
                    if (ok) setAbandonOpen(false);
                  });
                }}
              >
                Abandon task
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
};
