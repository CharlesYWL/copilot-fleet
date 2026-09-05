import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { OPERATOR_SESSION_ABSOLUTE_MS } from "../auth/sessions.js";
import type { EntraIdentity } from "../auth/entra.js";
import { buildServer } from "../server.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const identity: EntraIdentity = {
  tenantId: TENANT,
  objectId: "operator-object-id",
  username: "operator@example.com",
  displayName: "Operator",
};

function setCookies(
  response: { headers: Record<string, unknown> },
  jar: Map<string, string>,
) {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const value of values) {
    const pair = value.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator);
    const cookie = pair.slice(separator + 1);
    if (cookie) jar.set(name, cookie);
    else jar.delete(name);
  }
}

describe("browser authorization-code safety", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let authorizationCalls = 0;
  const jar = new Map<string, string>();

  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const remember = <T extends { headers: Record<string, unknown> }>(response: T): T => {
    setCookies(response, jar);
    return response;
  };

  beforeEach(async () => {
    jar.clear();
    authorizationCalls = 0;
    process.env.FLEET_PUBLIC_URL = "https://fleet.example.com";
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "",
      announceClaimCode: (code) => {
        claimCode = code;
      },
      entraProvider: () => ({
        authorizationUrl: async ({ state }) => {
          authorizationCalls += 1;
          return `https://login.microsoftonline.com/authorize?state=${state}`;
        },
        redeemAuthorizationCode: async () => identity,
        startDeviceCode: async () => {
          throw new Error("not enabled");
        },
        pollDeviceCode: async () => identity,
        // The Host stops a flow it has discarded; the fake records nothing.
        cancelDeviceCode: () => {},
      }),
    });
    app.log.level = "silent";
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.FLEET_PUBLIC_URL;
    await app.close();
  });

  async function bootstrapAndConfigure(host: string) {
    const bootstrap = remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { host, cookie: cookie() },
        payload: { code: claimCode },
      }),
    );
    expect(bootstrap.statusCode).toBe(200);
    const cookies = bootstrap.headers["set-cookie"];
    expect(cookies).toEqual([
      expect.stringContaining("fleet_bind="),
      expect.stringContaining("fleet_bootstrap="),
    ]);
    const values = cookies as string[];
    expect(values[0]).toContain("SameSite=Lax; Max-Age=3600");
    expect(values[1]).toContain("SameSite=Strict; Max-Age=600");
    for (const value of values) {
      expect(value).toContain("Path=/; HttpOnly;");
      expect(value.endsWith("; Secure")).toBe(host === "fleet.example.com");
    }
    const configure = await app.inject({
      method: "POST",
      url: "/api/auth/configure",
      headers: { host, cookie: cookie() },
      payload: { tenantId: TENANT, clientId: CLIENT },
    });
    expect(configure.statusCode).toBe(200);
  }

  it("refuses code login on an external origin instead of inventing an unregistered callback", async () => {
    await bootstrapAndConfigure("fleet.example.com");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/code/start",
      headers: { host: "fleet.example.com", cookie: cookie() },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ localForwardRequired: true });
    expect(authorizationCalls).toBe(0);
  });

  it("requires the canonical localhost name before setting the login cookies", async () => {
    await bootstrapAndConfigure("127.0.0.1:8787");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/code/start",
      headers: { host: "127.0.0.1:8787", cookie: cookie() },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      canonicalUrl: "http://localhost:8787",
    });
    expect(authorizationCalls).toBe(0);
  });

  it("completes the callback with the Lax binding cookie but without the Strict bootstrap cookie", async () => {
    await bootstrapAndConfigure("localhost:8787");
    const started = remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { host: "localhost:8787", cookie: cookie() },
        payload: {},
      }),
    );
    const state = new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    const binding = jar.get("fleet_bind");
    expect(binding).toBeTruthy();

    const callback = remember(
      await app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=code&state=${state}`,
        headers: { host: "localhost:8787", cookie: `fleet_bind=${binding}` },
      }),
    );
    expect(callback.statusCode).toBe(302);
    expect(jar.get("fleet_operator")).toBeTruthy();
  });

  it("keeps the cookie until the absolute deadline while idle expiry stays server-side", async () => {
    await bootstrapAndConfigure("localhost:8787");
    const started = remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { host: "localhost:8787", cookie: cookie() },
        payload: {},
      }),
    );
    const state = new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/entra/callback?code=code&state=${state}`,
      headers: { host: "localhost:8787", cookie: cookie() },
    });
    const values = Array.isArray(callback.headers["set-cookie"])
      ? callback.headers["set-cookie"]
      : [String(callback.headers["set-cookie"])];
    const session = values.find((value) => value.startsWith("fleet_operator="));
    expect(session).toContain(
      `Max-Age=${Math.floor(OPERATOR_SESSION_ABSOLUTE_MS / 1000)}`,
    );
  });
});
