import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { NodeAdmission } from "./node-admission.js";

const MarkerSchema = z.object({
  version: z.literal(1),
  phase: z.enum(["mutating", "built"]),
  root: z.string().min(1),
  revision: z.string(),
});
export const UPDATE_QUARANTINE_REASON =
  "Node update is incomplete. Retry Update Node to rebuild; command/session admission remains blocked.";

/** A failed Git/npm mutation must stay blocked across process restarts. */
export class UpdateQuarantine {
  private readonly file: string;
  private marker: z.infer<typeof MarkerSchema> | undefined;

  constructor(
    private readonly admission: NodeAdmission,
    private readonly directory: string,
    private readonly root: string,
    currentRevision: string,
  ) {
    this.file = join(directory, "update-incomplete.json");
    try {
      this.marker = MarkerSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      this.marker?.phase === "built" &&
      this.marker.revision !== "" &&
      resolve(this.marker.root) === resolve(root) &&
      this.marker.revision === currentRevision
    ) {
      this.clear();
    } else this.restoreBlock();
  }

  prepareRetry(): boolean {
    if (!this.marker) return false;
    this.admission.reconcileQuarantine(UPDATE_QUARANTINE_REASON);
    return true;
  }

  beforeMutation(): void {
    this.write({ version: 1, phase: "mutating", root: this.root, revision: "" });
    this.admission.quarantine(UPDATE_QUARANTINE_REASON);
  }

  built(revision: string): void {
    if (!revision)
      throw new Error("A successful update must identify its built revision.");
    this.write({ version: 1, phase: "built", root: this.root, revision });
    this.restoreBlock();
  }

  clear(): void {
    rmSync(this.file, { force: true });
    this.marker = undefined;
    this.admission.reconcileQuarantine(UPDATE_QUARANTINE_REASON);
  }

  restoreBlock(): void {
    if (this.marker && !this.admission.quarantined)
      this.admission.quarantine(UPDATE_QUARANTINE_REASON);
  }

  private write(marker: z.infer<typeof MarkerSchema>): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const staged = `${this.file}.${randomUUID()}.writing`;
    try {
      const descriptor = openSync(staged, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(marker));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(staged, this.file);
      this.marker = marker;
    } finally {
      rmSync(staged, { force: true });
    }
  }
}
