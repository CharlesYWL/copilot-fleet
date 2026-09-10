import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { degradedDriBackup } from "@fleet/protocol";
import { DriCoordinator, type DriCoordinatorOptions } from "../dri/coordinator.js";
import { fixtureProviders } from "../dri/fixtures.js";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { OrchestratorEngine } from "./engine.js";
import { fleet } from "./fleet-harness.js";
import { OrchestrationCreationService } from "./creation.js";

const contexts: ReturnType<typeof harness>[] = [];
function harness(options: DriCoordinatorOptions = {}, syntheticRouting = false) {
  const state = fleet();
  state.store.transitionSession(state.leadId, "starting");
  state.store.transitionSession(state.leadId, "running");
  const engine = new OrchestratorEngine(state.service);
  const tick = vi.spyOn(engine, "tick");
  const dri = new DriCoordinator(state.service, options);
  const creation = new OrchestrationCreationService(
    state.service,
    engine,
    dri,
    syntheticRouting,
  );
  return {
    ...state,
    dri,
    creation,
    tick,
    input: {
      workspaceId: state.store.getSession(state.leadId)!.workspaceId,
      name: "New task",
      objective: "Investigate ICM 123456789 with HAR and telemetry.",
    },
  };
}
const setup = (options?: DriCoordinatorOptions, syntheticRouting?: boolean) => {
  const value = harness(options, syntheticRouting);
  contexts.push(value);
  return value;
};
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.dri.shutdown();
    context.service.shutdown();
    context.store.close();
  }
});

