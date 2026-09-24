import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowSync20Regular } from "@fluentui/react-icons";
import {
  errorMessage,
  updateFinished,
  type FleetSession,
  type HostUpdateStatus,
  type UpdateStage,
} from "@fleet/protocol";
import { ApiError, api } from "../hooks/useFleet";
import { useSettingsActive } from "../hooks/useSettingsActivity";
import { sessionLabel } from "../lib/session-label";

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    "@media (max-width: 600px)": { flexWrap: "wrap" },
  },
  caption: { color: tokens.colorNeutralForeground3 },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: "12px",
  },
  progress: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
    overflowWrap: "anywhere",
  },
  button: { flexShrink: 0 },
  dialogBody: { display: "flex", flexDirection: "column", gap: "10px" },
  sessionList: {
    margin: 0,
    paddingLeft: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
});

const stageLabels: Record<UpdateStage, string> = {
  checking: "Checking…",
  pulling: "Pulling…",
  installing: "Installing…",
  building: "Building…",
  restarting: "Restarting…",
  up_to_date: "Up to date",
  failed: "Update failed",
};

export type HostUpdateCardProps = {
  status: HostUpdateStatus;
  /** The commit the Host's checkout is on. */
  revision: string;
};

/**
 * Pull, install, build and restart for the Host itself, from Settings.
 *
 * Progress arrives with the fleet as `host_update` rather than being polled
 * here: the Host restarts in the middle of it, and the snapshot a browser takes
 * when it reconnects already carries how the update ended.
 */
export const HostUpdateCard = ({ status, revision }: HostUpdateCardProps) => {
  const styles = useStyles();
  const active = useSettingsActive();
  const [confirming, setConfirming] = useState(false);
  /** The sessions standing in the way, once the Host has named them. */
  const [blocked, setBlocked] = useState<FleetSession[]>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const update = status.update;
  const running = update !== undefined && !updateFinished(update.stage);
  const available = status.unavailableReason === "";

  const submit = async (stopping?: FleetSession[]) => {
    setSubmitting(true);
    setError(undefined);
    try {
      await api("/api/host/update", {
        method: "POST",
        body: JSON.stringify(
          stopping
            ? { stopSessions: true, sessionIds: stopping.map((session) => session.id) }
            : { stopSessions: false },
        ),
      });
      setConfirming(false);
      setBlocked(undefined);
    } catch (reason) {
      const sessions =
        reason instanceof ApiError && Array.isArray(reason.body.blockedBy)
          ? (reason.body.blockedBy as FleetSession[])
          : [];
      setConfirming(false);
      // A refusal naming sessions — including ones started since the last
      // list — asks again rather than failing.
      if (sessions.length > 0) {
        setBlocked(sessions);
      } else {
        setBlocked(undefined);
        setError(errorMessage(reason));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Update Host">
      <div className={styles.row}>
        <div>
          <Text weight="semibold">Update Host</Text>
          <br />
          <Text className={styles.caption}>
            Pulls the newest commit of the branch this checkout tracks, installs
            dependencies and builds, then restarts the Host and the Node started beside it
            the way they were started. A build that fails restarts nothing.
          </Text>
        </div>
        <Button
          className={styles.button}
          appearance="primary"
          icon={running ? <Spinner size="tiny" /> : <ArrowSync20Regular />}
          disabled={!available || running || submitting}
          onClick={() => setConfirming(true)}
        >
          {running ? stageLabels[update.stage] : "Update Host"}
        </Button>
      </div>
      <Text className={styles.caption}>
        On <span className={styles.mono}>{revision || "an unknown commit"}</span>
        {status.restartCommand ? (
          <>
            {"; restarts with "}
            <span className={styles.mono}>{status.restartCommand}</span>
          </>
        ) : null}
        .
      </Text>
      {!available && (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>{status.unavailableReason}</MessageBarBody>
        </MessageBar>
      )}
      {update && (
        <div className={styles.progress} role="status">
          <Badge
            appearance="tint"
            color={
              update.stage === "failed"
                ? "danger"
                : update.stage === "up_to_date"
                  ? "success"
                  : "informative"
            }
          >
            {running
              ? stageLabels[update.stage]
              : `Last update: ${stageLabels[update.stage]}`}
          </Badge>
          <Text className={styles.caption}>
            {update.detail}
            {running ? "" : ` · ${new Date(update.updatedAt).toLocaleString()}`}
          </Text>
        </div>
      )}
      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <Dialog
        open={active && confirming}
        onOpenChange={(_event, data) => {
          if (!data.open) setConfirming(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Update and restart the Host?</DialogTitle>
            <DialogContent className={styles.dialogBody}>
              <Text>
                The Host resets this checkout onto the branch it tracks, installs
                dependencies and builds, then restarts itself and this machine&apos;s Node
                with <span className={styles.mono}>{status.restartCommand}</span>.
              </Text>
              <Text className={styles.caption}>
                Local commits that are not on that branch are dropped from it, as on a
                Node; uncommitted changes stop the update instead. Browsers reconnect when
                the Host is back, and sessions on other machines keep running.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={submitting}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={submitting}
                onClick={() => void submit()}
              >
                {submitting ? "Starting…" : "Update"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={active && Boolean(blocked)}
        onOpenChange={(_event, data) => {
          if (!data.open) setBlocked(undefined);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Stop {blocked?.length} session(s) to update?</DialogTitle>
            <DialogContent className={styles.dialogBody}>
              <Text>
                Updating the Host restarts this machine&apos;s Node, and the agents it is
                hosting stop with it. These sessions are running there now:
              </Text>
              <ul className={styles.sessionList}>
                {blocked?.map((session) => (
                  <li key={session.id}>
                    <Text weight="semibold">{sessionLabel(session)}</Text>
                    <Text className={styles.caption}>
                      {" "}
                      · {session.workspaceName} · {session.state}
                    </Text>
                  </li>
                ))}
              </ul>
              <Text className={styles.caption}>
                Each one keeps its transcript and can be resumed afterwards.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={submitting}
                onClick={() => setBlocked(undefined)}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={submitting || !blocked}
                onClick={() => void submit(blocked)}
              >
                {submitting ? "Stopping…" : "Stop and update"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
};
