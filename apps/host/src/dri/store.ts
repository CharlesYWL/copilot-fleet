import type { DatabaseSync } from "node:sqlite";
import {
  DriBackupSchema,
  DriInvestigationSchema,
  DriPageInputSchema,
  DriProfileDecisionSchema,
  DriRecordSchema,
  DRI_BACKUP_LIMITS,
  DriRetentionTombstoneSchema,
  type DriBackup,
  type DriInvestigation,
  type DriPage,
  type DriProfileDecision,
  type DriQuery,
  type DriRecord,
  type DriRecordKind,
  type DriRecordOf,
  type DriBackupCounts,
} from "@fleet/protocol";
import { canonical, contentHash, DriError, redactRecord, stableId } from "./safety.js";
import {
  DRI_BACKUP_MAX_BYTES,
  selectBackupInvestigations,
  type BackupCandidate,
  type DriBackupLimits,
} from "./backup.js";

const tables: Record<DriRecordKind, string> = {
  incidents: "dri_incident_snapshots",
  timeline: "dri_timeline",
  evidence: "dri_evidence",
  artifacts: "dri_artifacts",
  queries: "dri_invocations",
  hypotheses: "dri_hypotheses",
  similar: "dri_similar_incidents",
  changes: "dri_changes",
  reports: "dri_report_revisions",
  audit: "dri_audit_receipts",
  work: "dri_work",
};
type Row = {
  payload: string;
  hash: string;
  head: number;
  logical_key: string;
  sequence: number;
};
const decode = <T>(row: { payload: string }): T => JSON.parse(row.payload) as T;
const resultStates = new Set([
  "succeeded",
  "no_results",
  "access_denied",
  "unavailable",
  "failed",
  "truncated",
  "incomplete",
  "cancelled",
]);

