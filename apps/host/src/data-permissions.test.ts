import { describe, expect, it } from "vitest";
import { secureHostDataFiles, type SecureDataDeps } from "./data-permissions.js";

/**
 * The database is the fleet.
 *
 * It holds the Host's private signing key, the administrator table, the CSRF
 * and lead-token keys, and every transcript the fleet has produced. The design
 * puts those inside the operating-system account rather than outside it, which
 * only means anything if the files actually say so — a default-umask database
 * on a shared machine is readable by every other account on it.
 */
const recorder = (
  overrides: Partial<SecureDataDeps> = {},
): { deps: SecureDataDeps; chmods: [string, number][]; acls: string[][] } => {
  const chmods: [string, number][] = [];
  const acls: string[][] = [];
  return {
    chmods,
    acls,
    deps: {
      platform: "linux",
      exists: () => true,
      chmod: (path, mode) => chmods.push([path, mode]),
      applyWindowsAcl: (executable, args) => acls.push([executable, ...args]),
      env: {},
      production: false,
      warn: () => {},
      ...overrides,
    },
  };
};

describe("securing the Host data directory on Unix", () => {
  it("makes the directory owner-only and every database file owner-read-write", () => {
    const { deps, chmods } = recorder();
    secureHostDataFiles("/srv/fleet/data/fleet.db", deps);
    expect(chmods).toEqual([
      ["/srv/fleet/data", 0o700],
      ["/srv/fleet/data/fleet.db", 0o600],
      ["/srv/fleet/data/fleet.db-wal", 0o600],
      ["/srv/fleet/data/fleet.db-shm", 0o600],
    ]);
  });

  it("uses Unix path rules even when the filename contains a backslash", () => {
    const { deps, chmods } = recorder();
    secureHostDataFiles("/srv/fleet/data/fleet\\archive.db", deps);
    expect(chmods[0]).toEqual(["/srv/fleet/data", 0o700]);
  });

  /*
   * The write-ahead log carries the same rows as the database until a
   * checkpoint folds it in, so a WAL file that has not been created yet is
   * skipped rather than invented — but one that exists is never left behind.
   */
  it("skips sidecars the database has not written yet", () => {
    const { deps, chmods } = recorder({
      exists: (path) => !path.endsWith("-shm"),
    });
    secureHostDataFiles("/srv/fleet/data/fleet.db", deps);
    expect(chmods.map(([path]) => path)).not.toContain("/srv/fleet/data/fleet.db-shm");
  });

  it("says so loudly in production when the mode cannot be set", () => {
    const { deps } = recorder({
      production: true,
      chmod: () => {
        throw new Error("EPERM");
      },
    });
    expect(() => secureHostDataFiles("/srv/fleet/data/fleet.db", deps)).toThrow(
      /permission/i,
    );
  });

  /*
   * A developer checkout on a network share or a container bind mount may
   * genuinely refuse chmod, and refusing to start there would be a worse
   * outcome than a warning nobody has to act on.
   */
  it("only warns outside production", () => {
    const warnings: string[] = [];
    const { deps } = recorder({
      warn: (message) => warnings.push(message),
      chmod: () => {
        throw new Error("EPERM");
      },
    });
    expect(() => secureHostDataFiles("/srv/fleet/data/fleet.db", deps)).not.toThrow();
    expect(warnings.join(" ")).toMatch(/permission/i);
  });

  it("does nothing at all for an in-memory database", () => {
    const { deps, chmods, acls } = recorder();
    secureHostDataFiles(":memory:", deps);
    expect(chmods).toEqual([]);
    expect(acls).toEqual([]);
  });
});

