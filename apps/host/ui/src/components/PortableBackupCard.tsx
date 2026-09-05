import { useRef, useState } from "react";
import {
  Button,
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
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { errorMessage } from "@fleet/protocol";
import { csrfToken } from "../lib/auth";

/** The floor the Host enforces, repeated here so the form can refuse first. */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 14;

const useStyles = makeStyles({
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
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    alignItems: "flex-end",
  },
  passphrase: {
    minWidth: "260px",
  },
  hidden: {
    display: "none",
  },
});

export type PortableBackupCardProps = {
  /** A Host with administrators asks one of them; a fresh one asks its console. */
  claimed: boolean;
  onImported: () => void;
};

const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * Moving a Host, rather than moving what is on one.
 *
 * The archive this produces is the administrator table, the Entra registration,
 * the Host's private signing key and every key it derives proofs with, in one
 * file. So the form around it is a security surface in its own right: the
 * passphrase is the only thing standing between whoever ends up with the file
 * and the fleet, it is never stored anywhere, and it is cleared the moment the
 * request that used it returns.
 */
export const PortableBackupCard = ({ claimed, onImported }: PortableBackupCardProps) => {
  const styles = useStyles();
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState<unknown>();
  const fileInput = useRef<HTMLInputElement>(null);

  const tooShort = passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH;
  const refuseShort = (): boolean => {
    if (!tooShort) return false;
    setError(
      `A backup passphrase must be at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters. Deriving the key is the only thing protecting this file.`,
    );
    return true;
  };

  /** Hands the sealed archive to the browser without it ever touching disk here. */
  const download = (archive: unknown) => {
    const blob = new Blob([JSON.stringify(archive, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `copilot-fleet-portable-${stamp()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportArchive = async () => {
    setError(undefined);
    setNotice(undefined);
    if (refuseShort()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/backup/portable", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({ passphrase }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? `Could not export this Host (${response.status})`);
        return;
      }
      download(body);
      setNotice(
        "Archive downloaded. Keep the passphrase somewhere separate — it is not stored here and cannot be recovered.",
      );
    } catch (reason) {
      setError(errorMessage(reason, "Could not reach the Host"));
    } finally {
      // Whatever happened, the passphrase does not stay in the form. It is not
      // a setting, and a field left populated is a secret sitting on a screen.
      setPassphrase("");
      setBusy(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    setError(undefined);
    setNotice(undefined);
    if (!file) return;
    if (refuseShort()) return;
    try {
      const parsed = JSON.parse(await file.text()) as { kind?: string; version?: number };
      if (parsed?.kind !== "copilot-fleet-host" || parsed?.version !== 2) {
        setError(
          "That file is not a Copilot Fleet portable archive. A portable archive is version 2 and carries a sealed security section.",
        );
        return;
      }
      setPending(parsed);
    } catch {
      setError("That file is not a Copilot Fleet portable archive.");
    }
  };

  const importArchive = async () => {
    if (pending === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      /*
       * A CSRF token is derived from an operator session, and a Host nobody
       * owns has none — `/api/auth/csrf` answers 401 there. Asking for one
       * anyway turned the whole recovery path into an error about a token
       * nobody could have had. The Host authorises this call with the console
       * claim grant instead, which is a cookie bound to this browser and
       * spent on use, so there is nothing a CSRF proof would add. On a claimed
       * Host the session is what authorises it, and then the proof is the
       * difference between this restore and one another site asked for.
       */
      const response = await fetch("/api/backup/portable/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(claimed ? { "x-csrf-token": await csrfToken() } : {}),
        },
        body: JSON.stringify({ passphrase, backup: pending }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        administrators?: number;
      };
      if (!response.ok) {
        setError(body.error ?? `Could not restore this Host (${response.status})`);
        return;
      }
      setNotice(
        `Restored. ${body.administrators ?? 0} administrator(s) can sign in through the restored Microsoft configuration; every session this Host had issued is over.`,
      );
      onImported();
    } catch (reason) {
      setError(errorMessage(reason, "Could not reach the Host"));
    } finally {
      setPassphrase("");
      setPending(undefined);
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-label="Move this Host">
      <div>
        <Text weight="semibold">Move this Host</Text>
        <br />
        <Text className={styles.caption}>
          A portable archive carries the administrator table, the Microsoft registration,
          this Host&apos;s signing key and the keys it derives proofs with, sealed under a
          passphrase. Whoever has the file and the passphrase owns this fleet, so treat it
          as the fleet itself. The old Host has to be stopped before the moved one starts
          — two processes sharing one identity is one identity too few.
        </Text>
      </div>

      {claimed ? (
        <Text className={styles.caption}>
          Exporting and restoring both need a Microsoft sign-in from the last few minutes.
        </Text>
      ) : (
        <Text className={styles.caption}>
          Nobody administers this Host yet, so there is no administrator to ask. Enter the
          claim code printed on the Host console first; restoring then takes that code and
          the backup passphrase, and creates no session.
        </Text>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {notice && (
        <MessageBar intent="success">
          <MessageBarBody>{notice}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.actions}>
        <Field
          label="Backup passphrase"
          className={styles.passphrase}
          hint="Minimum 14 characters. Never stored, and it cannot be recovered."
        >
          <Input
            type="password"
            value={passphrase}
            autoComplete="new-password"
            disabled={busy}
            onChange={(_event, next) => setPassphrase(next.value)}
          />
        </Field>
        {claimed && (
          <Button
            appearance="primary"
            disabled={busy}
            onClick={() => void exportArchive()}
          >
            {busy ? "Sealing…" : "Export portable backup"}
          </Button>
        )}
        <Button
          appearance="secondary"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          Import portable backup…
        </Button>
      </div>

      <input
        ref={fileInput}
        className={styles.hidden}
        type="file"
        accept="application/json,.json"
        aria-label="Choose a portable archive to restore"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void pickFile(file);
        }}
      />

      <Dialog
        open={pending !== undefined}
        onOpenChange={(_event, data) => {
          if (!data.open) setPending(undefined);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Become the Host in that archive?</DialogTitle>
            <DialogContent>
              <Text>
                This replaces the administrators, the Microsoft registration and this
                machine&apos;s identity with the ones in the file, ends every browser
                session, and drops every connected Node. No session is created — the
                identities the archive names sign in afterwards.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={busy}
                onClick={() => setPending(undefined)}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() => void importArchive()}
              >
                {busy ? "Restoring…" : "Replace this Host"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
};
