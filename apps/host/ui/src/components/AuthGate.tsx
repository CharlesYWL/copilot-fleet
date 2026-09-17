import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { errorMessage } from "@fleet/protocol";
import {
  browserNavigation,
  canonicalLoginUrl,
  csrfToken,
  fetchAuthStatus,
  onSignedOut,
  readAuthError,
  readInvitation,
  startCodeLogin,
  type AuthErrorNotice,
  type BrowserAuthStatus,
} from "../lib/auth";
import { pollUntilSignedIn, type DeviceFlow } from "../lib/device-login";
import { markFirstClaimTour, saveTourProgress } from "../lib/onboarding";
import { BrandMark } from "./BrandMark";
import { CopyButton } from "./CopyButton";
import { PortableBackupCard } from "./PortableBackupCard";
import { DeviceCodePanel } from "./auth/DeviceCodePanel";
import { MicrosoftSignInForm } from "./auth/MicrosoftSignInForm";
import { MicrosoftSignInSetupGuide } from "./auth/MicrosoftSignInSetupGuide";
import { TrustRail, type TrustStage } from "./auth/TrustRail";
import { terminal } from "../theme";

const useStyles = makeStyles({
  screen: {
    minHeight: "100%",
    display: "grid",
    placeItems: "center",
    padding: "24px",
    boxSizing: "border-box",
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
  },
  card: {
    width: "min(460px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    padding: "28px",
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    // The only motion on the screen, and it is off for anyone who asked for
    // less of it.
    animationName: {
      from: { opacity: 0, transform: "translateY(4px)" },
      to: { opacity: 1, transform: "none" },
    },
    animationDuration: "160ms",
    animationTimingFunction: "ease-out",
    "@media (prefers-reduced-motion: reduce)": {
      animationName: "none",
      animationDuration: "0.01ms",
    },
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  brandText: {
    display: "flex",
    flexDirection: "column",
    lineHeight: 1.25,
  },
  // Focused after each step so a keyboard or screen-reader user lands on the
  // new question rather than at the top of a page that quietly changed.
  heading: {
    margin: 0,
    outlineStyle: "none",
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  divider: {
    height: "1px",
    background: tokens.colorNeutralStroke2,
  },
  command: {
    flexGrow: 1,
    margin: 0,
    padding: "12px 14px",
    borderRadius: tokens.borderRadiusMedium,
    background: terminal.background,
    color: terminal.agent,
    fontFamily: terminal.font,
    fontSize: "12px",
    lineHeight: "1.7",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  commandRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
  },
  liveRegion: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

/** What the gate is asking for, which is not the same as the Host's own state. */
type GateView =
  | "checking"
  | "unreachable"
  | "endpoint-refused"
  | "configure"
  | "claim"
  | "migrate"
  | "sign-in"
  | "password-sign-in"
  | "local-forward"
  | "device"
  | "denied"
  | "pending";

/**
 * Nothing renders until the Host says who is asking.
 *
 * The fleet's UI is an administrative console — it starts processes on other
 * machines and reads every transcript they produce — so the page it shows
 * before sign-in has to be a page that can do nothing at all, rather than the
 * console with its requests failing.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const [status, setStatus] = useState<BrowserAuthStatus>();
  const [notice, setNotice] = useState<AuthErrorNotice>();

  const refresh = useCallback(async () => {
    setStatus(await fetchAuthStatus());
  }, []);

  useEffect(() => {
    // Why the last callback sent us back here, read before the first status
    // arrives so a refusal is never replaced by a plain sign-in form.
    const returnedNotice = readAuthError();
    // The first read scrubs the URL; StrictMode's effect replay must not erase it.
    if (returnedNotice) setNotice(returnedNotice);
    void refresh();
  }, [refresh]);

  // Any call that comes back 401 — an expired session, a restarted Host —
  // lands here, so the console does not sit there failing silently.
  useEffect(
    () =>
      onSignedOut(() => {
        if (status?.state === "no-auth") {
          setStatus(undefined);
          void refresh();
          return;
        }
        setStatus((current) =>
          current ? { ...current, authenticated: false } : current,
        );
      }),
    [refresh, status?.state],
  );

  useEffect(() => {
    if (
      status &&
      !status.unreachable &&
      status.state !== "no-auth" &&
      (!status.authenticated || status.claimCodeRequired)
    ) {
      saveTourProgress();
    }
  }, [status]);

  /*
   * `authenticated` alone is not enough to hand over the console.
   *
   * An upgraded Host says `authenticated` the moment its existing password is
   * accepted, and keeps saying `claimCodeRequired` for as long as nobody
   * administers it. Revealing the console there drops the operator into a fleet
   * whose Security tab is the only thing that can finish the migration, with
   * nothing telling them they are half way through one.
   */
  if (
    status &&
    !status.unreachable &&
    ((status.state === "no-auth" && status.canSignIn) ||
      (status.authenticated && !status.claimCodeRequired && !notice))
  )
    return <>{children}</>;

  return (
    <div className={styles.screen}>
      <Checkpoint
        status={status}
        notice={notice}
        onDismissNotice={() => setNotice(undefined)}
        onChanged={refresh}
        allowSkip
      />
    </div>
  );
}

function viewFor(
  status: BrowserAuthStatus | undefined,
  notice: AuthErrorNotice | undefined,
): GateView {
  if (!status) return "checking";
  if (status.unreachable) return "unreachable";
  if (notice?.code === "pending-approval") return "pending";
  if (notice && (notice.code !== "cancelled" || status.authenticated)) return "denied";
  if (!status.canSignIn) return "endpoint-refused";
  if (status.state === "no-auth") return status.entraConfigured ? "claim" : "configure";
  /*
   * The migration checkpoint: signed in, and still nobody's Host.
   *
   * Only an upgraded Host reports both at once — a claimed Host has an
   * administrator, and every other unclaimed one has nobody signed in.
   */
  if (status.authenticated && status.claimCodeRequired) return "migrate";
  if (status.state === "entra-unconfigured") return "configure";
  if (status.state === "unclaimed") return "claim";
  /*
   * A Host with a password and no registration has exactly one door that
   * opens. Offering the Microsoft button beside it offers a button whose only
   * possible outcome is "this Host has no Microsoft sign-in configuration yet".
   */
  if (status.passwordEnabled && status.claimCodeRequired) return "password-sign-in";
  if (status.codeLogin.localForwardRequired) {
    return status.deviceFlowEnabled ? "device" : "local-forward";
  }
  return "sign-in";
}

const HEADINGS: Record<GateView, string> = {
  checking: "Checking sign-in",
  unreachable: "Could not reach this Host",
  "endpoint-refused": "This address cannot sign you in",
  configure: "Configure Microsoft sign-in",
  claim: "Claim this Fleet",
  migrate: "Finish claiming this Host",
  "sign-in": "Sign in with Microsoft",
  "password-sign-in": "Sign in to this Host",
  "local-forward": "Device sign-in is unavailable",
  device: "Sign in with a device code",
  denied: "Account not authorized",
  pending: "Waiting for approval",
};

function stagesFor(status: BrowserAuthStatus | undefined): TrustStage[] {
  const reachable = status !== undefined && !status.unreachable;
  const noAuth = status?.state === "no-auth";
  const configured = Boolean(status?.entraConfigured);
  const claimed = Boolean(status && !status.claimCodeRequired);
  // A password session on an unclaimed Host is a way in, not an identity: the
  // rail must not call that stage done while the Host still has no owner.
  const identified = Boolean(status?.authenticated) && claimed;
  return [
    {
      name: "Host",
      detail: !reachable
        ? "not answering"
        : noAuth
          ? "reachable"
          : configured
            ? "reachable and configured"
            : "reachable, not configured",
      state: reachable && (configured || noAuth) ? "done" : reachable ? "active" : "todo",
    },
    {
      name: "Microsoft identity",
      detail: noAuth
        ? "optional, not enabled"
        : identified
          ? "signed in"
          : claimed
            ? "sign-in required"
            : "no administrator yet",
      state: noAuth ? "todo" : identified ? "done" : configured ? "active" : "todo",
    },
    {
      name: "Nodes",
      detail: noAuth
        ? "ready to enrol"
        : claimed
          ? "enrol after sign-in"
          : "after this Fleet is claimed",
      state: "todo",
    },
  ];
}

type CheckpointProps = {
  status: BrowserAuthStatus | undefined;
  notice: AuthErrorNotice | undefined;
  onDismissNotice: () => void;
  onChanged: () => Promise<void>;
  allowSkip?: boolean;
};

/** Reuses the console-protected setup when sign-in is enabled later in Settings. */
export function MicrosoftSignInSetup({
  status,
  onChanged,
}: {
  status: BrowserAuthStatus;
  onChanged: () => Promise<void>;
}) {
  return (
    <Checkpoint
      status={status}
      notice={undefined}
      onDismissNotice={() => {}}
      onChanged={onChanged}
    />
  );
}

/**
 * One card, one question at a time.
 *
 * The card never becomes a general-purpose page: whatever the Host's state, the
 * only things reachable from here are the two proofs a claim takes and the
 * sign-in that follows them.
 */
function Checkpoint({
  status,
  notice,
  onDismissNotice,
  onChanged,
  allowSkip = false,
}: CheckpointProps) {
  const styles = useStyles();
  const [bootstrapped, setBootstrapped] = useState(false);
  const [configured, setConfigured] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const view = viewFor(status, notice);
  const title =
    view === "denied" &&
    notice?.code !== "not-authorized" &&
    notice?.code !== "wrong-tenant"
      ? "Microsoft sign-in could not be completed"
      : HEADINGS[view];

  useEffect(() => {
    heading.current?.focus();
  }, [view]);

  return (
    <section className={styles.card} aria-label="Sign in to Copilot Fleet">
      <div className={styles.brand}>
        <BrandMark size={36} />
        <span className={styles.brandText}>
          <Text weight="semibold" size={500}>
            Copilot Fleet
          </Text>
          <Text className={styles.caption}>Operator console</Text>
        </span>
      </div>

      <TrustRail stages={stagesFor(status)} />
      <div className={styles.divider} />

      <h1 className={styles.heading} tabIndex={-1} ref={heading}>
        {title}
      </h1>

      <div className={styles.liveRegion} role="status" aria-live="polite">
        {view === "checking" ? "Checking sign-in…" : title}
      </div>

      <div className={styles.body}>
        {view === "checking" && <Spinner size="small" label="Checking sign-in…" />}

        {view === "unreachable" && (
          <MessageBar intent="error">
            <MessageBarBody>
              Could not reach this Host. It may have stopped, or the tunnel in front of it
              may be down. Reload once it is back.
            </MessageBarBody>
          </MessageBar>
        )}

        {view === "endpoint-refused" && <EndpointRefused />}

        {(view === "denied" || view === "pending") && (
          <RefusedIdentity
            pending={view === "pending"}
            notice={notice}
            authenticated={Boolean(status?.authenticated)}
            onRetry={() => {
              onDismissNotice();
              void onChanged();
            }}
          />
        )}

        {view === "configure" && (
          <ConfigureStep
            bootstrapped={bootstrapped}
            configured={configured}
            onBootstrapped={() => setBootstrapped(true)}
            onConfigured={() => {
              setConfigured(true);
              void onChanged();
            }}
          />
        )}

        {view === "claim" && (
          <ClaimStep
            status={status}
            bootstrapped={bootstrapped}
            onBootstrapped={() => setBootstrapped(true)}
          />
        )}

        {allowSkip &&
          !status?.passwordEnabled &&
          (view === "configure" || view === "claim") &&
          bootstrapped && <SkipMicrosoftStep onChanged={onChanged} />}

        {/*
         * The Host that most needs restoring is the one that cannot sign
         * anyone in. A move lands a new machine in exactly these two states —
         * no Entra registration, or no administrators — while the archive that
         * fixes both sits on the operator's disk. The restore is authorised by
         * the console claim code, which is the proof this screen has just
         * collected, so gating it behind a sign-in that cannot happen yet was
         * gating recovery on the thing being recovered.
         */}
        {(view === "configure" || view === "claim") && bootstrapped && (
          <PortableBackupCard
            claimed={false}
            onImported={() => {
              void onChanged();
            }}
          />
        )}

        {view === "migrate" && <MigrationStep status={status} onChanged={onChanged} />}

        {view === "sign-in" && <SignInStep status={status} onSignedIn={onChanged} />}

        {view === "password-sign-in" && <PasswordOnlySignIn onSignedIn={onChanged} />}

        {view === "local-forward" && <LocalForward />}

        {view === "device" && <DeviceStep onSignedIn={onChanged} />}
      </div>
    </section>
  );
}

function SkipMicrosoftStep({ onChanged }: { onChanged: () => Promise<void> }) {
  const { busy, error, errorStatus, clearError, submit } = useAuthForm(
    "/api/auth/skip",
    "Could not skip Microsoft sign-in",
    async () => {
      markFirstClaimTour();
      await onChanged();
    },
  );
  return (
    <>
      <Text>
        Microsoft sign-in is optional. Without it, anyone who can reach this Host can
        operate Fleet. Keep the Host listener on loopback and use private, authenticated
        Dev Tunnels for remote access. Public tunnels are disabled.
      </Text>
      <Button disabled={busy} onClick={() => void submit({})}>
        {busy ? "Continuing…" : "Continue without Microsoft sign-in"}
      </Button>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {errorStatus === 401 && (
        <ClaimCodeForm action="Unlock setup again" onDone={clearError} />
      )}
    </>
  );
}

function EndpointRefused() {
  const styles = useStyles();
  return (
    <>
      <MessageBar intent="error">
        <MessageBarBody>
          Use loopback or a private Dev Tunnel when Microsoft sign-in is skipped. This
          Host will not issue a session over this address. A plain-HTTP tunnel would carry
          the session cookie in clear text, and a name this Host never published is not
          one it trusts.
        </MessageBarBody>
      </MessageBar>
      <Text className={styles.caption}>
        Open the Host on <code>http://localhost</code>, or reach it through an HTTPS
        provider such as Dev Tunnels.
      </Text>
    </>
  );
}

function RefusedIdentity({
  pending,
  notice,
  authenticated,
  onRetry,
}: {
  pending: boolean;
  notice: AuthErrorNotice | undefined;
  authenticated: boolean;
  onRetry: () => void;
}) {
  const styles = useStyles();
  return (
    <>
      <MessageBar intent={pending ? "info" : "error"}>
        <MessageBarBody>
          {notice?.message ??
            (notice?.code === "cancelled"
              ? "Microsoft sign-in was cancelled."
              : pending
                ? "Your request was recorded. An existing administrator has to approve it before you can sign in."
                : "That account is not authorized to use this Fleet.")}
        </MessageBarBody>
      </MessageBar>
      <Text className={styles.caption}>
        {pending
          ? "Microsoft authenticated you; this Fleet has not authorized you yet. Ask an administrator to approve the request in Settings → Security."
          : authenticated
            ? "If you were changing Microsoft sign-in configuration, a failed or cancelled verification leaves the previous configuration in place. Return to Settings → Security to retry."
            : "Signing in with Microsoft proves who you are. It does not make you an administrator of this Fleet — an existing administrator has to add you."}
      </Text>
      <Button appearance="primary" onClick={onRetry}>
        {authenticated ? "Return to Fleet" : "Try another account"}
      </Button>
    </>
  );
}

/** These signed-out forms use their submitted proof, not an operator CSRF token. */
function useAuthForm(path: string, refused: string, onDone: () => void | Promise<void>) {
  const [error, setError] = useState<string>();
  const [errorStatus, setErrorStatus] = useState<number>();
  const [busy, setBusy] = useState(false);
  const clearError = useCallback(() => {
    setError(undefined);
    setErrorStatus(undefined);
  }, []);

  const submit = async (values: Record<string, string>) => {
    setBusy(true);
    clearError();
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      if (response.ok) {
        await onDone();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setErrorStatus(response.status);
      setError(body.error ?? `${refused} (${response.status})`);
    } catch (reason) {
      setError(errorMessage(reason, "Could not reach the Host"));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, errorStatus, clearError, submit };
}

/** The console code, which is the only proof a fresh Host will accept. */
function ClaimCodeForm({ action, onDone }: { action: string; onDone: () => void }) {
  const styles = useStyles();
  const [code, setCode] = useState("");
  const { busy, error, submit } = useAuthForm(
    "/api/auth/bootstrap",
    "That code was refused",
    () => {
      // Never echoed back: it is a one-time secret, and a field still holding
      // it is a field a screenshot or a shoulder can read.
      setCode("");
      onDone();
    },
  );

  return (
    <form
      className={styles.body}
      onSubmit={(event) => {
        event.preventDefault();
        void submit({ code });
      }}
    >
      <Field
        label="Claim code"
        hint="Printed once on the Host's own console when it started."
        validationState={error ? "error" : "none"}
        {...(error ? { validationMessage: error } : {})}
      >
        <Input
          type="password"
          value={code}
          autoFocus
          autoComplete="one-time-code"
          onChange={(_event, data) => setCode(data.value)}
        />
      </Field>
      <Button type="submit" appearance="primary" disabled={busy || !code}>
        {busy ? "Checking…" : action}
      </Button>
    </form>
  );
}

/** The registration this Host will authenticate against. */
function EntraConfigForm({
  saved,
  bootstrapWithPassword = false,
  onConfigured,
}: {
  saved: boolean;
  bootstrapWithPassword?: boolean;
  onConfigured: () => void;
}) {
  const styles = useStyles();
  const { busy, error, errorStatus, clearError, submit } = useAuthForm(
    "/api/auth/configure",
    "That configuration was refused",
    onConfigured,
  );
  const needsBootstrap = errorStatus === 401;

  return (
    <>
      {/* Keep the form mounted so renewing the proof never loses the registration. */}
      <MicrosoftSignInForm
        busy={busy || needsBootstrap}
        error={error}
        submitLabel="Save and continue"
        busyLabel={needsBootstrap ? "Unlock setup to continue" : "Saving…"}
        onSubmit={submit}
      />
      {needsBootstrap && (
        <>
          <Text className={styles.caption}>
            Setup authorization has expired or was lost. Your registration details are
            still here; unlock setup again, then save and continue.
          </Text>
          {bootstrapWithPassword ? (
            <PasswordBootstrap onDone={clearError} />
          ) : (
            <>
              <Text className={styles.caption}>
                Enter the claim code from the Host&apos;s terminal again. If that code has
                expired, restart the unclaimed Host to print a new one.
              </Text>
              <ClaimCodeForm action="Unlock setup again" onDone={clearError} />
            </>
          )}
        </>
      )}
      {saved && (
        <MessageBar intent="success">
          <MessageBarBody>
            Saved. Sign in with Microsoft to become this Fleet&apos;s first administrator.
          </MessageBarBody>
        </MessageBar>
      )}
    </>
  );
}

function ConfigureStep({
  bootstrapped,
  configured,
  onBootstrapped,
  onConfigured,
}: {
  bootstrapped: boolean;
  configured: boolean;
  onBootstrapped: () => void;
  onConfigured: () => void;
}) {
  const styles = useStyles();

  if (!bootstrapped) {
    return (
      <>
        <Text className={styles.caption}>
          Microsoft sign-in is optional. The code on this Host&apos;s own console proves
          you are the person setting it up. A fresh Host can continue without Microsoft
          sign-in after unlocking setup; enabling sign-in requires your own approved
          application registration. No approved Fleet client ID is bundled.
        </Text>
        <MicrosoftSignInSetupGuide />
        <ClaimCodeForm action="Unlock setup" onDone={onBootstrapped} />
      </>
    );
  }

  return <EntraConfigForm saved={configured} onConfigured={onConfigured} />;
}

/**
 * The one screen an upgraded Host has always been missing.
 *
 * The operator has just proved the password this Host has had all along, which
 * is the same authority the console claim code stands for — so the Host is
 * asked for a bootstrap grant on that basis and the code is never mentioned.
 * From there the checkpoint is the ordinary claim: a registration if this Host
 * has none, then the Microsoft account that becomes its first administrator.
 */
function MigrationStep({
  status,
  onChanged,
}: {
  status: BrowserAuthStatus | undefined;
  onChanged: () => Promise<void>;
}) {
  const styles = useStyles();
  const [granted, setGranted] = useState(false);
  const [configured, setConfigured] = useState(false);
  const onGranted = useCallback(() => setGranted(true), []);

  if (!granted) {
    return <PasswordBootstrap onDone={onGranted} />;
  }

  if (!configured && !status?.entraConfigured) {
    return (
      <>
        <Text className={styles.caption}>
          The password was accepted, and nobody administers this Fleet yet. Point it at a
          Microsoft registration, then claim it with the account that will own it — no
          console code needed.
        </Text>
        <EntraConfigForm
          saved={false}
          bootstrapWithPassword
          onConfigured={() => {
            setConfigured(true);
            void onChanged();
          }}
        />
      </>
    );
  }

  return (
    <>
      <Text className={styles.caption}>
        The password was accepted. The Microsoft account you sign in with next becomes
        this Fleet&apos;s first administrator, and this password stops being the only way
        in.
      </Text>
      <MicrosoftButton status={status} label="Claim with Microsoft" />
    </>
  );
}

function PasswordBootstrap({ onDone }: { onDone: () => void }) {
  const styles = useStyles();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let abandoned = false;
    const request = async () => {
      setError(undefined);
      try {
        const response = await fetch("/api/auth/bootstrap/password", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": await csrfToken(),
          },
          body: "{}",
        });
        if (abandoned) return;
        if (response.ok) {
          onDone();
          return;
        }
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error ?? `This Host would not start the migration (${response.status})`,
        );
      } catch (reason) {
        if (!abandoned) setError(errorMessage(reason, "Could not reach the Host"));
      }
    };
    void request();
    return () => {
      abandoned = true;
    };
  }, [attempt, onDone]);

  if (error) {
    return (
      <>
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
        <Text className={styles.caption}>
          The password signed you in, but this Host would not let that stand in for the
          claim. Reload once whatever changed has settled, or claim it from the
          Host&apos;s own console instead.
        </Text>
        <Button appearance="primary" onClick={() => setAttempt((count) => count + 1)}>
          Try again
        </Button>
      </>
    );
  }

  return <Spinner size="small" label="Confirming this Host…" />;
}

