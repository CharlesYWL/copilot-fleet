import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The database is the fleet.
 *
 * It holds the Host's private signing key, the administrator table, the CSRF
 * and lead-token keys, and every transcript the fleet has produced. The design
 * puts all of that inside the operating-system account rather than outside it,
 * and that boundary is only real if the files say so — a database created under
 * a default umask on a shared machine is readable by every other account on it,
 * which turns "local administrators are inside the trust boundary" into
 * "everyone with a login is".
 */

/** The sidecars SQLite writes alongside the database in WAL mode. */
const SIDECARS = ["-wal", "-shm"] as const;

/** SYSTEM, which the operating system needs and which is not a person. */
const SYSTEM_SID = "S-1-5-18";

/** The local Administrators group, which the design already trusts. */
const ADMINISTRATORS_SID = "S-1-5-32-544";

export type SecureDataDeps = {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  chmod: (path: string, mode: number) => void;
  /** Runs the ACL tool by absolute path, with arguments, and never through a shell. */
  applyWindowsAcl: (executable: string, args: readonly string[]) => void;
  env: Record<string, string | undefined>;
  /** Whether a refusal is fatal, or a warning a developer can live with. */
  production: boolean;
  warn: (message: string) => void;
};

export function defaultSecureDataDeps(warn: (message: string) => void): SecureDataDeps {
  return {
    platform: process.platform,
    exists: existsSync,
    chmod: chmodSync,
    applyWindowsAcl: (executable, args) => {
      /*
       * `execFileSync`, not `exec`: there is no shell, so nothing in these
       * arguments can be interpreted as one — and the executable is named by
       * absolute path rather than looked up, so what runs is the operating
       * system's own tool and not something earlier on a search path a caller
       * may control.
       */
      execFileSync(executable, [...args], { stdio: "ignore", windowsHide: true });
    },
    env: process.env,
    production: process.env.NODE_ENV === "production",
    warn,
  };
}

/**
 * The account this process is running as, in the form an ACL names it by.
 *
 * Not resolved here at all: the script below asks Windows for the running
 * account's SID. Reading `USERDOMAIN`/`USERNAME` produces a *name*, and names
 * are localised, renameable, spelled differently on an Entra-joined machine,
 * and settable by whoever launched the process — so an ACL built from one
 * either grants the wrong account or, when the lookup fails, grants nothing at
 * all on a directory whose inheritance has just been broken.
 */
