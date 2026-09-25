import {
  createContext,
  useContext,
  useMemo,
  type MouseEvent,
  type ReactNode,
} from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { ArrowDownload16Regular } from "@fluentui/react-icons";
import { errorMessage } from "@fleet/protocol";
import { useNotify } from "../hooks/useAppNotifications";
import { downloadSessionFile, fileName, sessionFileUrl } from "../lib/session-files";
import { terminal } from "../theme";

const useStyles = makeStyles({
  linkIcon: {
    marginLeft: "2px",
    verticalAlign: "-0.2em",
    fontSize: "0.95em",
  },
  button: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    padding: 0,
    border: "none",
    borderRadius: tokens.borderRadiusSmall,
    background: "none",
    color: terminal.dim,
    cursor: "pointer",
    ":hover": {
      color: terminal.user,
      background: "rgba(127, 160, 255, 0.12)",
    },
    ":focus-visible": {
      outline: `1px solid ${terminal.user}`,
    },
  },
});

/** Downloads from the machine the transcript on screen belongs to. */
export type SessionFiles = {
  nodeName: string;
  /** Where the browser fetches a path from, for middle-clicks and "save link as". */
  href: (path: string) => string;
  download: (path: string) => void;
};

const SessionFilesContext = createContext<SessionFiles | undefined>(undefined);

/**
 * The session whose files the surrounding transcript names, if there is one.
 *
 * Markdown is rendered in places with no session behind it — a task's review
 * notes, for instance — and a path there cannot be resolved against anything,
 * so those keep rendering exactly as they did.
 */
export function useSessionFiles(): SessionFiles | undefined {
  return useContext(SessionFilesContext);
}

export function SessionFilesProvider({
  sessionId,
  nodeName,
  children,
}: {
  sessionId: string;
  nodeName: string;
  children: ReactNode;
}) {
  const notify = useNotify();
  const value = useMemo<SessionFiles>(
    () => ({
      nodeName,
      href: (path) => sessionFileUrl(sessionId, "download", path),
      download: (path) => {
        void downloadSessionFile(sessionId, path).catch((error: unknown) =>
          notify(`Could not download ${fileName(path)}: ${errorMessage(error)}`),
        );
      },
    }),
    [sessionId, nodeName, notify],
  );
  return (
    <SessionFilesContext.Provider value={value}>{children}</SessionFilesContext.Provider>
  );
}

/**
 * A path in the transcript, made into a download from the session's machine.
 *
 * A plain click goes through `download`, which checks the file first so a
 * refusal is shown as a message; a modified click falls through to the href.
 */
export function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const files = useSessionFiles();
  const styles = useStyles();
  if (!files) return <>{children}</>;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    files.download(path);
  };
  return (
    <a
      href={files.href(path)}
      onClick={onClick}
      title={`Download ${path} from ${files.nodeName}`}
    >
      {children}
      <ArrowDownload16Regular aria-hidden="true" className={styles.linkIcon} />
    </a>
  );
}

/** The download control on a tool row that wrote a file. */
export function FileDownloadButton({ path }: { path: string }) {
  const files = useSessionFiles();
  const styles = useStyles();
  if (!files) return null;
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={`Download ${fileName(path)}`}
      title={`Download ${path} from ${files.nodeName}`}
      onClick={() => files.download(path)}
    >
      <ArrowDownload16Regular aria-hidden="true" />
    </button>
  );
}