function ClaimStep({
  status,
  bootstrapped,
  onBootstrapped,
}: {
  status: BrowserAuthStatus | undefined;
  bootstrapped: boolean;
  onBootstrapped: () => void;
}) {
  const styles = useStyles();
  if (!bootstrapped) {
    return (
      <>
        <Text className={styles.caption}>
          Nobody administers this Fleet yet. Claiming it takes two proofs: the code
          printed on the Host&apos;s console, and a Microsoft account. Microsoft sign-in
          is optional; a fresh Host can also complete setup without it.
        </Text>
        <ClaimCodeForm action="Unlock claim" onDone={onBootstrapped} />
      </>
    );
  }
  return (
    <>
      <Text className={styles.caption}>
        The code was accepted. The Microsoft account you sign in with next becomes this
        Fleet&apos;s first and only administrator.
      </Text>
      <MicrosoftButton status={status} label="Claim with Microsoft" />
    </>
  );
}

function SignInStep({
  status,
  onSignedIn,
}: {
  status: BrowserAuthStatus | undefined;
  onSignedIn: () => Promise<void>;
}) {
  const styles = useStyles();
  const invitation = readInvitation();
  if (invitation) {
    return (
      <>
        <Text className={styles.caption}>
          You have been invited to administer this Fleet. Signing in records which account
          turned up; an existing administrator approves that exact identity before you get
          access — so the link alone grants nothing.
        </Text>
        <MicrosoftButton
          status={status}
          label="Accept the invitation"
          invitation={invitation}
        />
      </>
    );
  }
  return (
    <>
      <Text className={styles.caption}>
        Only accounts an administrator has added can use this Fleet. Signing in proves who
        you are; it does not grant access on its own.
      </Text>
      <MicrosoftButton status={status} label="Sign in with Microsoft" />
      {status?.passwordEnabled && (
        <>
          <div className={styles.divider} />
          <PasswordForm onSignedIn={onSignedIn} />
        </>
      )}
    </>
  );
}

