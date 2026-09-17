import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
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
  mode: "shared" | "exclusive";
  tracked: boolean;
  processPending: boolean;
  processes: number[];
  unknown: string;
};

/** The common-directory database, never a per-installation config lock. No age/PID reclamation. */
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
    db.prepare("INSERT OR IGNORE INTO policy VALUES (1,?,0)").run(target.repository.key);
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
    if (!existsSync(registryDirectory(target))) return false;
    const db = this.open(target);
    try {
      return db.prepare("SELECT enabled FROM policy WHERE id=1").get()?.enabled === 1;
    } finally {
      db.close();
    }
  }

  /** Operator attestation is necessary: a new registry cannot discover noncooperating old Nodes. */
  async activate(
    paths: readonly string[],
    allInstallationsUpgraded: boolean,
  ): Promise<void> {
    if (!allInstallationsUpgraded || !paths.length)
      throw new WorktreeConflict(
        "untracked_ownership",
        "List eligible roots and confirm all Fleet installations are upgraded and old/untracked sessions drained.",
      );
    const targets = await Promise.all(paths.map((path) => this.resolve(path)));
    for (const target of targets.sort((a, b) =>
      a.repository.key.localeCompare(b.repository.key),
    )) {
      await assertIdentity(target.repository);
      if (this.enabled(target)) continue;
      const legacy = join(
        target.repository.path,
        target.git ? "fleet-managed-locks-v1" : ".fleet-checkout-locks-v1",
      );
      if (
        existsSync(legacy) &&
        readdirSync(legacy).some((file) => file.endsWith(".json"))
      ) {
        // Even a stale PID is not proof that its old descendant tree is empty.
        throw new WorktreeConflict(
          "untracked_ownership",
          "Existing checkout ownership must be drained/reconciled before activation.",
        );
      }
      const db = this.open(target);
      try {
        db.exec("BEGIN IMMEDIATE");
        if (db.prepare("SELECT token FROM participants LIMIT 1").get())
          throw new WorktreeConflict(
            "repository_busy",
            "Existing Fleet participants must drain before activation.",
          );
        db.prepare("UPDATE policy SET enabled=1 WHERE id=1").run();
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    }
  }

  async acquire(
    targets: readonly RepositoryTarget[],
    owner: string,
    mode: "shared" | "exclusive",
    requireEnabled = false,
    forceExclusion = false,
  ): Promise<CheckoutLease[]> {
    const unique = [
      ...new Map(targets.map((target) => [target.repository.key, target])).values(),
    ].sort((a, b) => a.repository.key.localeCompare(b.repository.key));
    const leases: CheckoutLease[] = [];
    try {
      for (const target of unique) {
        await assertIdentity(target.repository);
        leases.push(this.acquireOne(target, owner, mode, requireEnabled, forceExclusion));
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
    mode: "shared" | "exclusive",
    requireEnabled: boolean,
    forceExclusion: boolean,
  ): CheckoutLease {
    const db = this.open(target);
    let enabled = false;
    const record: Participant = {
      token: randomUUID(),
      owner,
      incarnation: this.incarnation,
      mode,
      tracked: false,
      processPending: false,
      processes: [],
      unknown: "",
    };
    try {
      db.exec("BEGIN IMMEDIATE");
      enabled = db.prepare("SELECT enabled FROM policy WHERE id=1").get()?.enabled === 1;
      if (requireEnabled && !enabled)
        throw new WorktreeConflict(
          "repository_not_enabled",
          "This physical repository was not locally activated.",
        );
      const others = db
        .prepare("SELECT data FROM participants")
        .all()
        .map((row) => JSON.parse(String(row.data)) as Participant);
      if (
        others.some((other) => other.tracked && other.mode === "exclusive") ||
        ((enabled || forceExclusion) &&
          others.some(
            (other) =>
              other.unknown ||
              !other.tracked ||
              mode === "exclusive" ||
              other.mode === "exclusive",
          ))
      )
        throw new WorktreeConflict(
          "repository_busy",
          "Repository has active or unknown Fleet participation.",
        );
      record.tracked = enabled || forceExclusion;
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
        if (
          enabled &&
          (record.unknown || record.processPending || record.processes.length)
        )
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
    return { leases, supervised: targets.some((target) => this.enabled(target)) };
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
        if (record.mode !== "exclusive")
          throw new Error("Recovered command had unexpected shared participation.");
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
