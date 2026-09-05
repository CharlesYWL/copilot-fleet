import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { EntraIdentity } from "../auth/entra.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";

const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};
const bob: EntraIdentity = {
  tenantId: TENANT,
  objectId: "bob-object-id",
  username: "bob@example.com",
  displayName: "Bob",
};

/**
 * The whole point of the identity work: a Host nobody has claimed answers
 * nothing but its own setup, and claiming it needs two independent proofs.
 */
describe("Microsoft identity routes", () => {
  let app: FastifyInstance;
  let claimCode = "";
  /** What the injected provider will say the browser authenticated as. */
  let nextIdentity: EntraIdentity = alice;

  const cookiesOf = (response: { headers: Record<string, unknown> }) => {
    const raw = response.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    return list.map((value) => value.split(";")[0] ?? "");
  };

  const jar = new Map<string, string>();
  const remember = <T extends { headers: Record<string, unknown> }>(response: T): T => {
    for (const pair of cookiesOf(response)) {
      const [name, ...rest] = pair.split("=");
      if (!name) continue;
      const value = rest.join("=");
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  const cookieHeader = () =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  /** The reason a callback redirect carries, so a refusal can be named. */
  const deniedAs = (response: { headers: Record<string, unknown> }) =>
    new URL(String(response.headers.location), "http://localhost").searchParams.get(
      "auth_error",
    );

  beforeEach(async () => {
    jar.clear();
    nextIdentity = alice;
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      // A Host started without a password, which is the shipping default. The
      // repository's own .env sets one for development, and inheriting it here
      // would test the migration path instead of the fresh one.
      operatorPassword: "",
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

  const status = async () =>
    (
      await app.inject({
        method: "GET",
        url: "/api/auth/status",
        headers: { cookie: cookieHeader() },
      })
    ).json() as Record<string, unknown>;

  const bootstrap = async (code = claimCode) =>
    remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { cookie: cookieHeader() },
        payload: { code },
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

  it("prints a claim code and admits to nothing else", async () => {
    expect(claimCode.length).toBeGreaterThanOrEqual(22);
    expect(await status()).toMatchObject({
      state: "entra-unconfigured",
      authenticated: false,
    });
    for (const url of ["/api/snapshot", "/api/nodes", "/api/enrollment", "/api/logs"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });

  it("will not take a wrong claim code, or configure without one", async () => {
    const refused = await bootstrap("not-the-code");
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toContain(claimCode);

    const unconfigured = await configure();
    expect(unconfigured.statusCode).toBe(401);
    expect(await status()).toMatchObject({ state: "entra-unconfigured" });
  });

  it("takes the printed code, and configuration still grants no access", async () => {
    expect((await bootstrap()).statusCode).toBe(200);
    expect((await configure()).statusCode).toBe(200);
    expect(await status()).toMatchObject({ state: "unclaimed", authenticated: false });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: cookieHeader() },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("refuses to start a login on an unclaimed Host without the console code", async () => {
    // Configure through a bootstrap grant, then throw the grant away.
    await bootstrap();
    await configure();
    jar.delete("fleet_bootstrap");

    const started = await app.inject({
      method: "POST",
      url: "/api/auth/code/start",
      headers: { cookie: cookieHeader() },
      payload: {},
    });
    expect(started.statusCode).toBe(401);
  });

  it("will not let a copied bootstrap cookie configure from another browser", async () => {
    await bootstrap();
    const stolen = jar.get("fleet_bootstrap") ?? "";
    expect(stolen).toBeTruthy();

    // A second browser: same grant value, no binding cookie of its own.
    const elsewhere = await app.inject({
      method: "POST",
      url: "/api/auth/configure",
      headers: { cookie: `fleet_bootstrap=${stolen}` },
      payload: { tenantId: TENANT, clientId: CLIENT },
    });
    expect(elsewhere.statusCode).toBe(401);
    expect(await status()).toMatchObject({ state: "entra-unconfigured" });
  });

  it("claims the Host for the first identity that has both proofs", async () => {
    await bootstrap();
    await configure();
    const finished = await signIn();

    expect(finished.statusCode).toBe(302);
    expect(finished.headers.location).toBe("/");
    expect(jar.get("fleet_operator")).toBeTruthy();
    expect(await status()).toMatchObject({
      state: "microsoft-only",
      authenticated: true,
      identity: { username: "alice@example.com", displayName: "Alice" },
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

  it("consumes the bootstrap grant, so a second claim cannot ride on it", async () => {
    await bootstrap();
    await configure();
    await signIn();

    nextIdentity = bob;
    const second = await signIn();
    // The grant is spent, so this is no longer a claim: it is an ordinary
    // sign-in by somebody who is not an administrator. The refusal returns to
    // the app rather than replacing it with a JSON body.
    expect(second.statusCode).toBe(302);
    expect(deniedAs(second)).toBe("not-authorized");
    expect(jar.get("fleet_operator")).toBeTruthy();

    const administrators = await app.inject({
      method: "GET",
      url: "/api/auth/administrators",
      headers: { cookie: cookieHeader() },
    });
    expect(
      (administrators.json() as { administrators: unknown[] }).administrators,
    ).toHaveLength(1);
  });

  it("gives a valid tenant identity that nobody authorized no session at all", async () => {
    await bootstrap();
    await configure();
    await signIn();
    const adminCookies = cookieHeader();

    jar.clear();
    nextIdentity = bob;
    const denied = await signIn();
    expect(denied.statusCode).toBe(302);
    expect(deniedAs(denied)).toBe("not-authorized");
    expect(jar.get("fleet_operator")).toBeUndefined();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: cookieHeader() },
        })
      ).statusCode,
    ).toBe(401);
    // The administrator who does own it is unaffected.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: adminCookies },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("lets the claimed administrator sign in again on a fresh browser", async () => {
    await bootstrap();
    await configure();
    await signIn();

    jar.clear();
    const again = await signIn();
    expect(again.statusCode).toBe(302);
    expect(await status()).toMatchObject({ authenticated: true });
  });

  it("records the claim in the audit without ever writing the code down", async () => {
    await bootstrap("wrong-code");
    await bootstrap();
    await configure();
    await signIn();

    const audit = await app.inject({
      method: "GET",
      url: "/api/security/audit",
      headers: { cookie: cookieHeader() },
    });
    expect(audit.statusCode).toBe(200);
    const events = (audit.json() as { events: { eventType: string }[] }).events;
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "bootstrap_code_rejected",
        "bootstrap_code_accepted",
        "entra_configuration_changed",
        "fleet_claimed",
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(claimCode);
  });

  it("hands out a CSRF proof and refuses a state change without it", async () => {
    await bootstrap();
    await configure();
    await signIn();

    const csrf = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie: cookieHeader() },
    });
    expect(csrf.statusCode).toBe(200);
    const token = (csrf.json() as { csrfToken: string }).csrfToken;
    expect(token.length).toBeGreaterThanOrEqual(16);
    // Derived, not stored: asking twice gives the same answer.
    expect(
      (
        (
          await app.inject({
            method: "GET",
            url: "/api/auth/csrf",
            headers: { cookie: cookieHeader() },
          })
        ).json() as { csrfToken: string }
      ).csrfToken,
    ).toBe(token);

    const without = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: cookieHeader() },
      payload: { name: "no-proof", description: "" },
    });
    expect(without.statusCode).toBe(403);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: cookieHeader(), "x-csrf-token": `${token}x` },
      payload: { name: "bad-proof", description: "" },
    });
    expect(wrong.statusCode).toBe(403);

    const withProof = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: cookieHeader(), "x-csrf-token": token },
      payload: { name: "proof", description: "" },
    });
    expect(withProof.statusCode).toBe(201);
  });

  it("signs the administrator out server-side, not just in their browser", async () => {
    await bootstrap();
    await configure();
    await signIn();
    const held = cookieHeader();
    const token = (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/csrf",
          headers: { cookie: held },
        })
      ).json() as { csrfToken: string }
    ).csrfToken;

    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: held, "x-csrf-token": token },
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: held },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("refuses a login through a known plain-HTTP external endpoint", async () => {
    await bootstrap();
    await configure();

    const started = await app.inject({
      method: "POST",
      url: "/api/auth/code/start",
      headers: { cookie: cookieHeader(), host: "bore.pub:45871" },
      payload: {},
    });
    // The name is not one this Host published, so it never reaches the flow.
    expect([400, 403]).toContain(started.statusCode);
  });

  it("ignores forged source and forwarded headers when deciding to claim", async () => {
    const forged = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: {
        cookie: cookieHeader(),
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-proto": "https",
        "x-real-ip": "127.0.0.1",
      },
      payload: { code: "still-not-the-code" },
    });
    expect(forged.statusCode).toBe(401);
    expect(await status()).toMatchObject({ state: "entra-unconfigured" });
  });
});

/**
 * An upgraded Host must keep working while its operator migrates, and the new
 * session system must not honour a cookie the old one signed.
 */
describe("legacy password migration", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "test-password",
    });
    app.log.level = "silent";
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("reports legacy-password and still signs a password operator in", async () => {
    expect(
      (
        (await app.inject({ method: "GET", url: "/api/auth/status" })).json() as {
          state: string;
        }
      ).state,
    ).toBe("legacy-password");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "test-password" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = (login.headers["set-cookie"] as string).split(";")[0] ?? "";
    expect(
      (await app.inject({ method: "GET", url: "/api/snapshot", headers: { cookie } }))
        .statusCode,
    ).toBe(200);
  });

  it("will not accept a cookie the old signed-session scheme minted", async () => {
    // Shape of the retired token: id.fingerprint.signature. It was accepted by
    // signature alone, so nothing revoked it server-side.
    const forged = "fleet_operator=e0f1.abcdef0123456789.c2lnbmF0dXJl";
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: forged },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("does not offer a Microsoft login it has no configuration for", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/code/start",
      payload: {},
    });
    expect(started.statusCode).toBe(409);
  });
});
