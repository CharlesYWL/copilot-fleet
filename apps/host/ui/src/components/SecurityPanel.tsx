import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ERASE_AUTH_CONFIRMATION,
  OPERATOR_PASSWORD_REQUIREMENTS,
  OperatorPasswordSchema,
  errorMessage,
  type AuthStatus,
} from "@fleet/protocol";
import { useMessageNotification } from "../hooks/useAppNotifications";
import { api, ApiError } from "../hooks/useFleet";
import { browserNavigation, csrfToken, startCodeLogin } from "../lib/auth";
import { pollUntilSignedIn, type DeviceFlow } from "../lib/device-login";
import { DeviceCodePanel } from "./auth/DeviceCodePanel";
import { MicrosoftSignInForm } from "./auth/MicrosoftSignInForm";
import { CopyButton } from "./CopyButton";
import { PortableBackupCard } from "./PortableBackupCard";
import { terminal } from "../theme";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
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
  mono: {
    fontFamily: terminal.font,
    fontSize: "12px",
    wordBreak: "break-all",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  },
  identity: {
    display: "flex",
    flexDirection: "column",
    overflowWrap: "anywhere",
  },
  tableScroll: {
    overflowX: "auto",
  },
  table: {
    tableLayout: "auto",
    minWidth: "640px",
    overflowWrap: "anywhere",
  },
});

type PendingCandidate = {
  id: string;
  tenantId: string;
  objectId: string;
  username: string;
  displayName: string;
  consumedAt: string;
};

type Administrator = {
  id: string;
  tenantId: string;
  objectId: string;
  username: string;
  displayName: string;
  addedVia: string;
  createdAt: string;
  lastLoginAt: string;
};

type AuditEvent = {
  id: string;
  eventType: string;
  actorKind: string;
  actorId: string;
  targetId: string;
  requestHost: string;
  outcome: string;
  detail: string;
  createdAt: string;
};

type Enrollment = {
  hostId: string;
  hostFingerprint: string;
  nodeAuthentication: { total: number; mutualAuth: number; legacy: number };
  mutualAuthenticationRequired: boolean;
};

type Security = {
  status: AuthStatus;
  administrators: Administrator[];
  pending: PendingCandidate[];
  audit: AuditEvent[];
  enrollment: Enrollment;
};

const AUTH_MODE_COPY: Record<AuthStatus["state"], string> = {
  "entra-unconfigured": "No Microsoft sign-in is configured on this Host.",
  unclaimed: "Configured, but nobody has claimed this Fleet yet.",
  "legacy-password":
    "Password sign-in only. Claim this Fleet with a Microsoft account to replace it.",
  hybrid:
    "Password sign-in is still enabled alongside Microsoft accounts. It identifies nobody, so retire it once every administrator has signed in.",
  "microsoft-only": "Microsoft accounts only. A shared password cannot sign anyone in.",
  recovery:
    "A temporary recovery password is enabled from the Host console. Disable it once you are back in.",
};

/**
 * Everything about who may drive this fleet, on one page.
 *
 * Four reads rather than one composite endpoint, because each already exists
 * and each is independently authorised: an aggregate would be a new surface
 * whose permissions could drift from the parts it aggregates.
 */