function windowsAclScript(directory: string): string {
  /*
   * The one value that is not fixed, embedded as a PowerShell single-quoted
   * literal: no interpolation happens inside one, and `''` is its only escape,
   * so a data directory containing a quote, a `$` or a backtick cannot become
   * anything other than a path.
   */
  const root = `'${directory.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference='Stop'",
    `$root=${root}`,
    // Asked of the operating system, so the entry is this process's own SID
    // whatever the environment claims the account is called.
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$allowed=@($me," +
      `(New-Object System.Security.Principal.SecurityIdentifier('${SYSTEM_SID}')),` +
      `(New-Object System.Security.Principal.SecurityIdentifier('${ADMINISTRATORS_SID}')))`,
    // The directory itself plus everything already inside it: the database and
    // its `-wal`/`-shm` journals exist by the time a Host restarts and each
    // carries a DACL of its own.
    "$items=@(Get-Item -LiteralPath $root -Force)+" +
      "@(Get-ChildItem -LiteralPath $root -Recurse -Force)",
    "foreach($item in $items){" +
      "$container=$item.PSIsContainer;" +
      // Built from nothing rather than edited: a fresh security object has an
      // empty DACL, so what is written is exactly these three entries and
      // whatever was there before is gone in the same write.
      "$acl=if($container){New-Object System.Security.AccessControl.DirectorySecurity}" +
      "else{New-Object System.Security.AccessControl.FileSecurity};" +
      // Protected, and without copying the inherited entries into it.
      "$acl.SetAccessRuleProtection($true,$false);" +
      // Inheritable on a directory so the journals SQLite writes later land
      // inside the same three entries; a file inherits nothing to anything.
      "$inherit=if($container){'ContainerInherit,ObjectInherit'}else{'None'};" +
      "foreach($sid in $allowed){$acl.AddAccessRule(" +
      "(New-Object System.Security.AccessControl.FileSystemAccessRule(" +
      "$sid,'FullControl',$inherit,'None','Allow')))};" +
      // One `SetSecurityInfo` per item: the DACL is replaced whole, so there
      // is no moment where the directory is more permissive than it should be.
      "$item.SetAccessControl($acl)}",
    "exit 0",
  ].join("; ");
}

/**
 * Locks the Host's data directory and database to the account that runs it.
 *
 * Unix says this with mode bits. Windows ignores them entirely, so the
 * equivalent is an explicit ACL: one complete descriptor per item, naming
 * exactly the three principals the design allows — the running user, SYSTEM,
 * and local Administrators — each identified by SID rather than by display
 * name, because those names are localised and renameable and an ACL that
 * failed to match one would silently grant nothing instead of failing.
 */
export function secureHostDataFiles(databasePath: string, deps: SecureDataDeps): void {
  if (databasePath === ":memory:") return;
  const directory = dirname(databasePath);
  try {
    if (deps.platform === "win32") {
      secureOnWindows(directory, deps);
      return;
    }
    deps.chmod(directory, 0o700);
    for (const path of [databasePath, ...SIDECARS.map((s) => `${databasePath}${s}`)]) {
      if (deps.exists(path)) deps.chmod(path, 0o600);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message = `Could not restrict permission on the Host data directory at ${directory}: ${reason}. The Host database holds its private key and administrator table, so it must not be readable by other accounts.`;
    /*
     * Fatal in production and a warning elsewhere. A developer checkout on a
     * network share or a container bind mount may genuinely refuse this, and
     * refusing to start there would be a worse outcome than a line nobody has
     * to act on — but a production Host that cannot protect its own key has no
     * business serving a control plane.
     */
    if (deps.production) throw new Error(message, { cause: error });
    deps.warn(message);
  }
}

function secureOnWindows(directory: string, deps: SecureDataDeps): void {
  /*
   * Only on a deployed Host. Breaking inheritance and replacing a DACL is a
   * heavyweight, hard-to-undo change to a machine, and on a developer checkout
   * the data directory is usually under a profile the operating system already
   * protects. Applying it there reconfigures somebody's working tree.
   */
  if (!deps.production) return;
  const systemRoot = deps.env.SystemRoot ?? deps.env.SYSTEMROOT ?? deps.env.windir;
  if (!systemRoot) {
    throw new Error("SystemRoot is not set, so the ACL tool cannot be located");
  }
  /*
   * One invocation, and the DACL it writes is complete.
   *
   * The previous shape was two `icacls` calls — `/reset /T` to clear entries
   * nobody enumerated, then `/inheritance:r /grant:r` to put the three back —
   * because icacls has no verb that replaces a DACL. Between them the whole
   * tree inherited from the parent directory, which on `C:\ProgramData` is
   * "Users: read": a window, on every boot, where the file holding the Host's
   * private key is readable by every account on the machine. The window is
   * short and the failure it hides is permanent, and a `/reset` that succeeded
   * while the grant failed left the tree *more* open than it started.
   *
   * Windows PowerShell drives the ACL objects directly instead: each item gets
   * one security descriptor built from nothing — protected, three entries, no
   * inherited ones copied in — written in a single call. There is no
   * intermediate state to lose a race with, and a failure leaves the previous
   * DACL exactly as it was.
   *
   * `WindowsPowerShell\v1.0\powershell.exe` by absolute path, not `pwsh` and
   * not a PATH lookup: it ships with the operating system, its .NET Framework
   * runtime has `FileInfo.SetAccessControl` as an instance method, and naming
   * it absolutely means what runs cannot be something earlier on a search path
   * a caller controls.
   */
  deps.applyWindowsAcl(
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      windowsAclScript(directory),
    ],
  );
}