/**
 * The signed-out half of the same migration.
 *
 * A Host with a password and no registration cannot start a Microsoft login at
 * all, so a button offering one is a button that can only fail. The password is
 * the way in, and it is also the way forward: the checkpoint that follows it
 * asks for the registration and the first administrator.
 */
function PasswordOnlySignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const styles = useStyles();
  return (
    <>
      <Text className={styles.caption}>
        This Host was protected by an operator password before Microsoft sign-in was
        added. Sign in with that password once; Fleet then asks you to claim it with your
        Microsoft account. If no approved registration is configured, setup asks for an
        application client ID first.
      </Text>
      <PasswordForm onSignedIn={onSignedIn} appearance="primary" />
    </>
  );
}

function MicrosoftButton({
  status,
  label,
  invitation,
}: {
  status: BrowserAuthStatus | undefined;
  label: string;
  invitation?: string | undefined;
}) {
  const styles = useStyles();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    /*
     * A page opened at 127.0.0.1 has to move to localhost before the
     * transaction starts, not after: the reply URL is registered by name, and
     * the Lax transaction cookie set here would not be sent to a callback on a
     * different one — so the sign-in would fail after the person had already
     * authenticated.
     */
    const canonical =
      status?.codeLogin.canonicalUrl ?? canonicalLoginUrl(window.location.href);
    if (canonical) {
      browserNavigation.assign(canonical);
      return;
    }
    try {
      await startCodeLogin(invitation);
    } catch (reason) {
      setError(errorMessage(reason, "Could not start sign-in"));
      setBusy(false);
    }
  };

  return (
    <>
      <Button appearance="primary" disabled={busy} onClick={() => void start()}>
        {busy ? "Opening Microsoft…" : label}
      </Button>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <Text className={styles.caption}>
        {status?.entra?.tenantId === "common"
          ? "This Host supports work/school and personal Microsoft accounts, including Microsoft corporate accounts where organization policy permits. "
          : status?.entra
            ? "This Host uses a fixed organizational directory; only accounts in that directory can authenticate. "
            : "Supported account types depend on this Host's Microsoft sign-in registration. "}
        Organization consent and Conditional Access still apply.
      </Text>
      <Text className={styles.caption}>
        Fleet keeps no Microsoft token. It records only the account&apos;s directory and
        object id, and issues its own session.
      </Text>
    </>
  );
}

