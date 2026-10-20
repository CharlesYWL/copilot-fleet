import { afterEach, describe, expect, it } from "vitest";
import { FleetStore } from "./store.js";
import type { UsageSnapshot } from "@fleet/protocol";

const stores: FleetStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const create = () => {
  const store = new FleetStore(":memory:");
  stores.push(store);
  return store;
};
const setup = () => {
  const store = create();
  const { node } = store.registerNode({
    name: "Machine",
    os: "linux",
    arch: "x64",
    version: "test",
    capabilities: ["copilot-acp"],
    maxSessions: 4,
  });
  const workspace = store.createWorkspace("Project", "");
  const placement = store.createPlacement(workspace.id, node.id, "/repo");
  const task = store.createRun({
    workspaceId: workspace.id,
    name: "Task",
    objective: "Build feature",
  });
  const worker = store.createSession(
    placement,
    "Worker prompt is private",
    false,
    "Worker",
    { runId: task.id, runRole: "worker" },
  );
  const lead = store.createSession(
    placement,
    "Lead prompt is private",
    false,
    "Orchestrator",
    { runRole: "lead", agentParams: { kind: "hermes", profile: "fleet" } },
  );
  return { store, node, task, worker, lead };
};
const reading = (
  sessionId: string,
  sequence: number,
  tokens: number,
  aiCredits?: number,
): UsageSnapshot => ({
  id: `snapshot-${sequence}`,
  sequence,
  sessionId,
  accounting: {
    source: "test",
    observedAt: "2026-10-19T10:00:00Z",
    nativeSessionId: sessionId,
    counterId: sessionId,
    totalTokens: tokens,
    ...(aiCredits === undefined ? {} : { aiCredits }),
  },
});

describe("Fleet usage integration", () => {
  it("combines backend tokens while retaining Copilot-only credits and shared Orchestrator scope", () => {
    const { store, node, worker, lead, task } = setup();
    store.usage.ingest(node.id, [
      reading(worker.id, 1, 100, 2),
      reading(lead.id, 2, 200),
    ]);
    const report = store.usage.report({ groupBy: "task" });
    expect(report.totals).toMatchObject({ totalTokens: 300, aiCredits: 2 });
    expect(report.coverage).toMatchObject({
      sessions: 2,
      tokenSessions: 2,
      creditSessions: 1,
    });
    expect(report.rows.find((row) => row.key === task.id)).toMatchObject({
      totalTokens: 100,
    });
    expect(
      report.rows.find((row) => row.key === "__shared_orchestrator__"),
    ).toMatchObject({ totalTokens: 200, aiCredits: null });
    expect(store.usage.report({ backend: "hermes" }).totals).toMatchObject({
      totalTokens: 200,
      aiCredits: null,
    });
    expect(JSON.stringify(store.usage.exportBackup())).not.toContain("prompt is private");
  });
  it("retains counters through session deletion and Host backup restore", () => {
    const { store, node, worker } = setup();
    store.usage.ingest(node.id, [reading(worker.id, 1, 100, 2)]);
    store.transitionSession(worker.id, "failed");
    store.deleteSession(worker.id);
    const backup = store.exportHostBackup({ enrollmentToken: "test" });
    const target = create();
    target.replaceHostBackup(backup);
    expect(target.getSession(worker.id)).toBeUndefined();
    expect(target.usage.report({ groupBy: "session" }).totals).toMatchObject({
      totalTokens: 100,
      aiCredits: 2,
    });
    expect(target.usage.ingest(node.id, [reading(worker.id, 1, 100, 2)])).toBe(1);
    expect(target.usage.report({}).totals.totalTokens).toBe(100);
  });
  it("accepts a delayed first reading after transcript cleanup using retained ownership", () => {
    const { store, node, worker } = setup();
    store.transitionSession(worker.id, "failed");
    store.deleteSession(worker.id);
    store.usage.ingest(node.id, [reading(worker.id, 1, 100, 2)]);
    expect(store.usage.report({}).totals).toMatchObject({
      totalTokens: 100,
      aiCredits: 2,
    });
    expect(() =>
      store.usage.ingest("foreign-node", [reading(worker.id, 2, 200)]),
    ).toThrow(/ownership/);
    expect(store.usage.report({}).totals.totalTokens).toBe(100);
  });
  it("rejects another machine's usage even when its payload is valid", () => {
    const { store, worker } = setup();
    expect(() =>
      store.usage.ingest("foreign-node", [reading(worker.id, 1, 100)]),
    ).toThrow(/ownership/);
    expect(store.usage.report({}).totals.totalTokens).toBeNull();
  });
});