describe("one authoritative orchestration creation service", () => {
  it("preserves regular policy inheritance, pending brief and legacy no-key behavior", () => {
    const { creation, store, leadId, input, tick } = setup();
    const template = store.createRun({
      workspaceId: input.workspaceId,
      name: "Template",
      objective: "Code",
      policy: { maxParallel: 2, maxSessions: 17, yolo: false },
    });
    store.updateRun(template.id, { leadSessionId: leadId });
    const result = creation.create(
      {
        ...input,
        objective: "Update the README with instructions for investigating ICM incidents.",
        policy: { maxParallel: 4 },
      },
      { leadSessionId: leadId },
    );
    expect(result).toMatchObject({
      kind: "created",
      workflow: "regular",
      replayed: false,
      run: {
        state: "running",
        leadSessionId: leadId,
        policy: {
          maxParallel: 4,
          maxSessions: 17,
          yolo: false,
          wakePolicy: "on_any_settle",
          onStepFailure: "wake",
        },
      },
    });
    if (result.kind !== "created") throw new Error("Missing regular creation");
    expect(result.run.pendingPrompt).toBe(
      `<fleet-task name="New task" workspace="Alpha">\nUpdate the README with instructions for investigating ICM incidents.\n</fleet-task>\n\nPlan this with fleet_plan_task using the task name "New task", then dispatch the\nwork for its first phase and end your turn.`,
    );
    expect(tick).toHaveBeenCalledTimes(1);
    expect(store.dri.list().items).toHaveLength(0);
    creation.create(
      { ...input, objective: "Update the README" },
      { leadSessionId: leadId },
    );
    creation.create(
      { ...input, objective: "Update the README" },
      { leadSessionId: leadId },
    );
    expect(store.listRuns()).toHaveLength(4);
  });
  it("atomically creates exactly one linked DRI Run and eight steps, with stable replay keys", async () => {
    const { creation, store, leadId, input, dri, tick } = setup(
      { allowFixtures: true, fixtures: fixtureProviders({}) },
      true,
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, async () =>
        creation.create(
          { ...input, requestId: "same-request" },
          { leadSessionId: leadId },
        ),
      ),
    );
    expect(
      results.every((result) => result.kind === "created" && result.workflow === "dri"),
    ).toBe(true);
    expect(store.listRuns()).toHaveLength(1);
    const investigation = store.dri.list().items[0]!;
    await dri.execute(investigation.id);
    expect(store.dri.list().items).toHaveLength(1);
    expect(store.getRun(investigation.runId)).toMatchObject({
      investigationId: investigation.id,
      leadSessionId: leadId,
      pendingPrompt: "",
      creationReceipt: { workflow: "dri" },
      policy: { yolo: false, wakePolicy: "none" },
    });
    expect(store.listRunSteps(investigation.runId)).toHaveLength(8);
    expect(store.dri.require(investigation.id)).toMatchObject({
      mode: "fixture",
      status: "awaiting_review",
      profile: { profileId: "dms" },
    });
    expect(tick).not.toHaveBeenCalled();
  });
  it("returns correction without creating anything for ambiguity or a missing ICM", () => {
    const { creation, store, leadId, input } = setup();
    for (const extra of [
      { objective: "Investigate incident 123456789." },
      { objective: "DRI investigation" },
      { objective: "Investigate", workflow: "dri" },
    ])
      expect(
        creation.create({ ...input, ...extra }, { leadSessionId: leadId }),
      ).toMatchObject({
        kind: "confirmation_required",
      });
    expect(store.listRuns()).toHaveLength(0);
    expect(store.dri.list().items).toHaveLength(0);
  });
  it("honors explicit regular and DRI choices, and structured ICM correction", () => {
    const { creation, leadId, input } = setup();
    expect(
      creation.create({ ...input, workflow: "regular" }, { leadSessionId: leadId }),
    ).toMatchObject({ kind: "created", workflow: "regular" });
    expect(
      creation.create(
        {
          ...input,
          workflow: "dri",
          objective: "Update the README",
          dri: { icm: "42" },
        },
        { leadSessionId: leadId },
      ),
    ).toMatchObject({ kind: "created", workflow: "dri" });
    expect(
      creation.create(
        {
          ...input,
          objective: "Investigate incident 123456789.",
          dri: { icm: "123456789" },
        },
        { leadSessionId: leadId },
      ),
    ).toMatchObject({ kind: "created", workflow: "dri" });
  });
  it("never auto-selects available fixtures and persists exact missing capabilities", async () => {
    const { creation, store, leadId, input, dri } = setup({
      allowFixtures: true,
      fixtures: fixtureProviders({}),
    });
    const result = creation.create(input, { leadSessionId: leadId });
    if (result.kind !== "created" || result.workflow !== "dri")
      throw new Error("Missing DRI");
    await dri.execute(result.investigation.id);
    const current = store.dri.require(result.investigation.id);
    expect(current).toMatchObject({ mode: "live", status: "blocked" });
    expect(current.readiness).toHaveLength(6);
    expect(
      current.readiness.every(
        (entry) => entry.state === "unavailable" && entry.setup.includes("MCP"),
      ),
    ).toBe(true);
    expect(store.dri.invocationCount(current.id)).toBe(0);
    expect(store.dri.all(current.id, "reports")).toHaveLength(0);
    expect(
      store.dri
        .all(current.id, "evidence")
        .every(
          (entry) => entry.sensitivity === "redacted" && entry.type === "limitation",
        ),
    ).toBe(true);
  });
  it("supports Host-only DRI without an online Node, while regular still requires placement", () => {
    const { creation, store, service, leadId, input } = setup();
    service.disconnectNode(store.getSession(leadId)!.nodeId, "Synthetic disconnect");
    expect(creation.create(input, { standalone: true })).toMatchObject({
      workflow: "dri",
    });
    expect(() =>
      creation.create({ ...input, workflow: "regular" }, { leadSessionId: leadId }),
    ).toThrow(/online node/);
  });
  it("rejects changed input for an existing key, and does not restart stopped work on replay", () => {
    const { creation, store, leadId, input, dri } = setup();
    const result = creation.create(
      { ...input, requestId: "durable-key" },
      { leadSessionId: leadId },
    );
    if (result.kind !== "created" || result.workflow !== "dri")
      throw new Error("Missing DRI");
    dri.stop(
      result.investigation.id,
      store.dri.require(result.investigation.id).revision,
    );
    expect(
      creation.create({ ...input, requestId: "durable-key" }, { leadSessionId: leadId }),
    ).toMatchObject({ replayed: true, investigation: { status: "stopped" } });
    expect(() =>
      creation.create(
        { ...input, objective: "Investigate ICM 987654321", requestId: "durable-key" },
        { leadSessionId: leadId },
      ),
    ).toThrow(/different input/);
    expect(store.listRuns()).toHaveLength(1);
  });
  it("deduplicates fallback DRI keys and keyed regular requests, without inheriting DRI policy", () => {
    const { creation, store, leadId, input } = setup();
    creation.create(input, { leadSessionId: leadId });
    creation.create(input, { leadSessionId: leadId });
    const regular = {
      ...input,
      objective: "Implement feature",
      requestId: "regular-key",
    };
    const first = creation.create(regular, { leadSessionId: leadId });
    expect(first).toMatchObject({
      workflow: "regular",
      run: { policy: { yolo: true, wakePolicy: "on_any_settle" } },
    });
    expect(creation.create(regular, { leadSessionId: leadId })).toMatchObject({
      replayed: true,
    });
    expect(store.listRuns()).toHaveLength(2);
  });
  it("rolls back the Run, receipt and investigation when step persistence fails", () => {
    const { creation, store, leadId, input } = setup();
    const spy = vi.spyOn(store, "upsertRunStep").mockImplementation(() => {
      throw new Error("Synthetic disk failure");
    });
    expect(() =>
      creation.create({ ...input, requestId: "rollback" }, { leadSessionId: leadId }),
    ).toThrow(/disk failure/);
    expect(store.listRuns()).toHaveLength(0);
    expect(store.dri.list().items).toHaveLength(0);
    spy.mockRestore();
    expect(
      creation.create({ ...input, requestId: "rollback" }, { leadSessionId: leadId }),
    ).toMatchObject({ workflow: "dri", replayed: false });
  });
  it("exports and restores hashed creation receipts together with typed DRI state", () => {
    const { creation, store, leadId, input } = setup();
    const result = creation.create(
      { ...input, requestId: "portable-key" },
      { leadSessionId: leadId },
    );
    if (result.kind !== "created") throw new Error("Missing creation");
    const backup = store.exportHostBackup({ enrollmentToken: "synthetic-token" });
    const restored = new FleetStore(":memory:");
    try {
      restored.replaceHostBackup(backup);
      expect(
        restored.runForCreationKey(result.run.creationReceipt!.keyHash),
      ).toMatchObject({
        id: result.run.id,
        creationReceipt: result.run.creationReceipt,
      });
      expect(restored.dri.forRun(result.run.id)?.readiness).toHaveLength(6);
      const service = new FleetService(restored, Fastify({ logger: false }).log);
      const replay = new OrchestrationCreationService(
        service,
        new OrchestratorEngine(service),
      );
      expect(
        replay.create({ ...input, requestId: "portable-key" }, { leadSessionId: leadId }),
      ).toMatchObject({ replayed: true, run: { id: result.run.id } });
      expect(restored.listRuns()).toHaveLength(1);
      restored.replaceHostBackup({ ...backup, dri: degradedDriBackup() });
      expect(() =>
        replay.create({ ...input, requestId: "portable-key" }, { leadSessionId: leadId }),
      ).toThrow(/no restorable investigation/);
      expect(restored.listRuns()).toHaveLength(1);
      service.shutdown();
    } finally {
      restored.close();
    }
    expect(JSON.stringify(result.run.creationReceipt)).not.toContain("portable-key");
  });
  it("replays a durable request after closing and reopening its SQLite store", async () => {
    const directory = join(process.cwd(), ".dri-test-work", `routing-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    let runId = "";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = new FleetStore(join(directory, "fleet.db"));
        const service = new FleetService(store, Fastify({ logger: false }).log);
        const creation = new OrchestrationCreationService(
          service,
          new OrchestratorEngine(service),
        );
        try {
          const result = creation.create(
            {
              workspaceId: "chats",
              name: "Durable request",
              requestId: "restart",
              objective: "Investigate ICM 42 using telemetry.",
            },
            { standalone: true },
          );
          if (result.kind !== "created") throw new Error("Missing creation");
          if (attempt === 0) runId = result.run.id;
          expect(result.run.id).toBe(runId);
          expect(result.replayed).toBe(attempt === 1);
          expect(store.listRuns()).toHaveLength(1);
          expect(store.dri.list().items).toHaveLength(1);
        } finally {
          await creation.shutdown();
          service.shutdown();
          store.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
