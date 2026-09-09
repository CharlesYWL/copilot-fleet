import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateDriSchema,
  DriLimitsSchema,
  DriReportSchema,
  parseIcmReference,
  renderDriReport,
  type DriEvidence,
} from "@fleet/protocol";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { archiveRun } from "../orchestrator/lifecycle.js";
import { DriCoordinator, type DriCoordinatorOptions } from "./coordinator.js";
import { fixtureHar, fixtureProviders } from "./fixtures.js";
import { analyzeHar } from "./har.js";
import { ProfileRegistry, dmsProfile, genericProfile } from "./profiles.js";
import {
  DeclaredMcpProvider,
  ProviderPageSchema,
  ProviderRegistry,
  assertReadOnlyTool,
  matchSimilar,
  telemetryPlan,
} from "./providers.js";
import { canonical, contentHash, redactText } from "./safety.js";
import { validateHypothesis, validateReport } from "./reports.js";

const contexts: {
  store: FleetStore;
  service: FleetService;
  coordinator: DriCoordinator;
}[] = [];
function harness(options: DriCoordinatorOptions = {}, databasePath = ":memory:") {
  const store = new FleetStore(databasePath);
  const service = new FleetService(store, {
    info() {},
    warn() {},
    error() {},
    debug() {},
  } as unknown as FastifyBaseLogger);
  const publish = vi.spyOn(service, "broadcast");
  const coordinator = new DriCoordinator(service, { allowFixtures: true, ...options });
  const result = { store, service, coordinator, publish };
  contexts.push(result);
  return result;
}
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.coordinator.shutdown();
    context.service.shutdown();
    context.store.close();
  }
});
const create = (coordinator: DriCoordinator, extra: Record<string, unknown> = {}) =>
  coordinator.create({ icm: "42", mode: "fixture", ...extra });

describe("DRI input and profiles", () => {
  it.each([
    "42",
    "999999999999999999",
    "https://portal.microsofticm.com/imp/v5/incidents/details/42",
    "https://portal.microsofticm.com/#/incidents/details/42",
    "https://icm.ad.msft.net/imp/v3/incidents/details/42",
  ])("accepts bounded canonical ICM reference %s", (value) => {
    expect(parseIcmReference(value).id).toMatch(/^[1-9]\d*$/);
  });
  it.each([
    "0",
    "-1",
    "1e3",
    "123abc",
    "9999999999999999999",
    "http://portal.microsofticm.com/incidents/42",
    "https://evil.invalid/incidents/42",
    "https://portal.microsofticm.com.evil.invalid/incidents/42",
    "https://user:secret@portal.microsofticm.com/incidents/42",
    "https://portal.microsofticm.com:444/incidents/42",
    "https://portal.microsofticm.com/incidents/42?token=synthetic",
    "https://portal.microsofticm.com/elsewhere#123",
    "file:///incidents/42",
    "javascript:alert(1)",
  ])("rejects unsafe ICM reference %s", (value) => {
    expect(() => parseIcmReference(value)).toThrow();
    expect(CreateDriSchema.safeParse({ icm: value }).success).toBe(false);
  });
  it("does not infer DMS from operator hints or title wording, and permits correction", async () => {
    const { store, coordinator } = harness();
    const investigation = create(coordinator, {
      service: "DMS",
      component: "Fabric Warehouse",
    });
    expect(investigation.profile.profileId).toBe("generic");
    await coordinator.execute(investigation.id);
    const incident = store.dri.all(investigation.id, "incidents")[0]!;
    const registry = new ProfileRegistry();
    expect(
      registry.resolve("auto", { ...incident, ownershipVerified: false }, []).profileId,
    ).toBe("generic");
    expect(registry.resolve("auto", incident, []).profileId).toBe("dms");
    expect(registry.resolve("generic", incident, []).profileId).toBe("generic");
    const corrected = coordinator.correctProfile(
      investigation.id,
      store.dri.require(investigation.id).revision,
      "generic",
    );
    expect(corrected.status).toBe("stopped");
    expect(corrected.profile.method).toBe("correction");
    expect(store.dri.all(investigation.id, "reports")).toHaveLength(0);
    expect(store.dri.decisions(investigation.id).length).toBe(3);
    expect(() => coordinator.resume(investigation.id, 0)).toThrow(/Stale/);
    expect(registry.resolve("not-installed", undefined, []).method).toBe("unavailable");
  });
});

