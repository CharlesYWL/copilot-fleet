import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  WorkerResumeRequestSchema,
  errorMessage,
  type WorkerResumeDecision,
  type WorkerResumeRequest,
} from "@fleet/protocol";
import { ApiError, api } from "../../hooks/useFleet";
import { mergeResumeRequests, requestedByLabel } from "../../lib/worker-resume";

const useStyles = makeStyles({
  surface: { maxWidth: "760px", width: "min(760px, calc(100vw - 32px))" },
  context: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    gap: "8px 16px",
    margin: "12px 0",
    "& dd": { margin: 0, overflowWrap: "anywhere" },
    "& dt": { color: tokens.colorNeutralForeground3 },
  },
  prompt: {
    padding: "12px",
    margin: "4px 0 0",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxHeight: "22vh",
    overflowY: "auto",
  },
  sessions: { margin: 0, paddingLeft: "18px" },
  risk: {
    margin: "12px 0 0",
    padding: "10px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorPaletteYellowBackground1,
    color: tokens.colorNeutralForeground1,
  },
  actions: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "16px" },
  error: { color: tokens.colorPaletteRedForeground1 },
});

const identity = (request: WorkerResumeRequest) => `${request.id}:${request.version}`;

function isDecisionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409;
}

export type WorkerResumePromptsProps = {
  requests: readonly WorkerResumeRequest[];
  connected: boolean;
  /** Another dialog owns the screen; wait unless a request was asked for by name. */
  blocked?: boolean;
  /** Opens this request even if it was put off with "Review later". */
  focusRequestId?: string | undefined;
  onFocusHandled?: () => void;
};

/**
 * The approval dialog for a one-time "Resume now" scheduling exception.
 *
 * It shows everything the approval binds to — task, worker, Node, exact
 * checkout, queued work, the sessions on that Node and the restriction being
 * overridden — and decides only with the version and fingerprint it displayed.
 * "Review later" decides nothing; the request stays visible on its step.
 */