/** The migration escape hatch, shown only while a Host still accepts one. */
function PasswordForm({
  onSignedIn,
  appearance = "secondary",
}: {
  onSignedIn: () => Promise<void>;
  appearance?: "primary" | "secondary";
}) {
  const styles = useStyles();
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useAuthForm(
    "/api/auth/login",
    "Sign-in failed",
    async () => {
      setPassword("");
      await onSignedIn();
    },
  );

  return (
    <form
      className={styles.body}
      onSubmit={(event) => {
        event.preventDefault();
        void submit({ password });
      }}
    >
      <Field
        label="Operator password"
        hint="A shared password identifies nobody. Disable it once every administrator has a Microsoft account."
        validationState={error ? "error" : "none"}
        {...(error ? { validationMessage: error } : {})}
      >
        <Input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(_event, data) => setPassword(data.value)}
        />
      </Field>
      <Button type="submit" appearance={appearance} disabled={busy || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

const FORWARD_COMMAND = "devtunnel connect <tunnel-id>";

function LocalForward() {
  const styles = useStyles();

  return (
    <>
      <Text className={styles.caption}>
        Microsoft returns a sign-in to <code>http://localhost</code>, which this browser
        cannot reach from here. Device sign-in is off on this Host — an administrator can
        verify it in Settings → Security — so forward the Host to your own machine and
        sign in there instead.
      </Text>
      <div className={styles.commandRow}>
        <pre className={styles.command}>{FORWARD_COMMAND}</pre>
        <CopyButton
          text={FORWARD_COMMAND}
          label="Copy the local forward command"
          showText
        />
      </div>
      <Text className={styles.caption}>
        Then open the forwarded <code>http://localhost:&lt;port&gt;</code> address. Any
        local forward works — SSH, or the provider&apos;s own client.{" "}
        <Link
          href="https://learn.microsoft.com/azure/developer/dev-tunnels/cli-commands"
          target="_blank"
          rel="noreferrer"
        >
          Dev Tunnels CLI reference
        </Link>
      </Text>
    </>
  );
}

function DeviceStep({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const styles = useStyles();
  const [flow, setFlow] = useState<DeviceFlow>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /*
   * An invitation link is opened wherever the invited person is, and for a
   * remote administrator that is the public URL — the one place the loopback
   * flow cannot finish. Dropping it here would make the link unusable for
   * exactly the people it exists to reach: they would authenticate, be told
   * they are not an administrator, and leave nothing to approve.
   */
  const invitation = readInvitation();

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invitation ? { invitation } : {}),
      });
      const body = (await response.json().catch(() => ({}))) as DeviceFlow & {
        error?: string;
      };
      if (!response.ok) {
        setError(body.error ?? `Could not start a device sign-in (${response.status})`);
        return;
      }
      setFlow(body);
      const outcome = await pollUntilSignedIn({
        flowId: body.flowId,
        expiresAt: Date.parse(body.expiresAt),
      });
      if (outcome.outcome === "signed-in") {
        if (outcome.claimedHost) markFirstClaimTour();
        await onSignedIn();
        return;
      }
      if (outcome.outcome === "denied") setError(outcome.message);
      if (outcome.outcome === "expired") {
        setError("That code expired before it was used. Start another sign-in.");
      }
    } catch (reason) {
      setError(errorMessage(reason, "Could not reach the Host"));
    } finally {
      setBusy(false);
    }
  };

  if (flow) return <DeviceCodePanel flow={flow} error={error} />;

  return (
    <>
      <Text className={styles.caption}>
        This browser cannot reach a loopback listener, so Microsoft cannot redirect a
        sign-in back to it. An administrator enabled device sign-in after one successful
        verification. Your organization can still block it.
        {invitation
          ? " Signing in records which account turned up; an existing administrator approves that exact identity before you get access."
          : ""}
      </Text>
      <MessageBar intent="warning">
        <MessageBarBody>
          Only enter a code this page is showing you. A code sent by anyone else — in a
          message, a ticket, or an email — signs them into this fleet, not you.
        </MessageBarBody>
      </MessageBar>
      <Button appearance="primary" disabled={busy} onClick={() => void start()}>
        {busy ? "Asking Microsoft…" : "Sign in with a device code"}
      </Button>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
    </>
  );
}
