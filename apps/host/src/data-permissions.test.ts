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
      env: {
        SystemRoot: "C:\\Windows",
        USERDOMAIN: "CONTOSO",
        USERNAME: "fleetsvc",
      },
      ...overrides,
    });

  /*
   * chmod is a no-op on NTFS, so the mode bits Unix relies on say nothing here.
   * The equivalent is an explicit ACL: every explicit entry cleared, then
   * exactly the three principals the design names.
   */
  it("replaces the whole DACL with one naming the user, SYSTEM and Administrators", () => {
    const { deps, acls, chmods } = windows();
    secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps);
    expect(chmods).toEqual([]);
    expect(acls).toHaveLength(2);
    for (const [executable] of acls) {
      // Resolved absolutely from SystemRoot rather than looked up on PATH, so
      // what runs is the operating system's icacls and not something earlier on
      // a caller-controlled search path.
      expect(executable).toBe("C:\\Windows\\System32\\icacls.exe");
    }
    const [, ...granted] = acls[1]!;
    expect(granted[0]).toBe("C:\\fleet\\data");
    expect(granted).toContain("/inheritance:r");
    expect(granted.join(" ")).toContain("CONTOSO\\fleetsvc");
    // SIDs, not display names: "Administrators" and "SYSTEM" are localised and
    // renameable, and an ACL that failed to name them would silently grant
    // nothing rather than fail.
    expect(granted.join(" ")).toContain("*S-1-5-18");
    expect(granted.join(" ")).toContain("*S-1-5-32-544");
    // Nobody else, however the directory got there.
    expect(granted.filter((arg) => arg === "/grant:r")).toHaveLength(3);
    expect(granted.join(" ")).not.toContain("/grant ");
  });

  /*
   * `/grant:r` replaces the entry for the principal it names and nothing else,
   * so a directory carrying an explicit "Users: read" from whoever created it
   * keeps it — the one thing this file exists to prevent. Only `/reset` clears
   * entries nobody enumerated, so it has to come first and it has to run over
   * the whole tree.
   */
  it("clears every explicit entry it did not put there before granting", () => {
    const { deps, acls } = windows();
    secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps);
    const [, ...reset] = acls[0]!;
    expect(reset[0]).toBe("C:\\fleet\\data");
    expect(reset).toContain("/reset");
    expect(reset).toContain("/T");
    // The reset must not be the last word, or the directory would be left
    // inheriting whatever its parent grants.
    expect(acls[1]?.join(" ")).toContain("/inheritance:r");
  });

  /**
   * The database, its write-ahead log and its shared-memory file already exist
   * by the time a Host restarts, and each may carry a DACL of its own. An ACL
   * applied to the directory alone leaves those exactly as they were, which is
   * the file holding the Host's private key still readable by whoever could
   * read it before.
   *
   * The reset is what reaches them, and it is also what re-enables inheritance
   * on them so the grant that follows lands. The grant itself must *not* carry
   * `/T`: applied to a file, `(OI)(CI)` is not a valid inheritance flag, so
   * icacls drops the grant while `/inheritance:r` still strips what the file
   * inherited — leaving an empty DACL that even the Host cannot open. That is a
   * bricked Host, verified against the real tool.
   */
  it("reaches the database and its journals through the reset, not the grant", () => {
    const { deps, acls } = windows();
    secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps);
    expect(acls[0]).toContain("/T");
    expect(acls[1]).not.toContain("/T");
    // Inheritable, so both the journals that exist and the ones SQLite writes
    // later land inside the same three entries.
    expect(acls[1]?.join(" ")).toContain("(OI)(CI)F");
  });

  /*
   * `/C` tells icacls to carry on past a file it could not change and still
   * report success, which would turn "this Host protected its key" into "this
   * Host tried". A production Host that cannot finish the job has to stop.
   */
  it("never asks icacls to continue past a failure", () => {
    const { deps, acls } = windows();
    secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps);
    for (const invocation of acls) {
      expect(invocation).not.toContain("/C");
    }
  });

  it("stops before granting anything when the reset fails", () => {
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
    expect(attempts).toHaveLength(1);
  });

  /*
   * Replacing a DACL is hard to undo and, on a machine that spells the running
   * account differently, can leave a directory the Host itself cannot reopen.
   * A developer checkout is not the machine that boundary is for.
   */
  it("leaves a developer machine's permissions alone", () => {
    const { deps, acls } = windows({ production: false });
    secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps);
    expect(acls).toEqual([]);
  });

  it("refuses to guess an executable path when SystemRoot is missing", () => {
    const { deps, acls } = windows({ env: { USERNAME: "fleetsvc" } });
    expect(() => secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps)).toThrow(
      /permission/i,
    );
    expect(acls).toEqual([]);
  });

  it("says so loudly in production when the ACL cannot be applied", () => {
    const { deps } = windows({
      applyWindowsAcl: () => {
        throw new Error("Access is denied.");
      },
    });
    expect(() => secureHostDataFiles("C:\\fleet\\data\\fleet.db", deps)).toThrow(
      /permission/i,
    );
  });
});
