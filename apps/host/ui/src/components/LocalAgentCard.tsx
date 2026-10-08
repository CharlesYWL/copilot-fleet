import { useCallback, useEffect, useState } from "react";
import {
  Badge,
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
  MessageBar,
  MessageBarBody,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  LOCAL_AGENT_HEADER,
  errorMessage,
  type LocalAgentConfig,
  type LocalAgentListenerStatus,
  type LocalAgentRequest,
  type LocalAgentRequestState,
} from "@fleet/protocol";
import { useNotify } from "../hooks/useAppNotifications";
import { api, ApiError } from "../hooks/useFleet";
import { useSettingsActive } from "../hooks/useSettingsActivity";
import { CopyButton } from "./CopyButton";
import { terminal } from "../theme";

const useStyles = makeStyles({
  card: {
    flexShrink: 0,
    minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "18px 22px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  facts: {
    display: "grid",
    gridTemplateColumns: "minmax(150px, auto) minmax(0, 1fr)",
    gap: "6px 16px",
    alignItems: "baseline",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  },
  scope: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: "12px 24px",
  },
  choices: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "220px",
    overflowY: "auto",
  },
  example: {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
  },
  mono: {
    fontFamily: terminal.font,
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    margin: 0,
    flexGrow: 1,
    minWidth: 0,
  },
  tableScroll: {
    overflowX: "auto",
  },
  table: {
    tableLayout: "auto",
    minWidth: "640px",
    overflowWrap: "anywhere",
  },
  owed: {
    fontFamily: terminal.font,
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    maxHeight: "240px",
    overflowY: "auto",
    padding: "8px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
});

type Choice = { id: string; name: string; detail: string };

type LocalAgentView = {
  config: LocalAgentConfig;
  status: LocalAgentListenerStatus;
  hostPort: number;
  defaultPort: number;
  choices: {
    orchestrators: { id: string; name: string; state: string; nodeName: string }[];
    workspaces: { id: string; name: string; kind: string }[];
  };
};

export type LocalAgentAdminRequest = LocalAgentRequest & {
  workspaceId: string;
  taskName: string;
  targetDeleted: boolean;
  owedPreview?: string;
};

type Draft = { port: string; leads: string[]; workspaces: string[] };

/** Where an administrator can still step in; the Host decides what that does. */
const FINISHED = new Set<LocalAgentRequestState>(["settled", "rejected", "abandoned"]);

const STATUS: Record<
  LocalAgentListenerStatus["state"],
  { label: string; color: "success" | "informative" | "danger" | "warning" }
> = {
  disabled: { label: "Off", color: "informative" },
  starting: { label: "Starting", color: "warning" },
  listening: { label: "Listening", color: "success" },
  stopping: { label: "Stopping", color: "warning" },
  error: { label: "Could not listen", color: "danger" },
};

export const ENABLE_WARNING =
  "Any process that can reach this loopback port, potentially including other local users, can read exposed conversations and ask these orchestrators to act using their existing permissions. Browser filtering does not authenticate agents. Do not forward or tunnel this port.";

const draftOf = (config: LocalAgentConfig): Draft => ({
  port: String(config.port),
  leads: config.allowedLeadSessionIds,
  workspaces: config.allowedWorkspaceIds,
});

const toggle = (list: string[], id: string, on: boolean) =>
  on ? (list.includes(id) ? list : [...list, id]) : list.filter((item) => item !== id);

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

/**
 * Settings → Security for the loopback API a local agent (Hermes, an MCP
 * client, a script) uses to work with the orchestrators chosen here.
 *
 * Every call goes to this Host's own origin; the page never talks to the local
 * port itself. Nothing is pre-selected: an administrator names each
 * orchestrator and workspace, and turning the API on asks for a fresh
 * Microsoft sign-in, which the panel's `run` turns into a prompt.
 */
