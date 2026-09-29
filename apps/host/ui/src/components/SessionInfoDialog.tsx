import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Info20Regular } from "@fluentui/react-icons";
import {
  agentKindLabels,
  terminalSessionStates,
  type FleetNode,
  type FleetSession,
  type Placement,
} from "@fleet/protocol";
import { localResume, sessionWorkingDirectory } from "../lib/session-info";
import { sessionLabel } from "../lib/session-label";
import { sessionStatusLabel } from "../lib/session-status";
import { statusVisuals, terminal } from "../theme";
import { CopyButton } from "./CopyButton";

const useStyles = makeStyles({
  surface: {
    width: "min(620px, calc(100vw - 32px))",
    maxWidth: "620px",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    minWidth: 0,
  },
  summary: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "10px",
    overflowWrap: "anywhere",
  },
  details: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: "14px 20px",
    margin: 0,
    "@media (max-width: 480px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  wide: { gridColumn: "1 / -1" },
  label: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "4px",
  },
  value: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    margin: 0,
    overflowWrap: "anywhere",
  },
  mono: { fontFamily: terminal.font, fontSize: tokens.fontSizeBase200, minWidth: 0 },
  recovery: {
    padding: "14px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${statusVisuals.info.border}`,
    background: statusVisuals.info.surface,
  },
  recoveryTitle: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  instructions: {
    margin: "8px 0",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
  },
  code: {
    margin: "10px 0",
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    background: terminal.background,
    fontFamily: terminal.font,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});

type SessionInfoDialogProps = {
  session: FleetSession;
  node?: FleetNode | undefined;
  placement?: Placement | undefined;
  className?: string;
};

export function SessionInfoDialog({
  session,
  node,
  placement,
  className,
}: SessionInfoDialogProps) {
  const styles = useStyles();
  const resume = localResume(session, node, placement);
  const agentLabel = agentKindLabels[session.agentParams?.kind ?? "copilot"];
  const directory = sessionWorkingDirectory(session, placement);
  const model = session.configOptions.find((option) => option.category === "model");
  const modelName =
    model?.choices.find((choice) => choice.value === model.currentValue)?.name ??
    model?.currentValue;
  const mayBeRunning = !terminalSessionStates.has(session.state) || session.stopRequested;

  return (
    <Dialog>
      <DialogTrigger disableButtonEnhancement>
        <Button
          className={className}
          appearance="subtle"
          size="small"
          icon={<Info20Regular />}
          aria-label="Session information"
          title="Session information"
        />
      </DialogTrigger>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Session information</DialogTitle>
          <DialogContent className={styles.content}>
            <div className={styles.summary}>
              <strong>{sessionLabel(session)}</strong>
              <Badge appearance="tint">{sessionStatusLabel(session)}</Badge>
            </div>
            <dl className={styles.details}>
              <div>
                <dt className={styles.label}>Agent backend</dt>
                <dd className={styles.value}>
                  {agentLabel}
                  {session.agentParams?.kind === "hermes"
                    ? ` (${session.agentParams.profile})`
                    : ""}
                </dd>
              </div>
              <div>
                <dt className={styles.label}>Node</dt>
                <dd className={styles.value}>
                  {session.nodeName}
                  {node ? ` (${node.online ? "online" : "offline"})` : ""}
                </dd>
              </div>
              <div>
                <dt className={styles.label}>Platform</dt>
                <dd className={styles.value}>
                  {node ? `${node.os} / ${node.arch}` : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt className={styles.label}>Workspace</dt>
                <dd className={styles.value}>{session.workspaceName}</dd>
              </div>
              <div>
                <dt className={styles.label}>Role</dt>
                <dd className={styles.value}>
                  {session.runRole === "lead"
                    ? "Orchestrator"
                    : session.runRole || "Chat"}
                </dd>
              </div>
              <div className={styles.wide}>
                <dt className={styles.label}>Working directory</dt>
                <dd className={styles.value}>
                  <span className={styles.mono}>{directory || "Unavailable"}</span>
                  {directory && (
                    <CopyButton text={directory} label="Copy working directory" />
                  )}
                </dd>
              </div>
              <div className={styles.wide}>
                <dt className={styles.label}>{agentLabel} session ID</dt>
                <dd className={styles.value}>
                  <span className={styles.mono}>
                    {session.agentSessionId || "Not reported yet"}
                  </span>
                  {session.agentSessionId && (
                    <CopyButton
                      text={session.agentSessionId}
                      label={`Copy ${agentLabel} session ID`}
                    />
                  )}
                </dd>
              </div>
              <div className={styles.wide}>
                <dt className={styles.label}>Fleet session ID</dt>
                <dd className={styles.value}>
                  <span className={styles.mono}>{session.id}</span>
                  <CopyButton text={session.id} label="Copy Fleet session ID" />
                </dd>
              </div>
              <div>
                <dt className={styles.label}>Model</dt>
                <dd className={styles.value}>{modelName || "Not reported yet"}</dd>
              </div>
              <div>
                <dt className={styles.label}>Permissions</dt>
                <dd className={styles.value}>
                  {session.yolo ? "YOLO (allow all)" : "Ask for approval"}
                </dd>
              </div>
              <div>
                <dt className={styles.label}>Created</dt>
                <dd className={styles.value}>
                  <time dateTime={session.createdAt}>
                    {new Date(session.createdAt).toLocaleString()}
                  </time>
                </dd>
              </div>
              <div>
                <dt className={styles.label}>
                  {session.lastActivityAt ? "Last activity" : "Updated"}
                </dt>
                <dd className={styles.value}>
                  <time dateTime={session.lastActivityAt ?? session.updatedAt}>
                    {new Date(
                      session.lastActivityAt ?? session.updatedAt,
                    ).toLocaleString()}
                  </time>
                </dd>
              </div>
            </dl>
            <section className={styles.recovery} aria-label="Resume on the node">
              <div className={styles.recoveryTitle}>
                <strong>Resume on the node</strong>
                {resume.command && (
                  <CopyButton text={resume.command} label="Copy resume command" />
                )}
              </div>
              {resume.command ? (
                <>
                  <p className={styles.instructions}>
                    On <strong>{session.nodeName}</strong>, open {resume.shell} as the
                    same OS user that runs the Fleet Node.
                  </p>
                  {mayBeRunning && (
                    <p className={styles.instructions}>
                      <strong>This session may still be running.</strong> Stop it in Fleet
                      and wait for confirmation, or verify on the node that its process
                      has exited, before running this command.
                    </p>
                  )}
                  <pre className={styles.code}>{resume.command}</pre>
                  <p className={styles.instructions}>
                    {session.agentParams?.kind === "hermes"
                      ? "Uses Hermes with this session's saved profile. Stop any other process using that profile before local recovery. Keep the same OS user and original working directory."
                      : "Uses standard Copilot CLI and the bound execution directory when available, otherwise the current placement. If the directory moved, use the original directory. If you use Agency or a custom launcher, use its equivalent resume command and the same Copilot configuration."}
                  </p>
                  <p className={styles.instructions}>
                    Local recovery does not reconnect this terminal to Fleet
                    {session.runRole
                      ? " or restore orchestration tools. Use Fleet Resume to continue managed work."
                      : ". Use Fleet Resume to keep controlling the session here."}
                  </p>
                </>
              ) : (
                <p className={styles.instructions}>{resume.reason}</p>
              )}
            </section>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
