import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Field,
  Input,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { onSignedOut } from "../lib/auth";

const useStyles = makeStyles({
  screen: {
    height: "100%",
    display: "grid",
    placeItems: "center",
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
  },
  card: {
    width: "320px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "28px",
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

type Phase = "checking" | "signed-out" | "signed-in";

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
  const [phase, setPhase] = useState<Phase>("checking");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/status")
      .then((response) => (response.ok ? response.json() : { authenticated: false }))
      .then((status: { authenticated?: boolean }) => {
        if (!cancelled) setPhase(status.authenticated ? "signed-in" : "signed-out");
      })
      .catch(() => {
        // The Host is unreachable rather than refusing us; the sign-in form is
        // the honest thing to show, and its own error will say what happened.
        if (!cancelled) setPhase("signed-out");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Any call that comes back 401 — an expired session, a restarted Host —
  // lands here, so the console does not sit there failing silently.
  useEffect(() => onSignedOut(() => setPhase("signed-out")), []);

  if (phase === "checking") {
    return (
      <div className={styles.screen}>
        <Spinner label="Checking sign-in…" />
      </div>
    );
  }
  if (phase === "signed-out") {
    return (
      <div className={styles.screen}>
        <SignInCard onSignedIn={() => setPhase("signed-in")} />
      </div>
    );
  }
  return <>{children}</>;
}

function SignInCard({ onSignedIn }: { onSignedIn: () => void }) {
  const styles = useStyles();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        setPassword("");
        onSignedIn();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Sign-in failed (${response.status})`);
    } catch {
      setError("Could not reach the Host");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={styles.card}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Text weight="semibold" size={500}>
        Copilot Fleet
      </Text>
      <Field
        label="Operator password"
        validationState={error ? "error" : "none"}
        {...(error ? { validationMessage: error } : {})}
      >
        <Input
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          onChange={(_event, data) => setPassword(data.value)}
        />
      </Field>
      <Button type="submit" appearance="primary" disabled={busy || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
      <Text className={styles.caption}>
        Set FLEET_OPERATOR_PASSWORD to choose this password. A Host started without one
        generates it and prints it to its console on first run.
      </Text>
    </form>
  );
}
