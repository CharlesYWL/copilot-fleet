import Fastify, { type InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriInvestigation, OrchestrationCreationResult, Run } from "@fleet/protocol";
import { buildServer } from "../server.js";
import { fleet } from "../orchestrator/fleet-harness.js";
import { OrchestratorEngine } from "../orchestrator/engine.js";
import { OrchestrationCreationService } from "../orchestrator/creation.js";
import { DriCoordinator } from "../dri/coordinator.js";
import { fixtureProviders } from "../dri/fixtures.js";
import type { DriMcpOptions } from "../dri/mcp.js";
import { ProviderPageSchema, type DiscoveredMcpClient } from "../dri/providers.js";
import { orchestratorRoutes } from "./orchestrators.js";
import { orchestrationCreationRoutes } from "./orchestration-creation.js";
import { runRoutes } from "./runs.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function authenticated(synthetic = false, mcp?: DriMcpOptions) {
  const app = await buildServer({
    databasePath: ":memory:",
    operatorPassword: "synthetic-auto-dri-password",
    announceClaimCode: () => {},
    useBuiltInEntra: false,
    mcp: mcp ?? { catalog: { mcpServers: {} } },
    dri: { allowFixtures: true, fixtures: fixtureProviders({}) },
    testDriRouting: synthetic,
  });
  cleanups.push(() => app.close());
  app.log.level = "silent";
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: "synthetic-auto-dri-password" },
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const csrf = (await app.inject({ url: "/api/auth/csrf", headers: { cookie } })).json<{
    csrfToken: string;
  }>();
  return {
    app,
    cookie,
    request: (options: InjectOptions) =>
      app.inject({
        ...options,
        headers: { cookie, "x-csrf-token": csrf.csrfToken, ...options.headers },
      }),
  };
}
const payload = {
  workspaceId: "chats",
  name: "Automatic DRI",
  objective:
    "Investigate ICM 123456789, analyze the HAR and telemetry, and determine root cause.",
  requestId: "synthetic-request",
};
async function settled(
  request: Awaited<ReturnType<typeof authenticated>>["request"],
  id: string,
) {
  let item: DriInvestigation | undefined;
  await vi.waitFor(async () => {
    const response = await request({ url: `/api/dri/${id}` });
    item = response.json<{ investigation: DriInvestigation }>().investigation;
    expect(["blocked", "partial", "awaiting_review", "failed"]).toContain(item.status);
  });
  return item!;
}

