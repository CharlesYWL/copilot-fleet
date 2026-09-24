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
  CommandExecutionSchema,
  commandApprovalExpiresAt,
  errorMessage,
  type CommandDecision,
  type CommandExecution,
} from "@fleet/protocol";
import { api } from "../hooks/useFleet";
import { mergeCommandExecutions, visibleCommandText } from "../lib/command-output";
import {
  CommandApprovalActions,
  isCommandApprovalConflict,
} from "./CommandApprovalActions";

const useStyles = makeStyles({
  surface: { maxWidth: "720px", width: "min(720px, calc(100vw - 32px))" },
  context: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    gap: "8px 16px",
    "& dd": { margin: 0, overflowWrap: "anywhere" },
    "& dt": { color: tokens.colorNeutralForeground3 },
  },
  command: {
    padding: "16px",
    margin: "16px 0",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxHeight: "35vh",
    overflowY: "auto",
  },
  actions: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "16px" },
  warning: {
    color: tokens.colorNeutralForeground3,
    margin: "12px 0 0",
    fontSize: tokens.fontSizeBase200,
  },
  error: { color: tokens.colorPaletteRedForeground1 },
});

const identity = (execution: CommandExecution) =>
  `${execution.id}:${execution.descriptor?.digest ?? ""}`;

export function CommandPermissionPrompts({
  executions,
  connected,
  blocked = false,
}: {
  executions: readonly CommandExecution[];
  connected: boolean;
  blocked?: boolean;
}) {
  const styles = useStyles();
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<string>();
  const [activeKey, setActiveKey] = useState<string>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [refreshed, setRefreshed] = useState<CommandExecution[]>([]);
  const requests = mergeCommandExecutions(executions, refreshed)
    .filter(
      (entry) =>
        entry.state === "awaiting_approval" &&
        entry.descriptor &&
        !handled.has(identity(entry)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const selected =
    requests.find((entry) => identity(entry) === (pending ?? activeKey)) ?? requests[0];
  if (selected && identity(selected) !== activeKey) setActiveKey(identity(selected));
  if (!selected || (blocked && !pending)) return null;
  const key = identity(selected);
  const finish = () => {
    if (pending) return;
    setHandled((prior) => new Set([...prior, key]));
    setFailure(undefined);
  };
  async function decide(decision: CommandDecision["decision"]) {
    if (!selected?.descriptor || pending) return;
    setPending(key);
    setFailure(undefined);
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
      const updated = CommandExecutionSchema.parse(result.execution);
      if (updated.id !== selected.id || updated.state === "awaiting_approval")
        throw new Error("The Host did not confirm the permission decision.");
      setHandled((prior) => new Set([...prior, key]));
    } catch (error) {
      if (isCommandApprovalConflict(error)) {
        try {
          const page = await api<{ execution: unknown }>(
            `/api/command-executions/${encodeURIComponent(selected.id)}`,
          );
          const current = CommandExecutionSchema.parse(page.execution);
          if (current.id !== selected.id)
            throw new Error("The Host returned a different command.", { cause: error });
          setRefreshed((prior) => mergeCommandExecutions(prior, [current]));
          setFailure({
            key: identity(current),
            message:
              "This request changed. Review its refreshed details before deciding again; approval has not been retried.",
          });
        } catch (refreshError) {
          setFailure({
            key,
            message: `The approval conflicted and its current status could not be refreshed: ${errorMessage(refreshError)}`,
          });
        }
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
        if (!data.open) finish();
      }}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Allow command execution?</DialogTitle>
          <DialogContent>
            <Text>
              Your Orchestrator is asking to run a command on another machine. Nothing has
              run yet.
            </Text>
            <dl className={styles.context}>
              <dt>Target Node</dt>
              <dd>{selected.nodeName}</dd>
              <dt>Working folder</dt>
              <dd>{visibleCommandText(selected.descriptor!.prepared.cwd)}</dd>
              <dt>Requested by</dt>
              <dd>{selected.leadSessionId}</dd>
              <dt>Shell</dt>
              <dd>{selected.shell}</dd>
              <dt>Runtime limit</dt>
              <dd>{Math.round(selected.timeoutMs / 1000)} seconds</dd>
              <dt>Approve before</dt>
              <dd>{new Date(commandApprovalExpiresAt(selected)).toLocaleString()}</dd>
            </dl>
            <pre className={styles.command} aria-label="Command awaiting approval">
              {visibleCommandText(selected.command)}
            </pre>
            <Text>Reason: {visibleCommandText(selected.reason)}</Text>
            <p className={styles.warning}>
              Commands run with the Node account's permissions. The working folder is not
              a sandbox. Review the complete command before granting access.
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
              <CommandApprovalActions
                execution={selected}
                disabled={!!pending || !connected}
                onDecide={(decision) => void decide(decision)}
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Text size={200}>
              {requests.length > 1
                ? `${requests.length} requests waiting`
                : "You can also review requests in Commands."}
            </Text>
            <Button disabled={!!pending} onClick={finish}>
              Review later
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
