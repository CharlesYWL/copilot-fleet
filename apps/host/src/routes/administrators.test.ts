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
const mallory: EntraIdentity = {
  tenantId: TENANT,
  objectId: "mallory-object-id",
  username: "mallory@example.com",
  displayName: "Mallory",
};

/**
 * Adding and removing administrators.
 *
 * The invitation is deliberately not an authorisation: it lets somebody put
 * their name forward, and an existing administrator decides. These assert that
 * the gap between those two things is real, and that removal takes effect the
 * moment it happens rather than whenever a cookie happens to expire.
 */
describe("administrator management", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let nextIdentity: EntraIdentity = alice;

  /** One browser, one cookie jar; a second jar is a second person. */
  /** The reason a callback redirect carries, so a refusal can be named. */
  const deniedAs = (response: { headers: Record<string, unknown> }) =>
    new URL(String(response.headers.location), "http://localhost").searchParams.get(
      "auth_error",
    );

  const makeBrowser = () => {
    const jar = new Map<string, string>();
    const remember = <T extends { headers: Record<string, unknown> }>(response: T): T => {
      const raw = response.headers["set-cookie"];
      const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
      for (const pair of list.map((value) => value.split(";")[0] ?? "")) {
        const [name, ...rest] = pair.split("=");
        if (!name) continue;
        const value = rest.join("=");
        if (value === "") jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    return { jar, remember, cookie };
  };

  type Browser = ReturnType<typeof makeBrowser>;

  const signIn = async (browser: Browser, invitation?: string) => {
    const started = browser.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: browser.cookie() },
        payload: invitation ? { invitation } : {},
      }),
    );
    if (started.statusCode !== 200) return started;
    const url = (started.json() as { authorizationUrl: string }).authorizationUrl;
    const state = new URL(url).searchParams.get("state") ?? "";
    return browser.remember(
      await app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: browser.cookie() },
      }),
    );
  };

  const csrfFor = async (browser: Browser) =>
    (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/csrf",
          headers: { cookie: browser.cookie() },
        })
      ).json() as { csrfToken: string }
    ).csrfToken;

  const post = async (
    browser: Browser,
    url: string,
    payload: Record<string, unknown> = {},
  ) =>
    await app.inject({
      method: "POST",
      url,
      headers: { cookie: browser.cookie(), "x-csrf-token": await csrfFor(browser) },
      payload,
    });

  const del = async (browser: Browser, url: string) =>
    await app.inject({
      method: "DELETE",
      url,
      headers: { cookie: browser.cookie(), "x-csrf-token": await csrfFor(browser) },
    });

  let owner: Browser;

  beforeEach(async () => {
    nextIdentity = alice;
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

    owner = makeBrowser();
    owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { cookie: owner.cookie() },
        payload: { code: claimCode },
      }),
    );
    owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/configure",
        headers: { cookie: owner.cookie() },
        payload: { tenantId: TENANT, clientId: CLIENT },
      }),
    );
    await signIn(owner);
  });

  afterEach(async () => {
    await app.close();
  });

  const invite = async () => {
    const created = await post(owner, "/api/auth/administrator-invitations");
    expect(created.statusCode).toBe(201);
    return created.json() as { id: string; token: string };
  };

  it("turns a redeemed invitation into a candidate and nothing more", async () => {
    const invitation = await invite();

    nextIdentity = bob;
    const candidate = makeBrowser();
    const accepted = await signIn(candidate, invitation.token);

    // Redeeming granted no session: the invitation only put Bob forward, and
    // the page he lands back on says so rather than showing a refusal.
    expect(accepted.statusCode).toBe(302);
    expect(deniedAs(accepted)).toBe("pending-approval");
    expect(candidate.jar.get("fleet_operator")).toBeUndefined();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: candidate.cookie() },
        })
      ).statusCode,
    ).toBe(401);

    const listed = await app.inject({
      method: "GET",
      url: "/api/auth/administrators",
      headers: { cookie: owner.cookie() },
    });
    expect((listed.json() as { pending: { objectId: string }[] }).pending).toMatchObject([
      { objectId: "bob-object-id", username: "bob@example.com" },
    ]);
  });

  it("grants access only once an existing administrator approves the identity", async () => {
    const invitation = await invite();
    nextIdentity = bob;
    const candidate = makeBrowser();
    await signIn(candidate, invitation.token);

    const approved = await post(
      owner,
      `/api/auth/administrator-invitations/${invitation.id}/approve`,
    );
    expect(approved.statusCode).toBe(200);

    // Bob signs in again, this time as somebody the Host knows.
    const second = makeBrowser();
    const finished = await signIn(second);
    expect(finished.statusCode).toBe(302);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: second.cookie() },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects a candidate the inviting administrator did not mean to invite", async () => {
    const invitation = await invite();
    // The link leaked; somebody else in the tenant opened it.
    nextIdentity = mallory;
    await signIn(makeBrowser(), invitation.token);

    const rejected = await post(
      owner,
      `/api/auth/administrator-invitations/${invitation.id}/reject`,
    );
    expect(rejected.statusCode).toBe(200);

    const denied = await signIn(makeBrowser());
    expect(denied.statusCode).toBe(302);
    expect(deniedAs(denied)).toBe("not-authorized");
  });

  it("will not let one invitation be redeemed twice", async () => {
    const invitation = await invite();
    nextIdentity = bob;
    await signIn(makeBrowser(), invitation.token);

    nextIdentity = mallory;
    await signIn(makeBrowser(), invitation.token);

    const listed = await app.inject({
      method: "GET",
      url: "/api/auth/administrators",
      headers: { cookie: owner.cookie() },
    });
    expect((listed.json() as { pending: unknown[] }).pending).toHaveLength(1);
  });

  it("refuses an invitation token nobody issued", async () => {
    nextIdentity = bob;
    const denied = await signIn(makeBrowser(), "made-up.invitation-token");
    expect(denied.statusCode).toBe(302);
    expect(deniedAs(denied)).toBe("not-authorized");
    const listed = await app.inject({
      method: "GET",
      url: "/api/auth/administrators",
      headers: { cookie: owner.cookie() },
    });
    expect((listed.json() as { pending: unknown[] }).pending).toHaveLength(0);
  });

  it("removes an administrator and stops honouring their session at once", async () => {
    const invitation = await invite();
    nextIdentity = bob;
    await signIn(makeBrowser(), invitation.token);
    await post(owner, `/api/auth/administrator-invitations/${invitation.id}/approve`);

    const bobBrowser = makeBrowser();
    await signIn(bobBrowser);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: bobBrowser.cookie() },
        })
      ).statusCode,
    ).toBe(200);

    const administrators = (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/administrators",
          headers: { cookie: owner.cookie() },
        })
      ).json() as { administrators: { id: string; objectId: string }[] }
    ).administrators;
    const bobId =
      administrators.find((row) => row.objectId === "bob-object-id")?.id ?? "";

    expect((await del(owner, `/api/auth/administrators/${bobId}`)).statusCode).toBe(200);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: bobBrowser.cookie() },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("refuses to remove the last administrator", async () => {
    const administrators = (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/administrators",
          headers: { cookie: owner.cookie() },
        })
      ).json() as { administrators: { id: string }[] }
    ).administrators;
    const only = administrators[0]?.id ?? "";
    expect((await del(owner, `/api/auth/administrators/${only}`)).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: owner.cookie() },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("keeps a legacy password operator out of administrator management", async () => {
    // A password session proves no individual, so it cannot decide who else
    // gets in even while password mode is enabled.
    const passworded = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "test-password",
      announceClaimCode: () => {},
    });
    passworded.log.level = "silent";
    await passworded.ready();
    try {
      const login = await passworded.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "test-password" },
      });
      const cookie = (login.headers["set-cookie"] as string).split(";")[0] ?? "";
      const csrf = (
        (
          await passworded.inject({
            method: "GET",
            url: "/api/auth/csrf",
            headers: { cookie },
          })
        ).json() as { csrfToken: string }
      ).csrfToken;
      const created = await passworded.inject({
        method: "POST",
        url: "/api/auth/administrator-invitations",
        headers: { cookie, "x-csrf-token": csrf },
        payload: {},
      });
      expect(created.statusCode).toBe(403);
    } finally {
      await passworded.close();
    }
  });

  it("disables the password only for a Microsoft administrator", async () => {
    const hybrid = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "test-password",
      announceClaimCode: (code) => {
        claimCode = code;
      },
      entraProvider: () => ({
        authorizationUrl: async ({ state }) =>
          `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?state=${state}`,
        redeemAuthorizationCode: async () => alice,
        startDeviceCode: async () => {
          throw new Error("device flow is not enabled on this Host");
        },
        pollDeviceCode: async () => alice,
        // The Host stops a flow it has discarded; the fake records nothing.
        cancelDeviceCode: () => {},
      }),
    });
    hybrid.log.level = "silent";
    await hybrid.ready();
    const previous = app;
    app = hybrid;
    try {
      const admin = makeBrowser();
      admin.remember(
        await app.inject({
          method: "POST",
          url: "/api/auth/bootstrap",
          headers: { cookie: admin.cookie() },
          payload: { code: claimCode },
        }),
      );
      admin.remember(
        await app.inject({
          method: "POST",
          url: "/api/auth/configure",
          headers: { cookie: admin.cookie() },
          payload: { tenantId: TENANT, clientId: CLIENT },
        }),
      );
      await signIn(admin);

      const status = await app.inject({ method: "GET", url: "/api/auth/status" });
      expect((status.json() as { state: string }).state).toBe("hybrid");

      expect((await post(admin, "/api/auth/password/disable")).statusCode).toBe(200);

      expect(
        (
          (await app.inject({ method: "GET", url: "/api/auth/status" })).json() as {
            state: string;
          }
        ).state,
      ).toBe("microsoft-only");
      const afterwards = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "test-password" },
      });
      expect(afterwards.statusCode).toBe(409);
    } finally {
      app = previous;
      await hybrid.close();
    }
  });
});
