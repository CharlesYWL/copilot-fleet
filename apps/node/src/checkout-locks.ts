import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { WorktreeConflict, type CheckoutIdentity } from "@fleet/protocol";
import { assertIdentity, identityHash } from "./canonical-path.js";

export type LeaseOwner = {
  owner: string;
  attempt: string;
  kind: "worker" | "admin" | "integration" | "maintenance";
};
type LockRecord = LeaseOwner & {
  key: string;
  token: string;
  nodeIncarnation: string;
  pid: number;
  processes: number[];
  processPending: boolean;
  reconciliationRequired?: string;
};

export type CheckoutLease = {
  key: string;
  owner: string;
  revalidate: () => Promise<void>;
  release: () => void;
  processPending: () => void;
  processStarted: (pid: number) => void;
  processesQuiesced: () => void;
  requireReconciliation: (reason: string) => void;
  reattach: (owner: string, previousAttempt: string, attempt: string) => void;
};

export class CheckoutLocks {
  readonly incarnation = randomUUID();
  private readonly held = new Map<string, CheckoutLease>();
  private readonly scopes = new Map<string, string>();

  constructor(readonly directory?: string) {
    if (directory) mkdirSync(directory, { recursive: true });
  }

  bindScope(identity: CheckoutIdentity, commonDirectory?: CheckoutIdentity): void {
    const root = commonDirectory
      ? join(commonDirectory.path, "fleet-managed-locks-v1")
      : join(identity.path, ".fleet-checkout-locks-v1");
    const prior = this.scopes.get(identity.key);
    if (!this.directory && prior && prior !== root && this.holder(identity.key)) {
      throw new WorktreeConflict(
        "lock_scope_changed",
        "Git administration moved while the physical checkout still has a lease.",
      );
    }
    this.scopes.set(identity.key, root);
    if (commonDirectory) this.scopes.set(`admin:${commonDirectory.key}`, root);
  }

  private file(key: string): string {
    const root = this.directory ?? this.scopes.get(key);
    if (!root)
      throw new WorktreeConflict(
        "lock_scope_unknown",
        "The Node has not resolved a shared physical lock scope.",
      );
    mkdirSync(root, { recursive: true });
    return join(root, `${identityHash(key)}.json`);
  }

  locallyOwned(key: string): boolean {
    return this.held.has(key) && this.holder(key)?.nodeIncarnation === this.incarnation;
  }

