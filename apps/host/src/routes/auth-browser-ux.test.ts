import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AUTH_ERROR_MESSAGE_PARAM, AUTH_ERROR_PARAM } from "@fleet/protocol";
import { buildServer } from "../server.js";
import { codeLoginEndpoint } from "./auth.js";
import type { DeviceCodeStarted, EntraIdentity } from "../auth/entra.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";

const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};
const stranger: EntraIdentity = {
  tenantId: TENANT,
  objectId: "stranger-object-id",
  username: "stranger@example.com",
  displayName: "Stranger",
};

/**
 * What the browser is actually shown.
 *
 * These are the routes a person meets before they have anything else, so a
 * refusal that leaves a JSON body in the address bar is a bug in the same way a
 * missing check would be: the console is gone, and nothing says how to get back.
 */
describe("browser-facing auth endpoints", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let nextIdentity: EntraIdentity = alice;
  /** What the injected provider does when a device flow starts. */
  let deviceStart: () => Promise<DeviceCodeStarted> = async () => {
    throw new Error("not configured");
  };
  let devicePollError: Error | undefined;

  const jar = new Map<string, string>();
  const remember = <T extends { headers: Record<string, unknown> }>(response: T): T => {
    const raw = response.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    for (const cookie of list.map((value) => String(value).split(";")[0] ?? "")) {
      const [name, ...rest] = cookie.split("=");
      if (!name) continue;
      const value = rest.join("=");
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  const cookieHeader = () =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  beforeEach(async () => {
    jar.clear();
    nextIdentity = alice;
    devicePollError = undefined;
    deviceStart = async () => ({
      flowId: "provider-flow",
      userCode: "FLEET-123",
      verificationUri: "https://microsoft.com/devicelogin",
      message: "Enter FLEET-123 at https://microsoft.com/devicelogin",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "",
      announceClaimCode: (code) => {
        claimCode = code;
      },
      entraProvider: () => ({
        authorizationUrl: async ({ state }) =>
          `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?state=${state}`,
        redeemAuthorizationCode: async () => nextIdentity,
        startDeviceCode: () => deviceStart(),
        pollDeviceCode: async () => {
          if (devicePollError) throw devicePollError;
          return nextIdentity;
        },
        // The Host stops a flow it has discarded; the fake records nothing.
        cancelDeviceCode: () => {},
      }),
    });
    app.log.level = "silent";
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const status = async (host = "localhost:8787") =>
    (
      await app.inject({
        method: "GET",
        url: "/api/auth/status",
        headers: { cookie: cookieHeader(), host },
      })
    ).json() as Record<string, unknown>;

  const post = async (
    url: string,
    payload: Record<string, unknown> = {},
    host = "localhost:8787",
  ) =>
    remember(
      await app.inject({
        method: "POST",
        url,
        headers: { cookie: cookieHeader(), host },
        payload,
      }),
    );

  const csrf = async () =>
    (
      remember(
        await app.inject({
          method: "GET",
          url: "/api/auth/csrf",
          headers: { cookie: cookieHeader() },
        }),
      ).json() as { csrfToken: string }
    ).csrfToken;

  /** Claims the Host as Alice through the loopback code flow. */
  const claim = async () => {
    await post("/api/auth/bootstrap", { code: claimCode });
    await post("/api/auth/configure", { tenantId: TENANT, clientId: CLIENT });
    const started = await post("/api/auth/code/start", {});
    const url = (started.json() as { authorizationUrl: string }).authorizationUrl;
    const state = new URL(url).searchParams.get("state") ?? "";
    return remember(
      await app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: cookieHeader(), host: "localhost:8787" },
      }),
    );
  };

  describe("status", () => {
    it("says a loopback browser can finish a code sign-in here", async () => {
      expect(await status()).toMatchObject({
        codeLogin: { available: true, localForwardRequired: false },
      });
    });

    it("hands 127.0.0.1 the localhost URL rather than a login that cannot return", async () => {
      // Entra matches the registered `http://localhost/...` reply URL by name,
      // and the Lax transaction cookie is set for whichever name answered — so
      // starting at 127.0.0.1 loses the cookie at the callback.
      expect(await status("127.0.0.1:8787")).toMatchObject({
        codeLogin: {
          available: false,
          canonicalUrl: "http://localhost:8787",
          localForwardRequired: false,
        },
      });
    });

    it("tells a public origin it needs a local forward, not another retry", () => {
      // A published external name reaches the Host but no loopback listener,
      // so the answer is the forward that does work rather than a retry.
      const endpoint = codeLoginEndpoint("fleet.example.com");
      expect(endpoint).toEqual({ available: false, localForwardRequired: true });
      expect(endpoint.canonicalUrl).toBeUndefined();
    });
  });

  describe("callback failures", () => {
    it("sends an unauthorized account back to the app with a named reason", async () => {
      await claim();
      // A second, unknown identity finishing a sign-in on the same Host.
      jar.delete("fleet_operator");
      nextIdentity = stranger;

      const started = await post("/api/auth/code/start", {});
      const state =
        new URL(
          (started.json() as { authorizationUrl: string }).authorizationUrl,
        ).searchParams.get("state") ?? "";
      const finished = await app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: cookieHeader(), host: "localhost:8787" },
      });

      expect(finished.statusCode).toBe(302);
      const location = new URL(String(finished.headers.location), "http://localhost");
      expect(location.pathname).toBe("/");
      expect(location.searchParams.get(AUTH_ERROR_PARAM)).toBe("not-authorized");
      expect(location.searchParams.get(AUTH_ERROR_MESSAGE_PARAM)).toBeTruthy();
      expect(finished.body).not.toContain("{");
    });

    it("redirects a cancelled Microsoft sign-in instead of printing its error", async () => {
      const finished = await app.inject({
        method: "GET",
        url: "/api/auth/entra/callback?error=access_denied&error_description=User+cancelled",
        headers: { host: "localhost:8787" },
      });

      expect(finished.statusCode).toBe(302);
      const location = new URL(String(finished.headers.location), "http://localhost");
      expect(location.searchParams.get(AUTH_ERROR_PARAM)).toBe("cancelled");
    });

    it("redirects an expired transaction rather than answering 400 with JSON", async () => {
      const finished = await app.inject({
        method: "GET",
        url: "/api/auth/entra/callback?code=auth-code&state=never-issued",
        headers: { host: "localhost:8787" },
      });

      expect(finished.statusCode).toBe(302);
      expect(
        new URL(String(finished.headers.location), "http://localhost").searchParams.get(
          AUTH_ERROR_PARAM,
        ),
      ).toBe("expired");
    });
  });

  describe("first-run ordering", () => {
    it("will not enrol a machine into a Fleet nobody owns yet", async () => {
      // Claiming has to come first, or the machine joins a Host whose first
      // administrator has not been decided — and the legacy fleet-wide token is
      // a static string that would otherwise be enough to do it.
      const refused = await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        headers: { host: "localhost:8787" },
        payload: {
          name: "impostor",
          os: "linux",
          arch: "x64",
          version: "0.3.0",
          capabilities: ["copilot"],
          maxSessions: 1,
          enrollmentToken: "test-token",
        },
      });

      expect(refused.statusCode).toBe(423);
      expect(String((refused.json() as { error: string }).error)).toMatch(/claim/i);
    });

    it("enrols once the Fleet has an administrator", async () => {
      await claim();
      const enrolled = await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        headers: { host: "localhost:8787" },
        payload: {
          name: "legacy",
          os: "linux",
          arch: "x64",
          version: "0.3.0",
          capabilities: ["copilot"],
          maxSessions: 1,
          enrollmentToken: "test-token",
        },
      });
      expect(enrolled.statusCode).toBe(201);
    });
  });

  describe("device flow verification", () => {
    it("lets an administrator try device sign-in even though the flag is off", async () => {
      await claim();
      expect(await status()).toMatchObject({ deviceFlowEnabled: false });

      const started = await app.inject({
        method: "POST",
        url: "/api/auth/device/verify",
        headers: { cookie: cookieHeader(), "x-csrf-token": await csrf() },
        payload: {},
      });

      // The switch cannot be its own precondition: an administrator has to be
      // able to find out whether the tenant permits the flow at all.
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({
        userCode: "FLEET-123",
        verificationUri: "https://microsoft.com/devicelogin",
      });
      expect(await status()).toMatchObject({ deviceFlowEnabled: false });
    });

    it("enables device sign-in only once Microsoft actually completes one", async () => {
      await claim();
      const token = await csrf();
      const started = await app.inject({
        method: "POST",
        url: "/api/auth/device/verify",
        headers: { cookie: cookieHeader(), "x-csrf-token": token },
        payload: {},
      });
      const { flowId } = started.json() as { flowId: string };

      const finished = await app.inject({
        method: "POST",
        url: `/api/auth/device/verify/${flowId}`,
        headers: { cookie: cookieHeader(), "x-csrf-token": token },
        payload: {},
      });

      expect(finished.statusCode).toBe(200);
      expect(finished.json()).toMatchObject({ deviceFlowEnabled: true });
      expect(await status()).toMatchObject({ deviceFlowEnabled: true });
    });

    it("leaves it disabled and explains when Conditional Access blocks the flow", async () => {
      await claim();
      const token = await csrf();
      deviceStart = async () => {
        throw new Error(
          "AADSTS50199: Device code flow is blocked by a Conditional Access policy",
        );
      };

      const started = await app.inject({
        method: "POST",
        url: "/api/auth/device/verify",
        headers: { cookie: cookieHeader(), "x-csrf-token": token },
        payload: {},
      });

      expect(started.statusCode).toBe(409);
      expect(started.json()).toMatchObject({ blocked: true });
      expect(String((started.json() as { error: string }).error)).toMatch(
        /conditional access|local forward/i,
      );
      expect(await status()).toMatchObject({ deviceFlowEnabled: false });
    });

    it("refuses a verification from anybody who is not an administrator", async () => {
      const refused = await app.inject({
        method: "POST",
        url: "/api/auth/device/verify",
        headers: { host: "localhost:8787" },
        payload: {},
      });
      expect(refused.statusCode).toBe(401);
    });
  });
});