describe("bounded HAR, provider and query boundaries", () => {
  it("redacts credentials, extracts first meaningful failure, ordering, retry, cohorts and timings", () => {
    const analysis = analyzeHar(fixtureHar, DriLimitsSchema.parse({}));
    expect(analysis.firstFailure).toBe(2);
    expect(analysis.requests.map((request) => request.order)).toEqual([1, 2, 3, 4]);
    expect(analysis.requests[2]!.retryOf).toBe(2);
    expect(analysis.requests[1]!.phases.wait).toBe(5_990);
    expect(analysis.credentialHeadersRemoved).toBe(2);
    const serialized = JSON.stringify(analysis);
    for (const raw of [
      "Bearer",
      "synthetic-only",
      "not-a-secret",
      "fixture.invalid",
      "Authorization",
    ])
      expect(serialized).not.toContain(raw);
    expect(() =>
      analyzeHar(
        fixtureHar + " ".repeat(1_024),
        DriLimitsSchema.parse({ maxBytes: 1_024 }),
      ),
    ).toThrow(/budget/);
    expect(() => analyzeHar("not JSON", DriLimitsSchema.parse({}))).toThrow();
    expect(analyzeHar(fixtureHar, DriLimitsSchema.parse({ maxRows: 1 })).truncated).toBe(
      true,
    );
  });
  it("recognizes redirect graphs, cancellation, app errors, CORS, cookies and authentication without values", () => {
    const raw = JSON.parse(fixtureHar);
    raw.log.entries[0].response.status = 302;
    raw.log.entries[0].response.redirectURL = "https://fixture.invalid/operation";
    raw.log.entries[1]._error = "CORS failure";
    raw.log.entries[1].request.cookies = [{ name: "session", value: "synthetic-secret" }];
    raw.log.entries[2]._error = "cancelled";
    raw.log.entries[3].response.status = 200;
    raw.log.entries[3].response.content = { text: '{"error":"bad_operation"}' };
    const analysis = analyzeHar(JSON.stringify(raw), DriLimitsSchema.parse({}));
    expect(analysis.requests[1]!.parentOrder).toBe(1);
    expect(analysis.requests[1]!.signals).toEqual(
      expect.arrayContaining(["cors_failure", "cookies_present_values_removed"]),
    );
    expect(analysis.requests[2]!.outcome).toBe("cancelled");
    expect(analysis.requests[3]!.outcome).toBe("app_error");
    expect(JSON.stringify(analysis)).not.toContain("synthetic-secret");
  });
  it("centrally removes secrets, personal identifiers and untrusted external links", () => {
    const safe = redactText(
      "Authorization: Bearer synthetic\nperson@example.invalid password=synthetic\ncustomer=synthetic\nhttps://fixture.invalid/?token=synthetic",
    );
    expect(safe).not.toContain("person@");
    expect(safe).not.toContain("Bearer");
    expect(safe).not.toContain("=synthetic");
    expect(safe).not.toContain("https://");
  });
  it("never authorizes unknown or write tools, even if named read-only by a worker", () => {
    for (const tool of [
      "update_incident",
      "post_discussion_entry",
      "mitigate_incident",
      "resolve_incident",
      "transfer_incident",
      "read_then_write",
    ]) {
      expect(() => assertReadOnlyTool("incident.read", tool)).toThrow(/allowlist/);
    }
    const provider = fixtureProviders()[0]!;
    expect(
      () =>
        new ProviderRegistry([
          {
            ...provider,
            definition: { ...provider.definition, tools: ["update_incident"] },
          },
        ]),
    ).toThrow();
    expect(
      () =>
        new ProviderRegistry([
          {
            ...provider,
            definition: { ...provider.definition, readOnly: false },
          } as never,
        ]),
    ).toThrow();
  });
  it("requires explicit authorization and discovered read-only annotations before MCP dispatch", async () => {
    const { store, coordinator } = harness();
    const investigation = create(coordinator);
    await coordinator.execute(investigation.id);
    const query = store.dri
      .all(investigation.id, "queries")
      .find((query) => query.capability === "incident.read")!;
    const client = {
      discover: vi.fn(async () => [
        { name: "get_incident_details_by_id", readOnly: false },
      ]),
      call: vi.fn(),
    };
    const binding = {
      tool: "get_incident_details_by_id",
      capability: "incident.read" as const,
      arguments: () => ({ incidentId: "42" }),
      normalize: () =>
        ProviderPageSchema.parse({ state: "succeeded", summary: "Technical summary" }),
    };
    const context = {
      investigation,
      profile: genericProfile,
      query,
      cursor: undefined,
      signal: new AbortController().signal,
      privateBindings: {},
    };
    const denied = new DeclaredMcpProvider("icm", client, binding, async () => false);
    expect((await denied.read(context)).state).toBe("access_denied");
    expect(client.discover).not.toHaveBeenCalled();
    const allowed = new DeclaredMcpProvider("icm", client, binding, async () => true);
    expect((await allowed.read(context)).state).toBe("unavailable");
    expect(client.call).not.toHaveBeenCalled();
    client.discover.mockResolvedValue([
      { name: "get_incident_details_by_id", readOnly: true },
    ]);
    await allowed.read(context);
    expect(client.call).toHaveBeenCalledWith(
      "get_incident_details_by_id",
      { incidentId: "42" },
      context.signal,
    );
  });
});

