import type { FastifyInstance, InjectOptions } from "fastify";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  DriBackupSchema,
  DriEvidenceSchema,
  type DriInvestigation,
  type DriQuery,
  type DriPage,
  type DriProposalScope,
} from "@fleet/protocol";
import { buildServer } from "../server.js";
import { FleetStore } from "../store.js";
import { fixtureProviders } from "../dri/fixtures.js";
import { DriStore } from "../dri/store.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const client = "22222222-2222-4222-8222-222222222222";

describe("DRI review fixes through authenticated Host routes", () => {
  let app: FastifyInstance;
  let store: FleetStore;
  let createRunSpy: MockInstance<FleetStore["createRun"]>;
  let csrf = "";
  let hold = false;
  let release!: () => void;
  const cookies = new Map<string, string>();
  const request = async (options: InjectOptions) => {
    const reply = await app.inject({
      ...options,
      headers: {
        cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
        "x-csrf-token": csrf,
        ...options.headers,
      },
    });
    const raw = reply.headers["set-cookie"];
    for (const entry of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const [key, ...value] = String(entry).split(";")[0]!.split("=");
      if (key) cookies.set(key, value.join("="));
    }
    return reply;
  };
  const head = async (id: string) =>
    (await request({ url: `/api/dri/${id}` })).json<{ investigation: DriInvestigation }>()
      .investigation;
  const create = async (mode = "fixture") => {
    const reply = await request({
      method: "POST",
      url: "/api/dri",
      payload: { icm: "42", mode },
    });
    expect(reply.statusCode, reply.body).toBe(201);
    store = createRunSpy.mock.contexts[0] as FleetStore;
    return reply.json<DriInvestigation>();
  };
  const settle = async (id: string) => {
    await vi.waitFor(async () =>
      expect(
        ["awaiting_review", "partial", "blocked"].includes((await head(id)).status),
      ).toBe(true),
    );
    return head(id);
  };
  beforeEach(async () => {
    cookies.clear();
    csrf = "";
    hold = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    createRunSpy = vi.spyOn(FleetStore.prototype, "createRun");
    let code = "";
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "synthetic-review-token",
      operatorPassword: "",
      useBuiltInEntra: false,
      announceClaimCode: (value) => {
        code = value;
      },
      dri: {
        allowFixtures: true,
        fixtures: fixtureProviders({
          delay: async (context) => {
            if (hold && context.query.capability === "incident.read") await gate;
          },
        }),
      },
      entraProvider: () => ({
        authorizationUrl: async ({ state }) =>
          `https://login.example.invalid/authorize?state=${state}`,
        redeemAuthorizationCode: async () => ({
          tenantId: tenant,
          objectId: "fixture-operator",
          username: "fixture@example.invalid",
          displayName: "Fixture Operator",
        }),
        startDeviceCode: async () => {
          throw new Error("Not used");
        },
        pollDeviceCode: async () => {
          throw new Error("Not used");
        },
        cancelDeviceCode: () => {},
      }),
    });
    app.log.level = "silent";
    await app.ready();
    expect(
      (await request({ method: "POST", url: "/api/auth/bootstrap", payload: { code } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await request({
          method: "POST",
          url: "/api/auth/configure",
          payload: { tenantId: tenant, clientId: client },
        })
      ).statusCode,
    ).toBe(200);
    const start = await request({
      method: "POST",
      url: "/api/auth/code/start",
      payload: {},
    });
    const state = new URL(
      start.json<{ authorizationUrl: string }>().authorizationUrl,
    ).searchParams.get("state");
    expect(
      (await request({ url: `/api/auth/entra/callback?code=fixture&state=${state}` }))
        .statusCode,
    ).toBe(302);
    csrf = (await request({ url: "/api/auth/csrf" })).json<{ csrfToken: string }>()
      .csrfToken;
  });
  afterEach(async () => {
    release();
    await app.close();
    vi.restoreAllMocks();
  });

  it("returns explicit limited sections from both backup routes instead of parse errors", async () => {
    const item = await create();
    await settle(item.id);
    const original = DriStore.prototype.export;
    vi.spyOn(store.dri, "export").mockImplementation(() =>
      original.call(store.dri, { records: 0 }),
    );
    for (const options of [
      { url: "/api/backup" },
      {
        method: "POST" as const,
        url: "/api/backup/portable",
        payload: { passphrase: "synthetic-backup-passphrase" },
      },
    ]) {
      const reply = await request(options);
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.headers["x-fleet-dri-backup-state"]).toBe("limited");
      const body = reply.json<{ dri: unknown; workspaces: unknown[] }>();
      expect(DriBackupSchema.parse(body.dri).coverage?.state).toBe("limited");
      expect(body.workspaces.length).toBeGreaterThan(0);
    }
  });
  it("isolates exporter failures in both backup routes without revealing the error or claiming completeness", async () => {
    await create();
    vi.spyOn(store.dri, "export").mockImplementation(() => {
      throw new Error("synthetic-private-provider-error");
    });
    for (const options of [
      { url: "/api/backup" },
      {
        method: "POST" as const,
        url: "/api/backup/portable",
        payload: { passphrase: "synthetic-backup-passphrase" },
      },
    ]) {
      const reply = await request(options);
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.headers["x-fleet-dri-backup-state"]).toBe("degraded");
      expect(reply.body).not.toContain("synthetic-private-provider-error");
      expect(
        reply.json<{ dri: { coverage: { state: string } } }>().dri.coverage.state,
      ).toBe("degraded");
    }
  });
  it("protects active, awaiting and approved investigations; permits only post-expiry/non-DRI deletion", async () => {
    hold = true;
    const item = await create();
    expect(
      (await request({ method: "DELETE", url: `/api/runs/${item.runId}` })).statusCode,
    ).toBe(409);
    expect(store.dri.all(item.id, "queries")[0]!.state).toBe("running");
    hold = false;
    release();
    const awaiting = await settle(item.id);
    const report = store.dri.all(item.id, "reports")[0]!;
    const evidence = store.dri.all(item.id, "evidence");
    expect(
      (await request({ method: "DELETE", url: `/api/runs/${item.runId}` })).statusCode,
    ).toBe(409);
    expect(
      (
        await request({
          method: "POST",
          url: `/api/dri/${item.id}/complete`,
          headers: { "if-match": `"${awaiting.revision}"` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request({ method: "DELETE", url: `/api/runs/${item.runId}` })).statusCode,
    ).toBe(409);
    expect(store.dri.all(item.id, "reports")[0]).toEqual(report);
    expect(store.dri.all(item.id, "evidence")).toEqual(evidence);
    const retain = async (legalHold: boolean) =>
      request({
        method: "PATCH",
        url: `/api/dri/${item.id}/retention`,
        headers: { "if-match": `"${(await head(item.id)).revision}"` },
        payload: { legalHold },
      });
    expect((await retain(true)).statusCode).toBe(200);
    expect(store.dri.cleanup(Date.now() + 400 * 86_400_000)).toBe(0);
    expect(
      (await request({ method: "DELETE", url: `/api/runs/${item.runId}` })).statusCode,
    ).toBe(409);
    expect((await retain(false)).statusCode).toBe(200);
    expect(store.dri.cleanup(Date.now() + 400 * 86_400_000)).toBe(1);
    expect(
      (await request({ method: "DELETE", url: `/api/runs/${item.runId}` })).statusCode,
    ).toBe(204);
    expect(store.dri.tombstones(item.runId)).toHaveLength(1);
    const ordinary = store.createRun({
      workspaceId: "chats",
      name: "ordinary",
      objective: "ordinary",
    });
    expect(
      (await request({ method: "DELETE", url: `/api/runs/${ordinary.id}` })).statusCode,
    ).toBe(204);
  });
  it("binds proposals to independent Run, step, producer-session and attempt receipts", async () => {
    hold = true;
    const first = await create();
    const other = await create();
    const query = (await request({ url: `/api/dri/${first.id}/queries` })).json<
      DriPage<DriQuery>
    >().items[0]!;
    const scope: DriProposalScope = {
      runId: first.runId,
      stepId: query.stepId,
      producerAgentId: query.agentId,
      producerSessionId: "",
      stepAttempt: store.getRunStep(query.stepId)!.attempts,
      attempt: query.attempt,
      generation: query.generation,
      invocationId: query.id,
    };
    const { node } = store.registerNode({
      name: "synthetic-producer",
      os: "win32",
      arch: "x64",
      version: "1",
      capabilities: [],
      maxSessions: 1,
    });
    const workspace = store.createWorkspace("synthetic-producer", "");
    const placement = store.createPlacement(
      workspace.id,
      node.id,
      "C:\\synthetic-fixture",
    );
    const foreignSession = store.createSession(placement, "synthetic", false, "", {
      runId: other.runId,
      runRole: "worker",
    });
    const record = DriEvidenceSchema.parse({
      id: "operator-proposal",
      investigationId: first.id,
      profileId: first.profile.profileId,
      generation: query.generation,
      attempt: query.attempt,
      invocationId: query.id,
      createdAt: query.createdAt,
      kind: "evidence",
      type: "incident",
      providerId: query.providerId,
      source: query.template,
      reference: "evidence:proposal",
      observedAt: query.createdAt,
      identifiers: [],
      finding: "Synthetic scoped observation",
      hypothesisIds: [],
      confidence: 0.5,
      completeness: "partial",
      limitation: "",
      producerAgentId: query.agentId,
      sensitivity: "synthetic",
      redactionVersion: "dri-redaction-v1",
      provenance: {
        sourceVersion: "1",
        collectedAt: query.createdAt,
        contentHash: "a".repeat(64),
      },
      dedupeKey: "operator-proposal",
      signals: [],
    });
    const post = async (coordinates: DriProposalScope) =>
      request({
        method: "POST",
        url: `/api/dri/${first.id}/proposals`,
        headers: { "if-match": `"${(await head(first.id)).revision}"` },
        payload: { scope: coordinates, record },
      });
    expect((await post({ ...scope, runId: other.runId })).statusCode).toBe(403);
    expect(
      (await post({ ...scope, producerSessionId: foreignSession.id })).statusCode,
    ).toBe(403);
    store.updateRunStep(query.stepId, { sessionId: foreignSession.id });
    expect(
      (await post({ ...scope, producerSessionId: foreignSession.id })).statusCode,
    ).toBe(403);
    store.updateRunStep(query.stepId, { sessionId: "" });
    expect(
      (await post({ ...scope, stepId: store.dri.all(other.id, "queries")[0]!.stepId }))
        .statusCode,
    ).toBe(403);
    expect((await post({ ...scope, producerAgentId: "another-agent" })).statusCode).toBe(
      403,
    );
    expect((await post({ ...scope, attempt: scope.attempt + 1 })).statusCode).toBe(409);
    expect(
      (await post({ ...scope, stepAttempt: scope.stepAttempt + 1 })).statusCode,
    ).toBe(403);
    expect((await post(scope)).statusCode).toBe(200);
    expect(store.dri.record(first.id, "evidence", record.id)).toBeDefined();
  });
  it("advertises MCP registration and explicit test fixtures without hiding missing live capabilities", async () => {
    const availability = (await request({ url: "/api/dri/profiles" })).json<{
      availability: unknown;
    }>().availability;
    expect(availability).toEqual({
      fixtureEnabled: true,
      liveRegistration: "mcp_catalog",
      liveProvidersConfigured: false,
    });
    const item = await settle((await create("live")).id);
    expect(item.status).toBe("blocked");
    expect(item.limitation).toContain("incident.read");
    expect(item.readiness).toHaveLength(6);
    expect(
      item.readiness.every(
        (entry) => entry.state === "unavailable" && entry.setup.includes("MCP"),
      ),
    ).toBe(true);
    expect(store.dri.invocationCount(item.id)).toBe(0);
  });
});