describe("normal orchestration routing APIs", () => {
  it("inherits authentication/CSRF and keeps preview side-effect free", async () => {
    const { app, cookie, request } = await authenticated();
    expect(
      (await app.inject({ method: "POST", url: "/api/orchestrations/preview", payload }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/orchestrations",
          headers: { cookie },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const preview = await request({
      method: "POST",
      url: "/api/orchestrations/preview",
      payload,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ route: "dri", incident: { id: "123456789" } });
    expect(
      (await request({ url: "/api/runs" })).json<{ runs: Run[] }>().runs,
    ).toHaveLength(0);
  });
  it("automatically creates one synthetic test-injected Investigation+Run through ordinary creation", async () => {
    const { request } = await authenticated(true);
    const [first, replay] = await Promise.all([
      request({ method: "POST", url: "/api/orchestrations", payload }),
      request({ method: "POST", url: "/api/orchestrations", payload }),
    ]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const result = first.json<OrchestrationCreationResult>();
    expect(result).toMatchObject({ kind: "created", workflow: "dri" });
    if (result.kind !== "created" || result.workflow !== "dri")
      throw new Error("Missing routed DRI");
    expect((await settled(request, result.investigation.id)).status).toBe(
      "awaiting_review",
    );
    const runs = (await request({ url: "/api/runs" })).json<{
      runs: Run[];
      stepsByRunId: Record<string, unknown[]>;
    }>();
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]!.investigationId).toBe(result.investigation.id);
    expect(runs.stepsByRunId[result.run.id]).toHaveLength(8);
    expect(
      (await request({ method: "DELETE", url: `/api/runs/${result.run.id}` })).statusCode,
    ).toBe(409);
  });
  it("persists blocked live readiness rather than using enabled fixtures when MCP is absent", async () => {
    const { request } = await authenticated();
    const response = await request({
      method: "POST",
      url: "/api/orchestrations",
      payload,
    });
    const result = response.json<OrchestrationCreationResult>();
    if (result.kind !== "created" || result.workflow !== "dri")
      throw new Error(response.body);
    const item = await settled(request, result.investigation.id);
    expect(item.mode).toBe("live");
    expect(item.status).toBe("blocked");
    expect(item.readiness.map((entry) => entry.capability)).toHaveLength(6);
    expect(item.readiness.every((entry) => entry.state === "unavailable")).toBe(true);
    expect(
      (await request({ url: `/api/dri/${item.id}/queries` })).json<{ items: unknown[] }>()
        .items,
    ).toHaveLength(0);
    const backup = (await request({ url: "/api/backup" })).json<{
      runs: Run[];
      dri: { investigations: DriInvestigation[] };
    }>();
    expect(backup.dri.investigations[0]?.readiness).toEqual(item.readiness);
    expect(backup.runs[0]?.creationReceipt).toEqual(result.run.creationReceipt);
  });
  it("requires correction for ambiguity, and rejects attempts to select fixtures/tools via input", async () => {
    const { request } = await authenticated();
    const ambiguous = await request({
      method: "POST",
      url: "/api/orchestrations",
      payload: { ...payload, objective: "Investigate incident 123456789." },
    });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toMatchObject({
      kind: "confirmation_required",
      classification: { route: "ambiguous" },
    });
    for (const extra of [
      { mode: "fixture" },
      { tool: "update_incident" },
      { dri: { mode: "fixture" } },
    ])
      expect(
        (
          await request({
            method: "POST",
            url: "/api/orchestrations",
            payload: { ...payload, ...extra },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (await request({ url: "/api/runs" })).json<{ runs: Run[] }>().runs,
    ).toHaveLength(0);
    expect(
      (
        await request({
          method: "POST",
          url: "/api/orchestrations",
          payload: {
            ...payload,
            objective: "Investigate incident 123456789.",
            workflow: "dri",
            dri: { icm: "123456789" },
          },
        })
      ).statusCode,
    ).toBe(201);
  });
  it("auto-routes through configured read-only MCP discovery and retains partial live evidence", async () => {
    const call = vi.fn<DiscoveredMcpClient["call"]>(async () => ({
      structuredContent: ProviderPageSchema.parse({
        state: "succeeded",
        summary: "Synthetic normalized MCP integration test",
        incident: {
          summary: "Synthetic incident",
          symptom: "Synthetic service failure",
          impact: "Synthetic impact",
          scope: "Synthetic scope",
          owningService: "Verified generic service",
          component: "Verified component",
          ownershipVerified: true,
          startedAt: "2025-01-01T00:00:00.000Z",
          identifiers: [],
          resources: [],
          attachments: [],
          details: [],
          completeness: "complete",
        },
        evidence: [
          {
            type: "incident",
            finding: "Synthetic scoped incident evidence",
            observedAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      }),
    }));
    const discover = vi.fn<DiscoveredMcpClient["discover"]>(async () => [
      {
        name: "get_incident_details_by_id",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { scope: { type: "object" } },
          required: ["scope"],
        },
      },
    ]);
    const { request } = await authenticated(false, {
      catalog: {
        mcpServers: {
          normalized: {
            type: "http",
            url: "https://synthetic.invalid/mcp",
            _meta: {
              "fleet/dri": {
                version: 1,
                bindings: [
                  {
                    capability: "incident.read",
                    tool: "get_incident_details_by_id",
                    arguments: { scope: "scope" },
                    response: "provider-page-v1",
                  },
                ],
              },
            },
          },
        },
      },
      connect: async (_server, _bytes, _signal, work) => work({ discover, call }),
    });
    const response = await request({
      method: "POST",
      url: "/api/orchestrations",
      payload,
    });
    const result = response.json<OrchestrationCreationResult>();
    if (result.kind !== "created" || result.workflow !== "dri")
      throw new Error(response.body);
    const item = await settled(request, result.investigation.id);
    expect(item).toMatchObject({
      mode: "live",
      status: "partial",
      profile: { profileId: "generic" },
    });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "get_incident_details_by_id",
      expect.objectContaining({
        scope: expect.objectContaining({ incidentId: "123456789" }),
      }),
      expect.any(AbortSignal),
    );
    expect(
      item.readiness.find((entry) => entry.capability === "incident.read")?.state,
    ).toBe("ready");
    expect(item.readiness.filter((entry) => entry.state === "unavailable")).toHaveLength(
      5,
    );
  });
  it("bounds API inputs and emits safe errors instead of raw input/schema envelopes", async () => {
    const { request } = await authenticated();
    for (const extra of [
      { objective: "x".repeat(4_001) },
      { "synthetic-private-key": "synthetic-private-value" },
    ]) {
      const response = await request({
        method: "POST",
        url: "/api/orchestrations",
        payload: { ...payload, ...extra },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("synthetic-private");
    }
    expect(
      (
        await request({
          method: "POST",
          url: "/api/orchestrations",
          payload: { ...payload, objective: "x".repeat(32_769) },
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (await request({ url: "/api/runs" })).json<{ runs: Run[] }>().runs,
    ).toHaveLength(0);
  });
  it("routes the existing lead endpoint and preserves both legacy regular entry points", async () => {
    const state = fleet();
    const engine = new OrchestratorEngine(state.service);
    const dri = new DriCoordinator(state.service, {
      allowFixtures: true,
      fixtures: fixtureProviders({}),
    });
    const creation = new OrchestrationCreationService(state.service, engine, dri, true);
    const app = Fastify({ logger: false });
    cleanups.push(async () => {
      await app.close();
      await dri.shutdown();
      state.service.shutdown();
      state.store.close();
    });
    await app.register(orchestratorRoutes, { service: state.service, engine, creation });
    await app.register(orchestrationCreationRoutes, { creation });
    await app.register(runRoutes, { service: state.service, engine, creation });
    const workspaceId = state.store.getSession(state.leadId)!.workspaceId;
    const routed = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${state.leadId}/runs`,
      payload: { ...payload, workspaceId },
    });
    expect(routed.statusCode).toBe(201);
    expect(routed.json()).toMatchObject({
      workflow: "dri",
      run: { leadSessionId: state.leadId },
    });
    const regularInput = {
      workspaceId,
      name: "Docs",
      objective: "Update the README with instructions for investigating ICM incidents.",
    };
    const regular = await app.inject({
      method: "POST",
      url: `/api/orchestrators/${state.leadId}/runs`,
      payload: regularInput,
    });
    expect(regular.statusCode).toBe(201);
    expect(regular.json()).toMatchObject({
      workflow: "regular",
      run: { state: "running", leadSessionId: state.leadId },
    });
    expect(regular.json<{ run: Run }>().run.investigationId).toBeUndefined();
    const standalone = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: regularInput,
    });
    expect(standalone.statusCode).toBe(201);
    expect(standalone.json()).toMatchObject({ name: "Docs", state: "awaiting_approval" });
    expect(standalone.json<Run>().investigationId).toBeUndefined();
  });
  it("refuses non-isolated synthetic routing composition", async () => {
    await expect(
      buildServer({
        databasePath: ":memory:",
        testDriRouting: true,
        announceClaimCode: () => {},
      }),
    ).rejects.toThrow(/explicitly injected/);
  });
});
