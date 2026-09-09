import { DatabaseSync } from "node:sqlite";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRI_BACKUP_LIMITS,
  DriBackupSchema,
  DriInvestigationSchema,
  DriLimitsSchema,
  DriQuerySchema,
  type DriInvestigation,
  type DriRecord,
} from "@fleet/protocol";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { purgeRun } from "../orchestrator/lifecycle.js";
import { DriCoordinator } from "./coordinator.js";
import { DriStore } from "./store.js";
import { selectBackupInvestigations } from "./backup.js";
import { canonical, contentHash } from "./safety.js";

const ISO = "2025-01-01T00:00:00.000Z";
const epoch = Date.parse(ISO);
const day = 86_400_000;
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});
function investigation(
  id: string,
  patch: Partial<DriInvestigation> = {},
): DriInvestigation {
  return DriInvestigationSchema.parse({
    id,
    version: 1,
    revision: 0,
    generation: 1,
    runId: `run-${id}`,
    leadSessionId: "",
    incident: {
      id: "42",
      url: "https://portal.microsofticm.com/imp/v5/incidents/details/42",
    },
    requestedProfile: "generic",
    profile: {
      id: "generic-decision",
      profileId: "generic",
      profileVersion: "1.0.0",
      method: "explicit",
      confidence: 1,
      evidenceIds: [],
      explanation: "Synthetic",
      revision: 0,
      decidedAt: ISO,
    },
    mode: "fixture",
    phase: "intake",
    status: "draft",
    limits: DriLimitsSchema.parse({
      rawRetentionDays: 1,
      evidenceRetentionDays: 1,
      reportRetentionDays: 1,
    }),
    question: "",
    hints: [],
    createdAt: ISO,
    updatedAt: ISO,
    lifecycleCause: "created",
    limitation: "",
    ...patch,
  });
}
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE runs (id TEXT PRIMARY KEY,dri_id TEXT NOT NULL DEFAULT '',state TEXT DEFAULT 'running',failure_reason TEXT DEFAULT '');
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const dri = new DriStore(db, (work) => work());
  disposals.push(() => db.close());
  const add = (id: string, patch: Partial<DriInvestigation> = {}) => {
    const item = investigation(id, patch);
    db.prepare("INSERT INTO runs(id) VALUES (?)").run(item.runId);
    return dri.create(item);
  };
  return { db, dri, add };
}
function audit(item: DriInvestigation, id: string): DriRecord {
  return {
    id,
    investigationId: item.id,
    profileId: "generic",
    generation: 1,
    attempt: 1,
    invocationId: "domain",
    createdAt: ISO,
    kind: "audit",
    event: "policy",
    decision: "allow",
    reason: "Synthetic",
  };
}
function runningQuery(item: DriInvestigation) {
  return DriQuerySchema.parse({
    ...audit(item, "query"),
    kind: "queries",
    key: "query-key",
    stepId: "step",
    agentId: "agent",
    providerId: "fixture.incident.read",
    capability: "incident.read",
    purpose: "Synthetic",
    template: "incident.read.v1",
    parameters: [],
    privateParameterNames: [],
    parameterHash: "a".repeat(64),
    bounds: item.limits,
    timeRange: { start: ISO, end: ISO },
    state: "running",
    summary: "",
    error: "none",
    rows: 0,
    bytes: 0,
    pages: 0,
    cursor: "",
    startedAt: ISO,
  });
}
describe("bounded, explicit DRI backup sections", () => {
  it("exports exactly 2000 investigations and explicitly limits 2001 without breaking schema", () => {
    const { db, dri, add } = database();
    db.exec("BEGIN");
    for (let i = 0; i < 2_000; i++) add(`i-${String(i).padStart(4, "0")}`);
    db.exec("COMMIT");
    const exact = dri.export();
    expect(exact.investigations).toHaveLength(2_000);
    expect(exact.decisions).toHaveLength(2_000);
    expect(exact.coverage?.state).toBe("complete");
    add("i-2000");
    const limited = dri.export();
    expect(limited.investigations).toHaveLength(2_000);
    expect(limited.coverage).toMatchObject({
      state: "limited",
      reason: "capacity",
      totals: { investigations: 2_001, decisions: 2_001 },
      included: { investigations: 2_000, decisions: 2_000 },
    });
    expect(DriBackupSchema.safeParse(limited).success).toBe(true);
    const known = new Set(limited.investigations.map((item) => item.id));
    expect(limited.decisions.every((item) => known.has(item.investigationId))).toBe(true);
  }, 20_000);
  it.each(["records", "attempts"] as const)(
    "handles the exact 100000/100001 %s boundary without materializing oversized sections",
    (kind) => {
      expect(DRI_BACKUP_LIMITS[kind]).toBe(100_000);
      const candidate = {
        id: "one",
        decisions: 1,
        records: 0,
        attempts: 0,
        [kind]: 100_000,
      };
      expect(selectBackupInvestigations([candidate]).ids).toEqual(["one"]);
      expect(selectBackupInvestigations([{ ...candidate, [kind]: 100_001 }]).ids).toEqual(
        [],
      );
    },
  );
  it("materializes whole investigations at the same record boundary algorithm with a small budget", () => {
    const { dri, add } = database();
    const item = add("one");
    dri.put(audit(item, "a1"), "a1");
    dri.put(audit(item, "a2"), "a2");
    expect(dri.export({ records: 2 }).coverage?.state).toBe("complete");
    dri.put(audit(item, "a3"), "a3");
    const backup = dri.export({ records: 2 });
    expect(backup.records).toEqual([]);
    expect(backup.investigations).toEqual([]);
    expect(backup.decisions).toEqual([]);
    expect(backup.coverage).toMatchObject({
      state: "limited",
      totals: { records: 3 },
      included: { records: 0 },
    });
  });
  it("bounds attempts independently without severing invocation receipts", () => {
    const { db, dri, add } = database();
    const item = add("one");
    const query = runningQuery(item);
    dri.put(query, query.key);
    const insert = (id: string) =>
      db
        .prepare("INSERT INTO dri_invocation_attempts VALUES (?,?,?,?,?,?,?,?)")
        .run(id, item.id, query.id, 1, 1, contentHash(query), canonical(query), 1);
    insert("one");
    insert("two");
    expect(dri.export({ attempts: 2 }).attempts).toHaveLength(2);
    insert("three");
    const limited = dri.export({ attempts: 2 });
    expect(limited.attempts).toEqual([]);
    expect(limited.records).toEqual([]);
    expect(limited.coverage?.state).toBe("limited");
  });
  it("scopes identical profile decisions to their investigation", () => {
    const { dri, add } = database();
    add("first");
    add("second");
    expect(dri.decisions("first")).toHaveLength(1);
    expect(dri.decisions("second")).toHaveLength(1);
    expect(dri.export().decisions).toHaveLength(2);
  });
  it("bounds encoded size as well as counts and reports metadata omissions", () => {
    const { dri, add } = database();
    add("one");
    const limited = dri.export({}, 4096);
    expect(limited.investigations).toEqual([]);
    expect(limited.coverage?.state).toBe("limited");
    expect(dri.export({ decisions: 0 }).coverage?.state).toBe("limited");
  });
});

