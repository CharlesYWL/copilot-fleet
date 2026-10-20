import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  eventPayload,
  usageAmountKeys,
  UsageSnapshotSchema,
  type SessionEvent,
  type UsageSnapshot,
} from "@fleet/protocol";
import { privateJournalDirectory } from "./command-journal.js";

/** Accounting is durable for every role, independent of disposable transcript output. */
export class UsageJournal {
  private readonly db: DatabaseSync;
  private readonly sentThrough = new Map<string, number>();
  constructor(directory: string, secure = true) {
    if (secure) privateJournalDirectory(directory);
    else mkdirSync(directory, { recursive: true });
    const path = join(directory, "usage.db");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const stat = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink()))
        throw new Error("Usage journal must use regular files");
    }
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=32768;
      CREATE TABLE IF NOT EXISTS positions (host TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (host TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(host,sequence));
      CREATE TABLE IF NOT EXISTS latest (host TEXT NOT NULL, scope TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(host,scope));`);
  }
  observe(hostId: string, event: SessionEvent): void {
    const accounting = eventPayload(event, "usage")?.accounting;
    if (
      !hostId ||
      !accounting ||
      !usageAmountKeys.some((key) => accounting[key] !== undefined)
    )
      return;
    const keys = usageAmountKeys.filter((key) => accounting[key] !== undefined);
    const scope = JSON.stringify([event.sessionId, accounting.counterId, keys]);
    const signature = JSON.stringify(keys.map((key) => accounting[key]));
    if (
      this.db
        .prepare("SELECT signature FROM latest WHERE host=? AND scope=?")
        .get(hostId, scope)?.signature === signature
    )
      return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const count = Number(
        this.db.prepare("SELECT COUNT(*) AS count FROM pending WHERE host=?").get(hostId)!
          .count,
      );
      if (count >= 100_000)
        throw new Error("Usage journal is full; accounting delivery requires attention");
      const sequence =
        Number(
          this.db.prepare("SELECT sequence FROM positions WHERE host=?").get(hostId)
            ?.sequence ?? 0,
        ) + 1;
      const snapshot = UsageSnapshotSchema.parse({
        id: randomUUID(),
        sequence,
        sessionId: event.sessionId,
        accounting,
      });
      this.db
        .prepare("INSERT INTO pending VALUES (?,?,?)")
        .run(hostId, sequence, JSON.stringify(snapshot));
      this.db
        .prepare(
          "INSERT INTO positions VALUES (?,?) ON CONFLICT(host) DO UPDATE SET sequence=excluded.sequence",
        )
        .run(hostId, sequence);
      this.db
        .prepare(
          "INSERT INTO latest VALUES (?,?,?) ON CONFLICT(host,scope) DO UPDATE SET signature=excluded.signature",
        )
        .run(hostId, scope, signature);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  pending(hostId: string): UsageSnapshot[] {
    return this.db
      .prepare("SELECT data FROM pending WHERE host=? ORDER BY sequence LIMIT 100")
      .all(hostId)
      .map((row) => UsageSnapshotSchema.parse(JSON.parse(String(row.data))));
  }
  sent(hostId: string, throughSequence: number): void {
    this.sentThrough.set(
      hostId,
      Math.max(throughSequence, this.sentThrough.get(hostId) ?? 0),
    );
  }
  acknowledge(hostId: string, throughSequence: number): void {
    if (
      !Number.isSafeInteger(throughSequence) ||
      throughSequence < 0 ||
      throughSequence > (this.sentThrough.get(hostId) ?? 0)
    )
      throw new Error("Usage acknowledgment exceeds sent history");
    this.db
      .prepare("DELETE FROM pending WHERE host=? AND sequence<=?")
      .run(hostId, throughSequence);
  }
  close(): void {
    this.db.close();
  }
}