export function WorkerResumePrompts({
  requests,
  connected,
  blocked = false,
  focusRequestId,
  onFocusHandled,
}: WorkerResumePromptsProps) {
  const styles = useStyles();
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  /** A decision the Host refused because the request no longer waits for one. */
  const [settled, setSettled] = useState<{
    request: WorkerResumeRequest;
    message: string;
  }>();
  const [refreshed, setRefreshed] = useState<WorkerResumeRequest[]>([]);
  if (settled)
    return (
      <Dialog
        open
        onOpenChange={(_event, data) => {
          if (!data.open) setSettled(undefined);
        }}
      >
        <DialogSurface className={styles.surface}>
          <DialogBody>
            <DialogTitle>Resume request not approved</DialogTitle>
            <DialogContent>
              <p className={styles.error} role="alert">
                {settled.message}
              </p>
              <Text>
                {settled.request.stepTitle} on {settled.request.nodeName} is{" "}
                {settled.request.state}. {settled.request.outcome}
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setSettled(undefined)}>
                Close
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    );
  const waiting = mergeResumeRequests(requests, refreshed)
    .filter((request) => request.state === "awaiting_approval")
    .sort(
      (a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id),
    );
  const focused = focusRequestId
    ? waiting.find((request) => request.id === focusRequestId)
    : undefined;
  const selected =
    focused ??
    waiting.find((request) => request.id === pending) ??
    waiting.find((request) => !handled.has(request.id));
  if (!selected || (blocked && !pending && !focused)) return null;
  const key = identity(selected);

  const later = () => {
    if (pending) return;
    setHandled((prior) => new Set([...prior, selected.id]));
    setFailure(undefined);
    onFocusHandled?.();
  };

  async function decide(decision: WorkerResumeDecision["decision"]) {
    if (!selected || pending) return;
    setPending(selected.id);
    setFailure(undefined);
    try {
      const result = await api<{ request: unknown }>(
        `/api/worker-resume-requests/${encodeURIComponent(selected.id)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            expectedVersion: selected.version,
            fingerprint: selected.fingerprint,
          }),
        },
      );
      const updated = WorkerResumeRequestSchema.parse(result.request);
      setRefreshed((prior) => mergeResumeRequests(prior, [updated]));
      setHandled((prior) => new Set([...prior, selected.id]));
      onFocusHandled?.();
    } catch (error) {
      const current = isDecisionConflict(error)
        ? WorkerResumeRequestSchema.safeParse(error.body.request)
        : undefined;
      if (current?.success) {
        setRefreshed((prior) => mergeResumeRequests(prior, [current.data]));
        if (current.data.state !== "awaiting_approval") {
          setHandled((prior) => new Set([...prior, selected.id]));
          setSettled({
            request: current.data,
            message: `${errorMessage(error)} Nothing was approved.`,
          });
          onFocusHandled?.();
        } else
          setFailure({
            key: identity(current.data),
            message: `${errorMessage(error)} Review the refreshed details before deciding again; nothing was approved.`,
          });
      } else {
        setFailure({ key, message: errorMessage(error) });
      }
    } finally {
      setPending(undefined);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(_event, data) => {
        if (!data.open) later();
      }}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Approve a one-time resume exception?</DialogTitle>
          <DialogContent>
            <Text>
              This queued follow-up is waiting only because of the restriction below.
              Nothing has launched. Approving resumes the same worker conversation once
              and sends its already-queued follow-up; it does not change any other
              scheduling rule.
            </Text>
            <dl className={styles.context}>
              <dt>Task</dt>
              <dd>{selected.taskName || selected.runId}</dd>
              <dt>Worker session</dt>
              <dd>
                {selected.sessionName || selected.stepTitle} ({selected.sessionId})
              </dd>
              <dt>Node</dt>
              <dd>{selected.nodeName}</dd>
              <dt>Checkout</dt>
              <dd>{selected.localPath}</dd>
              <dt>Queued work</dt>
              <dd>
                {selected.stepTitle} · attempt {selected.stepAttempt}
                <pre className={styles.prompt} aria-label="Queued follow-up">
                  {selected.queuedPrompt}
                </pre>
              </dd>
              <dt>Restriction</dt>
              <dd>{selected.restrictionDetail}</dd>
              <dt>Slots</dt>
              <dd>
                {selected.capacity.reserved} of {selected.capacity.limit}{" "}
                {selected.capacity.kind} slots held on {selected.nodeName}
              </dd>
              <dt>Active on this Node</dt>
              <dd>
                {selected.activeSessions.length ? (
                  <ul
                    className={styles.sessions}
                    aria-label="Active sessions on this Node"
                  >
                    {selected.activeSessions.map((session) => (
                      <li key={session.sessionId}>
                        {session.name || session.sessionId} ({session.state}
                        {session.readOnly ? ", read-only" : ""})
                        {session.taskName ? ` · task “${session.taskName}”` : ""}
                        {session.localPath ? ` · ${session.localPath}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "None"
                )}
              </dd>
              <dt>Requested by</dt>
              <dd>
                {requestedByLabel(selected)}
                {selected.reason ? ` — “${selected.reason}”` : ""}
              </dd>
              <dt>Decide before</dt>
              <dd>{new Date(selected.expiresAt).toLocaleString()}</dd>
            </dl>
            <p className={styles.risk} role="note">
              {selected.risk}
            </p>
            {!connected && (
              <p role="status">Disconnected from the Host. Reconnect before deciding.</p>
            )}
            {failure?.key === key && (
              <p className={styles.error} role="alert">
                {failure.message}
              </p>
            )}
            <div className={styles.actions}>
              <Button
                appearance="primary"
                disabled={!!pending || !connected}
                onClick={() => void decide("approve_once")}
              >
                Approve once
              </Button>
              <Button
                disabled={!!pending || !connected}
                onClick={() => void decide("cancel")}
              >
                Cancel request
              </Button>
            </div>
          </DialogContent>
          <DialogActions>
            <Text size={200}>
              {waiting.length > 1
                ? `${waiting.length} resume requests waiting`
                : "The request stays on its step until it is decided or expires."}
            </Text>
            <Button disabled={!!pending} onClick={later}>
              Review later
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
