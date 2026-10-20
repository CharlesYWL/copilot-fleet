import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import {
  UsageBackupSchema,
  UsageReportQuerySchema,
  UsageSnapshotSchema,
  UsageStreamMetadataSchema,
  usageAmountKeys,
  type UsageAmountKey,
  type UsageAmounts,
  type UsageBackup,
  type UsageReport,
  type UsageReportRow,
  type UsageSnapshot,
  type UsageStreamMetadata,
} from "@fleet/protocol";

type Transaction = <T>(work: () => T) => T;
const emptyAmounts = (): UsageAmounts =>
  Object.fromEntries(usageAmountKeys.map((key) => [key, null])) as UsageAmounts;
const units = (key: UsageAmountKey, value: number): number =>
  key === "aiCredits" ? Math.round(value * 1e9) : value;
const quantity = (key: UsageAmountKey, value: number): number =>
  key === "aiCredits" ? value / 1e9 : value;
const add = (amounts: UsageAmounts, key: UsageAmountKey, value: number): void => {
  amounts[key] = quantity(key, units(key, amounts[key] ?? 0) + units(key, value));
};
const metadataKey = (nodeId: string, sessionId: string): string =>
  JSON.stringify([nodeId, sessionId]);

/** Metadata-only accounting: these tables deliberately have no cascading session foreign key. */
export class UsageStore {
  private readonly transaction: Transaction;
  constructor(
    private readonly db: DatabaseSync,
    private readonly resolve: (
      nodeId: string,
      sessionId: string,
    ) => UsageStreamMetadata | undefined,
    transaction?: Transaction,
    private readonly currentSessions: () => UsageStreamMetadata[] = () => [],
  ) {
    this.transaction =
      transaction ??
      ((work) => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const result = work();
          this.db.exec("COMMIT");
          return result;
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      });
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_streams (
        node_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(node_id,session_id)
      );
      CREATE TABLE IF NOT EXISTS usage_snapshots (
        node_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL,
        session_id TEXT NOT NULL, observed_at TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(node_id,id), UNIQUE(node_id,sequence)
      );
      CREATE INDEX IF NOT EXISTS usage_snapshots_session ON usage_snapshots(node_id,session_id,sequence);
      CREATE INDEX IF NOT EXISTS usage_snapshots_time ON usage_snapshots(observed_at);
      CREATE INDEX IF NOT EXISTS usage_snapshots_chronological ON usage_snapshots(node_id,observed_at,sequence);
    `);
  }

  retain(input: UsageStreamMetadata): void {
    const metadata = UsageStreamMetadataSchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO usage_streams VALUES (?,?,?) ON CONFLICT(node_id,session_id) DO UPDATE SET data=excluded.data",
      )
      .run(metadata.nodeId, metadata.sessionId, JSON.stringify(metadata));
  }

  ingest(nodeId: string, snapshots: readonly UsageSnapshot[]): number {
    return this.transaction(() => {
      let through = 0;
      for (const input of snapshots) {
        const snapshot = UsageSnapshotSchema.parse(input);
        const duplicate = this.db
          .prepare("SELECT data FROM usage_snapshots WHERE node_id=? AND id=?")
          .get(nodeId, snapshot.id);
        if (duplicate) {
          if (!isDeepStrictEqual(JSON.parse(String(duplicate.data)), snapshot))
            throw new Error("Usage snapshot identity conflict");
          through = Math.max(through, snapshot.sequence);
          continue;
        }
        const retained = this.db
          .prepare("SELECT data FROM usage_streams WHERE node_id=? AND session_id=?")
          .get(nodeId, snapshot.sessionId);
        if (
          !retained &&
          this.db
            .prepare("SELECT 1 FROM usage_streams WHERE session_id=? AND node_id<>?")
            .get(snapshot.sessionId, nodeId)
        )
          throw new Error("Usage session ownership mismatch");
        const current = this.resolve(nodeId, snapshot.sessionId);
        const metadata =
          current ??
          (retained
            ? UsageStreamMetadataSchema.parse(JSON.parse(String(retained.data)))
            : undefined);
        // Expired sessions with no retained accounting cannot block a Node's entire pending queue.
        if (!metadata) {
          through = Math.max(through, snapshot.sequence);
          continue;
        }
        if (metadata.nodeId !== nodeId || metadata.sessionId !== snapshot.sessionId)
          throw new Error("Usage session ownership mismatch");
        this.retain(metadata);
        this.insertSnapshot(nodeId, snapshot);
        through = Math.max(through, snapshot.sequence);
      }
      return through;
    });
  }

  private insertSnapshot(nodeId: string, snapshot: UsageSnapshot): void {
    // Delivery sequences belong to a Node journal, which can be replaced on
    // identity restore. UUIDs deduplicate delivery; commit order is Host-owned.
    const commitSequence =
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence),0) AS sequence FROM usage_snapshots WHERE node_id=?",
          )
          .get(nodeId)!.sequence,
      ) + 1;
    this.db
      .prepare("INSERT INTO usage_snapshots VALUES (?,?,?,?,?,?)")
      .run(
        nodeId,
        snapshot.id,
        commitSequence,
        snapshot.sessionId,
        new Date(snapshot.accounting.observedAt).toISOString(),
        JSON.stringify(snapshot),
      );
  }

  exportBackup(): UsageBackup {
    return {
      streams: this.db
        .prepare("SELECT data FROM usage_streams ORDER BY node_id,session_id")
        .all()
        .map((row) => UsageStreamMetadataSchema.parse(JSON.parse(String(row.data)))),
      snapshots: this.db
        .prepare("SELECT node_id,data FROM usage_snapshots ORDER BY node_id,sequence")
        .all()
        .map((row) => ({
          nodeId: String(row.node_id),
          snapshot: UsageSnapshotSchema.parse(JSON.parse(String(row.data))),
        })),
    };
  }

  importBackup(input: UsageBackup | undefined): void {
    if (!input) return;
    const backup = UsageBackupSchema.parse(input);
    const metadata = new Set(
      backup.streams.map((stream) => metadataKey(stream.nodeId, stream.sessionId)),
    );
    for (const row of backup.snapshots) {
      if (!metadata.has(metadataKey(row.nodeId, row.snapshot.sessionId)))
        throw new Error("Usage backup snapshot has no session metadata");
    }
    this.db.exec("DELETE FROM usage_snapshots; DELETE FROM usage_streams;");
    for (const stream of backup.streams)
      this.db
        .prepare("INSERT INTO usage_streams VALUES (?,?,?)")
        .run(stream.nodeId, stream.sessionId, JSON.stringify(stream));
    for (const row of backup.snapshots) this.insertSnapshot(row.nodeId, row.snapshot);
  }

  report(input: unknown): UsageReport {
    const query = UsageReportQuerySchema.parse(input);
    const from = query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY;
    const to = query.to ? Date.parse(query.to) : Number.POSITIVE_INFINITY;
    const allTime = !query.from && !query.to;
    const retained = this.db
      .prepare("SELECT data FROM usage_streams")
      .all()
      .map((row) => UsageStreamMetadataSchema.parse(JSON.parse(String(row.data))));
    const allMetadata = new Map(
      retained.map((metadata) => [
        metadataKey(metadata.nodeId, metadata.sessionId),
        metadata,
      ]),
    );
    for (const metadata of this.currentSessions())
      allMetadata.set(metadataKey(metadata.nodeId, metadata.sessionId), metadata);
    const metadata = new Map(
      [...allMetadata].filter(
        ([, value]) =>
          (!query.nodeId || value.nodeId === query.nodeId) &&
          (!query.taskId || value.taskId === query.taskId) &&
          (!query.backend || value.backend === query.backend) &&
          (!query.role || value.role === query.role),
      ),
    );
    // Stream history: all-time reporting must not materialize every snapshot in memory.
    const snapshots =
      metadata.size === 0
        ? []
        : this.db
            .prepare(
              "SELECT node_id,session_id,data FROM usage_snapshots ORDER BY node_id,observed_at,sequence",
            )
            .iterate();
    const totals = emptyAmounts();
    const rows = new Map<string, UsageReportRow>();
    const rowSessions = new Map<string, Set<string>>();
    const creditSessions = new Set<string>();
    const tokenSessions = new Set<string>();
    const previous = new Map<string, { value: number; at: number }>();
    const origins = new Map<string, { baseline: boolean; at: number }>();
    const coverage: UsageReport["coverage"] = {
      sessions: metadata.size,
      creditSessions: 0,
      tokenSessions: 0,
      openingAiCredits: 0,
      openingTokens: 0,
      unallocatedAiCredits: 0,
      unallocatedTokens: 0,
      regressions: 0,
      lastReportedAt: null,
    };
    const dayFormat = new Intl.DateTimeFormat("en-CA", {
      timeZone: query.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const day = (at: number): string => {
      const parts = dayFormat.formatToParts(at);
      return ["year", "month", "day"]
        .map((part) => parts.find((item) => item.type === part)?.value ?? "")
        .join("-");
    };
    const record = (
      owner: UsageStreamMetadata,
      key: UsageAmountKey,
      value: number,
      at: number,
      start: number,
      opening: boolean,
    ): void => {
      let rowKey: string;
      let label: string;
      if (query.groupBy === "machine") {
        rowKey = owner.nodeId;
        label = owner.nodeName;
      } else if (query.groupBy === "session") {
        rowKey = metadataKey(owner.nodeId, owner.sessionId);
        label = owner.sessionName;
      } else if (query.groupBy === "task") {
        rowKey = owner.taskId;
        label = owner.taskName;
      } else if (opening) {
        rowKey = "__opening__";
        label = "Opening balances · date unknown";
      } else if (day(start) !== day(at)) {
        rowKey = "__unallocated_time__";
        label = "Intervals spanning multiple days";
      } else {
        rowKey = day(at);
        label = rowKey;
      }
      let row = rows.get(rowKey);
      if (!row) {
        row = {
          key: rowKey,
          label,
          sessions: 0,
          ...emptyAmounts(),
          ...(query.groupBy === "session"
            ? { backend: owner.backend, role: owner.role }
            : {}),
        };
        rows.set(rowKey, row);
      }
      add(row, key, value);
      const set = rowSessions.get(rowKey) ?? new Set<string>();
      set.add(metadataKey(owner.nodeId, owner.sessionId));
      rowSessions.set(rowKey, set);
      row.sessions = set.size;
    };
    for (const stored of snapshots) {
      const nodeId = String(stored.node_id);
      const sessionKey = metadataKey(nodeId, String(stored.session_id));
      const owner = allMetadata.get(sessionKey);
      if (!owner) continue;
      const selected = metadata.has(sessionKey);
      const snapshot = UsageSnapshotSchema.parse(JSON.parse(String(stored.data)));
      const sample = snapshot.accounting;
      const at = Date.parse(sample.observedAt);
      const scope = JSON.stringify([nodeId, owner.backend, sample.counterId]);
      const origin = origins.get(scope) ?? {
        baseline: sample.baseline === true,
        at:
          sample.baseline !== true && sample.startedAt
            ? Math.min(at, Date.parse(sample.startedAt))
            : at,
      };
      origins.set(scope, origin);
      if (
        selected &&
        (!coverage.lastReportedAt || at > Date.parse(coverage.lastReportedAt))
      )
        coverage.lastReportedAt = sample.observedAt;
      let regressed = false;
      for (const key of usageAmountKeys) {
        const reading = sample[key];
        if (reading === undefined || (owner.backend === "hermes" && key === "aiCredits"))
          continue;
        const value = units(key, reading);
        const stream = JSON.stringify([nodeId, owner.backend, sample.counterId, key]);
        const before = previous.get(stream);
        if (before && (value < before.value || at < before.at)) {
          regressed = true;
          continue;
        }
        previous.set(stream, { value, at });
        if (!selected) continue;
        if (at < to) {
          if (key === "aiCredits") creditSessions.add(sessionKey);
          if (key === "totalTokens") tokenSessions.add(sessionKey);
          totals[key] ??= 0;
        }
        const opening = !before && (origin.baseline || sample.baseline === true);
        const delta = quantity(key, value - (before?.value ?? 0));
        const start = before?.at ?? origin.at;
        if (opening) {
          if (key === "aiCredits") coverage.openingAiCredits += delta;
          if (key === "totalTokens") coverage.openingTokens += delta;
          if (!allTime) continue;
        }
        const inside = at >= from && at < to && start >= from;
        if (opening || inside) {
          add(totals, key, delta);
          record(owner, key, delta, at, start, opening);
        } else if (delta > 0 && at >= from && start < to) {
          if (key === "aiCredits") coverage.unallocatedAiCredits += delta;
          if (key === "totalTokens") coverage.unallocatedTokens += delta;
        }
      }
      if (selected && regressed) coverage.regressions++;
    }
    coverage.creditSessions = creditSessions.size;
    coverage.tokenSessions = tokenSessions.size;
    const machines = new Map<string, string>();
    const tasks = new Map<string, string>();
    for (const owner of allMetadata.values()) {
      machines.set(owner.nodeId, owner.nodeName);
      tasks.set(owner.taskId, owner.taskName);
    }
    return {
      totals,
      rows: [...rows.values()].sort((a, b) =>
        query.groupBy === "day"
          ? a.key.localeCompare(b.key)
          : (b.totalTokens ?? 0) - (a.totalTokens ?? 0),
      ),
      coverage,
      machines: [...machines]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      tasks: [...tasks]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      generatedAt: new Date().toISOString(),
    };
  }
}
