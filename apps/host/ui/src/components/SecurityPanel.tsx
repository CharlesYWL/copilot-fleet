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
import { errorMessage, type AuthStatus } from "@fleet/protocol";
import { api, ApiError } from "../hooks/useFleet";
import { csrfToken, startCodeLogin } from "../lib/auth";
import { pollUntilSignedIn, type DeviceFlow } from "../lib/device-login";
import { DeviceCodePanel } from "./auth/DeviceCodePanel";
import { CopyButton } from "./CopyButton";
import { PortableBackupCard } from "./PortableBackupCard";
import { terminal } from "../theme";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    maxWidth: "860px",
  },
  card: {
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
    gridTemplateColumns: "minmax(150px, auto) 1fr",
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
    async (work: () => Promise<unknown>) => {
      setError(undefined);
      setReauth(undefined);
      try {
        await work();
        await load();
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

  if (!data) {
    return (
      <div className={styles.panel}>
        {error ? (
          <MessageBar intent="error">
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

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {reauth && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {reauth}{" "}
            <Button
              size="small"
              appearance="primary"
              onClick={() => void startCodeLogin()}
            >
              Confirm with Microsoft
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}

      <IdentityCard status={data.status} enrollment={data.enrollment} />
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

        <Text className={styles.caption}>Directory (tenant) ID</Text>
        <Text className={styles.mono}>{status.entra?.tenantId ?? "not configured"}</Text>

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

function PasswordCard({
  status,
  run,
}: {
  status: AuthStatus;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  if (!status.passwordEnabled) {
    return (
      <section className={styles.card} aria-label="Password sign-in">
        <Text weight="semibold">Password sign-in</Text>
        <Text className={styles.caption}>
          Disabled. Only Microsoft accounts this Host has been told about can sign in.
        </Text>
      </section>
    );
  }
  return (
    <section className={styles.card} aria-label="Password sign-in">
      <Text weight="semibold">Password sign-in</Text>
      <MessageBar intent="warning">
        <MessageBarBody>{AUTH_MODE_COPY[status.state]}</MessageBarBody>
      </MessageBar>
      <div className={styles.row}>
        <Button appearance="primary" onClick={() => setOpen(true)}>
          Disable password sign-in
        </Button>
      </div>
      <Dialog open={open} onOpenChange={(_event, data) => setOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Disable password sign-in?</DialogTitle>
            <DialogContent>
              <Text>
                The stored password is deleted and every session that used it is revoked
                immediately, closing their browser connections. Anyone who signs in after
                this needs a Microsoft account you have added. A local recovery command
                can issue a temporary password if you lock yourself out.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  setOpen(false);
                  void run(() => api("/api/auth/password/disable", { method: "POST" }));
                }}
              >
                Disable
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
        Fleet keeps it off until a verification has actually completed here.
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
            <MessageBar intent={blocked ? "warning" : "error"}>
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
      <Table aria-label="Waiting for approval" size="small">
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
  const [removing, setRemoving] = useState<Administrator>();
  const last = administrators.length <= 1;

  const invite = () =>
    void run(async () => {
      const created = await api<{ id: string; token: string }>(
        "/api/auth/administrator-invitations",
        { method: "POST" },
      );
      setInvitation(
        `${window.location.origin}/?invitation=${encodeURIComponent(created.token)}`,
      );
    });

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

      <Table aria-label="Administrators" size="small">
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

      <div className={styles.row}>
        <Button appearance="primary" onClick={invite}>
          Add administrator
        </Button>
        {last && (
          <Text className={styles.caption}>
            The last active administrator cannot be removed.
          </Text>
        )}
      </div>

      {invitation && (
        <>
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
        <MessageBar intent="warning">
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
        <Table aria-label="Security audit" size="small">
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
