import { createHash } from "node:crypto";
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

const PASSPHRASE = "correct horse battery staple";

type Browser = {
  remember: <T extends { headers: Record<string, unknown> }>(response: T) => T;
  cookie: () => string;
  jar: Map<string, string>;
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
    jar,
    remember,
    cookie: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
  };
};

/** One Host, with the console code it printed on its way up. */
type Host = { app: FastifyInstance; claimCode: () => string };

async function startHost(operatorPassword = ""): Promise<Host> {
  let claimCode = "";
  const app = await buildServer({
    databasePath: ":memory:",
    enrollmentToken: "test-token",
    operatorPassword,
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
  app.log.level = "silent";
  await app.ready();
  return { app, claimCode: () => claimCode };
}

/**
 * Moving a Host to another machine.
 *
 * The archive carries the administrator table and every key the Host signs and
 * derives with, so the file is the Host's authority in transit. These assert
 * the two ends of that: what it takes to produce one, and what it takes to
 * make a machine accept one.
 */
describe("portable security backup", () => {
  let origin: Host;
  let owner: Browser;

  const bootstrap = async (host: Host, browser: Browser) =>
    browser.remember(
      await host.app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { cookie: browser.cookie() },
        payload: { code: host.claimCode() },
      }),
    );

  const configure = async (host: Host, browser: Browser) =>
    browser.remember(
      await host.app.inject({
        method: "POST",
        url: "/api/auth/configure",
        headers: { cookie: browser.cookie() },
        payload: { tenantId: TENANT, clientId: CLIENT },
      }),
    );

  const signIn = async (host: Host, browser: Browser) => {
    const started = browser.remember(
      await host.app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: browser.cookie() },
        payload: {},
      }),
    );
    const url = (started.json() as { authorizationUrl: string }).authorizationUrl;
    const state = new URL(url).searchParams.get("state") ?? "";
    return browser.remember(
      await host.app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: browser.cookie() },
      }),
    );
  };

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
    await bootstrap(host, browser);
    await configure(host, browser);
    await signIn(host, browser);
  };

  const exportBackup = async () => {
    const response = await post(origin, owner, "/api/backup/portable", {
      passphrase: PASSPHRASE,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, unknown>;
  };

  beforeEach(async () => {
    origin = await startHost();
    owner = makeBrowser();
    await claim(origin, owner);
  });

  afterEach(async () => {
    await origin.app.close();
  });

  it("exports an archive whose security half is unreadable without the passphrase", async () => {
    const registered = await origin.app.inject({
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
    const nodeSecret = (registered.json() as { secret: string }).secret;
    const backup = await exportBackup();

    expect(backup).toMatchObject({
      kind: "copilot-fleet-host",
      version: 2,
      security: { cipher: "aes-256-gcm", kdf: { algorithm: "scrypt" } },
    });
    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("alice-object-id");
    expect(serialized).not.toContain(PASSPHRASE);
    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain(
      createHash("sha256").update(nodeSecret).digest("hex"),
    );
    expect(backup).not.toHaveProperty("enrollmentToken");
    expect((backup.nodes as Record<string, unknown>[])[0]).not.toHaveProperty(
      "secretHash",
    );
  });

  it("refuses to export to anyone who is not a signed-in administrator", async () => {
    const stranger = makeBrowser();

    const refused = await origin.app.inject({
      method: "POST",
      url: "/api/backup/portable",
      payload: { passphrase: PASSPHRASE },
      headers: { cookie: stranger.cookie() },
    });

    expect(refused.statusCode).toBe(401);
  });

  it("refuses to export for an operator who signed in with the shared password", async () => {
    // A password proves no individual, so it cannot authorise handing over the
    // Host's identity and administrator table in a single file.
    const legacy = await startHost("test-password");
    try {
      const browser = makeBrowser();
      browser.remember(
        await legacy.app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: "test-password" },
        }),
      );

      const refused = await post(legacy, browser, "/api/backup/portable", {
        passphrase: PASSPHRASE,
      });

      expect(refused.statusCode).toBe(403);
    } finally {
      await legacy.app.close();
    }
  });

  it("refuses a passphrase short enough to be guessed offline", async () => {
    const refused = await post(origin, owner, "/api/backup/portable", {
      passphrase: "too-short",
    });

    expect(refused.statusCode).toBe(400);
  });

  it("claims a fresh Host with the console code and the passphrase", async () => {
    const backup = await exportBackup();
    const destination = await startHost();
    try {
      const browser = makeBrowser();
      await bootstrap(destination, browser);

      const imported = browser.remember(
        await destination.app.inject({
          method: "POST",
          url: "/api/backup/portable/import",
          headers: { cookie: browser.cookie() },
          payload: { passphrase: PASSPHRASE, backup },
        }),
      );

      expect(imported.statusCode).toBe(200);
      // A restore is not a login: the administrator signs in afterwards
      // through the Entra configuration that was just restored.
      expect(browser.jar.get("fleet_operator")).toBeUndefined();
      const status = await destination.app.inject({
        method: "GET",
        url: "/api/auth/status",
      });
      expect(status.json()).toMatchObject({
        state: "microsoft-only",
        authenticated: false,
        claimCodeRequired: false,
        entraConfigured: true,
      });
    } finally {
      await destination.app.close();
    }
  });

  it("refuses to claim a fresh Host without the console code", async () => {
    const backup = await exportBackup();
    const destination = await startHost();
    try {
      const refused = await destination.app.inject({
        method: "POST",
        url: "/api/backup/portable/import",
        payload: { passphrase: PASSPHRASE, backup },
      });

      expect(refused.statusCode).toBe(401);
      expect(
        (await destination.app.inject({ method: "GET", url: "/api/auth/status" })).json(),
      ).toMatchObject({ claimCodeRequired: true });
    } finally {
      await destination.app.close();
    }
  });

  it("refuses the wrong passphrase, and leaves the Host as it found it", async () => {
    const backup = await exportBackup();
    const destination = await startHost();
    try {
      const browser = makeBrowser();
      await bootstrap(destination, browser);

      const refused = await destination.app.inject({
        method: "POST",
        url: "/api/backup/portable/import",
        headers: { cookie: browser.cookie() },
        payload: { passphrase: "not-the-passphrase-at-all", backup },
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.body).not.toContain(PASSPHRASE);
      expect(
        (await destination.app.inject({ method: "GET", url: "/api/auth/status" })).json(),
      ).toMatchObject({ claimCodeRequired: true });
    } finally {
      await destination.app.close();
    }
  });

  it("takes an administrator's own session away when it lands on a claimed Host", async () => {
    const backup = await exportBackup();

    const imported = await post(origin, owner, "/api/backup/portable/import", {
      passphrase: PASSPHRASE,
      backup,
    });

    expect(imported.statusCode).toBe(200);
    // Every session is revoked, including the one that asked for the restore:
    // the Host it is signing into is not the Host it signed into.
    const after = await origin.app.inject({
      method: "GET",
      url: "/api/snapshot",
      headers: { cookie: owner.cookie() },
    });
    expect(after.statusCode).toBe(401);
  });

  it("will not let an unauthenticated caller restore over a claimed Host", async () => {
    const backup = await exportBackup();
    const stranger = makeBrowser();

    const refused = await origin.app.inject({
      method: "POST",
      url: "/api/backup/portable/import",
      headers: { cookie: stranger.cookie() },
      payload: { passphrase: PASSPHRASE, backup },
    });

    expect(refused.statusCode).toBe(401);
    expect(
      (
        await origin.app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { cookie: owner.cookie() },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("refuses an unauthenticated restore before parsing the archive body", async () => {
    const refused = await origin.app.inject({
      method: "POST",
      url: "/api/backup/portable/import",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expect(refused.statusCode).toBe(401);
  });

  it("tells an operator who posts a portable archive to the data restore what to do", async () => {
    const backup = await exportBackup();

    const refused = await post(origin, owner, "/api/backup", backup);

    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatch(/passphrase/i);
  });
});