  holder(key: string): LockRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(this.file(key), "utf8")) as LockRecord;
      if (value.key !== key || !value.token || !Number.isInteger(value.pid))
        throw new Error("invalid lock");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new WorktreeConflict(
        "unknown_lock",
        "Checkout lock ownership is unreadable; do not remove it by age.",
      );
    }
  }

  acquire(identity: CheckoutIdentity, owner: LeaseOwner): CheckoutLease {
    const key = owner.kind === "admin" ? `admin:${identity.key}` : identity.key;
    const existing = this.holder(key);
    const local = this.held.get(key);
    if (existing) {
      if (
        local &&
        !existing.reconciliationRequired &&
        existing.owner === owner.owner &&
        existing.attempt === owner.attempt
      )
        return local;
      throw new WorktreeConflict(
        "checkout_busy",
        `Checkout is reserved by ${existing.owner}. Stop and verify the previous process before transferring its lease.`,
      );
    }
    const record: LockRecord = {
      ...owner,
      key,
      token: randomUUID(),
      nodeIncarnation: this.incarnation,
      pid: process.pid,
      processes: [],
      processPending: false,
    };
    try {
      writeFileSync(this.file(key), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    } catch {
      throw new WorktreeConflict(
        "checkout_busy",
        "Another Node process acquired this physical checkout.",
      );
    }
    const verify = () => {
      if (this.holder(key)?.token !== record.token) {
        throw new WorktreeConflict(
          "lease_lost",
          "Checkout lease ownership changed. Execution is blocked.",
        );
      }
    };
    const save = () => {
      verify();
      const file = this.file(key);
      const staged = `${file}.${randomUUID()}.next`;
      try {
        writeFileSync(staged, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        verify();
        renameSync(staged, file);
      } finally {
        if (existsSync(staged)) unlinkSync(staged);
      }
    };
    let released = false;
    const lease: CheckoutLease = {
      key,
      owner: owner.owner,
      revalidate: async () => {
        verify();
        const current = this.holder(key)!;
        if (
          current.owner !== record.owner ||
          current.attempt !== record.attempt ||
          current.reconciliationRequired
        )
          throw new WorktreeConflict(
            "lease_lost",
            "Checkout lease attempt or ownership changed.",
          );
        await assertIdentity(identity);
      },
      release: () => {
        if (released) return;
        verify();
        if (
          record.processPending ||
          record.processes.length ||
          record.reconciliationRequired
        ) {
          throw new WorktreeConflict(
            "process_unknown",
            "Process quiescence has not been verified; its checkout lease is retained.",
          );
        }
        unlinkIfPresent(this.file(key));
        this.held.delete(key);
        released = true;
      },
      processPending: () => {
        record.processPending = true;
        save();
      },
      processStarted: (pid) => {
        record.processes.push(pid);
        record.processPending = false;
        save();
      },
      processesQuiesced: () => {
        record.processes = [];
        record.processPending = false;
        delete record.reconciliationRequired;
        save();
      },
      requireReconciliation: (reason) => {
        record.reconciliationRequired = reason;
        save();
      },
      reattach: (sessionOwner, previousAttempt, attempt) => {
        verify();
        const current = this.holder(key)!;
        if (
          released ||
          current.owner !== sessionOwner ||
          current.attempt !== previousAttempt ||
          record.attempt !== previousAttempt ||
          current.reconciliationRequired
        )
          throw new WorktreeConflict("binding_mismatch", "Checkout lease owner changed.");
        const previous = record.attempt;
        record.attempt = attempt;
        try {
          save();
        } catch (error) {
          record.attempt = previous;
          throw error;
        }
      },
    };
    this.held.set(key, lease);
    return lease;
  }

  /** Called only after the command supervisor proves this exact attempt quiescent. */
  releaseRecoveredCommand(
    identity: CheckoutIdentity,
    owner: string,
    attempt: string,
    admin = false,
  ): void {
    if (!owner.startsWith("command:"))
      throw new Error("Only a verified command supervisor can reconcile this owner.");
    const key = admin ? `admin:${identity.key}` : identity.key;
    const record = this.holder(key);
    if (!record) return;
    if (record.owner !== owner) return;
    if (record.attempt !== attempt)
      throw new WorktreeConflict(
        "lease_changed",
        "Recovered command no longer owns this lease.",
      );
    if (this.holder(key)?.token !== record.token)
      throw new WorktreeConflict("lease_changed", "Recovered command lease changed.");
    unlinkIfPresent(this.file(key));
    this.held.delete(key);
  }

  /** Only administrative commands have a bounded, recorded child-process set. */
  reconcileAdmin(identity: CheckoutIdentity): void {
    const key = `admin:${identity.key}`;
    const record = this.holder(key);
    if (!record) return;
    if (
      record.kind !== "admin" ||
      record.processPending ||
      isAlive(record.pid) ||
      record.processes.some(isAlive)
    ) {
      throw new WorktreeConflict(
        "process_unknown",
        "A previous Node/Git process may still own repository administration.",
      );
    }
    if (this.holder(key)?.token !== record.token) {
      throw new WorktreeConflict(
        "lease_changed",
        "Repository ownership changed during reconciliation.",
      );
    }
    unlinkSync(this.file(key));
  }

  recoverIntegration(identity: CheckoutIdentity, operationId: string): void {
    const record = this.holder(identity.key);
    if (!record || this.held.has(identity.key)) return;
    if (
      record.kind !== "integration" ||
      record.owner !== `integration:${operationId}` ||
      record.processPending ||
      record.processes.some(isAlive) ||
      isAlive(record.pid)
    ) {
      throw new WorktreeConflict(
        "process_unknown",
        "The target reservation cannot be safely transferred to this Node incarnation.",
      );
    }
    if (this.holder(identity.key)?.token !== record.token)
      throw new WorktreeConflict("lease_changed", "Target reservation changed.");
    unlinkIfPresent(this.file(identity.key));
  }

  recoverMaintenance(identity: CheckoutIdentity, owner: string): void {
    const record = this.holder(identity.key);
    if (!record) return;
    if (
      record.kind !== "maintenance" ||
      record.owner !== owner ||
      record.processPending ||
      record.processes.length ||
      isAlive(record.pid)
    ) {
      throw new WorktreeConflict(
        "process_unknown",
        "Maintenance lease ownership is not proven quiescent.",
      );
    }
    if (this.holder(identity.key)?.token !== record.token) {
      throw new WorktreeConflict(
        "lease_changed",
        "Maintenance ownership changed during reconciliation.",
      );
    }
    unlinkIfPresent(this.file(identity.key));
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