export const LocalAgentCard = ({
  run,
}: {
  run: (work: () => Promise<unknown>, refresh?: boolean) => Promise<void>;
}) => {
  const styles = useStyles();
  const active = useSettingsActive();
  const notify = useNotify();
  const [view, setView] = useState<LocalAgentView>();
  const [requests, setRequests] = useState<LocalAgentAdminRequest[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [confirmingEnable, setConfirmingEnable] = useState(false);
  const [abandoning, setAbandoning] = useState<LocalAgentAdminRequest>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const adopt = useCallback((next: LocalAgentView) => {
    setView(next);
    setDraft(draftOf(next.config));
  }, []);

  const load = useCallback(async () => {
    try {
      const [next, listed] = await Promise.all([
        api<LocalAgentView>("/api/local-agent/config"),
        api<{ requests: LocalAgentAdminRequest[] }>("/api/local-agent/requests"),
      ]);
      setLoadError(undefined);
      adopt(next);
      setRequests(listed.requests);
    } catch (reason) {
      setLoadError(
        reason instanceof ApiError && reason.status === 403
          ? "Only a Microsoft administrator can manage the local agent API."
          : errorMessage(reason, "Could not read the local agent API settings"),
      );
    }
  }, [adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!view || !draft) {
    return (
      <section className={styles.card} aria-label="Local agent API">
        <Text weight="semibold">Local agent API</Text>
        {loadError ? (
          <MessageBar intent="warning">
            <MessageBarBody>{loadError}</MessageBarBody>
          </MessageBar>
        ) : (
          <Spinner size="tiny" label="Loading…" />
        )}
      </section>
    );
  }

  const { config, status } = view;
  const port = Number(draft.port);
  const portProblem = !/^\d+$/.test(draft.port.trim())
    ? "Enter a port number."
    : port < 1024 || port > 65_535
      ? "Use a port from 1024 to 65535."
      : port === view.hostPort
        ? "This is the Host's own port; choose another."
        : undefined;
  const changed =
    port !== config.port ||
    !sameSet(draft.leads, config.allowedLeadSessionIds) ||
    !sameSet(draft.workspaces, config.allowedWorkspaceIds);

  const leadChoices: Choice[] = view.choices.orchestrators.map((lead) => ({
    id: lead.id,
    name: lead.name,
    detail: [lead.nodeName, lead.state].filter(Boolean).join(" · "),
  }));
  const workspaceChoices: Choice[] = view.choices.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    detail: workspace.kind,
  }));
  const staleLeads = draft.leads.filter((id) => !leadChoices.some((c) => c.id === id));
  const staleWorkspaces = draft.workspaces.filter(
    (id) => !workspaceChoices.some((c) => c.id === id),
  );

  const save = (enabled: boolean, scope: Draft) =>
    run(async () => {
      setBusy(true);
      try {
        const next = await api<LocalAgentView>("/api/local-agent/config", {
          method: "PUT",
          body: JSON.stringify({
            enabled,
            port: Number(scope.port),
            allowedLeadSessionIds: scope.leads,
            allowedWorkspaceIds: scope.workspaces,
            expectedRevision: config.revision,
          }),
        });
        adopt(next);
        notify(
          enabled
            ? next.status.state === "listening"
              ? "Local agent API saved."
              : "Saved, but the local agent API is not listening. See its status."
            : "Local agent API turned off.",
          enabled && next.status.state !== "listening" ? "warning" : "success",
        );
      } catch (reason) {
        // Someone else saved first: show what is there now rather than overwrite it.
        if (reason instanceof ApiError && reason.status === 409) await load();
        throw reason;
      } finally {
        setBusy(false);
      }
    }, false);

  const abandon = (request: LocalAgentAdminRequest) =>
    run(async () => {
      setBusy(true);
      try {
        await api(
          `/api/local-agent/requests/${encodeURIComponent(request.operationId)}/disposition`,
          {
            method: "POST",
            body: JSON.stringify({
              action: "abandon",
              reason: reason.trim(),
              expectedRequestVersion: request.version,
              ...(request.briefDigest
                ? { expectedBriefDigest: request.briefDigest }
                : {}),
            }),
          },
        );
        setAbandoning(undefined);
        setReason("");
        notify("Request abandoned.", "success");
      } finally {
        setBusy(false);
        await load();
      }
    }, false);

  const url = status.url ?? `http://127.0.0.1:${config.port}`;
  const curl = `curl -H "${LOCAL_AGENT_HEADER}: 1" ${url}/v1/orchestrators`;
  const mcp = JSON.stringify(
    {
      mcpServers: {
        "copilot-fleet": {
          type: "http",
          url: `${url}/v1/mcp`,
          headers: { [LOCAL_AGENT_HEADER]: "1" },
        },
      },
    },
    null,
    2,
  );

  const picker = (
    label: string,
    choices: Choice[],
    stale: string[],
    selected: string[],
    pick: (next: string[]) => void,
  ) => (
    <Field label={label}>
      <div className={styles.choices}>
        {choices.length === 0 && stale.length === 0 && (
          <Text className={styles.caption}>None on this Host.</Text>
        )}
        {choices.map((choice) => (
          <Checkbox
            key={choice.id}
            checked={selected.includes(choice.id)}
            disabled={busy}
            onChange={(_event, data) =>
              pick(toggle(selected, choice.id, data.checked === true))
            }
            label={
              <span>
                {choice.name}
                {choice.detail && (
                  <Text className={styles.caption}> — {choice.detail}</Text>
                )}
              </span>
            }
          />
        ))}
        {stale.map((id) => (
          <Checkbox
            key={id}
            checked
            disabled={busy}
            onChange={() => pick(toggle(selected, id, false))}
            label={
              <span>
                <Badge appearance="tint" color="warning" size="small">
                  Stale
                </Badge>{" "}
                <Text className={styles.caption}>
                  {id} — no longer exists; grants nothing
                </Text>
              </span>
            }
          />
        ))}
      </div>
    </Field>
  );

  const badge = STATUS[status.state];
  return (
    <section className={styles.card} aria-label="Local agent API">
      <div>
        <Text weight="semibold">Local agent API</Text>
        <br />
        <Text className={styles.caption}>
          Lets an agent on this computer — Hermes, an MCP client, a script — list the
          orchestrators and workspaces chosen here, create tasks, ask about them, and read
          their transcripts, over plain HTTP or MCP on a loopback port. It has no
          password: anything that can reach the port is trusted, so expose only what you
          would let any local program drive.
        </Text>
      </div>

      <div className={styles.facts}>
        <Text>Listener</Text>
        <span className={styles.row}>
          <Badge appearance="filled" color={badge.color}>
            {badge.label}
          </Badge>
          {status.state === "listening" && status.url && (
            <Text className={styles.caption}>{status.url}</Text>
          )}
        </span>
        <Text>Saved setting</Text>
        <Text>
          {config.enabled ? "On" : "Off"} · port {config.port} ·{" "}
          {config.allowedLeadSessionIds.length} orchestrator(s) ·{" "}
          {config.allowedWorkspaceIds.length} workspace(s) · revision {config.revision}
        </Text>
      </div>

      {status.state === "error" && status.error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>{status.error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.scope}>
        {picker(
          "Orchestrators it may use",
          leadChoices,
          staleLeads,
          draft.leads,
          (leads) => setDraft({ ...draft, leads }),
        )}
        {picker(
          "Workspaces it may create tasks in",
          workspaceChoices,
          staleWorkspaces,
          draft.workspaces,
          (workspaces) => setDraft({ ...draft, workspaces }),
        )}
      </div>

      <div className={styles.row}>
        <Field
          label="Port"
          validationState={portProblem ? "error" : "none"}
          validationMessage={
            portProblem ??
            `127.0.0.1 only. Default ${view.defaultPort}; this Host itself uses ${view.hostPort}.`
          }
        >
          <Input
            value={draft.port}
            inputMode="numeric"
            disabled={busy}
            onChange={(_event, data) => setDraft({ ...draft, port: data.value })}
          />
        </Field>
      </div>

      <div className={styles.row}>
        {config.enabled ? (
          <>
            <Button
              appearance="primary"
              disabled={busy || !changed || !!portProblem}
              onClick={() => void save(true, draft)}
            >
              Save changes
            </Button>
            <Button
              appearance="secondary"
              disabled={busy}
              onClick={() => void save(false, draftOf(config))}
            >
              Turn off
            </Button>
          </>
        ) : (
          <Button
            appearance="primary"
            disabled={busy || !!portProblem}
            onClick={() => setConfirmingEnable(true)}
          >
            Turn on…
          </Button>
        )}
        {changed && (
          <Button
            appearance="subtle"
            disabled={busy}
            onClick={() => setDraft(draftOf(config))}
          >
            Discard edits
          </Button>
        )}
      </div>
      <Text className={styles.caption}>
        With Microsoft sign-in on, turning it on or widening it needs a sign-in from the
        last few minutes. Turning it off stops new requests at once; anything already
        accepted still reaches its orchestrator through the normal delivery path, and Stop
        remains how to halt it. Restoring a backup or resetting sign-in turns it off.
      </Text>

      {config.enabled && (
        <>
          <Text weight="semibold">Connect an agent</Text>
          <Text className={styles.caption}>
            Every request must carry the <code>{LOCAL_AGENT_HEADER}: 1</code> header and
            address the numeric URL exactly. A browser page cannot call it. Never forward
            or tunnel this port.
          </Text>
          <div className={styles.example}>
            <pre className={styles.mono}>{curl}</pre>
            <CopyButton text={curl} label="Copy curl example" />
          </div>
          <div className={styles.example}>
            <pre className={styles.mono}>{mcp}</pre>
            <CopyButton text={mcp} label="Copy MCP client configuration" />
          </div>
        </>
      )}

      <div className={styles.row}>
        <Text weight="semibold">Requests from local agents</Text>
        <Button
          appearance="subtle"
          size="small"
          disabled={busy}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>
      {requests.length === 0 ? (
        <Text className={styles.caption}>No local agent has made a request yet.</Text>
      ) : (
        <div className={styles.tableScroll}>
          <Table size="small" className={styles.table} aria-label="Local agent requests">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>Request</TableHeaderCell>
                <TableHeaderCell>Task</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>From</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.operationId}>
                  <TableCell>{new Date(request.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{request.kind.replace("_", " ")}</TableCell>
                  <TableCell>
                    {request.targetDeleted ? "(deleted task)" : request.taskName}
                  </TableCell>
                  <TableCell>
                    {request.state.replaceAll("_", " ")}
                    {request.disposition && (
                      <Text className={styles.caption}>
                        {" "}
                        — {request.disposition.reason}
                      </Text>
                    )}
                    {request.detail && (
                      <Text className={styles.caption}> — {request.detail}</Text>
                    )}
                  </TableCell>
                  <TableCell>{request.clientLabel ?? "—"}</TableCell>
                  <TableCell>
                    {!FINISHED.has(request.state) && (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          setReason("");
                          setAbandoning(request);
                        }}
                      >
                        Abandon…
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={active && confirmingEnable}
        onOpenChange={(_event, data) => {
          if (!data.open) setConfirmingEnable(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Turn on the local agent API?</DialogTitle>
            <DialogContent>
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>{ENABLE_WARNING}</MessageBarBody>
              </MessageBar>
              <br />
              <Text>
                It will listen on 127.0.0.1:{draft.port} and expose {draft.leads.length}{" "}
                orchestrator(s) and {draft.workspaces.length} workspace(s).
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmingEnable(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => {
                  setConfirmingEnable(false);
                  void save(true, draft);
                }}
              >
                Turn on
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={active && abandoning !== undefined}
        onOpenChange={(_event, data) => {
          if (!data.open) setAbandoning(undefined);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Abandon this request?</DialogTitle>
            <DialogContent>
              {abandoning && (
                <>
                  <Text>
                    {abandoning.kind.replace("_", " ")} on{" "}
                    {abandoning.targetDeleted ? "a deleted task" : abandoning.taskName},
                    now {abandoning.state.replaceAll("_", " ")}.{" "}
                    {abandoning.dispatchEverReserved
                      ? "It was handed to the orchestrator's agent, so it cannot be called cancelled: the Host only records it as abandoned once that turn can no longer continue."
                      : "It was never handed to the orchestrator's agent, so abandoning withdraws it."}
                  </Text>
                  {abandoning.owedPreview !== undefined && (
                    <>
                      <br />
                      <br />
                      <Text weight="semibold">
                        The task brief that will be withdrawn, exactly:
                      </Text>
                      <div className={styles.owed}>{abandoning.owedPreview}</div>
                      <Text className={styles.caption}>
                        Anything a person added after it stays queued for the
                        orchestrator.
                      </Text>
                    </>
                  )}
                  <br />
                  <Field label="Reason" required>
                    <Input
                      value={reason}
                      disabled={busy}
                      onChange={(_event, data) => setReason(data.value)}
                    />
                  </Field>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAbandoning(undefined)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={busy || !reason.trim()}
                onClick={() => abandoning && void abandon(abandoning)}
              >
                Abandon
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
};
