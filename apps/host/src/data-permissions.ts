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
const SYSTEM_SID = "*S-1-5-18";

/** The local Administrators group, which the design already trusts. */
const ADMINISTRATORS_SID = "*S-1-5-32-544";

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
 * Read from the environment the session already set rather than by asking the
 * system for it: resolving a current user by spawning a helper is a process
 * launch on every boot for a value the session has already published, and it is
 * the kind of name-based lookup this file exists to avoid.
 */
function currentPrincipal(env: Record<string, string | undefined>): string | undefined {
  const user = env.USERNAME;
  if (!user) return undefined;
  const domain = env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

/**
 * Locks the Host's data directory and database to the account that runs it.
 *
 * Unix says this with mode bits. Windows ignores them entirely, so the
 * equivalent is an explicit ACL: every entry cleared, then exactly the three
 * principals the design names — the running user, SYSTEM, and local
 * Administrators — identified by SID rather than by display name, because those
 * names are localised and renameable and an ACL that failed to match one would
 * silently grant nothing instead of failing.
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
   * protects. Applying it there reconfigures somebody's working tree — and if
   * the running account cannot be named (an Entra-joined machine spells it
   * differently), it reconfigures it into one the Host itself cannot reopen.
   */
  if (!deps.production) return;
  const systemRoot = deps.env.SystemRoot ?? deps.env.SYSTEMROOT ?? deps.env.windir;
  if (!systemRoot) {
    throw new Error("SystemRoot is not set, so the ACL tool cannot be located");
  }
  const principal = currentPrincipal(deps.env);
  if (!principal) {
    throw new Error("USERNAME is not set, so the running account cannot be named");
  }
  const icacls = `${systemRoot}\\System32\\icacls.exe`;

  /*
   * Two invocations, and both the order and the scope are load-bearing.
   *
   * `/grant:r` replaces the entry for the principal it names and leaves every
   * other one exactly where it was, so a directory carrying an explicit
   * "Users: read" — from whoever created it, from a copy, from an older build
   * — keeps it, and `/inheritance:r` does not help because that entry is not
   * inherited. `/reset` is the only icacls verb that removes entries nobody
   * enumerated, and it runs over the whole tree because the database and its
   * `-wal`/`-shm` journals already exist by the time a Host restarts and each
   * carries a DACL of its own. It also re-enables inheritance on every one of
   * them, which is what makes the second call reach them.
   *
   * The second call is deliberately *not* `/T`. Applied to a file, `(OI)(CI)`
   * is not a valid inheritance flag, so icacls drops the grant while
   * `/inheritance:r` still strips what the file inherited — leaving an empty
   * DACL that even the Host cannot open. Granting on the directory alone and
   * letting NTFS propagate leaves every existing child with exactly these
   * three entries, marked inherited, and every future child with the same.
   *
   * The tree is briefly left inheriting from the parent directory between the
   * two calls, which is the price of icacls having no atomic "replace this
   * DACL" verb. The alternative is leaving an entry that grants a whole
   * machine permanent read access to the Host's private key.
   */
  deps.applyWindowsAcl(icacls, [directory, "/reset", "/T", "/Q"]);
  deps.applyWindowsAcl(icacls, [
    directory,
    // Now that nothing explicit is left, drop what the parent handed down.
    "/inheritance:r",
    "/grant:r",
    `${principal}:(OI)(CI)F`,
    "/grant:r",
    `${SYSTEM_SID}:(OI)(CI)F`,
    "/grant:r",
    `${ADMINISTRATORS_SID}:(OI)(CI)F`,
    "/Q",
  ]);
  /*
   * Deliberately no `/C`: it tells icacls to continue past a file it could not
   * change and still exit zero, which would turn "this Host protected its key"
   * into "this Host tried". A failure here is thrown, and in production that
   * stops the Host from starting.
   */
}
