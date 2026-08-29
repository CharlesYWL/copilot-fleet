import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { EntraIdentity } from "../auth/entra.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const PASSPHRASE = "correct horse battery staple";

const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};

type Browser = {
  remember: <T extends { headers: Record<string, unknown> }>(response: T) => T;
  cookie: () => string;
};

const makeBrowser = (): Browser => {
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
  return {
    remember,
    cookie: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
  };
};

type Host = { app: FastifyInstance; claimCode: () => string };

async function startHost(): Promise<Host> {
  let claimCode = "";
  const app = await buildServer({
    databasePath: ":memory:",
    enrollmentToken: "test-token",
    operatorPassword: "",
    announceClaimCode: (code) => {
      claimCode = code;
    },
    entraProvider: () => ({
      authorizationUrl: async ({ state }) => `https://login.example/?state=${state}`,
      redeemAuthorizationCode: async () => alice,
      startDeviceCode: async () => {
        throw new Error("device flow is not enabled on this Host");
      },
      pollDeviceCode: async () => alice,
      cancelDeviceCode: () => {},
    }),
  });
  app.log.level = "silent";
  await app.ready();
  return { app, claimCode: () => claimCode };
}

const hosts: Host[] = [];

const openHost = async (): Promise<Host> => {
  const host = await startHost();
  hosts.push(host);
  return host;
};

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.app.close();
});

const csrfFor = async (host: Host, browser: Browser) =>
  (
    (
      await host.app.inject({
        method: "GET",
        url: "/api/auth/csrf",
        headers: { cookie: browser.cookie() },
      })
    ).json() as { csrfToken: string }
  ).csrfToken;

const post = async (
  host: Host,
  browser: Browser,
  url: string,
  payload: Record<string, unknown>,
) =>
  browser.remember(
    await host.app.inject({
      method: "POST",
      url,
      headers: {
        cookie: browser.cookie(),
        "x-csrf-token": await csrfFor(host, browser),
      },
      payload,
    }),
  );

const claim = async (host: Host, browser: Browser) => {
  browser.remember(
    await host.app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: { cookie: browser.cookie() },
      payload: { code: host.claimCode() },
    }),
  );
  browser.remember(
    await host.app.inject({
      method: "POST",
      url: "/api/auth/configure",
      headers: { cookie: browser.cookie() },
      payload: { tenantId: TENANT, clientId: CLIENT },
    }),
  );
  const started = browser.remember(
    await host.app.inject({
      method: "POST",
      url: "/api/auth/code/start",
      headers: { cookie: browser.cookie() },
      payload: {},
    }),
  );
  const state =
    new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state") ?? "";
  browser.remember(
    await host.app.inject({
      method: "GET",
      url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: browser.cookie() },
    }),
  );
};

const enrollment = async (host: Host, browser?: Browser) =>
  (
    await host.app.inject({
      method: "GET",
      url: "/api/enrollment",
      ...(browser ? { headers: { cookie: browser.cookie() } } : {}),
    })
  ).json() as {
    hostId: string;
    hostFingerprint: string;
    hostPublicKey: string;
    mutualAuthenticationRequired: boolean;
    enrollmentToken?: string;
  };

/**
 * A moved Host has to actually become the Host it restored.
 *
 * Every enrolled machine has pinned the origin's fingerprint and will not speak
 * to anything that cannot sign for it. The archive writes that identity into
 * the settings table underneath a service that read the destination's own at
 * startup — so unless the service is told to look again, the Host advertises
 * the identity it just imported while signing with the one it is about to
 * throw away, and every Node refuses the handshake.
 */
describe("a Host that has restored a portable archive", () => {
  it("signs with the identity it just imported", async () => {
    const origin = await openHost();
    const owner = makeBrowser();
    await claim(origin, owner);
    const originIdentity = await enrollment(origin, owner);
    expect(originIdentity.hostId).toBeTruthy();

    const backup = (
      await post(origin, owner, "/api/backup/portable", { passphrase: PASSPHRASE })
    ).json();

    const destination = await openHost();
    const arriving = makeBrowser();
    arriving.remember(
      await destination.app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { cookie: arriving.cookie() },
        payload: { code: destination.claimCode() },
      }),
    );

    const imported = arriving.remember(
      await destination.app.inject({
        method: "POST",
        url: "/api/backup/portable/import",
        headers: { cookie: arriving.cookie() },
        payload: { passphrase: PASSPHRASE, backup },
      }),
    );
    expect(imported.statusCode).toBe(200);

    // The archive's administrator signs in on the machine that now holds their
    // Entra configuration, which is the only way to read an operator endpoint.
    const restored = makeBrowser();
    const started = restored.remember(
      await destination.app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: restored.cookie() },
        payload: {},
      }),
    );
    const state =
      new URL(
        (started.json() as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get("state") ?? "";
    restored.remember(
      await destination.app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: restored.cookie() },
      }),
    );

    // The identity service was reloaded, so what this Host now advertises — and
    // what it will sign a Node challenge with — is the archived key.
    const after = await enrollment(destination, restored);
    expect(after.hostId).toBe(originIdentity.hostId);
    expect(after.hostFingerprint).toBe(originIdentity.hostFingerprint);
    expect(after.hostPublicKey).toBe(originIdentity.hostPublicKey);

    const challenge = await destination.app.inject({
      method: "POST",
      url: "/api/nodes/enrollment/challenge",
      payload: { grantId: "made-up", nodePublicKey: "x".repeat(43) },
    });
    // Whatever it refuses for, it must not be for having no identity at all.
    expect(challenge.statusCode).not.toBe(500);
  });

  /**
   * Enforcement travels with the fleet.
   *
   * A Host that had declared the shared Node secret over must not come back
   * from a restore accepting it again, and must not resurrect the fleet-wide
   * enrollment token the enforcement retired.
   */
  it("keeps mutual Node authentication enforced across the move", async () => {
    const origin = await openHost();
    const owner = makeBrowser();
    await claim(origin, owner);

    const enforced = await post(origin, owner, "/api/nodes/mutual-authentication", {
      required: true,
    });
    expect(enforced.statusCode).toBe(200);

    const backup = (
      await post(origin, owner, "/api/backup/portable", { passphrase: PASSPHRASE })
    ).json();

    const destination = await openHost();
    const arriving = makeBrowser();
    arriving.remember(
      await destination.app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { cookie: arriving.cookie() },
        payload: { code: destination.claimCode() },
      }),
    );
    const imported = await destination.app.inject({
      method: "POST",
      url: "/api/backup/portable/import",
      headers: { cookie: arriving.cookie() },
      payload: { passphrase: PASSPHRASE, backup },
    });
    expect(imported.statusCode).toBe(200);

    const restored = makeBrowser();
    const started = restored.remember(
      await destination.app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: restored.cookie() },
        payload: {},
      }),
    );
    const state =
      new URL(
        (started.json() as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get("state") ?? "";
    restored.remember(
      await destination.app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: restored.cookie() },
      }),
    );

    const moved = await enrollment(destination, restored);
    expect(moved.mutualAuthenticationRequired).toBe(true);
    // The legacy credential the enforcement retired does not come back with it.
    expect(moved).not.toHaveProperty("enrollmentToken");

    const legacy = await destination.app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        enrollmentToken: "test-token",
        name: "box",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities: [],
        maxSessions: 1,
      },
    });
    expect(legacy.statusCode).toBe(403);
  });
});
