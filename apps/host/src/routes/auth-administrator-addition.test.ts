import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { registerRequestGuard } from "../request-guard.js";
import { FleetStore, type OperatorAuthMethod } from "../store.js";
import type { EntraIdentity } from "../auth/entra.js";
import { FleetAuth } from "../auth/service.js";
import { RECENT_REAUTH_MS } from "../auth/sessions.js";
import { authRoutes } from "./auth.js";

const START = "/api/auth/administrators/add/start";
const HOST = "localhost:8787";
const UI = "http://localhost:5173";
const CONFIG = {
  tenantId: "common",
  clientId: "11111111-2222-3333-4444-555555555555",
};
const OWNER: EntraIdentity = {
  tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
  objectId: "owner",
  username: "owner@example.com",
  displayName: "Owner",
};
const ADDED: EntraIdentity = {
  tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad",
  objectId: "personal",
  username: "personal@outlook.com",
  displayName: "Another account",
};
const resources: { app: FastifyInstance; store: FleetStore }[] = [];

afterEach(async () => {
  for (const { app, store } of resources.splice(0)) {
    await app.close();
    store.close();
  }
});

async function setup(
  authMethod: OperatorAuthMethod = "microsoft-code",
  uiOrigin?: string,
) {
  const store = new FleetStore(":memory:");
  const app = Fastify();
  resources.push({ app, store });
  store.setSetting("auth.entraTenantId", CONFIG.tenantId);
  store.setSetting("auth.entraClientId", CONFIG.clientId);
  const owner = store.insertAdministrator({ ...OWNER, addedVia: "claim" });
  let now = Date.now();
  const redeem = vi.fn(async () => ADDED);
  const auth = new FleetAuth({
    store,
    now: () => now,
    announceClaimCode: () => {},
    warn: () => {},
    externalScheme: {
      publicUrl: () => "https://fleet.example.com",
      tunnels: () => [],
    },
    entraProvider: () => ({
      authorizationUrl: async ({ state }) =>
        `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${state}`,
      redeemAuthorizationCode: redeem,
      startDeviceCode: async () => {
        throw new Error("Not enabled");
      },
      pollDeviceCode: redeem,
      cancelDeviceCode: () => {},
    }),
  });
  const shared = authMethod === "password" || authMethod === "recovery";
  if (shared) auth.enablePassword("test-password-for-shared-session", owner.id);
  const source = auth.sessions.issue({
    administratorId: shared ? "" : owner.id,
    authMethod,
  });
  const headers = {
    host: HOST,
    cookie: `fleet_operator=${source.token}; fleet_bind=browser`,
    "x-csrf-token": auth.sessions.csrfToken(source.tokenHash),
  };
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof ZodError ? 400 : 500).send({ error: "Invalid request" });
  });
  registerRequestGuard(app, {
    store,
    auth,
    allowlist: { publicUrl: () => "https://fleet.example.com" },
  });
  await app.register(authRoutes, { auth, uiOrigin });
  await app.ready();
  const start = () => app.inject({ method: "POST", url: START, headers, payload: {} });
  const begin = async () => {
    const started = await start();
    expect(started.statusCode).toBe(200);
    return (
      new URL(
        started.json<{ authorizationUrl: string }>().authorizationUrl,
      ).searchParams.get("state") ?? ""
    );
  };
  const callback = (state: string, query = "code=add-code", binding = "browser") =>
    app.inject({
      method: "GET",
      url: `/api/auth/entra/callback?state=${encodeURIComponent(state)}&${query}`,
      // A Microsoft redirect carries the Lax binding, not the Strict operator cookie.
      headers: { host: HOST, cookie: `fleet_bind=${binding}` },
    });
  return {
    app,
    auth,
    store,
    source,
    headers,
    owner,
    redeem,
    start,
    begin,
    callback,
    advance: (ms: number) => void (now += ms),
  };
}

