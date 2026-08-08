import { execFile } from "node:child_process";
import { homedir } from "node:os";

export type PickerCommand = {
  file: string;
  args: string[];
  env?: Record<string, string>;
};

export type PickerResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; reason: string };

/*
 * The starting folder is passed as data, never spliced into the script source.
 * Both of these languages would happily execute a directory name containing
 * their own syntax, and directory names are not under our control.
 *
 * On macOS `osascript` exposes trailing arguments to the script as `argv`; on
 * Windows an environment variable does the same job, since PowerShell's -Command
 * takes one string that we do not want to build by concatenation.
 */

const MAC_SCRIPT = `on run argv
  set startPath to item 1 of argv
  try
    set startFolder to (POSIX file startPath) as alias
  on error
    set startFolder to path to home folder
  end try
  try
    set chosen to choose folder with prompt "Choose a folder for this placement" default location startFolder
  on error number -128
    return ""
  end try
  return POSIX path of chosen
end run`;

const WINDOWS_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder for this placement'
$start = $env:FLEET_PICKER_START
if ($start -and (Test-Path -LiteralPath $start)) { $dialog.SelectedPath = $start }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}`;

/**
 * Builds the command that opens this platform's own folder dialog.
 *
 * Returns undefined where no standard dialog exists, so the caller can fall
 * back rather than block on something that will never appear.
 */
export function nativePickerCommand(
  platform: string,
  startPath: string,
): PickerCommand | undefined {
  if (platform === "darwin") {
    return { file: "osascript", args: ["-e", MAC_SCRIPT, startPath] };
  }
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        WINDOWS_SCRIPT,
      ],
      env: { FLEET_PICKER_START: startPath },
    };
  }
  return undefined;
}

/** macOS returns this when the operator dismisses the dialog. */
const CANCEL_EXIT_CODE = 1;

export function parsePickerResult(code: number, stdout: string): PickerResult {
  const path = stdout.trim();
  if (path) return { ok: true, path };
  // No path and a clean-ish exit means the dialog was dismissed. Only an
  // unexpected exit code is worth showing as an error.
  if (code === 0 || code === CANCEL_EXIT_CODE) {
    return { ok: false, canceled: true };
  }
  return { ok: false, reason: `The folder dialog failed (exit ${code})` };
}

/** How long to leave an unanswered dialog open before giving up on it. */
const PICKER_TIMEOUT_MS = 300_000;

/**
 * Opens the operating system's folder dialog on *this* machine.
 *
 * The dialog appears on the node's own display, which is the only place it can
 * appear: the page requesting it may be running on a different computer
 * entirely. That makes this useful when configuring the machine you are sitting
 * at, and useless when configuring one you are not, hence the typed-path
 * fallback the page keeps alongside it.
 */
export function pickFolder(
  startPath: string,
  platform: string = process.platform,
): Promise<PickerResult> {
  const command = nativePickerCommand(platform, startPath.trim() || homedir());
  if (!command) {
    return Promise.resolve({
      ok: false,
      reason: "This machine has no native folder dialog; type the path instead",
    });
  }
  return new Promise((resolve) => {
    execFile(
      command.file,
      command.args,
      {
        timeout: PICKER_TIMEOUT_MS,
        ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
      },
      (error, stdout) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? -1
              : 0;
        resolve(parsePickerResult(code, String(stdout)));
      },
    );
  });
}