describe("securing the Host data directory on Windows", () => {
  const windows = (overrides: Partial<SecureDataDeps> = {}) =>
    recorder({
      platform: "win32",
      // A deployed Host, which is the only place Fleet reconfigures an ACL.
      production: true,
      env: { SystemRoot: "C:\\Windows" },
      ...overrides,
    });

  /** The one invocation, as `[executable, ...args]`. */
  const invocation = (overrides: Partial<SecureDataDeps> = {}): string[] => {
    const { deps, acls } = windows(overrides);
    secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps);
    expect(acls).toHaveLength(1);
    return acls[0]!;
  };

  /**
   * chmod is a no-op on NTFS, so the mode bits Unix relies on say nothing here.
   * The equivalent is an explicit ACL — and it is written in one call, because
   * the two-step shape this replaced (`icacls /reset /T`, then a grant) left
   * the whole tree inheriting `C:\ProgramData`'s "Users: read" in between. That
   * is a window, on every boot, where the file holding the Host's private key
   * is readable by every account on the machine.
   */
  it("assigns the whole DACL in a single invocation", () => {
    const { deps, acls, chmods } = windows();
    secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps);
    expect(chmods).toEqual([]);
    expect(acls).toHaveLength(1);
    const script = acls[0]!.join(" ");
    // Nothing clears permissions and then puts them back.
    expect(script).not.toContain("/reset");
    expect(script).not.toContain("icacls");
  });

  /*
   * Resolved absolutely from SystemRoot rather than looked up on PATH, so what
   * runs is the operating system's own shell and not something earlier on a
   * search path a caller controls. Windows PowerShell rather than `pwsh`: it
   * ships with Windows, and its .NET Framework runtime has
   * `FileInfo.SetAccessControl` as an instance method.
   */
  it("runs the shell that ships with Windows, by absolute path", () => {
    const [executable] = invocation();
    expect(executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    const args = invocation().slice(1);
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-Command");
  });

  /*
   * A name is not an identity. `USERDOMAIN\USERNAME` is localised, renameable,
   * spelled differently on an Entra-joined machine, and settable by whoever
   * launched the process — and an entry that failed to resolve would grant
   * nothing on a directory whose inheritance had just been broken, which is a
   * Host that cannot reopen its own database.
   */
  it("asks Windows for the running account's SID instead of reading its name", () => {
    const script = invocation().join(" ");
    expect(script).toContain("[System.Security.Principal.WindowsIdentity]::GetCurrent()");
    expect(script).toContain("GetCurrent().User");
    expect(script).not.toContain("USERNAME");
    expect(script).not.toContain("USERDOMAIN");
  });

  /** With no name in the environment at all, since none is consulted. */
  it("needs no account name in the environment", () => {
    const script = invocation({ env: { SystemRoot: "C:\\Windows" } }).join(" ");
    expect(script).toContain("GetCurrent().User");
  });

  /*
   * SIDs, not display names: "Administrators" and "SYSTEM" are localised and
   * renameable. Exactly three, because a fourth is somebody the design did not
   * put inside the trust boundary.
   */
  it("allows the running account, SYSTEM and Administrators, and nobody else", () => {
    const script = invocation().join(" ");
    expect(script).toContain("SecurityIdentifier('S-1-5-18')");
    expect(script).toContain("SecurityIdentifier('S-1-5-32-544')");
    expect(script).toContain("$allowed=@($me,");
    expect(script.match(/AddAccessRule/g)).toHaveLength(1);
    expect(script).toContain("'FullControl'");
  });

  /**
   * The descriptor is built from nothing rather than edited, so what lands is
   * exactly those three entries: a directory carrying an explicit "Users: read"
   * — from whoever created it, from a copy, from an older build — loses it in
   * the same write that adds the three, with no moment in between.
   */
  it("writes a descriptor built from nothing, with inheritance broken", () => {
    const script = invocation().join(" ");
    expect(script).toContain(
      "New-Object System.Security.AccessControl.DirectorySecurity",
    );
    expect(script).toContain("New-Object System.Security.AccessControl.FileSecurity");
    // Protected, and without copying the inherited entries in first.
    expect(script).toContain("SetAccessRuleProtection($true,$false)");
    expect(script).toContain("SetAccessControl($acl)");
  });

  /**
   * The database, its write-ahead log and its shared-memory file already exist
   * by the time a Host restarts, and each carries a DACL of its own. An ACL
   * applied to the directory alone leaves those exactly as they were, which is
   * the file holding the Host's private key still readable by whoever could
   * read it before.
   *
   * The recursion is what reaches them; the inheritable flags on the directory
   * are what covers the journals SQLite writes later.
   */
  it("reaches the database and its journals, and the ones not written yet", () => {
    const script = invocation().join(" ");
    expect(script).toContain("Get-Item -LiteralPath $root");
    expect(script).toContain("Get-ChildItem -LiteralPath $root -Recurse -Force");
    expect(script).toContain("'ContainerInherit,ObjectInherit'");
    // A file inherits nothing to anything; `(OI)(CI)` on one is what used to
    // silently drop the entry and leave an empty DACL behind.
    expect(script).toContain("$inherit=if($container)");
  });

  /*
   * The target is the one value that is not fixed, so it travels as a
   * single-quoted PowerShell literal with its quotes doubled: nothing in a
   * path can then be read as anything but a path.
   */
  it.each(["C:\\fleet\\o'brien data", "\\\\server\\share\\o'brien data"])(
    "quotes the Windows directory %s rather than interpolating it into the script",
    (directory) => {
      const { deps, acls } = windows();
      secureHostDataFiles(`${directory}\\fleet.db`, deps);
      expect(acls[0]!.join(" ")).toContain(`$root='${directory.replace(/'/g, "''")}'`);
    },
  );

  it("says so loudly in production when the ACL cannot be applied", () => {
    const attempts: string[][] = [];
    const { deps } = windows({
      applyWindowsAcl: (executable, args) => {
        attempts.push([executable, ...args]);
        throw new Error("Access is denied.");
      },
    });
    expect(() => secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps)).toThrow(
      /permission/i,
    );
    // And it failed having changed nothing, rather than half-way through a
    // sequence that had already opened the tree up.
    expect(attempts).toHaveLength(1);
  });

  /*
   * Replacing a DACL is hard to undo and, on a machine where the Host runs as
   * somebody else, can leave a directory its owner cannot reopen. A developer
   * checkout is not the machine that boundary is for.
   */
  it("leaves a developer machine's permissions alone", () => {
    const { deps, acls } = windows({ production: false });
    secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps);
    expect(acls).toEqual([]);
  });

  it("refuses to guess an executable path when SystemRoot is missing", () => {
    const { deps, acls } = windows({ env: {} });
    expect(() => secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps)).toThrow(
      /permission/i,
    );
    expect(acls).toEqual([]);
  });
});