describe("administrator addition routes", () => {
  it.each([undefined, UI])(
    "preserves the operator cookie and redirects to %s",
    async (uiOrigin) => {
      const h = await setup("microsoft-code", uiOrigin);
      const originalSession = h.store.getOperatorSession(h.source.tokenHash);
      const completed = await h.callback(await h.begin());
      const added = h.store.findAdministrator(ADDED.tenantId, ADDED.objectId);
      expect(added).toBeDefined();
      expect(completed.statusCode).toBe(302);
      expect(completed.headers.location).toBe(
        `${uiOrigin ?? ""}/?administrator_added=${encodeURIComponent(added?.id ?? "")}`,
      );
      expect(completed.headers["set-cookie"]).toBeUndefined();
      expect(h.store.countOperatorSessions()).toBe(1);
      expect(h.store.getOperatorSession(h.source.tokenHash)).toEqual(originalSession);
      expect(h.auth.sessions.csrfToken(h.source.tokenHash)).toBe(
        h.headers["x-csrf-token"],
      );
      const status = await h.app.inject({
        method: "GET",
        url: "/api/auth/status",
        headers: h.headers,
      });
      expect(status.json()).toMatchObject({
        authenticated: true,
        identity: { username: OWNER.username },
      });
      const listing = await h.app.inject({
        method: "GET",
        url: "/api/auth/administrators",
        headers: h.headers,
      });
      expect(listing.json().administrators).toContainEqual(
        expect.objectContaining({ id: added?.id, username: ADDED.username }),
      );
      expect(
        (
          await h.app.inject({
            method: "GET",
            url: "/api/auth/status",
            headers: { host: HOST, cookie: "fleet_bind=browser" },
          })
        ).json(),
      ).toMatchObject({ authenticated: false });
    },
  );

  it("requires an operator cookie and CSRF proof before starting", async () => {
    const h = await setup();
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: START,
          payload: {},
          headers: { host: HOST },
        })
      ).statusCode,
    ).toBe(401);
    for (const csrf of [undefined, "incorrect"]) {
      expect(
        (
          await h.app.inject({
            method: "POST",
            url: START,
            payload: {},
            headers: {
              host: HOST,
              cookie: h.headers.cookie,
              ...(csrf ? { "x-csrf-token": csrf } : {}),
            },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(h.auth.transactions.size()).toBe(0);
    expect(h.redeem).not.toHaveBeenCalled();
    expect((await h.start()).statusCode).toBe(200);
  });

  it.each(["password", "recovery", "microsoft-device"] as const)(
    "refuses an existing %s session",
    async (method) => {
      const h = await setup(method);
      const response = await h.start();
      expect(response.statusCode).toBe(403);
      if (method === "microsoft-device") {
        expect(response.json()).toMatchObject({ reauthRequired: true });
      }
      expect(h.auth.transactions.size()).toBe(0);
      expect(h.auth.listAdministrators()).toHaveLength(1);
    },
  );

  it("returns the standard reauthRequired response when authorization is stale", async () => {
    const h = await setup();
    h.advance(RECENT_REAUTH_MS);
    const response = await h.start();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reauthRequired: true });
    expect(h.auth.transactions.size()).toBe(0);
  });

  it.each([
    { host: "127.0.0.1:8787", expected: { canonicalUrl: `http://${HOST}` } },
    { host: "fleet.example.com", expected: { localForwardRequired: true } },
  ])("requires a usable localhost callback on $host", async ({ host, expected }) => {
    const h = await setup();
    const response = await h.app.inject({
      method: "POST",
      url: START,
      payload: {},
      headers: { ...h.headers, host },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject(expected);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(h.auth.transactions.size()).toBe(0);
  });

  it("creates a browser binding without changing the operator cookie", async () => {
    const h = await setup();
    const started = await h.app.inject({
      method: "POST",
      url: START,
      payload: {},
      headers: { ...h.headers, cookie: `fleet_operator=${h.source.token}` },
    });
    expect(started.statusCode).toBe(200);
    expect(started.headers["set-cookie"]).toEqual(expect.stringContaining("fleet_bind="));
    expect(started.headers["set-cookie"]).toEqual(
      expect.stringContaining("SameSite=Lax"),
    );
    expect(started.headers["set-cookie"]).not.toContain("fleet_operator");
  });

  it("accepts only empty JSON rather than a client-provided identity or invitation", async () => {
    const h = await setup();
    for (const payload of [
      { ...ADDED },
      { invitation: "reusable-token" },
      { administratorId: h.owner.id },
    ]) {
      expect(
        (
          await h.app.inject({
            method: "POST",
            url: START,
            headers: h.headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(h.auth.transactions.size()).toBe(0);
  });

  it.each(["logout", "wrong binding", "cancel", "expiry"] as const)(
    "uses sanitized auth_error redirects after %s without adding an account",
    async (failure) => {
      const h = await setup("microsoft-code", UI);
      const state = await h.begin();
      if (failure === "logout") {
        expect(
          (
            await h.app.inject({
              method: "POST",
              url: "/api/auth/logout",
              headers: h.headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
      }
      if (failure === "expiry") h.advance(RECENT_REAUTH_MS);
      const completed = await h.callback(
        state,
        failure === "cancel"
          ? "error=access_denied&error_description=private%40outlook.com"
          : "code=add-code",
        failure === "wrong binding" ? "elsewhere" : "browser",
      );
      expect(completed.statusCode).toBe(302);
      const location = new URL(String(completed.headers.location));
      expect(location.origin).toBe(UI);
      expect(location.searchParams.get("auth_error")).toBe(
        failure === "logout"
          ? "not-authorized"
          : failure === "cancel"
            ? "cancelled"
            : "expired",
      );
      expect(location.searchParams.has("administrator_added")).toBe(false);
      expect(String(completed.headers.location)).not.toContain("private");
      expect(String(completed.headers["set-cookie"])).not.toContain("fleet_operator");
      expect(h.auth.listAdministrators()).toHaveLength(1);
      const replay = await h.callback(state);
      expect(
        new URL(String(replay.headers.location)).searchParams.get("auth_error"),
      ).toBe("expired");
    },
  );
});
