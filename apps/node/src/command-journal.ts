import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  COMMAND_LIMITS,
  CommandOutputEventSchema,
  CommandReceiptSchema,
  PreparedCommandSchema,
  type CommandOutputEvent,
} from "@fleet/protocol";
import { z } from "zod";

export function privateJournalDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Journal directory may not be a link.");
  if (process.platform === "win32") {
    const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const identity = execFileSync(
      join(system, "whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    const sid = /S-1-\d+(?:-\d+)+/.exec(identity)?.[0];
    if (!sid) throw new Error("Cannot establish the journal owner's Windows SID.");
    execFileSync(
      join(system, "icacls.exe"),
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      { windowsHide: true, stdio: "pipe", timeout: 10_000 },
    );
  } else chmodSync(directory, 0o700);
}

export const CommandJournalRecordSchema = z.object({
  hostId: z.string(),
  nodeId: z.string(),
  namespace: z.string().uuid(),
  descriptor: PreparedCommandSchema,
  receipt: CommandReceiptSchema,
  launchIntent: z.boolean().default(false),
  admissionIntent: z.boolean().default(false),
  leasesReleased: z.boolean().default(false),
  artifactCleanupComplete: z.boolean().default(false),
  supervisionError: z.string().max(4000).optional(),
  released: z.boolean().default(false),
  cancelRequested: z.boolean().default(false),
  identity: z.record(z.string(), z.unknown()).optional(),
  terminalAck: z.boolean().default(false),
  acknowledgedSeq: z.number().int().nonnegative().default(0),
  lastSequence: z.number().int().nonnegative().default(0),
  outputBytes: z.number().int().nonnegative().default(0),
  capturedBytes: z.number().int().nonnegative().default(0),
});
export type CommandJournalRecord = z.infer<typeof CommandJournalRecordSchema>;

/** FULL SQLite transactions protect identities independently from disposable output. */
export class CommandJournal {
  readonly db: DatabaseSync;
  namespace: string;
  onFailure: (error: unknown) => void = () => {};
  constructor(
    readonly directory: string,
    secure = true,
  ) {
    if (secure) privateJournalDirectory(directory);
    else mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "commands.db"));
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA max_page_count=57344;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cancellations (id TEXT PRIMARY KEY, host TEXT NOT NULL, attempt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS output (id TEXT NOT NULL, sequence INTEGER NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, sequence));
      CREATE TABLE IF NOT EXISTS output_offsets (
        id TEXT NOT NULL, stream TEXT NOT NULL, bytes INTEGER NOT NULL,
        PRIMARY KEY(id,stream)
      );
    `);
    this.db.exec(`
      INSERT OR IGNORE INTO output_offsets(id,stream,bytes)
      SELECT output.id,json_extract(output.data,'$.stream'),sum(output.bytes)
      FROM output JOIN executions ON executions.id=output.id
      WHERE (SELECT coalesce(sum(saved.bytes),0) FROM output saved WHERE saved.id=output.id)
        =json_extract(executions.data,'$.capturedBytes')
      GROUP BY output.id,json_extract(output.data,'$.stream');
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES ('namespace',?)")
      .run(randomUUID());
    this.namespace = String(
      this.db.prepare("SELECT value FROM metadata WHERE key='namespace'").get()!.value,
    );
  }

  get(id: string): CommandJournalRecord | undefined {
    const row = this.db.prepare("SELECT data FROM executions WHERE id=?").get(id);
    return row
      ? CommandJournalRecordSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }

  all(): CommandJournalRecord[] {
    return this.db
      .prepare("SELECT data FROM executions")
      .all()
      .map((row) => CommandJournalRecordSchema.parse(JSON.parse(String(row.data))));
  }

  save(record: CommandJournalRecord): void {
    try {
      this.persist(record);
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private persist(record: CommandJournalRecord): void {
    const value = JSON.stringify(CommandJournalRecordSchema.parse(record));
    const size = Number(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM executions WHERE id<>?",
        )
        .get(record.descriptor.executionId)!.bytes,
    );
    const tombstones =
      Number(
        this.db.prepare("SELECT COUNT(*) AS count FROM cancellations").get()!.count,
      ) *
        600 +
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM tombstones",
          )
          .get()!.bytes,
      );
    if (
      size + tombstones + Buffer.byteLength(value) >
      COMMAND_LIMITS.lifecycleReserveBytes
    )
      throw new Error("Command lifecycle storage is full; admission must remain closed.");
    this.db
      .prepare(
        "INSERT INTO executions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(record.descriptor.executionId, value);
  }

  cancel(id: string, host: string, attempt: string): void {
    const prior = this.cancellation(id);
    if (prior && (prior.host !== host || prior.attempt !== attempt))
      throw new Error("Cancellation identity mismatch.");
    if (
      !prior &&
      Number(
        this.db.prepare("SELECT COUNT(*) AS count FROM cancellations").get()!.count,
      ) >= 8192
    ) {
      const error = new Error("Cancellation identity storage is full.");
      this.onFailure(error);
      throw error;
    }
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO cancellations VALUES (?,?,?)")
        .run(id, host, attempt);
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  cancellation(id: string): { host: string; attempt: string } | undefined {
    return this.db
      .prepare("SELECT host,attempt FROM cancellations WHERE id=?")
      .get(id) as { host: string; attempt: string } | undefined;
  }

  retired(id: string): boolean {
    return !!this.db.prepare("SELECT id FROM tombstones WHERE id=?").get(id);
  }

  output(record: CommandJournalRecord, event: CommandOutputEvent): boolean {
    CommandOutputEventSchema.parse(event);
    const bytes = Buffer.from(event.data, "base64").length;
    const total = Number(
      this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM output").get()!.bytes,
    );
    const retain =
      record.outputBytes + bytes <= COMMAND_LIMITS.outputBytes &&
      total + bytes <= COMMAND_LIMITS.nodeLogBytes - COMMAND_LIMITS.outputBytes;
    const next = {
      ...record,
      receipt: {
        ...record.receipt,
        gaps: record.receipt.gaps.map((gap) => ({ ...gap })),
      },
      lastSequence: event.sequence,
      capturedBytes: record.capturedBytes + bytes,
      outputBytes: record.outputBytes + (retain ? bytes : 0),
    };
    if (!retain) {
      const last = next.receipt.gaps.at(-1);
      if (last?.to === event.sequence - 1) last.to = event.sequence;
      else if (next.receipt.gaps.length < 128)
        next.receipt.gaps.push({ from: event.sequence, to: event.sequence });
      else next.receipt.gaps[127]!.to = event.sequence;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (retain)
        this.db
          .prepare("INSERT INTO output VALUES (?,?,?,?)")
          .run(event.executionId, event.sequence, bytes, JSON.stringify(event));
      this.db
        .prepare(
          `INSERT INTO output_offsets(id,stream,bytes) VALUES(?,?,?)
         ON CONFLICT(id,stream) DO UPDATE SET bytes=bytes+excluded.bytes`,
        )
        .run(event.executionId, event.stream, bytes);
      this.save(next);
      this.db.exec("COMMIT");
      Object.assign(record, next);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return retain;
  }

  outputOffset(id: string, stream: "stdout" | "stderr"): number {
    const row = this.db
      .prepare("SELECT bytes FROM output_offsets WHERE id=? AND stream=?")
      .get(id, stream);
    return row ? Number(row.bytes) : 0;
  }

  events(id: string, afterSeq: number, limit = 32): CommandOutputEvent[] {
    return this.db
      .prepare(
        "SELECT data FROM output WHERE id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(id, afterSeq, limit)
      .map((row) => CommandOutputEventSchema.parse(JSON.parse(String(row.data))));
  }

  acknowledge(record: CommandJournalRecord, throughSeq: number, terminal: boolean): void {
    if (throughSeq > record.lastSequence)
      throw new Error("Output acknowledgement exceeds the journal watermark.");
    record.acknowledgedSeq = Math.max(throughSeq, record.acknowledgedSeq);
    record.terminalAck ||=
      terminal &&
      record.receipt.finalOutputSeq !== undefined &&
      throughSeq >= record.receipt.finalOutputSeq &&
      ["not_started", "quiescent"].includes(record.receipt.ownership);
    // Keep replayable evidence for seven days even after acknowledgement.
    this.save(record);
  }

  prune(now = Date.now()): void {
    for (const record of this.all()) {
      if (
        !record.terminalAck ||
        !record.receipt.settledAt ||
        now - Date.parse(record.receipt.settledAt) <= COMMAND_LIMITS.replayMs
      )
        continue;
      this.db.prepare("DELETE FROM output WHERE id=?").run(record.descriptor.executionId);
      if (record.lastSequence)
        record.receipt.gaps = [{ from: 1, to: record.lastSequence }];
      this.save(record);
      if (
        now - Date.parse(record.receipt.settledAt) > COMMAND_LIMITS.retentionMs &&
        record.leasesReleased &&
        (!record.launchIntent || record.artifactCleanupComplete)
      ) {
        const tombstone = JSON.stringify({
          hostId: record.hostId,
          nodeId: record.nodeId,
          namespace: record.namespace,
          receipt: record.receipt,
          requestKey: record.descriptor.requestKey,
        });
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db
            .prepare("INSERT OR IGNORE INTO tombstones VALUES (?,?)")
            .run(record.descriptor.executionId, tombstone);
          this.db
            .prepare("DELETE FROM executions WHERE id=?")
            .run(record.descriptor.executionId);
          this.db
            .prepare("DELETE FROM output_offsets WHERE id=?")
            .run(record.descriptor.executionId);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
    }
  }

  rotateNamespace(): void {
    this.namespace = randomUUID();
    this.db
      .prepare("UPDATE metadata SET value=? WHERE key='namespace'")
      .run(this.namespace);
  }

  close(): void {
    this.db.close();
  }
}