describe("age-gated retention and durable deletion receipts", () => {
  it.each([
    "draft",
    "blocked",
    "partial",
    "awaiting_review",
    "completed",
    "failed",
    "stopped",
  ] as const)("expires inactive %s after policy, with a tombstone", (status) => {
    const { dri, add, db } = database();
    const item = add("one", { status });
    expect(dri.cleanup(epoch + day)).toBe(0);
    expect(dri.cleanup(epoch + 2 * day)).toBe(1);
    expect(dri.get(item.id)).toBeUndefined();
    expect(dri.tombstones(item.runId)).toMatchObject([
      { reason: "retention_expired", investigationId: item.id },
    ]);
    db.prepare("DELETE FROM runs WHERE id=?").run(item.runId);
    expect(dri.tombstones(item.runId)).toHaveLength(1);
  });
  it.each(["intake", "collect", "analyze", "validate", "report"] as const)(
    "never removes the active %s phase",
    (status) => {
      const { dri, add } = database();
      const item = add("one", { status });
      expect(dri.cleanup(epoch + 5_000 * day)).toBe(0);
      expect(dri.get(item.id)).toBeDefined();
    },
  );
  it("honors legal hold and the longest raw/evidence/report retention", () => {
    const { dri, add } = database();
    add("held", { status: "completed", legalHold: true });
    add("raw", {
      limits: DriLimitsSchema.parse({
        rawRetentionDays: 7,
        evidenceRetentionDays: 1,
        reportRetentionDays: 1,
      }),
    });
    add("report", {
      limits: DriLimitsSchema.parse({
        rawRetentionDays: 1,
        evidenceRetentionDays: 2,
        reportRetentionDays: 10,
      }),
    });
    add("evidence", {
      limits: DriLimitsSchema.parse({
        rawRetentionDays: 1,
        evidenceRetentionDays: 10,
        reportRetentionDays: 2,
      }),
    });
    expect(dri.cleanup(epoch + 6 * day)).toBe(0);
    expect(dri.cleanup(epoch + 8 * day)).toBe(1);
    expect(dri.cleanup(epoch + 11 * day)).toBe(2);
    expect(dri.get("held")?.legalHold).toBe(true);
  });
  it("does not expire an inactive label while a current invocation is still running", () => {
    const { db, dri, add } = database();
    const item = add("one", { status: "partial" });
    const query = runningQuery(item);
    dri.put(query, query.key);
    db.prepare("UPDATE dri_investigations SET payload=? WHERE id=?").run(
      canonical(item),
      item.id,
    );
    expect(dri.cleanup(epoch + 5_000 * day)).toBe(0);
  });
  it("updates activity time on result writes, and scans past active rows in bounded batches", () => {
    const { dri, add } = database();
    add("active", { status: "collect" });
    const recent = add("recent");
    dri.put(audit(recent, "receipt"), "receipt");
    expect(Date.parse(dri.require(recent.id).updatedAt)).toBeGreaterThan(epoch);
    add("old");
    expect(dri.cleanup(epoch + 2 * day, 1)).toBe(0);
    expect(dri.cleanup(epoch + 2 * day, 1)).toBe(0);
    expect(dri.cleanup(epoch + 2 * day, 1)).toBe(1);
  });
});

