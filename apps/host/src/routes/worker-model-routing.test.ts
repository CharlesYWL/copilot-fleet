import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionProviderSchema, UpdateWorkerRoutingSchema } from "@fleet/protocol";
import type { FleetAuth } from "../auth/service.js";
import { fleet } from "../orchestrator/fleet-harness.js";
import { WorkerModelRoutingService } from "../worker-model-routing.js";
import { workerModelRoutingRoutes } from "./worker-model-routing.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const f = fleet();
  const app = Fastify({ logger: false });
  let noAuth = false;
  const auth = {
    administratorFor: () => ({ id: "admin" }),
    requireRecentReauth: vi.fn(
      (session: { tokenHash: string }) => session.tokenHash === "fresh",
    ),
    noAuthEnabled: () => noAuth,
    noAuthEndpointAllowed: (host: string | undefined) => host === "localhost",
    audit: vi.fn(),
  } as unknown as FleetAuth;
  app.addHook("onRequest", async (request) => {
    const freshness = request.headers["fixture-admin"];
    if (typeof freshness === "string")
      request.fleetSession = {
        tokenHash: freshness,
        administratorId: "admin",
        authMethod: "microsoft-code",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
  });
  app.setErrorHandler((error, _request, reply) => {
    const code =
      error && typeof error === "object" && "statusCode" in error
        ? Number(error.statusCode)
        : 400;
    reply
      .code(code)
      .send({ error: error instanceof Error ? error.message : "Request failed" });
  });
  const evaluate = vi.fn(async (_provider, _key, payload) => {
    const ids = Object.keys(payload.questions.profile.criteria);
    return {
      profileId: ids[0]!,
      probabilities: { [ids[0]!]: 0.9, [ids[1]!]: 0.1 },
      returnedModel: "actual-decision-model",
      usage: null,
    };
  });
  const routing = new WorkerModelRoutingService(f.store, app.log, undefined, {
    evaluate,
    rateIntervalMs: 0,
  });
  await app.register(workerModelRoutingRoutes, { routing, auth });
  cleanups.push(async () => {
    routing.reset();
    await app.close();
    f.store.close();
  });
  return {
    ...f,
    app,
    auth,
    routing,
    evaluate,
    setNoAuth: (value: boolean) => {
      noAuth = value;
    },
  };
}

const draft = {
  provider: DecisionProviderSchema.parse({
    id: "primary",
    name: "Primary",
    kind: "foundry",
    endpoint: "https://demo.services.ai.azure.com",
    model: "Exact-Deployment",
  }),
  keyAction: "replace" as const,
  key: "private-route-fixture-key",
};
const update = () =>
  UpdateWorkerRoutingSchema.parse({
    expectedRevision: 0,
    mode: "off",
    minProbability: 0.5,
    timeoutMs: 5000,
    profiles: [],
    providers: [draft],
  });

describe("decision settings operator boundary", () => {
  it("refuses reads, tests and changes from an unauthenticated or MCP-only caller", async () => {
    const h = await setup();
    for (const [method, url, payload] of [
      ["GET", "/api/worker-model-routing", undefined],
      ["POST", "/api/worker-model-routing/test", draft],
      ["PUT", "/api/worker-model-routing", update()],
    ] as const) {
      const result = await h.app.inject({
        method,
        url,
        headers: { authorization: "Bearer a-lead-token-is-not-an-operator" },
        ...(payload ? { payload } : {}),
      });
      expect(result.statusCode).toBe(403);
      expect(result.body).not.toContain("private-route-fixture-key");
    }
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.routing.view().providers).toHaveLength(0);
  });

  it("allows an authenticated operator to save repeatedly without recent reauthentication or key disclosure", async () => {
    const h = await setup();
    const stale = await h.app.inject({
      method: "PUT",
      url: "/api/worker-model-routing",
      headers: { "fixture-admin": "stale" },
      payload: update(),
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().reauthRequired).toBeUndefined();
    expect(stale.body).not.toContain("private-route-fixture-key");
    expect(h.evaluate).not.toHaveBeenCalled();
    const saved = await h.app.inject({
      method: "PUT",
      url: "/api/worker-model-routing",
      headers: { "fixture-admin": "stale" },
      payload: { ...update(), expectedRevision: stale.json().revision },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("private-route-fixture-key");
    const read = await h.app.inject({
      url: "/api/worker-model-routing",
      headers: { "fixture-admin": "stale" },
    });
    expect(read.json().providers[0]).toMatchObject({ keyConfigured: true, ready: false });
    expect(read.body).not.toContain("private-route-fixture-key");
    expect(h.auth.requireRecentReauth).not.toHaveBeenCalled();
    expect(h.auth.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "worker_model_routing_updated",
        outcome: "success",
      }),
    );
  });

  it("tests a draft without enabling routing or starting a session", async () => {
    const h = await setup();
    const result = await h.app.inject({
      method: "POST",
      url: "/api/worker-model-routing/test",
      headers: { "fixture-admin": "stale" },
      payload: draft,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      success: true,
      returnedModel: "actual-decision-model",
    });
    expect(result.body).not.toContain("private-route-fixture-key");
    expect(h.routing.view()).toMatchObject({ mode: "off", revision: 0, providers: [] });
    expect(h.store.listSessions()).toHaveLength(1);
  });

  it("retains only deliberately restricted localhost operations in no-auth mode", async () => {
    const h = await setup();
    h.setNoAuth(true);
    expect(
      (
        await h.app.inject({
          url: "/api/worker-model-routing",
          headers: { host: "public.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          url: "/api/worker-model-routing",
          headers: { host: "localhost" },
        })
      ).statusCode,
    ).toBe(200);
  });
});