/** Additive tables on FleetStore's connection and synchronous transaction boundary. */
export class DriStore {
  private cleanupCursor = 0;
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(work: () => T) => T,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dri_schema (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO dri_schema(version) VALUES (1);
      CREATE TABLE IF NOT EXISTS dri_generation_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO dri_generation_clock VALUES (1,0);
      CREATE TABLE IF NOT EXISTS dri_investigations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dri_investigations_created ON dri_investigations(created_at,id);
      CREATE INDEX IF NOT EXISTS dri_investigations_status ON dri_investigations(json_extract(payload,'$.status'));
      CREATE TABLE IF NOT EXISTS dri_profile_decisions (
        id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES dri_investigations(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, payload TEXT NOT NULL,
        UNIQUE(investigation_id, revision)
      );
      CREATE TABLE IF NOT EXISTS dri_invocation_attempts (
        id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES dri_investigations(id) ON DELETE CASCADE,
        invocation_id TEXT NOT NULL, generation INTEGER NOT NULL, attempt INTEGER NOT NULL,
        hash TEXT NOT NULL, payload TEXT NOT NULL, accepted INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dri_attempt_lookup ON dri_invocation_attempts(investigation_id, invocation_id);
      CREATE TABLE IF NOT EXISTS dri_hypothesis_relations (
        investigation_id TEXT NOT NULL REFERENCES dri_investigations(id) ON DELETE CASCADE,
        hypothesis_id TEXT NOT NULL, evidence_id TEXT NOT NULL, relation TEXT NOT NULL,
        PRIMARY KEY(investigation_id,hypothesis_id,evidence_id,relation)
      );
      CREATE TABLE IF NOT EXISTS dri_retention_tombstones (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, expired_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dri_retention_run ON dri_retention_tombstones(run_id);
    `);
    for (const table of Object.values(tables)) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          investigation_id TEXT NOT NULL REFERENCES dri_investigations(id) ON DELETE CASCADE,
          logical_key TEXT NOT NULL, generation INTEGER NOT NULL, attempt INTEGER NOT NULL,
          hash TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ${table}_head ON ${table}(investigation_id,logical_key) WHERE head=1;
        CREATE INDEX IF NOT EXISTS ${table}_page ON ${table}(investigation_id,head,sequence);
        CREATE INDEX IF NOT EXISTS ${table}_generation ON ${table}(investigation_id,generation,attempt);
      `);
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS dri_timeline_utc ON dri_timeline(investigation_id,head,json_extract(payload,'$.at'),sequence)",
    );
    db.exec(
      "UPDATE runs SET dri_id=(SELECT id FROM dri_investigations WHERE run_id=runs.id) WHERE EXISTS (SELECT 1 FROM dri_investigations WHERE run_id=runs.id)",
    );
  }

  create(input: DriInvestigation): DriInvestigation {
    const parsed = DriInvestigationSchema.parse(input);
    return this.atomic(() => {
      this.db
        .prepare(
          "INSERT INTO dri_investigations(id,run_id,revision,payload,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          parsed.id,
          parsed.runId,
          parsed.revision,
          canonical(parsed),
          parsed.createdAt,
        );
      this.db
        .prepare("UPDATE dri_generation_clock SET value=MAX(value,?) WHERE id=1")
        .run(parsed.generation);
      this.decision(parsed.id, parsed.profile);
      this.db.prepare("UPDATE runs SET dri_id=? WHERE id=?").run(parsed.id, parsed.runId);
      return parsed;
    });
  }
  get(id: string): DriInvestigation | undefined {
    const row = this.db
      .prepare("SELECT payload FROM dri_investigations WHERE id=?")
      .get(id);
    return row
      ? DriInvestigationSchema.parse(JSON.parse(String(row.payload)))
      : undefined;
  }
  forRun(runId: string): DriInvestigation | undefined {
    const row = this.db
      .prepare("SELECT payload FROM dri_investigations WHERE run_id=?")
      .get(runId);
    return row ? decode<DriInvestigation>(row as { payload: string }) : undefined;
  }
  list(input: { limit?: number; cursor?: number } = {}): DriPage<DriInvestigation> {
    const { limit, cursor } = DriPageInputSchema.parse(input);
    const rows = this.db
      .prepare(
        "SELECT rowid sequence,payload FROM dri_investigations WHERE rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(cursor, limit + 1) as unknown as Row[];
    return {
      items: rows.slice(0, limit).map((row) => decode<DriInvestigation>(row)),
      nextCursor: rows.length > limit ? rows[limit - 1]!.sequence : null,
      revision: 0,
    };
  }
  update(
    id: string,
    expected: number,
    patch: Partial<DriInvestigation>,
  ): DriInvestigation {
    return this.atomic(() => {
      const current = this.require(id);
      if (current.revision !== expected)
        throw new DriError("Investigation revision changed; reload and retry", 412);
      const next = DriInvestigationSchema.parse({
        ...current,
        ...patch,
        id: current.id,
        runId: current.runId,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare(
          "UPDATE dri_investigations SET revision=?,payload=? WHERE id=? AND revision=?",
        )
        .run(next.revision, canonical(next), id, expected);
      return next;
    });
  }
  require(id: string): DriInvestigation {
    const found = this.get(id);
    if (!found) throw new DriError("Investigation not found", 404);
    return found;
  }
  runnable(): DriInvestigation[] {
    return this.db
      .prepare(
        "SELECT payload FROM dri_investigations WHERE json_extract(payload,'$.status') IN ('intake','collect','analyze','validate','report') LIMIT 50",
      )
      .all()
      .map((row) => decode<DriInvestigation>(row as { payload: string }));
  }
  invocationCount(id: string): number {
    return Number(
      this.db
        .prepare("SELECT COUNT(*) count FROM dri_invocations WHERE investigation_id=?")
        .get(id)!.count,
    );
  }
  decision(id: string, input: DriProfileDecision): void {
    const parsed = DriProfileDecisionSchema.parse(input);
    const key = stableId("decision", [id, parsed.id]);
    const existing = this.db
      .prepare(
        "SELECT payload FROM dri_profile_decisions WHERE investigation_id=? AND (id=? OR id=?)",
      )
      .get(id, key, parsed.id);
    if (existing) {
      if (String(existing.payload) !== canonical(parsed))
        throw new DriError("Profile decision conflict");
      return;
    }
    this.db
      .prepare(
        "INSERT INTO dri_profile_decisions(id,investigation_id,revision,payload) VALUES (?,?,?,?)",
      )
      .run(key, id, parsed.revision, canonical(parsed));
  }
  decisions(id: string): DriProfileDecision[] {
    return this.db
      .prepare(
        "SELECT payload FROM dri_profile_decisions WHERE investigation_id=? ORDER BY revision LIMIT 100",
      )
      .all(id)
      .map((row) => decode<DriProfileDecision>(row as { payload: string }));
  }

  page<K extends DriRecordKind>(
    id: string,
    kind: K,
    input: {
      limit?: number;
      cursor?: number;
      revision?: number | undefined;
      generation?: number | undefined;
    } = {},
  ): DriPage<DriRecordOf<K>> {
    return this.atomic(() => {
      const current = this.require(id);
      const { limit, cursor, revision, generation } = DriPageInputSchema.parse(input);
      if (cursor > 0 && (revision === undefined || generation === undefined))
        throw new DriError(
          "Continuation pages require their first-page revision and generation",
          428,
        );
      if (
        cursor > 0 &&
        (current.revision !== revision || current.generation !== generation)
      )
        throw new DriError("Page revision changed; restart pagination", 412);
      const rows = (kind === "timeline"
        ? this.db
            .prepare(
              "SELECT sequence,payload FROM dri_timeline WHERE investigation_id=? AND head=1 ORDER BY json_extract(payload,'$.at'),sequence LIMIT ? OFFSET ?",
            )
            .all(id, limit + 1, cursor)
        : this.db
            .prepare(
              `SELECT sequence,payload FROM ${tables[kind]} WHERE investigation_id=? AND head=1 AND sequence>? ORDER BY sequence LIMIT ?`,
            )
            .all(id, cursor, limit + 1)) as unknown as Row[];
      return {
        items: rows.slice(0, limit).map((row) => decode<DriRecordOf<K>>(row)),
        nextCursor:
          rows.length > limit
            ? kind === "timeline"
              ? cursor + limit
              : rows[limit - 1]!.sequence
            : null,
        revision: current.revision,
        generation: current.generation,
      };
    });
  }
  all<K extends DriRecordKind>(id: string, kind: K): DriRecordOf<K>[] {
    const bound = this.require(id).limits.maxRecords;
    return this.db
      .prepare(
        `SELECT payload FROM ${tables[kind]} WHERE investigation_id=? AND head=1 ORDER BY sequence LIMIT ?`,
      )
      .all(id, bound)
      .map((row) => decode<DriRecordOf<K>>(row as { payload: string }));
  }
  record<K extends DriRecordKind>(
    id: string,
    kind: K,
    recordId: string,
  ): DriRecordOf<K> | undefined {
    const row = this.db
      .prepare(`SELECT payload FROM ${tables[kind]} WHERE investigation_id=? AND id=?`)
      .get(id, recordId);
    return row ? decode<DriRecordOf<K>>(row as { payload: string }) : undefined;
  }
  head<K extends DriRecordKind>(
    id: string,
    kind: K,
    key: string,
  ): DriRecordOf<K> | undefined {
    const row = this.db
      .prepare(
        `SELECT payload FROM ${tables[kind]} WHERE investigation_id=? AND logical_key=? AND head=1`,
      )
      .get(id, key);
    return row ? decode<DriRecordOf<K>>(row as { payload: string }) : undefined;
  }

  put<T extends DriRecord>(
    input: T,
    logicalKey: string,
    promote = true,
  ): { record: T; changed: boolean } {
    const record = DriRecordSchema.parse(redactRecord(input)) as T;
    return this.atomic(() => {
      const current = this.require(record.investigationId);
      const table = tables[record.kind];
      const digest = contentHash(record);
      const existing = this.db
        .prepare(`SELECT hash FROM ${table} WHERE id=?`)
        .get(record.id);
      if (existing) {
        if (String(existing.hash) !== digest)
          throw new DriError("Immutable record conflict");
        return { record, changed: false };
      }
      if (
        promote &&
        current.generation === record.generation &&
        ["evidence", "reports"].includes(record.kind)
      ) {
        const head = this.head(current.id, record.kind, logicalKey);
        if (head) {
          const semantic = (entry: DriRecord) => {
            const {
              id: _id,
              createdAt: _createdAt,
              generation: _generation,
              attempt: _attempt,
              invocationId: _invocation,
              ...body
            } = entry;
            if (body.kind === "evidence")
              return {
                ...body,
                provenance: { ...body.provenance, collectedAt: "" },
              };
            return body;
          };
          if (
            record.kind === "reports" ||
            canonical(semantic(head)) !== canonical(semantic(record))
          ) {
            throw new DriError(
              "Stable evidence key or immutable report revision conflict",
              409,
            );
          }
          return { record: head as T, changed: false };
        }
      }
      const count = Number(
        this.db
          .prepare(`SELECT COUNT(*) count FROM ${table} WHERE investigation_id=?`)
          .get(current.id)!.count,
      );
      if (
        count >= current.limits.maxRecords ||
        (record.kind === "evidence" && count >= current.limits.maxEvidence)
      ) {
        throw new DriError("Investigation record budget reached", 422);
      }
      const eligible = promote && current.generation === record.generation;
      if (eligible)
        this.db
          .prepare(
            `UPDATE ${table} SET head=0 WHERE investigation_id=? AND logical_key=?`,
          )
          .run(current.id, logicalKey);
      this.db
        .prepare(
          `INSERT INTO ${table}(id,investigation_id,logical_key,generation,attempt,hash,head,payload) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.id,
          current.id,
          logicalKey,
          record.generation,
          record.attempt,
          digest,
          eligible ? 1 : 0,
          canonical(record),
        );
      if (record.kind === "hypotheses") {
        for (const [relation, ids] of [
          ["supports", record.supportingEvidence],
          ["contradicts", record.contradictingEvidence],
        ] as const) {
          for (const evidenceId of ids)
            this.db
              .prepare("INSERT OR IGNORE INTO dri_hypothesis_relations VALUES (?,?,?,?)")
              .run(current.id, record.id, evidenceId, relation);
        }
      }
      this.update(current.id, current.revision, {});
      return { record, changed: true };
    });
  }

  finishQuery(query: DriQuery, accepted: boolean): boolean {
    return this.atomic(() => {
      const old = this.record(query.investigationId, "queries", query.id);
      if (!old) throw new DriError("Invocation receipt missing");
      const identity = (entry: DriQuery) => {
        const {
          state: _state,
          summary: _summary,
          error: _error,
          rows: _rows,
          bytes: _bytes,
          pages: _pages,
          cursor: _cursor,
          endedAt: _end,
          ...rest
        } = entry;
        return rest;
      };
      if (canonical(identity(old)) !== canonical(identity(query)))
        throw new DriError("Invocation identity changed");
      const receiptId = stableId("receipt", [query.id, contentHash(query)]);
      const receipt = this.db
        .prepare("SELECT id FROM dri_invocation_attempts WHERE id=?")
        .get(receiptId);
      if (receipt) return false;
      const current = this.require(query.investigationId);
      if (
        accepted &&
        current.generation === query.generation &&
        resultStates.has(old.state) &&
        !["incomplete", "cancelled"].includes(old.state)
      ) {
        if (canonical(old) === canonical(query)) return false;
        throw new DriError("Conflicting terminal invocation result");
      }
      const eligible =
        accepted && current.generation === query.generation && old.state === "running";
      this.db
        .prepare("INSERT INTO dri_invocation_attempts VALUES (?,?,?,?,?,?,?,?)")
        .run(
          receiptId,
          current.id,
          query.id,
          query.generation,
          query.attempt,
          contentHash(query),
          canonical(query),
          eligible ? 1 : 0,
        );
      if (eligible) {
        const safe = DriRecordSchema.parse(redactRecord(query));
        this.db
          .prepare("UPDATE dri_invocations SET payload=?,hash=? WHERE id=?")
          .run(canonical(safe), contentHash(safe), query.id);
      }
      this.update(current.id, current.revision, {});
      return eligible;
    });
  }

  pause(id: string, cause: DriInvestigation["lifecycleCause"]): DriInvestigation {
    return this.atomic(() => {
      const current = this.require(id);
      // Safety transitions cannot consume the record budget they are stopping.
      for (const work of this.all(id, "work")) {
        if (!["pending", "running"].includes(work.state)) continue;
        const paused = { ...work, state: "stopped" as const };
        this.db
          .prepare("UPDATE dri_work SET payload=?,hash=? WHERE id=? AND head=1")
          .run(canonical(paused), contentHash(paused), work.id);
      }
      for (const query of this.all(id, "queries")) {
        if (query.state === "running")
          this.finishQuery(
            {
              ...query,
              state: "incomplete",
              error: "interrupted",
              summary: "Interrupted; explicit Resume required",
              endedAt: new Date().toISOString(),
            },
            true,
          );
      }
      return this.update(id, this.require(id).revision, {
        generation: Number(
          this.db
            .prepare(
              "UPDATE dri_generation_clock SET value=MAX(value,?)+1 WHERE id=1 RETURNING value",
            )
            .get(current.generation)!.value,
        ),
        status: "stopped",
        lifecycleCause: cause,
        limitation:
          cause === "operator"
            ? "Stopped by operator"
            : "Paused; explicit Resume and provider authorization required",
      });
    });
  }
  invalidateProfileHeads(id: string): void {
    for (const kind of [
      "evidence",
      "hypotheses",
      "similar",
      "changes",
      "reports",
      "work",
      "queries",
      "timeline",
    ] as const) {
      this.db
        .prepare(`UPDATE ${tables[kind]} SET head=0 WHERE investigation_id=?`)
        .run(id);
    }
  }

  export(
    overrides: Partial<DriBackupLimits> = {},
    maxBytes = DRI_BACKUP_MAX_BYTES,
  ): DriBackup {
    const limits = { ...DRI_BACKUP_LIMITS, ...overrides };
    for (const key of Object.keys(limits) as (keyof DriBackupLimits)[]) {
      if (
        !Number.isInteger(limits[key]) ||
        limits[key] < 0 ||
        limits[key] > DRI_BACKUP_LIMITS[key]
      )
        throw new DriError("Invalid backup section budget", 422);
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > DRI_BACKUP_MAX_BYTES)
      throw new DriError("Invalid backup byte budget", 422);
    return this.atomic(() => {
      const count = (table: string) =>
        Number(this.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()!.count);
      const totals: DriBackupCounts = {
        investigations: count("dri_investigations"),
        decisions: count("dri_profile_decisions"),
        records: Object.values(tables).reduce((sum, table) => sum + count(table), 0),
        attempts: count("dri_invocation_attempts"),
        tombstones: count("dri_retention_tombstones"),
      };
      const groups = [
        ...Object.values(tables).map((table) => ({ table, column: "records" })),
        { table: "dri_profile_decisions", column: "decisions" },
        { table: "dri_invocation_attempts", column: "attempts" },
      ];
      const parts = groups.map(
        ({ table, column }) =>
          `SELECT investigation_id,${column === "records" ? "COUNT(*)" : "0"} records,${column === "decisions" ? "COUNT(*)" : "0"} decisions,${column === "attempts" ? "COUNT(*)" : "0"} attempts,
         SUM(length(CAST(${table}.payload AS BLOB))+512) bytes
         FROM ${table} JOIN candidates ON candidates.id=investigation_id GROUP BY investigation_id`,
      );
      const candidates = this.db
        .prepare(
          `
        WITH candidates AS (SELECT id,created_at,length(CAST(payload AS BLOB))+512 bytes FROM dri_investigations ORDER BY created_at,id LIMIT ?),
        parts AS (${parts.join(" UNION ALL ")})
        SELECT c.id,COALESCE(SUM(p.records),0) records,COALESCE(SUM(p.decisions),0) decisions,COALESCE(SUM(p.attempts),0) attempts,c.bytes+COALESCE(SUM(p.bytes),0) bytes
        FROM candidates c LEFT JOIN parts p ON p.investigation_id=c.id GROUP BY c.id ORDER BY c.created_at,c.id
      `,
        )
        .all(limits.investigations + 1) as unknown as BackupCandidate[];
      const { ids, bytes } = selectBackupInvestigations(
        candidates,
        limits,
        Math.max(0, maxBytes - 4096),
      );
      const selected = ids.length ? ids.map(() => "?").join(",") : "NULL";
      const investigations = this.db
        .prepare(
          `SELECT payload FROM dri_investigations WHERE id IN (${selected}) ORDER BY created_at,id LIMIT ?`,
        )
        .all(...ids, limits.investigations)
        .map((row) => decode<DriInvestigation>(row as { payload: string }));
      const decisions = this.db
        .prepare(
          `SELECT investigation_id,payload FROM dri_profile_decisions WHERE investigation_id IN (${selected}) ORDER BY investigation_id,revision LIMIT ?`,
        )
        .all(...ids, limits.decisions)
        .map((row) => ({
          investigationId: String(row.investigation_id),
          decision: decode<DriProfileDecision>(row as { payload: string }),
        }));
      const records: DriBackup["records"] = [];
      for (const table of Object.values(tables)) {
        for (const row of this.db
          .prepare(
            `SELECT payload,hash,head,logical_key FROM ${table} WHERE investigation_id IN (${selected}) ORDER BY sequence LIMIT ?`,
          )
          .all(...ids, limits.records - records.length) as unknown as Row[]) {
          const record = decode<DriRecord>(row);
          if (contentHash(record) !== row.hash)
            throw new DriError("DRI backup source hash mismatch", 422);
          records.push({
            record,
            hash: row.hash,
            head: row.head === 1,
            logicalKey: row.logical_key,
          });
        }
      }
      const attempts = this.db
        .prepare(
          `SELECT id,payload,hash,accepted FROM dri_invocation_attempts WHERE investigation_id IN (${selected}) ORDER BY id LIMIT ?`,
        )
        .all(...ids, limits.attempts)
        .map((row) => ({
          id: String(row.id),
          query: decode<DriQuery>(row as { payload: string }),
          hash: String(row.hash),
          accepted: Number(row.accepted) === 1,
        }));
      for (const receipt of attempts)
        if (contentHash(receipt.query) !== receipt.hash)
          throw new DriError("DRI backup attempt hash mismatch", 422);
      let availableBytes = Math.max(0, maxBytes - bytes - 4096);
      const tombstoneIds: string[] = [];
      for (const row of this.db
        .prepare(
          "SELECT id,length(CAST(payload AS BLOB))+512 bytes FROM dri_retention_tombstones ORDER BY expired_at,id LIMIT ?",
        )
        .all(limits.tombstones)) {
        if (Number(row.bytes) > availableBytes) break;
        availableBytes -= Number(row.bytes);
        tombstoneIds.push(String(row.id));
      }
      const tombstones = this.db
        .prepare(
          `SELECT payload FROM dri_retention_tombstones WHERE id IN (${tombstoneIds.length ? tombstoneIds.map(() => "?").join(",") : "NULL"}) ORDER BY expired_at,id`,
        )
        .all(...tombstoneIds)
        .map((row) =>
          DriRetentionTombstoneSchema.parse(decode(row as { payload: string })),
        );
      const included = {
        investigations: investigations.length,
        decisions: decisions.length,
        records: records.length,
        attempts: attempts.length,
        tombstones: tombstones.length,
      };
      const missingSource =
        Boolean(
          this.db
            .prepare("SELECT 1 FROM settings WHERE key='dri.incompleteBackupSource'")
            .get(),
        ) ||
        Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM runs WHERE dri_id<>'' AND NOT EXISTS (SELECT 1 FROM dri_investigations WHERE id=runs.dri_id) LIMIT 1",
            )
            .get(),
        );
      const limited = (Object.keys(totals) as (keyof DriBackupCounts)[]).some(
        (key) => included[key] < totals[key],
      );
      return DriBackupSchema.parse({
        version: 1,
        investigations,
        decisions,
        records,
        attempts,
        tombstones,
        coverage: {
          state: missingSource || limited ? "limited" : "complete",
          reason: missingSource ? "incomplete_source" : limited ? "capacity" : "none",
          totals: missingSource ? null : totals,
          included,
        },
      });
    });
  }
  restore(input: DriBackup): void {
    const backup = DriBackupSchema.parse(input);
    this.atomic(() => {
      for (const entry of backup.records) {
        if (contentHash(entry.record) !== entry.hash)
          throw new DriError("DRI backup hash mismatch", 400);
        if (canonical(redactRecord(entry.record)) !== canonical(entry.record))
          throw new DriError("DRI backup contains unredacted data", 400);
      }
      for (const receipt of backup.attempts) {
        if (
          contentHash(receipt.query) !== receipt.hash ||
          canonical(redactRecord(receipt.query)) !== canonical(receipt.query)
        )
          throw new DriError("DRI attempt hash or redaction mismatch", 400);
      }
      for (const row of backup.investigations) this.create(row);
      for (const row of backup.decisions)
        this.decision(row.investigationId, row.decision);
      for (const entry of backup.records) {
        const record = entry.record;
        this.require(record.investigationId);
        this.db
          .prepare(
            `INSERT INTO ${tables[record.kind]}(id,investigation_id,logical_key,generation,attempt,hash,head,payload) VALUES (?,?,?,?,?,?,?,?)`,
          )
          .run(
            record.id,
            record.investigationId,
            entry.logicalKey,
            record.generation,
            record.attempt,
            entry.hash,
            entry.head ? 1 : 0,
            canonical(record),
          );
      }
      for (const tombstone of backup.tombstones)
        this.db
          .prepare("INSERT OR IGNORE INTO dri_retention_tombstones VALUES (?,?,?,?)")
          .run(tombstone.id, tombstone.runId, tombstone.expiredAt, canonical(tombstone));
      if (backup.coverage && backup.coverage.state !== "complete") {
        this.db
          .prepare(
            "INSERT INTO settings(key,value) VALUES ('dri.incompleteBackupSource','true') ON CONFLICT(key) DO UPDATE SET value='true'",
          )
          .run();
      } else
        this.db
          .prepare("DELETE FROM settings WHERE key='dri.incompleteBackupSource'")
          .run();
      for (const receipt of backup.attempts) {
        const query = receipt.query;
        this.db
          .prepare("INSERT INTO dri_invocation_attempts VALUES (?,?,?,?,?,?,?,?)")
          .run(
            receipt.id,
            query.investigationId,
            query.id,
            query.generation,
            query.attempt,
            receipt.hash,
            canonical(query),
            receipt.accepted ? 1 : 0,
          );
      }
      for (const row of backup.investigations) {
        this.pause(row.id, "restore");
        this.db
          .prepare(
            "UPDATE runs SET state='cancelled',failure_reason='DRI paused after restore' WHERE id=?",
          )
          .run(row.runId);
        this.db
          .prepare(
            "UPDATE run_steps SET state='cancelled',stopped_by_orchestrator=1 WHERE run_id=? AND state IN ('pending','running','starting')",
          )
          .run(row.runId);
      }
    });
  }

  /** Deletes only whole expired investigations, preserving report citations until the longest retention expires. */
  cleanup(now = Date.now(), batch = 20): number {
    const size = Math.max(1, Math.min(100, Math.floor(batch)));
    return this.atomic(() => {
      const rows = this.db
        .prepare(
          "SELECT rowid sequence,id,payload FROM dri_investigations WHERE rowid>? ORDER BY rowid LIMIT ?",
        )
        .all(this.cleanupCursor, size);
      this.cleanupCursor = rows.length === size ? Number(rows.at(-1)!.sequence) : 0;
      let deleted = 0;
      for (const row of rows) {
        const investigation = decode<DriInvestigation>(row as { payload: string });
        const days = Math.max(
          investigation.limits.rawRetentionDays,
          investigation.limits.reportRetentionDays,
          investigation.limits.evidenceRetentionDays,
        );
        if (
          [
            "draft",
            "blocked",
            "partial",
            "awaiting_review",
            "completed",
            "failed",
            "stopped",
          ].includes(investigation.status) &&
          !investigation.legalHold &&
          now -
            Math.max(
              Date.parse(investigation.createdAt),
              Date.parse(investigation.updatedAt),
            ) >
            days * 86_400_000 &&
          !this.db
            .prepare(
              "SELECT 1 FROM dri_invocations WHERE investigation_id=? AND generation=? AND head=1 AND json_extract(payload,'$.state')='running' LIMIT 1",
            )
            .get(investigation.id, investigation.generation) &&
          !this.db
            .prepare(
              "SELECT 1 FROM dri_work WHERE investigation_id=? AND generation=? AND head=1 AND json_extract(payload,'$.state')='running' LIMIT 1",
            )
            .get(investigation.id, investigation.generation) &&
          !this.db
            .prepare(
              "SELECT 1 FROM dri_artifacts WHERE investigation_id=? AND julianday(json_extract(payload,'$.expiresAt'))>julianday(?) LIMIT 1",
            )
            .get(investigation.id, new Date(now).toISOString())
        ) {
          const tombstone = DriRetentionTombstoneSchema.parse({
            id: stableId("retention", [investigation.id, investigation.generation]),
            investigationId: investigation.id,
            runId: investigation.runId,
            generation: investigation.generation,
            expiredAt: new Date(now).toISOString(),
            reason: "retention_expired",
          });
          this.db
            .prepare("INSERT INTO dri_retention_tombstones VALUES (?,?,?,?)")
            .run(
              tombstone.id,
              investigation.runId,
              tombstone.expiredAt,
              canonical(tombstone),
            );
          this.db
            .prepare(
              "UPDATE runs SET dri_id='',state='cancelled',failure_reason='DRI retention expired' WHERE id=?",
            )
            .run(investigation.runId);
          this.db
            .prepare("DELETE FROM dri_investigations WHERE id=?")
            .run(investigation.id);
          deleted++;
        }
      }
      return deleted;
    });
  }
  tombstones(runId: string) {
    return this.db
      .prepare(
        "SELECT payload FROM dri_retention_tombstones WHERE run_id=? ORDER BY expired_at,id LIMIT 50",
      )
      .all(runId)
      .map((row) =>
        DriRetentionTombstoneSchema.parse(decode(row as { payload: string })),
      );
  }
  completed(query: DriQuery | undefined): boolean {
    return Boolean(
      query &&
      resultStates.has(query.state) &&
      ["succeeded", "no_results", "truncated"].includes(query.state),
    );
  }
}
