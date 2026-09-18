import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorktreeConflict, type CheckoutIdentity } from "@fleet/protocol";
import { assertIdentity, canonicalPath } from "./canonical-path.js";
import { GitRunner } from "./git-runner.js";
import type { CheckoutLease } from "./checkout-locks.js";

export type RepositoryTarget = {
  cwd: string;
  checkout: CheckoutIdentity;
  repository: CheckoutIdentity;
  git: boolean;
};

export async function resolveRepositoryTarget(
  path: string,
  git = new GitRunner(),
): Promise<RepositoryTarget> {
  const directory = await canonicalPath(path);
  const root = await git.run(directory.path, ["rev-parse", "--show-toplevel"], {
    allowedExitCodes: [0, 128],
  });
  if (root.exitCode !== 0) {
    const metadata = await git.run(directory.path, ["rev-parse", "--absolute-git-dir"], {
      allowedExitCodes: [0, 128],
    });
    if (metadata.exitCode === 0)
      throw new WorktreeConflict(
        "git_administration_target",
        "Use a working directory, not a bare repository or Git administration directory.",
      );
    return {
      cwd: directory.path,
      checkout: directory,
      repository: directory,
      git: false,
    };
  }
  const checkout = await canonicalPath(root.stdout.trim());
  const common = await git.run(checkout.path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return {
    cwd: directory.path,
    checkout,
    repository: await canonicalPath(common.stdout.trim()),
    git: true,
  };
}

function registryDirectory(target: RepositoryTarget): string {
  return join(
    target.repository.path,
    target.git ? "fleet-participation-v1" : ".fleet-participation-v1",
  );
}

type Participant = {
  token: string;
  owner: string;
  incarnation: string;
  mode: "shared" | "exclusive" | "command";
  tracked: boolean;
  processPending: boolean;
  processes: number[];
  unknown: string;
};

/** Shared registry across installations. Command participation coexists with sessions, not maintenance. */
export class RepositoryParticipation {
  readonly incarnation = randomUUID();

  constructor(private readonly resolveTarget = resolveRepositoryTarget) {}

  resolve(path: string): Promise<RepositoryTarget> {
    return this.resolveTarget(path);
  }

  private open(target: RepositoryTarget): DatabaseSync {
    const directory = registryDirectory(target);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(directory, "participation.db"));
    db.exec(`
      PRAGMA busy_timeout=1000;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (token TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    db.prepare("INSERT OR IGNORE INTO policy VALUES (1,?,1)").run(target.repository.key);
    const policy = db.prepare("SELECT identity FROM policy WHERE id=1").get();
    if (policy?.identity !== target.repository.key) {
      db.close();
      throw new WorktreeConflict(
        "identity_changed",
        "Participation registry identity changed.",
      );
    }
    return db;
  }

  enabled(target: RepositoryTarget): boolean {
    const db = this.open(target);
    try {
      db.prepare("UPDATE policy SET enabled=1 WHERE id=1").run();
      return true;
    } finally {
      db.close();
    }
  }

  /** Compatibility for older callers; every upgraded participant is automatic. */
  async activate(
    paths: readonly string[],
    _allInstallationsUpgraded: boolean,
  ): Promise<void> {
    const targets = await Promise.all(paths.map((path) => this.resolve(path)));
    for (const target of targets.sort((a, b) =>
      a.repository.key.localeCompare(b.repository.key),
    )) {
      await assertIdentity(target.repository);
      this.enabled(target);
    }
  }

  async acquire(
    targets: readonly RepositoryTarget[],
    owner: string,
    mode: Participant["mode"],
    _requireEnabled = false,
    _forceExclusion = false,
  ): Promise<CheckoutLease[]> {
    const unique = [
      ...new Map(targets.map((target) => [target.repository.key, target])).values(),
    ].sort((a, b) => a.repository.key.localeCompare(b.repository.key));
    const leases: CheckoutLease[] = [];
    try {
      for (const target of unique) {
        await assertIdentity(target.repository);
        leases.push(this.acquireOne(target, owner, mode));
      }
      return leases;
    } catch (error) {
      for (const lease of leases.reverse()) lease.release();
      throw error;
    }
  }

  private acquireOne(
    target: RepositoryTarget,
    owner: string,
    mode: Participant["mode"],
  ): CheckoutLease {
    const db = this.open(target);
    const record: Participant = {
      token: randomUUID(),
      owner,
      incarnation: this.incarnation,
      mode,
      tracked: true,
      processPending: false,
      processes: [],
      unknown: "",
    };
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE policy SET enabled=1 WHERE id=1").run();
      const others = db
        .prepare("SELECT data FROM participants")
        .all()
        .map((row) => JSON.parse(String(row.data)) as Participant);
      if (
        others.some(
          (other) =>
            other.unknown ||
            (!other.tracked &&
              !(
                mode === "command" &&
                other.mode === "shared" &&
                other.owner.startsWith("session:")
              )) ||
            mode === "exclusive" ||
            other.mode === "exclusive",
        )
      )
        throw new WorktreeConflict(
          "repository_busy",
          "Checkout busy: repository has active or unknown Fleet participation.",
        );
      db.prepare("INSERT INTO participants VALUES (?,?)").run(
        record.token,
        JSON.stringify(record),
      );
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
    let released = false;
    const update = (remove = false) => {
      if (released)
        throw new WorktreeConflict("lease_lost", "Repository participation was retired.");
      const connection = this.open(target);
      try {
        const changed = remove
          ? connection.prepare("DELETE FROM participants WHERE token=?").run(record.token)
          : connection
              .prepare("UPDATE participants SET data=? WHERE token=?")
              .run(JSON.stringify(record), record.token);
        if (changed.changes !== 1)
          throw new WorktreeConflict(
            "lease_lost",
            "Repository participation is missing.",
          );
      } finally {
        connection.close();
      }
    };
    return {
      key: `repository:${target.repository.key}`,
      owner,
      revalidate: async () => {
        await assertIdentity(target.repository);
        await assertIdentity(target.checkout);
        if (record.unknown) throw new WorktreeConflict("process_unknown", record.unknown);
        update();
      },
      release: () => {
        if (released) return;
        if (record.unknown || record.processPending || record.processes.length)
          throw new WorktreeConflict(
            "process_unknown",
            "Repository participation requires verified quiescence.",
          );
        update(true);
        released = true;
      },
      processPending: () => {
        record.processPending = true;
        update();
      },
      processStarted: (pid) => {
        record.processPending = false;
        record.processes.push(pid);
        update();
      },
      processesQuiesced: () => {
        record.processPending = false;
        record.processes = [];
        record.unknown = "";
        update();
      },
      requireReconciliation: (reason) => {
        record.unknown = reason;
        update();
      },
      reattach: () => {
        throw new WorktreeConflict(
          "lease_upgrade",
          "Repository participation cannot be upgraded in place.",
        );
      },
    };
  }

  async participate(
    paths: readonly string[],
    owner: string,
  ): Promise<{ leases: CheckoutLease[]; supervised: boolean }> {
    const targets = await Promise.all(paths.map((path) => this.resolve(path)));
    const leases = await this.acquire(targets, owner, "shared");
    return { leases, supervised: true };
  }

  requireRecoveredCommandReconciliation(
    target: RepositoryTarget,
    owner: string,
    reason: string,
  ): void {
    if (!owner.startsWith("command:"))
      throw new Error("Reconciliation requires a command owner.");
    const db = this.open(target);
    try {
      db.exec("BEGIN IMMEDIATE");
      let found = false;
      for (const row of db.prepare("SELECT token,data FROM participants").all()) {
        const record = JSON.parse(String(row.data)) as Participant;
        if (record.owner !== owner) continue;
        if (record.mode !== "exclusive" && record.mode !== "command")
          throw new Error("Recovered command had unexpected session participation.");
        record.unknown = reason || "Command process ownership requires reconciliation.";
        db.prepare("UPDATE participants SET data=? WHERE token=?").run(
          JSON.stringify(record),
          String(row.token),
        );
        found = true;
      }
      if (!found)
        throw new WorktreeConflict(
          "lease_lost",
          "Command participation is missing during recovery.",
        );
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  releaseRecoveredCommand(target: RepositoryTarget, owner: string): void {
    if (!owner.startsWith("command:"))
      throw new Error("Recovery requires a verified command supervisor receipt.");
    const db = this.open(target);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const row of db.prepare("SELECT token,data FROM participants").all()) {
        const record = JSON.parse(String(row.data)) as Participant;
        if (record.owner !== owner) continue;
        if (record.mode !== "exclusive" && record.mode !== "command")
          throw new Error("Recovered command had unexpected session participation.");
        db.prepare("DELETE FROM participants WHERE token=?").run(String(row.token));
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
}