describe("fixture DMS orchestration and durable authority", () => {
  it("executes a complete paginated, evidence-linked investigation without model prompts or writes", async () => {
    const { store, service, coordinator, publish } = harness();
    const investigation = create(coordinator);
    new OrchestratorEngine(service).tickRun(investigation.runId);
    expect(store.listSessions()).toHaveLength(0);
    await coordinator.execute(investigation.id);
    const final = store.dri.require(investigation.id);
    expect(final.status, JSON.stringify(store.dri.all(final.id, "queries"))).toBe(
      "awaiting_review",
    );
    expect(final.profile.profileId).toBe("dms");
    expect(final.profile.confidence).toBe(0.98);
    expect(store.getRun(final.runId)!.state).toBe("awaiting_human");
    const incident = store.dri.all(final.id, "incidents")[0]!;
    expect(incident.details).toHaveLength(2);
    expect(incident.resources).toHaveLength(1);
    expect(incident.completeness).toBe("complete");
    const timeline = store.dri.page(final.id, "timeline", { limit: 50 }).items;
    expect(timeline.map((event) => event.at)).toEqual(
      timeline.map((event) => event.at).sort(),
    );
    const queries = store.dri.all(final.id, "queries");
    expect(queries.find((query) => query.capability === "incident.read")!.pages).toBe(2);
    expect(queries.find((query) => query.capability === "similar.search")!.pages).toBe(2);
    const telemetry = queries.find((query) => query.capability === "telemetry.query")!;
    const plan = telemetryPlan(dmsProfile, telemetry);
    expect(plan.filterOrder).toEqual(["environment", "utc_time", "correlation"]);
    expect(plan.comparisons).toEqual(["failed_success", "affected_unaffected"]);
    expect(plan.selectedColumns).not.toContain("*");
    expect(() =>
      telemetryPlan(dmsProfile, { ...telemetry, template: "arbitrary_query" }),
    ).toThrow();
    expect(store.dri.all(final.id, "similar").map((match) => match.match)).toEqual([
      "strong",
      "ruled_out",
    ]);
    expect(store.dri.all(final.id, "changes")[0]!.assessment).toBe("temporal_only");
    const report = store.dri.all(final.id, "reports")[0]!;
    expect(report.causalChain.assessment).toBe("provisional");
    expect(report.causalChain.underlyingRootCause.statement).toMatch(/^Unknown/);
    expect(report.causalChain.firstIncorrectBehavior.evidenceIds.length).toBeGreaterThan(
      1,
    );
    validateReport(report, store.dri.all(final.id, "evidence"));
    expect(renderDriReport(report)).toContain("#evidence-");
    expect(store.listRunSteps(final.runId).every((step) => step.output === "")).toBe(
      true,
    );
    const snapshot = JSON.stringify(service.snapshot());
    for (const value of [
      "synthetic-not-a-credential",
      "fixture.invalid",
      "upstream_unavailable",
      "fixture-correlation",
    ])
      expect(snapshot).not.toContain(value);
    expect(
      publish.mock.calls
        .filter(([message]) => message.type === "dri_changed")
        .every(([message]) => JSON.stringify(message).length < 300),
    ).toBe(true);
    expect(
      store
        .listNotifications()
        .notifications.filter(
          (notification) => notification.kind === "orchestration_needs_review",
        ),
    ).toHaveLength(1);
    coordinator.complete(final.id, final.revision);
    expect(store.dri.require(final.id).status).toBe("completed");
    const count = store.dri.invocationCount(final.id);
    await coordinator.execute(final.id);
    coordinator.resume(final.id, store.dri.require(final.id).revision);
    expect(store.dri.invocationCount(final.id)).toBe(count);
  });
  it.each(["no_results", "access_denied", "failed", "truncated"] as const)(
    "distinguishes %s and preserves other providers",
    async (outcome) => {
      const { store, coordinator } = harness({
        fixtures: fixtureProviders({ outcomes: { "telemetry.query": outcome } }),
      });
      const investigation = create(coordinator);
      await coordinator.execute(investigation.id);
      const query = store.dri
        .all(investigation.id, "queries")
        .find((query) => query.capability === "telemetry.query")!;
      expect(query.state).toBe(outcome);
      expect(
        store.dri.all(investigation.id, "evidence").some((item) => item.type === "har"),
      ).toBe(true);
      expect(store.dri.all(investigation.id, "reports")).toHaveLength(1);
      expect(store.dri.require(investigation.id).status).toBe(
        outcome === "no_results" ? "awaiting_review" : "partial",
      );
    },
  );
  it.each(["missingAttachment", "inaccessibleAttachment"] as const)(
    "handles %s without dispatching HAR work",
    async (flag) => {
      const { store, coordinator } = harness({
        fixtures: fixtureProviders({ [flag]: true }),
      });
      const investigation = create(coordinator);
      await coordinator.execute(investigation.id);
      expect(
        store.dri
          .all(investigation.id, "queries")
          .some((query) => query.capability === "har.analyze"),
      ).toBe(false);
      expect(store.dri.require(investigation.id).status).toBe("partial");
      expect(store.dri.all(investigation.id, "reports")).toHaveLength(1);
    },
  );
  it("keeps inaccessible intake blocked and does not fan out", async () => {
    const { store, coordinator } = harness({
      fixtures: fixtureProviders({ unavailable: ["incident.read"] }),
    });
    const investigation = create(coordinator);
    await coordinator.execute(investigation.id);
    expect(store.dri.require(investigation.id).status).toBe("blocked");
    expect(store.dri.invocationCount(investigation.id)).toBe(0);
  });
  it("rejects evidence conflicts, invalid citations and unsupported causal confidence", async () => {
    const { store, coordinator } = harness();
    const investigation = create(coordinator);
    await coordinator.execute(investigation.id);
    const evidence = store.dri.all(investigation.id, "evidence");
    const first = evidence[0]!;
    expect(store.dri.put(first, first.dedupeKey).changed).toBe(false);
    expect(() =>
      store.dri.put({ ...first, finding: "Changed claim" }, first.dedupeKey),
    ).toThrow(/conflict/);
    expect(() =>
      store.dri.put(
        { ...first, id: "new-id", finding: "Changed claim" },
        first.dedupeKey,
      ),
    ).toThrow(/conflict/);
    const hypothesis = store.dri.all(investigation.id, "hypotheses")[0]!;
    expect(() =>
      validateHypothesis({ ...hypothesis, supportingEvidence: ["unknown"] }, evidence),
    ).toThrow(/citation/);
    expect(() => validateHypothesis({ ...hypothesis, confidence: 1 }, evidence)).toThrow(
      /confidence/,
    );
    expect(() =>
      validateHypothesis(
        { ...hypothesis, contradictingEvidence: hypothesis.supportingEvidence },
        evidence,
      ),
    ).toThrow(/both/);
    const report = store.dri.all(investigation.id, "reports")[0]!;
    expect(
      DriReportSchema.safeParse({ ...report, sections: report.sections.slice(1) })
        .success,
    ).toBe(false);
    expect(() =>
      validateReport({ ...report, evidenceIds: ["unknown"] }, evidence),
    ).toThrow(/citation/);
    expect(() =>
      validateReport(
        {
          ...report,
          causalChain: { ...report.causalChain, assessment: "supported", confidence: 1 },
        },
        evidence,
      ),
    ).toThrow(/Root cause/);
    expect(() =>
      coordinator.propose(investigation.id, first, {
        runId: investigation.runId,
        stepId: "missing-step",
        producerAgentId: first.producerAgentId,
        producerSessionId: "",
        stepAttempt: 1,
        attempt: first.attempt,
        generation: 0,
        invocationId: first.invocationId,
      }),
    ).toThrow(/scope/);
    const page = store.dri.page(investigation.id, "evidence", { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(() =>
      store.dri.page(investigation.id, "evidence", {
        cursor: 1,
        revision: 0,
        generation: investigation.generation,
      }),
    ).toThrow(/revision/);
  });
  it("matches technical signals rather than shared wording", () => {
    expect(
      matchSimilar(
        {
          reference: "fixture:wording",
          technicalSignals: [],
          mismatches: [],
          priorCause: "Warehouse unavailable",
          priorMitigation: "Retry",
        },
        new Set(["upstream_unavailable"]),
      ).match,
    ).toBe("ruled_out");
    expect(
      matchSimilar(
        {
          reference: "fixture:partial",
          technicalSignals: ["upstream_unavailable", "other_signal"],
          mismatches: [],
          priorCause: "",
          priorMitigation: "",
        },
        new Set(["upstream_unavailable"]),
      ).match,
    ).toBe("partial");
  });

  it("atomically stops, resumes only unfinished work, and fences late attempts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    let held = false;
    const providers = fixtureProviders({
      delay: async (context) => {
        calls.push(context.query.capability);
        if (context.query.capability === "telemetry.query" && !held) {
          held = true;
          await gate;
        }
      },
    });
    const { store, coordinator, service } = harness({ fixtures: providers });
    const investigation = create(coordinator);
    const executing = coordinator.execute(investigation.id);
    await vi.waitFor(() =>
      expect(
        store.dri
          .all(investigation.id, "queries")
          .some(
            (query) =>
              query.capability === "telemetry.query" && query.state === "running",
          ),
      ).toBe(true),
    );
    const old = store.dri
      .all(investigation.id, "queries")
      .find((query) => query.capability === "telemetry.query")!;
    coordinator.stop(investigation.id, store.dri.require(investigation.id).revision);
    expect(store.getRun(investigation.runId)!.state).toBe("cancelled");
    release();
    await executing;
    const receipt = store.dri.record(investigation.id, "queries", old.id)!;
    expect(receipt.state).toBe("incomplete");
    expect(
      store.dri.all(investigation.id, "work").some((work) => work.state === "running"),
    ).toBe(false);
    const first = store.dri.all(investigation.id, "evidence")[0]!;
    const late: DriEvidence = {
      ...first,
      id: "late-evidence",
      generation: old.generation,
      dedupeKey: "late-key",
    };
    store.dri.put(late, "late-key");
    expect(store.dri.record(investigation.id, "evidence", late.id)).toBeDefined();
    expect(
      store.dri.all(investigation.id, "evidence").some((item) => item.id === late.id),
    ).toBe(false);
    coordinator.resume(investigation.id, store.dri.require(investigation.id).revision);
    coordinator.resume(investigation.id, store.dri.require(investigation.id).revision);
    await Promise.all([
      coordinator.execute(investigation.id),
      coordinator.execute(investigation.id),
    ]);
    expect(store.dri.require(investigation.id).status).toBe("awaiting_review");
    expect(calls.filter((capability) => capability === "incident.read")).toHaveLength(2);
    expect(store.listRunSteps(investigation.runId)).toHaveLength(8);
    expect(store.getRunStep(old.stepId)!.attempts).toBe(2);
    archiveRun(service, investigation.runId, "Archived by operator");
    expect(store.dri.require(investigation.id).status).toBe("stopped");
  });
  it("backs up normalized metadata, validates hashes, restores paused and preserves immutable reports", async () => {
    const source = harness();
    const investigation = create(source.coordinator);
    await source.coordinator.execute(investigation.id);
    const backup = source.store.exportHostBackup({ enrollmentToken: "" });
    expect(JSON.stringify(backup.dri)).not.toContain("synthetic-not-a-credential");
    const target = harness({
      profiles: new ProfileRegistry([genericProfile]),
      fixtures: [],
    });
    target.store.replaceHostBackup(backup);
    const restored = target.store.dri.require(investigation.id);
    expect(restored.status).toBe("stopped");
    expect(restored.lifecycleCause).toBe("restore");
    expect(target.store.dri.all(restored.id, "reports")).toHaveLength(1);
    expect(() => target.coordinator.resume(restored.id, restored.revision)).toThrow(
      /unavailable/,
    );
    expect(target.store.dri.invocationCount(restored.id)).toBe(5);
    const tampered = structuredClone(backup);
    tampered.dri!.records[0]!.hash = "0".repeat(64);
    expect(() => target.store.replaceHostBackup(tampered)).toThrow(/hash/);
    expect(target.store.dri.require(restored.id).status).toBe("stopped");
    expect(canonical(backup.dri!.records[0]!.record)).toBeTruthy();
    expect(contentHash(backup.dri!.records[0]!.record)).toBe(
      backup.dri!.records[0]!.hash,
    );
  });
  it("persists recoverable state across a real SQLite reopen, without auto replay", async () => {
    const directory = join(process.cwd(), ".dri-test-work", randomUUID());
    mkdirSync(directory, { recursive: true });
    try {
      const path = join(directory, "restart.db");
      const first = harness({}, path);
      const investigation = create(first.coordinator);
      await first.coordinator.shutdown();
      first.service.shutdown();
      first.store.close();
      contexts.splice(contexts.indexOf(first), 1);
      const second = harness({}, path);
      second.coordinator.recover();
      expect(second.store.dri.require(investigation.id).status).toBe("stopped");
      expect(second.store.dri.require(investigation.id).lifecycleCause).toBe(
        "host_restart",
      );
      expect(second.store.dri.invocationCount(investigation.id)).toBe(0);
      second.coordinator.resume(
        investigation.id,
        second.store.dri.require(investigation.id).revision,
      );
      await second.coordinator.execute(investigation.id);
      expect(second.store.dri.require(investigation.id).status).toBe("awaiting_review");
      await second.coordinator.shutdown();
      second.service.shutdown();
      second.store.close();
      contexts.splice(contexts.indexOf(second), 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("does not create fixture calls unless enabled and requires ICM input", () => {
    const { coordinator } = harness({ allowFixtures: false });
    expect(() => create(coordinator)).toThrow(/disabled/);
    expect(() => coordinator.create({})).toThrow();
  });
  it("extends another team's profile without changing coordinator logic", async () => {
    const other = {
      ...dmsProfile,
      id: "other",
      label: "Other team",
      queryTemplates: dmsProfile.queryTemplates.map((template) => ({
        ...template,
        id: "other.cohorts.v1",
      })),
    };
    const { store, coordinator } = harness({
      profiles: new ProfileRegistry([genericProfile, other]),
    });
    const investigation = create(coordinator, { profile: "other" });
    await coordinator.execute(investigation.id);
    expect(store.dri.require(investigation.id).profile.profileId).toBe("other");
    expect(store.dri.require(investigation.id).status).toBe("awaiting_review");
    expect(
      store.dri
        .all(investigation.id, "queries")
        .some((query) => query.template === "other.cohorts.v1"),
    ).toBe(true);
  });
  it("enforces pagination and invocation budgets without discarding accepted partial facts", async () => {
    const { store, coordinator } = harness();
    const investigation = create(coordinator);
    store.dri.update(investigation.id, investigation.revision, {
      limits: DriLimitsSchema.parse({ maxPages: 1, maxInvocations: 2 }),
    });
    await coordinator.execute(investigation.id);
    expect(store.dri.require(investigation.id).status).toBe("partial");
    expect(store.dri.invocationCount(investigation.id)).toBe(2);
    expect(store.dri.all(investigation.id, "incidents")[0]!.completeness).toBe("partial");
    expect(store.dri.all(investigation.id, "queries")[0]!.state).toBe("truncated");
    expect(store.dri.all(investigation.id, "reports")).toHaveLength(1);
  });
  it("times out an isolated provider and preserves other evidence", async () => {
    const { store, coordinator } = harness({
      fixtures: fixtureProviders({
        delay: async (context) => {
          if (context.query.capability === "telemetry.query") await new Promise(() => {});
        },
      }),
    });
    const investigation = create(coordinator);
    store.dri.update(investigation.id, investigation.revision, {
      limits: DriLimitsSchema.parse({ timeoutMs: 50 }),
    });
    await coordinator.execute(investigation.id);
    expect(
      store.dri
        .all(investigation.id, "queries")
        .find((query) => query.capability === "telemetry.query")!.error,
    ).toBe("timeout");
    expect(store.dri.require(investigation.id).status).toBe("partial");
  });
  it("advances a restore epoch beyond the live generation and runs bounded retention", async () => {
    const { store, coordinator } = harness();
    const investigation = create(coordinator);
    const early = store.exportHostBackup({ enrollmentToken: "" });
    coordinator.stop(investigation.id, store.dri.require(investigation.id).revision);
    coordinator.resume(investigation.id, store.dri.require(investigation.id).revision);
    coordinator.stop(investigation.id, store.dri.require(investigation.id).revision);
    const liveGeneration = store.dri.require(investigation.id).generation;
    store.replaceHostBackup(early);
    expect(store.dri.require(investigation.id).generation).toBeGreaterThan(
      liveGeneration,
    );
    expect(store.dri.cleanup(Date.now() + 400 * 86_400_000, 1)).toBe(1);
    expect(store.getRun(investigation.runId)).toBeDefined();
    expect(store.dri.get(investigation.id)).toBeUndefined();
  });
  it("keeps private hints and adapter pivots out of persistence and public query context", async () => {
    const seen: string[] = [];
    const { store, coordinator } = harness({
      fixtures: fixtureProviders({
        delay: async (context) => {
          if (context.query.capability === "incident.read")
            context.recordPrivateBindings?.({ correlation: "synthetic-private-pivot" });
          if (context.query.capability === "telemetry.query") {
            seen.push(
              context.privateBindings.telemetryCluster ?? "",
              context.privateBindings.correlation ?? "",
            );
          }
        },
      }),
    });
    const investigation = create(coordinator, {
      telemetryCluster: "synthetic-private-cluster",
    });
    await coordinator.execute(investigation.id);
    expect(seen).toEqual(["synthetic-private-cluster", "synthetic-private-pivot"]);
    const persisted = JSON.stringify(store.exportHostBackup({ enrollmentToken: "" }));
    expect(persisted).not.toContain("synthetic-private-cluster");
    expect(persisted).not.toContain("synthetic-private-pivot");
  });
  it("fails atomically when the evidence budget is exhausted without stranding running work", async () => {
    const { store, coordinator } = harness({ limits: { maxEvidence: 1 } });
    const investigation = create(coordinator);
    await coordinator.execute(investigation.id);
    expect(store.dri.require(investigation.id).status).toBe("failed");
    expect(store.getRun(investigation.runId)!.state).toBe("failed");
    expect(
      store.dri
        .all(investigation.id, "queries")
        .every((query) => query.state !== "running"),
    ).toBe(true);
    expect(
      store.dri.all(investigation.id, "work").every((work) => work.state !== "running"),
    ).toBe(true);
  });
});
