import { randomUUID } from "node:crypto";
import { WorktreeConflict } from "@fleet/protocol";

export type AdmissionTicket = { release(): void; revalidate(): void };

/** Synchronous registration only: filesystem work and draining happen outside this gate. */
export class NodeAdmission {
  private readonly tickets = new Map<string, string>();
  private readonly closures = new Map<string, string>();
  private quarantineReason = "";

  get reason(): string {
    return this.quarantineReason || [...this.closures.values()][0] || "";
  }

  get quarantined(): string {
    return this.quarantineReason;
  }

  get active(): readonly string[] {
    return [...this.tickets.values()];
  }

  enter(owner: string): AdmissionTicket {
    if (this.reason) throw new WorktreeConflict("node_draining", this.reason);
    const id = randomUUID();
    this.tickets.set(id, owner);
    let released = false;
    return {
      revalidate: () => {
        if (released || this.reason)
          throw new WorktreeConflict(
            "node_draining",
            this.reason || "Admission retired.",
          );
      },
      release: () => {
        released = true;
        this.tickets.delete(id);
      },
    };
  }

  close(reason: string): () => void {
    const id = randomUUID();
    this.closures.set(id, reason);
    return () => this.closures.delete(id);
  }

  quarantine(reason: string): void {
    this.quarantineReason = reason;
  }

  reconcileQuarantine(expectedReason: string): void {
    if (this.quarantineReason === expectedReason) this.quarantineReason = "";
  }

  assertIdle(): void {
    if (this.active.length || this.quarantineReason)
      throw new WorktreeConflict(
        "node_busy",
        this.quarantineReason ||
          "Active or launch-in-progress Fleet work prevents maintenance.",
      );
  }

  async maintenance<T>(reason: string, work: () => Promise<T>): Promise<T> {
    const reopen = this.close(reason);
    try {
      this.assertIdle();
      return await work();
    } finally {
      reopen();
    }
  }
}