describe("Host backup resilience and Run purge fences", () => {
  function host() {
    const store = new FleetStore(":memory:");
    const service = new FleetService(store, {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as unknown as FastifyBaseLogger);
    const coordinator = new DriCoordinator(service, { allowFixtures: true });
    disposals.push(() => {
      service.shutdown();
      store.close();
    });
    return { store, service, coordinator };
  }
  it("returns degraded DRI coverage on exporter failure without dropping ordinary Host data", () => {
    const { store, coordinator } = host();
    const item = coordinator.create({ icm: "42", mode: "fixture" });
    vi.spyOn(store.dri, "export").mockImplementation(() => {
      throw new Error("private-provider-error");
    });
    const backup = store.exportHostBackup({ enrollmentToken: "" });
    expect(backup.workspaces.length).toBeGreaterThan(0);
    expect(backup.dri?.coverage).toMatchObject({
      state: "degraded",
      reason: "export_failed",
      totals: null,
    });
    expect(backup.runs.find((run) => run.id === item.runId)?.investigationId).toBe(
      item.id,
    );
    expect(JSON.stringify(backup)).not.toContain("private-provider-error");
    const restored = host();
    restored.store.replaceHostBackup(backup);
    const run = restored.store.getRun(item.runId)!;
    expect(run.state).toBe("cancelled");
    expect(run.investigationId).toBe(item.id);
    new OrchestratorEngine(restored.service).tickRun(run.id);
    expect(restored.store.listSessions()).toEqual([]);
    expect(() => restored.store.deleteRun(run.id)).toThrow(/retained/);
    expect(
      restored.store.exportHostBackup({ enrollmentToken: "" }).dri?.coverage?.state,
    ).toBe("limited");
  });
  it("keeps omitted DRI Runs and their sessions paused after a limited restore", () => {
    const source = host(),
      target = host();
    const item = source.coordinator.create({ icm: "42", mode: "fixture" });
    const { node } = source.store.registerNode({
      name: "synthetic-node",
      os: "win32",
      arch: "x64",
      version: "1",
      capabilities: [],
      maxSessions: 1,
    });
    const workspace = source.store.createWorkspace("synthetic-session", "");
    const placement = source.store.createPlacement(
      workspace.id,
      node.id,
      "C:\\synthetic",
    );
    const session = source.store.createSession(placement, "synthetic", false, "", {
      runId: item.runId,
      runRole: "worker",
    });
    const backup = source.store.exportHostBackup({ enrollmentToken: "" });
    backup.dri = source.store.dri.export({ records: 0 });
    expect(backup.dri.coverage?.state).toBe("limited");
    target.store.replaceHostBackup(backup);
    expect(target.store.getRun(item.runId)?.state).toBe("cancelled");
    expect(target.store.getSession(session.id)?.stopRequested).toBe(true);
    expect(
      target.store.listRunSteps(item.runId).every((step) => step.state === "cancelled"),
    ).toBe(true);
    expect(target.store.dri.get(item.id)).toBeUndefined();
    expect(() => target.store.deleteRun(item.runId)).toThrow(/retained/);
  });
  it.each(["intake", "awaiting_review", "completed", "stopped"] as const)(
    "rejects generic purge of retained %s Runs before any lifecycle side effect",
    (status) => {
      const { store, service, coordinator } = host();
      const item = coordinator.create({ icm: "42", mode: "fixture" });
      store.dri.update(item.id, store.dri.require(item.id).revision, { status });
      const before = store.dri.export();
      const stop = vi.spyOn(service, "dispatch");
      expect(() => store.deleteRun(item.runId)).toThrow(/retained/);
      expect(() => purgeRun(service, item.runId)).toThrow(/retained/);
      expect(stop).not.toHaveBeenCalled();
      expect(store.dri.export()).toEqual(before);
    },
  );
  it("permits only post-retention generic purge and retains its audit tombstone", async () => {
    const { store, coordinator, service } = host();
    const item = coordinator.create({ icm: "42", mode: "fixture" });
    await coordinator.execute(item.id);
    coordinator.complete(item.id, store.dri.require(item.id).revision);
    expect(() => purgeRun(service, item.runId)).toThrow(/retained/);
    expect(store.dri.all(item.id, "reports")).toHaveLength(1);
    coordinator.setLegalHold(item.id, store.dri.require(item.id).revision, true);
    expect(store.dri.cleanup(Date.now() + 400 * day)).toBe(0);
    coordinator.setLegalHold(item.id, store.dri.require(item.id).revision, false);
    expect(store.dri.cleanup(Date.now() + 400 * day)).toBe(1);
    expect(purgeRun(service, item.runId)).toBe(true);
    expect(store.dri.tombstones(item.runId)).toHaveLength(1);
    const ordinary = store.createRun({
      workspaceId: "chats",
      name: "ordinary",
      objective: "ordinary",
    });
    expect(purgeRun(service, ordinary.id)).toBe(true);
  });
});
