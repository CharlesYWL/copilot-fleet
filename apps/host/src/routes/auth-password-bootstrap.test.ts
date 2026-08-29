import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { EntraIdentity } from "../auth/entra.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const PASSWORD = "test-password";

const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};

/**
 * The migration a legacy Host actually has to make.
 *
 * Such a Host has a password its operator already knows and no administrators
 * at all, so the console claim code is a second proof of something they have
 * just proved: whoever holds the password holds the Host. Demanding it is what
 * left upgraded fleets unable to move to Microsoft sign-in without going back
 * to the machine's terminal — often a machine in another building.
 *
 * What must not follow from that is a way in for anybody else, so every test
 * here is about who the grant is *refused* to.
 */
describe("password bootstrap", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let nextIdentity: EntraIdentity = alice;

  const jar = new Map<string, string>();
  const remember = <T extends { headers: Record<string, unknown> }>(response: T): T => {
    const raw = response.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    for (const cookie of list) {
      const [name, ...rest] = (cookie.split(";")[0] ?? "").split("=");
      if (!name) continue;
      const value = rest.join("=");
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  const cookieHeader = () =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  const start = async (options: { password: string }) => {
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: options.password,
      announceClaimCode: (code) => {
        claimCode = code;
      },
      entraProvider: () => ({
        authorizationUrl: async ({ state }) =>
          `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?state=${state}`,
        redeemAuthorizationCode: async () => nextIdentity,
        startDeviceCode: async () => {
          throw new Error("device flow is not enabled on this Host");
        },
        pollDeviceCode: async () => nextIdentity,
        cancelDeviceCode: () => {},
      }),
    });
    app.log.level = "silent";
    await app.ready();
  };

  const status = async () =>
    (
      await app.inject({
        method: "GET",
        url: "/api/auth/status",
        headers: { cookie: cookieHeader() },
      })
    ).json() as Record<string, unknown>;

  const passwordLogin = async (password = PASSWORD) =>
    remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { cookie: cookieHeader() },
        payload: { password },
      }),
    );

  const csrf = async () =>
    (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/csrf",
          headers: { cookie: cookieHeader() },
        })
      ).json() as { csrfToken: string }
    ).csrfToken;

  const passwordBootstrap = async (headers: Record<string, string> = {}) =>
    remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap/password",
        headers: { cookie: cookieHeader(), ...headers },
        payload: {},
      }),
    );

  const configure = async () =>
    remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/configure",
        headers: { cookie: cookieHeader() },
        payload: { tenantId: TENANT, clientId: CLIENT },
      }),
    );

  const signIn = async () => {
    const started = remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: cookieHeader() },
        payload: {},
      }),
    );
    if (started.statusCode !== 200) return started;
    const url = (started.json() as { authorizationUrl: string }).authorizationUrl;
    const state = new URL(url).searchParams.get("state") ?? "";
    return remember(
      await app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: cookieHeader() },
      }),
    );
  };

  beforeEach(() => {
    jar.clear();
    claimCode = "";
    nextIdentity = alice;
  });

  afterEach(async () => {
    await app.close();
  });

  describe("a legacy Host whose only credential is its password", () => {
    beforeEach(async () => {
      await start({ password: PASSWORD });
    });

    it("is the state this whole endpoint exists for", async () => {
      expect(await status()).toMatchObject({
        state: "legacy-password",
        passwordEnabled: true,
        claimCodeRequired: true,
        authenticated: false,
      });
    });

    it("refuses an anonymous caller", async () => {
      const refused = await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap/password",
        payload: {},
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.headers["set-cookie"]).toBeUndefined();
    });

    it("refuses a live password session that brings no CSRF proof", async () => {
      await passwordLogin();
      const refused = await passwordBootstrap();
      expect(refused.statusCode).toBe(403);
    });

    it("refuses a CSRF proof minted for somebody else's session", async () => {
      await passwordLogin();
      const token = await csrf();

      // A second browser, signed in on its own session: the proof is derived
      // from the session, so one browser's is worthless in another's.
      const other = new Map(jar);
      jar.clear();
      await passwordLogin();
      const mine = await csrf();
      expect(mine).not.toBe(token);
      jar.clear();
      for (const [name, value] of other) jar.set(name, value);

      expect((await passwordBootstrap({ "x-csrf-token": mine })).statusCode).toBe(403);
    });

    it("issues the browser-bound bootstrap grant to a proven password operator", async () => {
      await passwordLogin();
      const granted = await passwordBootstrap({ "x-csrf-token": await csrf() });

      expect(granted.statusCode).toBe(200);
      expect(granted.json()).toMatchObject({ ok: true });
      expect(jar.get("fleet_bootstrap")).toBeTruthy();
      expect(jar.get("fleet_bind")).toBeTruthy();
      // The console code is a separate secret and stays one.
      expect(granted.body).not.toContain(claimCode);
      expect(JSON.stringify([...jar])).not.toContain(claimCode);
    });

    it("will not let the grant be replayed from another browser", async () => {
      await passwordLogin();
      await passwordBootstrap({ "x-csrf-token": await csrf() });
      const stolen = jar.get("fleet_bootstrap") ?? "";
      expect(stolen).toBeTruthy();

      const elsewhere = await app.inject({
        method: "POST",
        url: "/api/auth/configure",
        headers: { cookie: `fleet_bootstrap=${stolen}` },
        payload: { tenantId: TENANT, clientId: CLIENT },
      });
      expect(elsewhere.statusCode).toBe(401);
      expect(await status()).toMatchObject({ entraConfigured: false });
    });

    it("configures Entra and claims the Host without the console code", async () => {
      await passwordLogin();
      await passwordBootstrap({ "x-csrf-token": await csrf() });

      expect((await configure()).statusCode).toBe(200);
      const claimed = await signIn();
      expect(claimed.statusCode).toBe(302);
      expect(claimed.headers.location).toBe("/");

      expect(await status()).toMatchObject({
        claimCodeRequired: false,
        authenticated: true,
        identity: { username: "alice@example.com" },
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/snapshot",
            headers: { cookie: cookieHeader() },
          })
        ).statusCode,
      ).toBe(200);
    });

    it("spends the grant on the claim, so a second identity cannot ride it", async () => {
      await passwordLogin();
      await passwordBootstrap({ "x-csrf-token": await csrf() });
      await configure();
      await signIn();

      nextIdentity = {
        tenantId: TENANT,
        objectId: "bob-object-id",
        username: "bob@example.com",
        displayName: "Bob",
      };
      await signIn();

      const administrators = await app.inject({
        method: "GET",
        url: "/api/auth/administrators",
        headers: { cookie: cookieHeader() },
      });
      expect(
        (administrators.json() as { administrators: unknown[] }).administrators,
      ).toHaveLength(1);
    });

    it("names the trusted grant in the audit rather than a console redemption", async () => {
      await passwordLogin();
      await passwordBootstrap({ "x-csrf-token": await csrf() });
      await configure();
      await signIn();

      const events = (
        (
          await app.inject({
            method: "GET",
            url: "/api/security/audit",
            headers: { cookie: cookieHeader() },
          })
        ).json() as { events: { eventType: string }[] }
      ).events.map((event) => event.eventType);

      expect(events).toEqual(
        expect.arrayContaining([
          "bootstrap_password_granted",
          "entra_configuration_changed",
          "fleet_claimed",
        ]),
      );
      // A password grant is not a console redemption and must not read as one.
      expect(events).not.toContain("bootstrap_code_accepted");
    });
  });

  describe("a Host that already has an administrator", () => {
    beforeEach(async () => {
      await start({ password: PASSWORD });
      await passwordLogin();
      await passwordBootstrap({ "x-csrf-token": await csrf() });
      await configure();
      await signIn();
    });

    it("refuses a Microsoft session outright", async () => {
      // The session the claim just issued is a Microsoft one.
      const refused = await passwordBootstrap({ "x-csrf-token": await csrf() });
      expect(refused.statusCode).toBe(403);
      expect(jar.get("fleet_bootstrap")).toBeUndefined();
    });

    it("refuses a password session too, because there is nothing left to claim", async () => {
      jar.clear();
      await passwordLogin();
      const refused = await passwordBootstrap({ "x-csrf-token": await csrf() });
      expect(refused.statusCode).toBe(409);
      expect(jar.get("fleet_bootstrap")).toBeUndefined();
    });
  });

  describe("a Host with no password at all", () => {
    beforeEach(async () => {
      await start({ password: "" });
    });

    it("still prints a console code, and still needs it", async () => {
      expect(claimCode.length).toBeGreaterThanOrEqual(22);
      expect(await status()).toMatchObject({
        state: "entra-unconfigured",
        passwordEnabled: false,
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/bootstrap/password",
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/bootstrap",
            payload: { code: claimCode },
          })
        ).statusCode,
      ).toBe(200);
    });
  });
});
