import type { SessionFileInfo } from "@fleet/protocol";
import { api } from "../hooks/useFleet";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/;
/** Characters no concrete file path carries: globs, redirections, line breaks. */
const NOT_A_PATH = /[\n\r\t*?"<>|]/;
const MAX_PATH_LENGTH = 1024;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A `file:` URL as the path it names on the machine it came from. */
function fileUrlPath(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "file:") return undefined;
  const path = decoded(url.pathname);
  if (url.hostname && url.hostname !== "localhost") {
    return `\\\\${url.hostname}${path.replaceAll("/", "\\")}`;
  }
  if (/^\/[A-Za-z]:(?:[\\/]|$)/.test(path)) return path.slice(1);
  return path || undefined;
}

/**
 * The file a link in a transcript points at, when it points at one.
 *
 * Agents link their output the way an editor would: a `file:` URL, a drive
 * path, an absolute POSIX path, or a path relative to where they work. None of
 * those means anything on this page's origin — the browser navigates away, or
 * to nothing at all — so they are resolved on the session's own machine
 * instead. Links with a web scheme, and in-page anchors, are left alone.
 *
 * Markdown percent-encodes what it does not allow in a URL, backslashes and
 * spaces included, so the path is decoded before it is recognised.
 */
export function linkedFilePath(href: string | undefined): string | undefined {
  const value = href?.trim();
  if (!value || /^[#?]/.test(value) || value.startsWith("//")) return undefined;
  if (/^file:/i.test(value)) return fileUrlPath(value);
  const path = decoded(value.split(/[?#]/, 1)[0] ?? "");
  if (!path || path.length > MAX_PATH_LENGTH) return undefined;
  if (DRIVE.test(path)) return path;
  return SCHEME.test(path) ? undefined : path;
}

/**
 * Inline code that is nothing but the absolute path of a file.
 *
 * "Saved the report to `C:\work\report.docx`" is how an agent most often says
 * where its output went. Only absolute paths ending in an extension qualify —
 * `index.ts` or `npm test` could be anything — and a trailing `:line` is
 * dropped, since it names a place in the file rather than the file.
 */
export function inlineFilePath(text: string): string | undefined {
  // Inline code never spans lines; a fenced block's text always ends in one.
  if (/[\r\n]/.test(text)) return undefined;
  const value = text
    .trim()
    .replace(/^(["'])(.+)\1$/, "$2")
    .replace(/:\d+(?::\d+)?$/, "");
  if (!value || value.length > MAX_PATH_LENGTH || NOT_A_PATH.test(value))
    return undefined;
  const path = /^file:\/\//i.test(value) ? fileUrlPath(value) : value;
  if (!path) return undefined;
  const windows = WINDOWS_ABSOLUTE.test(path);
  const posix = /^~?\/[^/\s]/.test(path) && !/\s/.test(path);
  if (!windows && !posix) return undefined;
  const name = path.split(/[\\/]/).pop() ?? "";
  return /\.[A-Za-z0-9]{1,10}$/.test(name) ? path : undefined;
}

/**
 * The file a completed edit touched, from the one-line detail its row shows.
 *
 * A detail cut short with an ellipsis is not a path any more, and a relative
 * one with spaces in it is more likely a summary than a file.
 */
export function toolFilePath(detail: string | undefined): string | undefined {
  const value = detail?.trim();
  if (
    !value ||
    value.endsWith("…") ||
    value.length > MAX_PATH_LENGTH ||
    NOT_A_PATH.test(value)
  ) {
    return undefined;
  }
  if (/^file:\/\//i.test(value)) return fileUrlPath(value);
  const absolute = WINDOWS_ABSOLUTE.test(value) || /^~?\//.test(value);
  return absolute || !/\s/.test(value) ? value : undefined;
}

/** The last component of a path, for labels. */
export function fileName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function sessionFileUrl(
  sessionId: string,
  kind: "stat" | "download",
  path: string,
): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/files/${kind}?path=${encodeURIComponent(path)}`;
}

/**
 * Downloads a file from the machine a session ran on.
 *
 * Asks what the file is first, so a missing or refused file is a message the
 * page can show; then hands the download itself to the browser, which streams
 * it to disk with its own progress and cancel rather than holding it in a tab.
 */
export async function downloadSessionFile(
  sessionId: string,
  path: string,
): Promise<SessionFileInfo> {
  const info = await api<SessionFileInfo>(sessionFileUrl(sessionId, "stat", path));
  const link = document.createElement("a");
  link.href = sessionFileUrl(sessionId, "download", info.path);
  link.download = info.name;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
  return info;
}
