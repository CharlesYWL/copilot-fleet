import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  LEGACY_CREDIT_BACKFILL_SOURCE,
  SessionAccountingSchema,
  terminalSessionStates,
  type SessionState,
  type UsageBackfillPreview,
  type UsageBackfillResult,
  type UsageStreamMetadata,
} from "@fleet/protocol";
import type { UsageStore } from "./usage-store.js";

type LegacySession = {
  metadata: UsageStreamMetadata;
  nativeSessionId: string;
  state: SessionState;
  aiCredits: number | null | undefined;
  accountingNativeSessionId?: string | undefined;
};
type Candidate = {
  metadata: UsageStreamMetadata;
  nativeSessionId: string;
  aiCredits: number;
  sessions: number;
};
type Plan = { preview: UsageBackfillPreview; candidates: Candidate[] };
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeKey = (nodeId: string, native: string): string =>
  JSON.stringify([nodeId, native]);

export class UsageBackfillConflict extends Error {
  readonly statusCode = 409;
  constructor() {
    super("The backfill preview changed. Preview again before importing credits.");
  }
}

/** Imports saved counters only. No agents, provider calls, or transcript replay. */
export class UsageBackfillStore {
  constructor(
    private readonly options: {
      db: DatabaseSync;
      usage: UsageStore;
      sessions: () => LegacySession[];
      transaction: <T>(work: () => T) => T;
      backup: () => string | null;
    },
  ) {}

  preview(): UsageBackfillPreview {
    return this.plan().preview;
  }

  apply(previewId: string): UsageBackfillResult {
    const plan = this.plan();
    if (plan.preview.previewId !== previewId) throw new UsageBackfillConflict();
    if (!plan.candidates.length)
      return { importedConversations: 0, aiCredits: 0, backupFile: null };
    // VACUUM INTO cannot run inside a transaction. A second plan check under the
    // write lock catches any external change while the consistent backup ran.
    const backupFile = this.options.backup();
    return this.options.transaction(() => {
      const current = this.plan();
      if (current.preview.previewId !== previewId) throw new UsageBackfillConflict();
      const observedAt = new Date().toISOString();
      for (const candidate of current.candidates) {
        this.options.usage.ingest(candidate.metadata.nodeId, [
          {
            id: `${LEGACY_CREDIT_BACKFILL_SOURCE}:${digest([candidate.metadata.nodeId, candidate.nativeSessionId])}`,
            sequence: 1,
            sessionId: candidate.metadata.sessionId,
            accounting: {
              nativeSessionId: candidate.nativeSessionId,
              counterId: candidate.nativeSessionId,
              source: LEGACY_CREDIT_BACKFILL_SOURCE,
              observedAt,
              baseline: true,
              aiCredits: candidate.aiCredits,
            },
          },
        ]);
      }
      return {
        importedConversations: current.candidates.length,
        aiCredits: current.preview.aiCredits,
        backupFile,
      };
    });
  }

  private plan(): Plan {
    const skipped: UsageBackfillPreview["skipped"] = {
      active: 0,
      otherBackend: 0,
      missingIdentity: 0,
      missingCredits: 0,
      conflicting: 0,
      alreadyRecorded: 0,
    };
    const recorded = new Set<string>();
    const readings = this.options.db
      .prepare(
        "SELECT DISTINCT u.node_id,json_extract(u.data,'$.accounting.nativeSessionId') AS native_id FROM usage_snapshots u JOIN usage_streams s ON s.node_id=u.node_id AND s.session_id=u.session_id WHERE json_extract(s.data,'$.backend')='copilot' AND json_type(u.data,'$.accounting.aiCredits') IN ('integer','real')",
      )
      .iterate();
    for (const row of readings)
      recorded.add(scopeKey(String(row.node_id), String(row.native_id)));
    const groups = new Map<string, LegacySession[]>();
    for (const session of this.options.sessions()) {
      if (session.metadata.backend !== "copilot") {
        skipped.otherBackend++;
        continue;
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.nativeSessionId)) {
        skipped.missingIdentity++;
        continue;
      }
      const key = scopeKey(session.metadata.nodeId, session.nativeSessionId);
      const group = groups.get(key) ?? [];
      group.push(session);
      groups.set(key, group);
    }
    const candidates: Candidate[] = [];
    for (const [key, group] of groups) {
      if (recorded.has(key)) {
        skipped.alreadyRecorded += group.length;
        continue;
      }
      if (group.some((session) => !terminalSessionStates.has(session.state))) {
        skipped.active += group.length;
        continue;
      }
      if (
        group.some(
          (session) =>
            session.accountingNativeSessionId &&
            session.accountingNativeSessionId !== session.nativeSessionId,
        )
      ) {
        skipped.conflicting += group.length;
        continue;
      }
      if (
        group.some(
          (session) =>
            !SessionAccountingSchema.shape.aiCredits.safeParse(session.aiCredits)
              .success || session.aiCredits == null,
        )
      ) {
        skipped.missingCredits += group.length;
        continue;
      }
      const signatures = new Set(
        group.map((session) =>
          JSON.stringify([
            Math.round(session.aiCredits! * 1e9),
            session.metadata.taskId,
            session.metadata.role,
          ]),
        ),
      );
      if (signatures.size !== 1) {
        skipped.conflicting += group.length;
        continue;
      }
      const selected = group.sort((a, b) =>
        a.metadata.sessionId.localeCompare(b.metadata.sessionId),
      )[0]!;
      candidates.push({
        metadata: selected.metadata,
        nativeSessionId: selected.nativeSessionId,
        aiCredits: Math.round(selected.aiCredits! * 1e9) / 1e9,
        sessions: group.length,
      });
    }
    candidates.sort((a, b) =>
      scopeKey(a.metadata.nodeId, a.nativeSessionId).localeCompare(
        scopeKey(b.metadata.nodeId, b.nativeSessionId),
      ),
    );
    const nanoCredits = candidates.reduce(
      (sum, candidate) => sum + Math.round(candidate.aiCredits * 1e9),
      0,
    );
    if (!Number.isSafeInteger(nanoCredits))
      throw new Error("Saved credit totals exceed the safe accounting limit.");
    const summary = {
      eligibleConversations: candidates.length,
      eligibleSessions: candidates.reduce(
        (sum, candidate) => sum + candidate.sessions,
        0,
      ),
      aiCredits: nanoCredits / 1e9,
      skipped,
    };
    return {
      preview: { ...summary, previewId: digest({ summary, candidates }) },
      candidates,
    };
  }
}
