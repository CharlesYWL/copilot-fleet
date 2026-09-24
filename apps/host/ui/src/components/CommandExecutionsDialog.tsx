import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from "@fluentui/react-components";
import {
  COMMAND_LIMITS,
  CommandExecutionPageSchema,
  CommandExecutionSchema,
  commandApprovalExpiresAt,
  errorMessage,
  terminalCommandExecutionStates,
  prMaintenanceUrl,
  type CommandExecution,
  type CommandDecision,
  type CommandExecutionPage,
  type CommandOutputEvent,
  type PrMaintenanceApproval,
  type Run,
} from "@fleet/protocol";
import { api } from "../hooks/useFleet";
import {
  decodeCommandOutput,
  mergeCommandExecutions,
  mergeCommandOutput,
  visibleCommandText,
} from "../lib/command-output";
import {
  CommandApprovalActions,
  isCommandApprovalConflict,
} from "./CommandApprovalActions";
import { semanticColors } from "../theme";

const useStyles = makeStyles({
  surface: { width: "min(1060px, calc(100vw - 32px))", maxWidth: "1060px" },
  content: {
    display: "flex",
    gap: "20px",
    minHeight: "300px",
    maxHeight: "70vh",
    "@media (max-width: 680px)": { flexDirection: "column" },
  },
  tabs: { marginBottom: "14px" },
  pendingTab: { color: semanticColors.permission },
  list: {
    width: "240px",
    flexShrink: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    "@media (max-width: 680px)": { width: "100%", maxHeight: "130px" },
  },
  item: {
    width: "100%",
    flexShrink: 0,
    justifyContent: "flex-start",
    textAlign: "left",
    overflow: "hidden",
  },
  itemText: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    gap: "3px",
  },
  preview: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: tokens.fontFamilyMonospace,
  },
  detail: {
    flexGrow: 1,
    minWidth: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  manifest: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: "14px",
    rowGap: "6px",
    margin: 0,
    "& dt": { color: tokens.colorNeutralForeground3 },
    "& dd": { margin: 0, overflowWrap: "anywhere" },
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: "12px",
    margin: 0,
  },
  output: {
    minHeight: "200px",
    maxHeight: "min(520px, 50vh)",
    flexShrink: 0,
    overflowY: "auto",
    resize: "vertical",
    fontSize: tokens.fontSizeBase200,
  },
  warning: {
    padding: "10px",
    backgroundColor: tokens.colorPaletteYellowBackground1,
    color: tokens.colorPaletteYellowForeground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  error: { color: tokens.colorPaletteRedForeground1 },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

export type CommandExecutionsDialogProps = {
  executions: readonly CommandExecution[];
  output: readonly CommandOutputEvent[];
  connected: boolean;
  initialExecutionId?: string | undefined;
  leadSessionId?: string | undefined;
  onClose: () => void;
  maintenanceApprovals?: readonly PrMaintenanceApproval[];
  tasks?: readonly Run[];
  onReviewMaintenance?: (approval: PrMaintenanceApproval) => void;
};

export function CommandExecutionsDialog({
  executions,
  output,
  connected,
  initialExecutionId,
  leadSessionId,
  onClose,
  maintenanceApprovals = [],
  tasks = [],
  onReviewMaintenance,
}: CommandExecutionsDialogProps) {
  const styles = useStyles();
  const restoreFocusTarget = useRestoreFocusTarget();
  const [history, setHistory] = useState<CommandExecution[]>([]);
  const [selectedId, setSelectedId] = useState(initialExecutionId);
  const [selectedProposalId, setSelectedProposalId] = useState<string>();
  const [group, setGroup] = useState<"waiting" | "history">();
  const [detail, setDetail] = useState<CommandExecutionPage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [reload, setReload] = useState(0);
  const records = useMemo(
    () =>
      mergeCommandExecutions(
        history,
        executions,
        detail ? [detail.execution] : [],
      ).filter((item) => !leadSessionId || item.leadSessionId === leadSessionId),
    [history, executions, detail, leadSessionId],
  );
  const waiting = records.filter((item) => item.state === "awaiting_approval").reverse();
  const proposals = maintenanceApprovals
    .filter((item) => !leadSessionId || item.leadSessionId === leadSessionId)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.proposalId.localeCompare(b.proposalId),
    );
  const approvalCount = waiting.length + proposals.length;
  const reviewed = records.filter((item) => item.state !== "awaiting_approval");
  const initial = records.find((item) => item.id === initialExecutionId);
  const activeGroup =
    group ??
    (initial
      ? initial.state === "awaiting_approval"
        ? "waiting"
        : "history"
      : approvalCount
        ? "waiting"
        : "history");
  const visible = activeGroup === "waiting" ? waiting : reviewed;
  const selectedProposal =
    activeGroup === "waiting"
      ? (proposals.find((item) => item.proposalId === selectedProposalId) ??
        (!selectedId && !waiting.length ? proposals[0] : undefined))
      : undefined;
  const selected = selectedProposal
    ? undefined
    : (visible.find((item) => item.id === selectedId) ?? visible[0]);
  const currentId = selectedProposal
    ? undefined
    : (selected?.id ??
      (records.some((item) => item.id === selectedId) ? undefined : selectedId));

  useEffect(() => {
    const controller = new AbortController();
    const query = leadSessionId
      ? `?leadSessionId=${encodeURIComponent(leadSessionId)}`
      : "";
    void api<{ executions: unknown[] }>(`/api/command-executions${query}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setHistory(result.executions.map((item) => CommandExecutionSchema.parse(item)));
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [leadSessionId, reload]);

  useEffect(() => {
    if (!currentId) return;
    const controller = new AbortController();
    void api(
      `/api/command-executions/${encodeURIComponent(currentId)}?afterSeq=0&limitBytes=${COMMAND_LIMITS.pageBytes}`,
      {
        signal: controller.signal,
      },
    )
      .then((page) => {
        if (!controller.signal.aborted) setDetail(CommandExecutionPageSchema.parse(page));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [currentId, reload]);

  const currentDetail = detail?.execution.id === currentId ? detail : undefined;
  const renderedOutput = useMemo(() => {
    if (!selected) return { text: "", lossy: false, gap: false, truncated: false };
    const events = mergeCommandOutput(
      currentDetail?.events ?? [],
      output.filter(
        (event) =>
          event.executionId === selected.id && event.attemptId === selected.attemptId,
      ),
    );
    return decodeCommandOutput(
      events,
      selected.outputComplete && !currentDetail?.hasMore,
    );
  }, [currentDetail, output, selected]);

  async function decide(decision: CommandDecision["decision"]) {
    if (!selected?.descriptor) return;
    setWorking(true);
    setError("");
    try {
      const result = await api<{ execution: unknown }>(
        `/api/command-executions/${encodeURIComponent(selected.id)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            expectedVersion: selected.version,
            digest: selected.descriptor.digest,
          }),
        },
      );
      const execution = CommandExecutionSchema.parse(result.execution);
      setHistory((prior) => mergeCommandExecutions(prior, [execution]));
      if (execution.state === "expired")
        setError(
          "That request had already expired, so your decision was not applied and nothing ran. It moved to Request history.",
        );
      setGroup("waiting");
      setSelectedId(undefined);
      setSelectedProposalId(undefined);
    } catch (failure) {
      if (isCommandApprovalConflict(failure)) {
        setError(
          "That request was already reviewed or changed. Refreshing its current status; approval has not been retried.",
        );
        setReload((value) => value + 1);
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      setWorking(false);
    }
  }

  async function cancel() {
    if (!selected) return;
    setWorking(true);
    setError("");
    try {
      const result = await api<{ execution: unknown }>(
        `/api/command-executions/${encodeURIComponent(selected.id)}/cancel`,
        { method: "POST", body: "{}" },
      );
      const execution = CommandExecutionSchema.parse(result.execution);
      setHistory((prior) => mergeCommandExecutions(prior, [execution]));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setWorking(false);
    }
  }

  async function loadMore() {
    if (!selected || !currentDetail) return;
    const id = selected.id;
    setWorking(true);
    setError("");
    try {
      const page = CommandExecutionPageSchema.parse(
        await api(
          `/api/command-executions/${encodeURIComponent(id)}?afterSeq=${currentDetail.nextSeq}&limitBytes=${COMMAND_LIMITS.pageBytes}`,
        ),
      );
      setDetail((prior) => {
        if (prior?.execution.id !== id) return prior;
        return { ...page, events: mergeCommandOutput(prior.events, page.events) };
      });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setWorking(false);
    }
  }

  function downloadRaw() {
    if (!selected) return;
    const events = mergeCommandOutput(
      currentDetail?.events ?? [],
      output.filter(
        (event) =>
          event.executionId === selected.id && event.attemptId === selected.attemptId,
      ),
    );
    const blob = new Blob(
      [JSON.stringify({ executionId: selected.id, events }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `command-${selected.id}-loaded-output.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <Dialog
      open
      onOpenChange={(_event, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>
            {proposals.length ? "Commands and approvals" : "Command executions"}
          </DialogTitle>
          <DialogContent>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            {!connected && (
              <p role="status">
                Disconnected from the Host. Live output is paused; outcomes may have
                changed.
              </p>
            )}
            <TabList
              className={styles.tabs}
              aria-label="Command request sections"
              selectedValue={activeGroup}
              onTabSelect={(_event, data) => {
                if (data.value !== "waiting" && data.value !== "history") return;
                setGroup(data.value);
                setSelectedId(undefined);
                setError("");
              }}
            >
              <Tab
                id="commands-waiting-tab"
                value="waiting"
                className={approvalCount ? styles.pendingTab : undefined}
                aria-controls="commands-panel"
              >
                Waiting approval ({approvalCount})
              </Tab>
              <Tab
                id="commands-history-tab"
                value="history"
                aria-controls="commands-panel"
              >
                Request history ({reviewed.length})
              </Tab>
            </TabList>
            <div
              className={styles.content}
              id="commands-panel"
              role="tabpanel"
              aria-labelledby={
                activeGroup === "waiting"
                  ? "commands-waiting-tab"
                  : "commands-history-tab"
              }
            >
              <nav
                className={styles.list}
                aria-label={
                  activeGroup === "waiting"
                    ? "Waiting approval requests"
                    : "Command history"
                }
              >
                {loading && <Spinner size="small" label="Loading command history" />}
                {!loading &&
                  visible.length === 0 &&
                  !(activeGroup === "waiting" && proposals.length) && (
                    <Text>
                      {activeGroup === "waiting"
                        ? "No requests are waiting for approval."
                        : "No other requests yet. Approved, denied, completed, and preparing requests appear here."}
                    </Text>
                  )}
                {visible.map((item) => (
                  <Button
                    key={item.id}
                    className={styles.item}
                    appearance={item.id === currentId ? "secondary" : "subtle"}
                    aria-current={item.id === currentId ? "true" : undefined}
                    onClick={() => {
                      setSelectedId(item.id);
                      setSelectedProposalId(undefined);
                      setGroup(activeGroup);
                      setError("");
                    }}
                  >
                    <span className={styles.itemText}>
                      <span>
                        {item.nodeName} · {item.state.replaceAll("_", " ")}
                      </span>
                      <span className={styles.preview}>
                        {visibleCommandText(item.command.split(/\r?\n/)[0] ?? "")}
                      </span>
                    </span>
                  </Button>
                ))}
                {activeGroup === "waiting"
                  ? proposals.map((item) => (
                      <Button
                        key={`maintenance:${item.proposalId}`}
                        className={styles.item}
                        appearance={
                          selectedProposal?.proposalId === item.proposalId
                            ? "secondary"
                            : "subtle"
                        }
                        aria-current={
                          selectedProposal?.proposalId === item.proposalId
                            ? "true"
                            : undefined
                        }
                        onClick={() => {
                          setSelectedProposalId(item.proposalId);
                          setSelectedId(undefined);
                          setError("");
                        }}
                      >
                        <span className={styles.itemText}>
                          <span>PR maintenance · waiting approval</span>
                          <span className={styles.preview}>
                            {item.identity.repository} #{item.identity.prNumber}
                          </span>
                        </span>
                      </Button>
                    ))
                  : null}
              </nav>
              <section
                className={styles.detail}
                aria-label={
                  selectedProposal ? "PR maintenance approval details" : "Command details"
                }
              >
                {selectedProposal ? (
                  <>
                    <Text weight="semibold">PR maintenance needs your authorization</Text>
                    <dl className={styles.manifest}>
                      <dt>Task</dt>
                      <dd>
                        {tasks.find((task) => task.id === selectedProposal.taskId)
                          ?.name ?? selectedProposal.taskId}
                      </dd>
                      <dt>Pull request</dt>
                      <dd>{prMaintenanceUrl(selectedProposal.identity)}</dd>
                      <dt>Proposed mode</dt>
                      <dd>Bounded repairs</dd>
                      <dt>Requested</dt>
                      <dd>{new Date(selectedProposal.createdAt).toLocaleString()}</dd>
                    </dl>
                    <Text>
                      Nothing is enabled until you review and authorize the exact
                      maintenance scope.
                    </Text>
                    <Text className={styles.muted}>
                      This is separate from command execution permission. Review the PR,
                      worker, limits, and allowed actions before deciding.
                    </Text>
                    <div>
                      <Button
                        {...restoreFocusTarget}
                        appearance="primary"
                        disabled={!connected || !onReviewMaintenance}
                        onClick={() => onReviewMaintenance?.(selectedProposal)}
                      >
                        Review maintenance scope
                      </Button>
                    </div>
                  </>
                ) : selected ? (
                  <>
                    <Text weight="semibold">{selected.state.replaceAll("_", " ")}</Text>
                    <dl className={styles.manifest}>
                      <dt>Node</dt>
                      <dd>{selected.nodeName}</dd>
                      <dt>Directory</dt>
                      <dd>
                        {visibleCommandText(
                          selected.descriptor?.prepared.cwd ?? selected.requestedPath,
                        )}
                      </dd>
                      <dt>Shell</dt>
                      <dd>{selected.shell}</dd>
                      {selected.descriptor && (
                        <>
                          <dt>Shell executable</dt>
                          <dd>
                            {visibleCommandText(selected.descriptor.prepared.shellPath)}
                          </dd>
                        </>
                      )}
                      <dt>Requested by</dt>
                      <dd>{selected.leadSessionId}</dd>
                      {selected.taskId && (
                        <>
                          <dt>Task</dt>
                          <dd>{selected.taskId}</dd>
                        </>
                      )}
                      <dt>Runtime limit</dt>
                      <dd>{Math.round(selected.timeoutMs / 1000)} seconds</dd>
                      <dt>Start approval expires</dt>
                      <dd>
                        {new Date(commandApprovalExpiresAt(selected)).toLocaleString()}
                      </dd>
                      {selected.approvedBy && (
                        <>
                          <dt>Approved by</dt>
                          <dd>{selected.approvedBy}</dd>
                        </>
                      )}
                      <dt>Ownership</dt>
                      <dd>{selected.ownership.replaceAll("_", " ")}</dd>
                      <dt>Exit code</dt>
                      <dd>
                        {selected.exitCode === null ? "Not known" : selected.exitCode}
                      </dd>
                      <dt>Completion delivery</dt>
                      <dd>{selected.delivery.replaceAll("_", " ")}</dd>
                    </dl>
                    <Text weight="semibold">Exact command</Text>
                    <pre className={styles.code} aria-label="Exact command">
                      {visibleCommandText(selected.command)}
                    </pre>
                    {visibleCommandText(selected.command) !== selected.command && (
                      <Text className={styles.warning}>
                        Control and directional characters are shown as Unicode escapes;
                        they are not removed from the submitted command.
                      </Text>
                    )}
                    <Text>Reason: {visibleCommandText(selected.reason)}</Text>
                    {selected.state === "awaiting_approval" && (
                      <div className={styles.warning}>
                        This runs arbitrary code as the Node&apos;s OS user. The directory
                        is not a sandbox. Choose how long the Node should remember your
                        permission below.
                      </div>
                    )}
                    {selected.error && (
                      <Text role="alert" className={styles.error}>
                        {selected.error}
                      </Text>
                    )}
                    {selected.descendantCleanupForced && (
                      <Text className={styles.warning}>
                        Remaining child processes were forcibly stopped. A zero root exit
                        does not mean every child completed.
                      </Text>
                    )}
                    {selected.ownership === "unknown" && (
                      <Text className={styles.warning}>
                        Process ownership is unknown. Keep the checkout unavailable until
                        the Node is reconciled.
                      </Text>
                    )}
                    <div className={styles.actions}>
                      {selected.state === "awaiting_approval" && selected.descriptor && (
                        <CommandApprovalActions
                          execution={selected}
                          disabled={working || !connected}
                          onDecide={(decision) => void decide(decision)}
                        />
                      )}
                      {!terminalCommandExecutionStates.has(selected.state) && (
                        <Button
                          disabled={working || !connected || selected.cancelRequested}
                          onClick={() => void cancel()}
                        >
                          {selected.cancelRequested
                            ? "Cancellation pending"
                            : "Cancel execution"}
                        </Button>
                      )}
                    </div>
                    <Text weight="semibold">Output</Text>
                    <Text className={styles.muted}>
                      UTF-8 display is assumed; native programs may use another encoding.
                      Raw loaded bytes remain available.
                    </Text>
                    {(renderedOutput.lossy ||
                      renderedOutput.gap ||
                      renderedOutput.truncated ||
                      selected.gaps.length > 0) && (
                      <Text className={styles.warning}>
                        Output has gaps or lossy decoding. Do not treat this view as a
                        complete transcript.
                      </Text>
                    )}
                    <pre
                      className={`${styles.code} ${styles.output}`}
                      aria-label="Command output"
                      tabIndex={0}
                    >
                      {renderedOutput.text || "No output received."}
                    </pre>
                    <Text className={styles.muted}>
                      {selected.outputComplete
                        ? "Output transfer settled; check any gap markers."
                        : "Output transfer is not complete."}
                    </Text>
                    <div className={styles.actions}>
                      {currentDetail?.hasMore && (
                        <Button disabled={working} onClick={() => void loadMore()}>
                          Load more output
                        </Button>
                      )}
                      <Button disabled={!renderedOutput.text} onClick={downloadRaw}>
                        Download loaded raw output
                      </Button>
                    </div>
                  </>
                ) : (
                  <Text>Select a command to inspect its approval and result.</Text>
                )}
              </section>
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              disabled={working}
              onClick={() => {
                setError("");
                setReload((value) => value + 1);
              }}
            >
              Refresh details
            </Button>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