export const SecurityPanel = () => {
  const styles = useStyles();
  const [data, setData] = useState<Security>();
  const [error, setError] = useState<string>();
  const [reauth, setReauth] = useState<string>();
  const [signingIn, setSigningIn] = useState(false);
  useMessageNotification(error);
  useMessageNotification(reauth, "warning");

  const load = useCallback(async () => {
    try {
      const [status, admins, audit, enrollment] = await Promise.all([
        api<AuthStatus>("/api/auth/status"),
        api<{ administrators: Administrator[]; pending: PendingCandidate[] }>(
          "/api/auth/administrators",
        ),
        api<{ events: AuditEvent[] }>("/api/security/audit?limit=100"),
        api<Enrollment>("/api/enrollment"),
      ]);
      setData({
        status,
        administrators: admins.administrators,
        pending: admins.pending,
        audit: audit.events,
        enrollment,
      });
    } catch (reason) {
      setError(errorMessage(reason, "Could not read this Host's security settings"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Runs a change, and turns the Host's "prove it again" into something to do.
   *
   * A high-impact setting requires an authorization-code sign-in within the
   * last few minutes, because a device flow can be started by an attacker and
   * finished by a phished administrator. A bare 403 leaves the operator with
   * nothing but a guess; naming it lets the page offer the sign-in that fixes
   * it.
   */
  const run = useCallback(
    async (work: () => Promise<unknown>, refresh = true) => {
      setError(undefined);
      setReauth(undefined);
      try {
        await work();
        if (refresh) await load();
      } catch (reason) {
        if (
          reason instanceof ApiError &&
          reason.status === 403 &&
          reason.body.reauthRequired === true
        ) {
          setReauth(reason.message);
          return;
        }
        setError(errorMessage(reason, "That change was refused"));
      }
    },
    [load],
  );

  const confirmIdentity = async () => {
    setSigningIn(true);
    setError(undefined);
    try {
      await startCodeLogin();
    } catch (reason) {
      setError(errorMessage(reason, "Could not start Microsoft sign-in"));
    } finally {
      setSigningIn(false);
    }
  };

  const dismissFeedback = () => {
    setError(undefined);
    setReauth(undefined);
  };

  if (!data) {
    return (
      <div className={styles.panel}>
        {error ? (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        ) : (
          <Spinner label="Loading security settings…" />
        )}
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div>
        <Title3 as="h1">Security</Title3>
        <br />
        <Text className={styles.caption}>
          Reaching this Host, being authenticated by Microsoft, and being trusted by these
          Nodes are three separate facts. This page is where the middle one is decided.
        </Text>
      </div>

      <IdentityCard status={data.status} enrollment={data.enrollment} />
      <MicrosoftConfigurationCard status={data.status} run={run} />
      <PasswordCard status={data.status} run={run} />
      <DeviceFlowCard status={data.status} onChanged={load} />
      <PendingCard pending={data.pending} run={run} />
      <AdministratorsCard administrators={data.administrators} run={run} />
      <NodeMigrationCard enrollment={data.enrollment} run={run} />
      {/*
       * Placed with the administrators rather than with session defaults,
       * because that is what it moves: the data archive on the General tab
       * deliberately leaves this Host's security envelope alone.
       */}
      <PortableBackupCard
        claimed={!data.status.claimCodeRequired}
        onImported={() => window.location.reload()}
      />
      <AuditCard events={data.audit} />
      <EraseAuthCard run={run} />
      <Dialog
        open={Boolean(error || reauth)}
        onOpenChange={(_event, data) => {
          if (!data.open && !signingIn) dismissFeedback();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {reauth
                ? "Confirm this change with Microsoft"
                : "Could not complete the change"}
            </DialogTitle>
            <DialogContent>
              {reauth && (
                <Text>
                  {reauth} Use your current administrator account, then return to Settings
                  → Security and retry the action.
                </Text>
              )}
              {error && (
                <MessageBar intent="error" layout="multiline">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={signingIn}
                onClick={dismissFeedback}
              >
                {reauth ? "Cancel" : "Close"}
              </Button>
              {reauth && (
                <Button
                  appearance="primary"
                  disabled={signingIn}
                  onClick={() => void confirmIdentity()}
                >
                  {signingIn ? "Opening Microsoft…" : "Confirm with Microsoft"}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
};

function IdentityCard({
  status,
  enrollment,
}: {
  status: AuthStatus;
  enrollment: Enrollment;
}) {
  const styles = useStyles();
  useMessageNotification(
    status.state === "microsoft-only" ? undefined : AUTH_MODE_COPY[status.state],
    "warning",
  );
  return (
    <section className={styles.card} aria-label="This Host">
      <Text weight="semibold">This Host</Text>
      <div className={styles.facts}>
        <Text className={styles.caption}>Signed in as</Text>
        <span className={styles.identity}>
          <Text>{status.identity?.username ?? "a shared password session"}</Text>
          {status.identity?.displayName && (
            <Text className={styles.caption}>{status.identity.displayName}</Text>
          )}
        </span>

        <Text className={styles.caption}>Authentication mode</Text>
        <Text>{AUTH_MODE_COPY[status.state]}</Text>

        <Text className={styles.caption}>Supported accounts</Text>
        <Text>
          {!status.entra
            ? "not configured"
            : status.entra.tenantId === "common"
              ? "Work/school and personal Microsoft accounts"
              : "Accounts in one fixed directory"}
        </Text>

        {status.entra && status.entra.tenantId !== "common" && (
          <>
            <Text className={styles.caption}>Directory (tenant) ID</Text>
            <Text className={styles.mono}>{status.entra.tenantId}</Text>
          </>
        )}

        <Text className={styles.caption}>Application (client) ID</Text>
        <Text className={styles.mono}>{status.entra?.clientId ?? "not configured"}</Text>

        <Text className={styles.caption}>Host ID</Text>
        <Text className={styles.mono}>{enrollment.hostId}</Text>

        <Text className={styles.caption}>Host fingerprint</Text>
        <span className={styles.row}>
          <Text className={styles.mono}>{enrollment.hostFingerprint}</Text>
          <CopyButton text={enrollment.hostFingerprint} label="Copy the fingerprint" />
        </span>
      </div>
      <Text className={styles.caption}>
        A Node that has pinned this fingerprint sends nothing to anything that cannot sign
        for the matching key, which is what makes a relay merely a relay.
      </Text>
    </section>
  );
}

function MicrosoftConfigurationCard({
  status,
  run,
}: {
  status: AuthStatus;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const styles = useStyles();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const change = async (configuration: NonNullable<AuthStatus["entra"]>) => {
    setBusy(true);
    let navigating = false;
    try {
      await run(async () => {
        const result = await api<{ authorizationUrl: string } | undefined>(
          "/api/auth/configuration/start",
          { method: "POST", body: JSON.stringify(configuration) },
        );
        if (typeof result?.authorizationUrl !== "string" || !result.authorizationUrl) {
          throw new Error("The Host returned no Microsoft verification URL. Try again.");
        }
        browserNavigation.assign(result.authorizationUrl);
        navigating = true;
      });
    } finally {
      if (!navigating) setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Microsoft sign-in configuration">
      <Text weight="semibold">Microsoft sign-in configuration</Text>
      <Text className={styles.caption}>
        The current configuration stays active until you sign in through the new
        registration as the same administrator, with the same directory and object IDs.
        Failed or cancelled verification leaves it unchanged.
      </Text>
      {editing ? (
        <>
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              A successful switch signs out other sessions, clears pending sign-in and
              device transactions, and turns device sign-in off until reverified. Other
              administrator records stay in place; narrowing to a fixed directory can
              prevent administrators from other directories from signing in.
            </MessageBarBody>
          </MessageBar>
          <Text className={styles.caption}>
            Use this Host on localhost or through a local forward. This change requires a
            recent Microsoft authorization-code sign-in, not a device code or shared
            password. If prompted, confirm your current administrator account, then return
            here and retry.
          </Text>
          <Text className={styles.caption}>
            A guest account and its home account may have different identities even with
            the same email. A different identity needs administrator approval; Fleet never
            merges accounts by email.
          </Text>
          <MicrosoftSignInForm
            configuration={status.entra}
            busy={busy}
            submitLabel="Verify new configuration with Microsoft"
            busyLabel="Opening Microsoft…"
            onSubmit={change}
          />
          <div className={styles.row}>
            <Button disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.row}>
          <Button appearance="secondary" onClick={() => setEditing(true)}>
            Change Microsoft sign-in configuration
          </Button>
        </div>
      )}
    </section>
  );
}

function PasswordCard({
  status,
  run,
}: {
  status: AuthStatus;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const styles = useStyles();
  const [dialog, setDialog] = useState<"enable" | "disable">();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const enabling = !status.passwordEnabled;
  const action = enabling ? "enable" : "disable";
  const parsedPassword = OperatorPasswordSchema.safeParse(password);
  const enableError =
    password.length > 0 && !parsedPassword.success
      ? parsedPassword.error.issues[0]?.message
      : confirmation.length > 0 && password !== confirmation
        ? "The passwords do not match."
        : undefined;
  return (
    <section className={styles.card} aria-label="Password sign-in">
      <Text weight="semibold">Password sign-in</Text>
      {enabling ? (
        <Text className={styles.caption}>
          Disabled by default after this Host was claimed. Only approved Microsoft
          accounts can sign in.
        </Text>
      ) : (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>{AUTH_MODE_COPY[status.state]}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.row}>
        <Button
          appearance={enabling ? "secondary" : "primary"}
          onClick={() => setDialog(action)}
        >
          {enabling ? "Enable password sign-in" : "Disable password sign-in"}
        </Button>
      </div>
      <Dialog
        open={dialog === action}
        onOpenChange={(_event, data) => setDialog(data.open ? action : undefined)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {enabling ? "Enable shared password sign-in?" : "Disable password sign-in?"}
            </DialogTitle>
            <DialogContent>
              {enabling ? (
                <>
                  <Text>
                    This adds a second way to control every Node. Anyone who knows this
                    password has full Fleet access and is not identified as a Microsoft
                    account.
                  </Text>
                  <Field
                    label="New operator password"
                    hint={OPERATOR_PASSWORD_REQUIREMENTS}
                    validationState={enableError ? "error" : "none"}
                    {...(enableError ? { validationMessage: enableError } : {})}
                  >
                    <Input
                      type="password"
                      value={password}
                      maxLength={512}
                      autoComplete="new-password"
                      onChange={(_event, data) => setPassword(data.value)}
                    />
                  </Field>
                  <Field label="Confirm operator password">
                    <Input
                      type="password"
                      value={confirmation}
                      maxLength={512}
                      autoComplete="new-password"
                      onChange={(_event, data) => setConfirmation(data.value)}
                    />
                  </Field>
                </>
              ) : (
                <Text>
                  The stored password is deleted and every session that used it is revoked
                  immediately, closing their browser connections. Anyone who signs in
                  after this needs a Microsoft account you have added. A local recovery
                  command can issue a temporary password if you lock yourself out.
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDialog(undefined)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={
                  enabling && (!password || !confirmation || Boolean(enableError))
                }
                onClick={() => {
                  const chosen = password;
                  if (enabling) {
                    setPassword("");
                    setConfirmation("");
                  }
                  setDialog(undefined);
                  void run(() =>
                    api(`/api/auth/password/${action}`, {
                      method: "POST",
                      ...(enabling ? { body: JSON.stringify({ password: chosen }) } : {}),
                    }),
                  );
                }}
              >
                {enabling ? "Enable" : "Disable"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}

function EraseAuthCard({
  run,
}: {
  run: (work: () => Promise<unknown>, refresh?: boolean) => Promise<void>;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setConfirmation("");
  };
  const erase = async () => {
    close();
    setBusy(true);
    let navigating = false;
    try {
      await run(async () => {
        await api("/api/auth/erase", {
          method: "POST",
          body: JSON.stringify({ confirmation: ERASE_AUTH_CONFIRMATION }),
        });
        browserNavigation.assign("/");
        navigating = true;
      }, false);
    } finally {
      if (!navigating) setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Erase auth settings">
      <Text weight="semibold">Erase auth settings</Text>
      <Text className={styles.caption}>
        Return this Host to sign-in setup without restarting the Host or Nodes. Node
        connections, keys, enrollment, tunnels and other settings are kept.
      </Text>
      <div className={styles.row}>
        <Button disabled={busy} onClick={() => setOpen(true)}>
          {busy ? "Erasing authentication…" : "Erase auth settings"}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(_event, data) => {
          if (!data.open) close();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Erase all Host authentication?</DialogTitle>
            <DialogContent>
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  This removes Microsoft client/tenant configuration, all administrators
                  and invitations, browser sessions, passwords and device sign-in
                  settings. Every browser is signed out.
                </MessageBarBody>
              </MessageBar>
              <Text>
                You must have access to the Host console to read the new claim code and
                set up sign-in again. The code is not shown in this browser. A recent
                Microsoft authorization-code sign-in is required to confirm the reset.
              </Text>
              <Text className={styles.caption}>
                Existing authentication environment values are ignored for the rest of
                this Host process; .env is not edited. Node processes and connections stay
                running, and their data is not erased.
              </Text>
              <Field label={`Type ${ERASE_AUTH_CONFIRMATION} to confirm`}>
                <Input
                  value={confirmation}
                  autoComplete="off"
                  onChange={(_event, data) => setConfirmation(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={close}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={confirmation !== ERASE_AUTH_CONFIRMATION || busy}
                onClick={() => void erase()}
              >
                Erase and sign out
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}

/**
 * The one switch that cannot be its own precondition.
 *
 * Device sign-in stays off until this Host has watched a flow complete, because
 * Microsoft recommends blocking it and a tenant may. An administrator has to be
 * able to find out which, so the verification runs whatever the setting says
 * and only a completion writes it.
 */
function DeviceFlowCard({
  status,
  onChanged,
}: {
  status: AuthStatus;
  onChanged: () => Promise<void>;
}) {
  const styles = useStyles();
  const [flow, setFlow] = useState<DeviceFlow>();
  const [message, setMessage] = useState<string>();
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  useMessageNotification(message, blocked ? "warning" : "error");

  const verify = async () => {
    setBusy(true);
    setMessage(undefined);
    setBlocked(false);
    setFlow(undefined);
    try {
      const token = await csrfToken();
      const response = await fetch("/api/auth/device/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: "{}",
      });
      const body = (await response.json().catch(() => ({}))) as DeviceFlow & {
        error?: string;
        blocked?: boolean;
      };
      if (!response.ok) {
        setBlocked(Boolean(body.blocked));
        setMessage(body.error ?? `Could not start a verification (${response.status})`);
        return;
      }
      setFlow(body);
      const outcome = await pollUntilSignedIn({
        flowId: body.flowId,
        expiresAt: Date.parse(body.expiresAt),
        path: `/api/auth/device/verify/${body.flowId}`,
        headers: { "x-csrf-token": token },
      });
      if (outcome.outcome === "signed-in") {
        setFlow(undefined);
        await onChanged();
        return;
      }
      if (outcome.outcome === "denied") setMessage(outcome.message);
      if (outcome.outcome === "expired") {
        setMessage("That code expired before it was used. Try again.");
      }
    } catch (reason) {
      setMessage(errorMessage(reason, "Could not reach the Host"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Device sign-in">
      <div className={styles.row}>
        <Text weight="semibold">Device sign-in</Text>
        <Badge
          appearance="outline"
          color={status.deviceFlowEnabled ? "success" : "informative"}
        >
          {status.deviceFlowEnabled
            ? "Device sign-in is enabled"
            : "Device sign-in is off"}
        </Badge>
      </div>
      <Text className={styles.caption}>
        The fallback for a browser that cannot reach a loopback listener. Microsoft
        recommends blocking it by default and a tenant&apos;s Conditional Access may, so
        Fleet keeps it off until a verification has actually completed here. Enabling it
        offers the flow; it does not prove every organization permits it. Sensitive
        changes still require a recent authorization-code sign-in.
      </Text>
      {flow ? (
        <DeviceCodePanel flow={flow} error={message} />
      ) : (
        <>
          <div className={styles.row}>
            <Button appearance="secondary" disabled={busy} onClick={() => void verify()}>
              {busy ? "Asking Microsoft…" : "Verify device sign-in"}
            </Button>
          </div>
          {message && (
            <MessageBar intent={blocked ? "warning" : "error"} layout="multiline">
              <MessageBarBody>{message}</MessageBarBody>
            </MessageBar>
          )}
        </>
      )}
    </section>
  );
}

function PendingCard({
  pending,
  run,
}: {
  pending: PendingCandidate[];
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const styles = useStyles();
  if (pending.length === 0) return null;
  return (
    <section className={styles.card} aria-label="Waiting for approval">
      <Text weight="semibold">Waiting for approval</Text>
      <Text className={styles.caption}>
        Redeeming an invitation only puts an identity forward. Check that this is the
        person you invited — an invitation that leaked would show up here as somebody
        else.
      </Text>
      <div className={styles.tableScroll}>
        <Table className={styles.table} aria-label="Waiting for approval" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Account</TableHeaderCell>
              <TableHeaderCell>Object ID</TableHeaderCell>
              <TableHeaderCell>Directory</TableHeaderCell>
              <TableHeaderCell>Decision</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending.map((candidate) => (
              <TableRow key={candidate.id}>
                <TableCell>
                  <span className={styles.identity}>
                    <Text>{candidate.username}</Text>
                    <Text className={styles.caption}>{candidate.displayName}</Text>
                  </span>
                </TableCell>
                <TableCell>
                  <Text className={styles.mono}>{candidate.objectId}</Text>
                </TableCell>
                <TableCell>
                  <Text className={styles.mono}>{candidate.tenantId}</Text>
                </TableCell>
                <TableCell>
                  <div className={styles.row}>
                    <Button
                      size="small"
                      appearance="primary"
                      aria-label={`Approve ${candidate.username}`}
                      onClick={() =>
                        void run(() =>
                          api(
                            `/api/auth/administrator-invitations/${candidate.id}/approve`,
                            { method: "POST" },
                          ),
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="small"
                      appearance="secondary"
                      aria-label={`Reject ${candidate.username}`}
                      onClick={() =>
                        void run(() =>
                          api(
                            `/api/auth/administrator-invitations/${candidate.id}/reject`,
                            { method: "POST" },
                          ),
                        )
                      }
                    >
                      Reject
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function AdministratorsCard({
  administrators,
  run,
}: {
  administrators: Administrator[];
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const styles = useStyles();
  const [invitation, setInvitation] = useState<string>();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Administrator>();
  const last = administrators.length <= 1;

  const invite = async () => {
    setInviting(true);
    setInvitation(undefined);
    try {
      await run(async () => {
        const created = await api<{ id: string; token: string }>(
          "/api/auth/administrator-invitations",
          { method: "POST" },
        );
        setInvitation(
          `${window.location.origin}/?invitation=${encodeURIComponent(created.token)}`,
        );
      });
    } finally {
      setInviting(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Administrators">
      <div className={styles.row}>
        <Text weight="semibold">Administrators</Text>
        <Badge appearance="outline">{administrators.length}</Badge>
      </div>
      <Text className={styles.caption}>
        Every administrator has full authority. Fleet keys them by directory and object
        id, never by email — a renamed or re-created account is a different identity.
      </Text>

      <div className={styles.tableScroll}>
        <Table className={styles.table} aria-label="Administrators" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Account</TableHeaderCell>
              <TableHeaderCell>Object ID</TableHeaderCell>
              <TableHeaderCell>Added</TableHeaderCell>
              <TableHeaderCell>Last signed in</TableHeaderCell>
              <TableHeaderCell>Remove</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {administrators.map((administrator) => (
              <TableRow key={administrator.id}>
                <TableCell>
                  <span className={styles.identity}>
                    <Text>{administrator.username}</Text>
                    <Text className={styles.caption}>{administrator.displayName}</Text>
                  </span>
                </TableCell>
                <TableCell>
                  <Text className={styles.mono}>{administrator.objectId}</Text>
                </TableCell>
                <TableCell>
                  <Text className={styles.caption}>{administrator.addedVia}</Text>
                </TableCell>
                <TableCell>
                  <Text className={styles.caption}>
                    {administrator.lastLoginAt
                      ? new Date(administrator.lastLoginAt).toLocaleString()
                      : "never"}
                  </Text>
                </TableCell>
                <TableCell>
                  <Button
                    size="small"
                    appearance="secondary"
                    disabled={last}
                    aria-label={`Remove ${administrator.username}`}
                    onClick={() => setRemoving(administrator)}
                  >
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className={styles.row}>
        <Button appearance="primary" disabled={inviting} onClick={() => void invite()}>
          {inviting ? "Creating invitation…" : "Add administrator"}
        </Button>
        {last && (
          <Text className={styles.caption}>
            The last active administrator cannot be removed.
          </Text>
        )}
      </div>

      {invitation && (
        <>
          <Text>
            Open this link in a private browser window or a different browser profile to
            sign in with the second Microsoft account. Then refresh this Security page and
            approve that account under Waiting for approval.
          </Text>
          <div className={styles.row}>
            <Input
              readOnly
              value={invitation}
              aria-label="Invitation link"
              style={{ flexGrow: 1 }}
            />
            <CopyButton text={invitation} label="Copy the invitation link" />
          </div>
          <Text className={styles.caption}>
            Single use, fifteen minutes, and shown once. Redeeming it records the identity
            as a candidate — you still approve the exact account that turns up, so a
            leaked link grants nothing on its own.
          </Text>
        </>
      )}

      <Dialog
        open={removing !== undefined}
        onOpenChange={(_event, data) => {
          if (!data.open) setRemoving(undefined);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Remove this administrator?</DialogTitle>
            <DialogContent>
              <Text>
                {removing?.username} loses access immediately. Every session they hold is
                revoked and their open browser connections are closed in the same
                operation, mid-transcript if necessary. They can be added again with a new
                invitation.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRemoving(undefined)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  const target = removing;
                  setRemoving(undefined);
                  if (!target) return;
                  void run(() =>
                    api(`/api/auth/administrators/${target.id}`, { method: "DELETE" }),
                  );
                }}
              >
                Remove
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}

function NodeMigrationCard({
  enrollment,
  run,
}: {
  enrollment: Enrollment;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const styles = useStyles();
  const { total, mutualAuth, legacy } = enrollment.nodeAuthentication;
  useMessageNotification(
    legacy > 0
      ? `${legacy} Node${legacy === 1 ? "" : "s"} still authenticate with a shared secret. Run a fresh Connect command on each machine before requiring mutual Node authentication.`
      : undefined,
    "warning",
  );
  return (
    <section className={styles.card} aria-label="Node authentication">
      <Text weight="semibold">Node authentication</Text>
      <Text>
        {mutualAuth} of {total} Node{total === 1 ? "" : "s"} authenticate with their own
        key.
      </Text>
      <Text className={styles.caption}>
        A key-based Node signs the whole handshake and derives a per-connection channel,
        so a relay can carry its traffic without reading or forging it. A Node still on
        the shared secret sends a reusable credential instead.
      </Text>
      {legacy > 0 && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            {legacy} Node{legacy === 1 ? "" : "s"} still authenticate with a shared
            secret. Each one migrates by running a fresh Connect command on that machine:
            mint one below, run it there, and it reclaims the same node — same name, same
            id, same history — against a key. There is no automatic upgrade, because a
            shared secret has already reached whatever relays that Node&apos;s connection,
            so nothing sent back over it could prove which Host is answering. Enforcing
            before they have re-enrolled would lock them out of the fleet with no way to
            reach them.
          </MessageBarBody>
        </MessageBar>
      )}
      <Switch
        checked={enrollment.mutualAuthenticationRequired}
        disabled={legacy > 0}
        label="Require mutual Node authentication"
        onChange={(_event, data) =>
          void run(() =>
            api("/api/nodes/mutual-authentication", {
              method: "POST",
              body: JSON.stringify({ required: data.checked }),
            }),
          )
        }
      />
    </section>
  );
}

function AuditCard({ events }: { events: AuditEvent[] }) {
  const styles = useStyles();
  return (
    <section className={styles.card} aria-label="Security audit">
      <Text weight="semibold">Security audit</Text>
      <Text className={styles.caption}>
        Local to this Host and kept to the newest ten thousand entries. Claim codes,
        tokens, cookies and keys never appear here.
      </Text>
      {events.length === 0 ? (
        <Text className={styles.caption}>Nothing recorded yet.</Text>
      ) : (
        <div className={styles.tableScroll}>
          <Table className={styles.table} aria-label="Security audit" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>Event</TableHeaderCell>
                <TableHeaderCell>Actor</TableHeaderCell>
                <TableHeaderCell>Outcome</TableHeaderCell>
                <TableHeaderCell>Detail</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    <Text className={styles.caption}>
                      {new Date(event.createdAt).toLocaleString()}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text className={styles.mono}>{event.eventType}</Text>
                  </TableCell>
                  <TableCell>
                    <Text className={styles.caption}>{event.actorKind}</Text>
                  </TableCell>
                  <TableCell>
                    <Badge
                      appearance="outline"
                      color={event.outcome === "allowed" ? "success" : "danger"}
                    >
                      {event.outcome}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Text className={styles.caption}>{event.detail}</Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Text className={styles.caption}>
        <Link
          href="https://learn.microsoft.com/entra/identity/conditional-access/policy-block-authentication-flows"
          target="_blank"
          rel="noreferrer"
        >
          How Conditional Access blocks authentication flows
        </Link>
      </Text>
    </section>
  );
}
