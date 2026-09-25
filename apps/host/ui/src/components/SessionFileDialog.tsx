import { useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  makeStyles,
} from "@fluentui/react-components";
import { ArrowDownload20Regular } from "@fluentui/react-icons";
import { errorMessage, type FleetSession, type Placement } from "@fleet/protocol";
import { downloadSessionFile } from "../lib/session-files";
import { sessionWorkingDirectory } from "../lib/session-info";
import { terminal } from "../theme";

const useStyles = makeStyles({
  surface: {
    width: "min(560px, calc(100vw - 32px))",
    maxWidth: "560px",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    minWidth: 0,
  },
  path: {
    fontFamily: terminal.font,
  },
});

type SessionFileDialogProps = {
  session: FleetSession;
  placement?: Placement | undefined;
  className?: string;
};

/**
 * Downloads any file the session could reach, by path.
 *
 * Transcript links cover the files an agent names; this covers the ones it
 * mentions in passing, or never mentions at all — the file is read on the
 * session's own machine, so it works the same whether that is this computer
 * or one on the other side of a tunnel.
 */
export function SessionFileDialog({
  session,
  placement,
  className,
}: SessionFileDialogProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const directory = sessionWorkingDirectory(session, placement);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const requested = path.trim();
    if (!requested || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await downloadSessionFile(session.id, requested);
      setOpen(false);
      setPath("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_event, data) => {
        setOpen(data.open);
        if (!data.open) setError(undefined);
      }}
    >
      <DialogTrigger disableButtonEnhancement>
        <Button
          className={className}
          appearance="subtle"
          size="small"
          icon={<ArrowDownload20Regular />}
          aria-label="Download a file"
          title={`Download a file from ${session.nodeName}`}
        />
      </DialogTrigger>
      <DialogSurface className={styles.surface}>
        <form onSubmit={submit}>
          <DialogBody>
            <DialogTitle>Download a file</DialogTitle>
            <DialogContent className={styles.content}>
              <Field
                label={`File on ${session.nodeName}`}
                required
                {...(error
                  ? { validationState: "error" as const, validationMessage: error }
                  : {})}
                hint={
                  directory
                    ? `Absolute, or relative to ${directory}. Only files in this session's folders can be downloaded.`
                    : "Use an absolute path. Only files in this session's folders can be downloaded."
                }
              >
                <Input
                  className={styles.path}
                  value={path}
                  autoFocus
                  placeholder="docs/report.docx"
                  onChange={(_event, data) => setPath(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary" type="button">
                  Cancel
                </Button>
              </DialogTrigger>
              <Button appearance="primary" type="submit" disabled={busy || !path.trim()}>
                {busy ? "Checking…" : "Download"}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
