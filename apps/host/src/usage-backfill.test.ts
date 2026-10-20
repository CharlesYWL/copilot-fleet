import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetStore } from "./store.js";
import type { UsageSnapshot } from "@fleet/protocol";

const stores: FleetStore[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const fixture = (disk = false) => {
  const directory = disk
    ? mkdtempSync(join(tmpdir(), "fleet-usage-backfill-"))
    : undefined;
  if (directory) directories.push(directory);
  const store = new FleetStore(directory ? join(directory, "fleet.db") : ":memory:");
  stores.push(store);
  const { node } = store.registerNode({
    name: "Machine",
    os: "linux",
    arch: "x64",
    version: "test",
    capabilities: ["copilot-acp"],
    maxSessions: 8,
  });
  const workspace = store.createWorkspace("Project", "");
  const placement = store.createPlacement(workspace.id, node.id, "/repo");
  const add = (
    native: string = randomUUID(),
    credits: number | null = 100,
    options: { active?: boolean; hermes?: boolean; taskId?: string } = {},
  ) => {
    const session = store.createSession(placement, "private prompt", false, "Worker", {
      runRole: "worker",
      ...(options.taskId ? { runId: options.taskId } : {}),
      ...(options.hermes ? { agentParams: { kind: "hermes", profile: "fleet" } } : {}),
    });
    if (native)
      store.appendEvent({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 1,
        type: "agent_session",
        payload: { agentSessionId: native },
        createdAt: "2026-10-19T09:00:00Z",
      });
    store.appendEvent({
      eventId: randomUUID(),
      sessionId: session.id,
      sequence: 2,
      type: "usage",
      payload: { aiCredits: credits },
      createdAt: "2026-10-19T10:00:00Z",
    });
    if (!options.active) store.transitionSession(session.id, "failed");
    return store.getSession(session.id)!;
  };
  const sample = (
    sessionId: string,
    native: string,
    credits: number,
    at = "2026-10-19T11:00:00Z",
  ): UsageSnapshot => ({
    id: randomUUID(),
    sequence: 1,
    sessionId,
    accounting: {
      nativeSessionId: native,
      counterId: native,
      source: "copilot-checkpoint",
      observedAt: at,
      aiCredits: credits,
      baseline: true,
    },
  });
  return { store, node, add, sample, directory };
};

describe("legacy Copilot credit backfill", () => {
  it("previews without mutation and imports the same conversation only once", () => {
    const { store, add } = fixture();
    const session = add("native", 100);
    const preview = store.usageBackfill.preview();
    expect(preview).toMatchObject({
      eligibleConversations: 1,
      eligibleSessions: 1,
      aiCredits: 100,
    });
    expect(store.usage.report({}).totals.aiCredits).toBeNull();
    expect(store.usageBackfill.apply(preview.previewId)).toMatchObject({
      importedConversations: 1,
      aiCredits: 100,
      backupFile: null,
    });
    expect(store.getSession(session.id)?.usage?.aiCredits).toBe(100);
    expect(store.usage.report({})).toMatchObject({
      totals: { aiCredits: 100, totalTokens: null },
      coverage: { openingAiCredits: 100, lastReportedAt: null },
    });
    expect(store.usage.report({ from: "2026-10-01T00:00:00Z" }).totals.aiCredits).toBe(0);
    expect(
      store.usageBackfill.apply(store.usageBackfill.preview().previewId)
        .importedConversations,
    ).toBe(0);
    expect(store.usage.exportBackup().snapshots).toHaveLength(1);
    expect(JSON.stringify(store.usage.exportBackup())).not.toContain("private prompt");
  });
  it("collapses matching native aliases and skips conflicting or active conversations", () => {
    const { store, add } = fixture();
    add("same", 100);
    add("same", 100);
    add("conflict", 5);
    add("conflict", 8);
    add("active", 7);
    add("active", 7, { active: true });
    add("", 9);
    add("missing", null);
    add("hermes", 4, { hermes: true });
    const preview = store.usageBackfill.preview();
    expect(preview).toMatchObject({
      eligibleConversations: 1,
      eligibleSessions: 2,
      aiCredits: 100,
      skipped: {
        conflicting: 2,
        active: 2,
        missingIdentity: 1,
        missingCredits: 1,
        otherBackend: 1,
      },
    });
    store.usageBackfill.apply(preview.previewId);
    expect(store.usage.report({}).totals.aiCredits).toBe(100);
  });
  it("skips existing credit scopes but allows credit imports when only tokens were reported", () => {
    const { store, node, add, sample } = fixture();
    const covered = add("covered", 100);
    const tokens = add("tokens", 200);
    store.usage.ingest(node.id, [
      sample(covered.id, "covered", 100),
      {
        ...sample(tokens.id, "tokens", 0),
        accounting: {
          nativeSessionId: "tokens",
          counterId: "tokens",
          source: "copilot-session-totals",
          observedAt: "2026-10-19T10:00:00Z",
          totalTokens: 1000,
        },
      },
    ]);
    expect(store.usageBackfill.preview()).toMatchObject({
      eligibleConversations: 1,
      aiCredits: 200,
      skipped: { alreadyRecorded: 1 },
    });
    store.usageBackfill.apply(store.usageBackfill.preview().previewId);
    expect(store.usage.report({}).totals).toMatchObject({
      aiCredits: 300,
      totalTokens: 1000,
    });
  });
  it("refuses a changed preview and rolls back a failed import batch", () => {
    const { store, add } = fixture();
    add("first", 100);
    const old = store.usageBackfill.preview();
    add("second", 50);
    expect(() => store.usageBackfill.apply(old.previewId)).toThrow(/preview/i);
    const ingest = store.usage.ingest.bind(store.usage);
    vi.spyOn(store.usage, "ingest").mockImplementation((nodeId, rows) => {
      ingest(nodeId, rows);
      throw new Error("simulated failure");
    });
    expect(() =>
      store.usageBackfill.apply(store.usageBackfill.preview().previewId),
    ).toThrow("simulated failure");
    expect(store.usage.exportBackup().snapshots).toHaveLength(0);
  });
  it("keeps delayed historical readings and imported top-ups out of migration-day spend", () => {
    const { store, node, add, sample } = fixture();
    const session = add("native", 100);
    store.usageBackfill.apply(store.usageBackfill.preview().previewId);
    const imported =
      store.usage.exportBackup().snapshots[0]!.snapshot.accounting.observedAt;
    const later = new Date(Date.parse(imported) + 60_000).toISOString();
    store.usage.ingest(node.id, [
      sample(session.id, "native", 80),
      sample(session.id, "native", 112, later),
    ]);
    expect(store.usage.report({})).toMatchObject({
      totals: { aiCredits: 112 },
      coverage: { openingAiCredits: 100, regressions: 0, lastReportedAt: later },
    });
    expect(store.usage.report({ from: imported }).totals.aiCredits).toBe(12);
  });
  it("preserves backfill and its idempotency through backup restore", () => {
    const { store, add } = fixture();
    add("native", 100);
    store.usageBackfill.apply(store.usageBackfill.preview().previewId);
    const target = fixture().store;
    target.replaceHostBackup(store.exportHostBackup({ enrollmentToken: "test" }));
    expect(target.usageBackfill.preview().eligibleConversations).toBe(0);
    expect(target.usage.report({}).totals.aiCredits).toBe(100);
  });
  it("fails without importing when the database backup cannot be created", () => {
    const { store, add, directory } = fixture(true);
    add("native", 100);
    const original = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "VACUUM INTO ?") throw new Error("disk full");
      return original.call(this, sql);
    });
    expect(() =>
      store.usageBackfill.apply(store.usageBackfill.preview().previewId),
    ).toThrow(/backup/i);
    expect(store.usage.exportBackup().snapshots).toHaveLength(0);
    expect(
      readdirSync(directory!).filter((name) => name.startsWith("usage-backfill-")),
    ).toHaveLength(0);
  });
  it("revalidates eligibility after backing up and before writing", () => {
    const { store, add } = fixture(true);
    const session = add("native", 100);
    const preview = store.usageBackfill.preview();
    const original = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "VACUUM INTO ?")
        store.appendEvent({
          eventId: randomUUID(),
          sessionId: session.id,
          sequence: 3,
          type: "usage",
          payload: { aiCredits: 101 },
          createdAt: "2026-10-19T11:00:00Z",
        });
      return original.call(this, sql);
    });
    expect(() => store.usageBackfill.apply(preview.previewId)).toThrow(/preview/i);
    expect(store.usage.exportBackup().snapshots).toHaveLength(0);
  });
  it("does not flag a lower imported balance when delayed native history already covers it", () => {
    const { store, node, add, sample } = fixture();
    const session = add("native", 100);
    store.usageBackfill.apply(store.usageBackfill.preview().previewId);
    store.usage.ingest(node.id, [sample(session.id, "native", 120)]);
    expect(store.usage.report({})).toMatchObject({
      totals: { aiCredits: 120 },
      coverage: { openingAiCredits: 120, regressions: 0 },
    });
  });
  it("preserves explicit zero and fractional credit precision", () => {
    const { store, add } = fixture();
    add("zero", 0);
    add("fractional", 1.123456789);
    expect(store.usageBackfill.preview()).toMatchObject({
      eligibleConversations: 2,
      aiCredits: 1.123456789,
    });
    store.usageBackfill.apply(store.usageBackfill.preview().previewId);
    expect(store.usage.report({}).totals.aiCredits).toBe(1.123456789);
  });
  it("creates a consistent pre-import database backup in the protected Host directory", () => {
    const { store, add, directory } = fixture(true);
    add("native", 100);
    const result = store.usageBackfill.apply(store.usageBackfill.preview().previewId);
    expect(result.backupFile).toMatch(/^usage-backfill-.*\.db$/);
    const backup = new DatabaseSync(join(directory!, result.backupFile!), {
      readOnly: true,
    });
    try {
      expect(
        backup.prepare("SELECT COUNT(*) AS count FROM usage_snapshots").get()?.count,
      ).toBe(0);
      expect(backup.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count).toBe(
        1,
      );
    } finally {
      backup.close();
    }
    expect(
      readdirSync(directory!).filter((name) => name.startsWith("usage-backfill-")),
    ).toHaveLength(1);
  });
});
