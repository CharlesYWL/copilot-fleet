import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resolveLegacyEnrollmentToken } from "./config.js";
import { packageRoot } from "./paths.js";
import { buildServer } from "./server.js";
import { FleetStore } from "./store.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";

const alice = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};

/** Scratch databases live under the package, never in a shared temp directory. */
const scratchRoot = join(packageRoot(), "data", "test-scratch");

const scratchDatabase = (): string => {
  mkdirSync(scratchRoot, { recursive: true });
  return join(mkdtempSync(join(scratchRoot, "legacy-")), "fleet.db");
};

type Signed = { app: FastifyInstance; cookie: string };

/**
 * Claims a Host and returns a signed-in browser's cookies.
 *
 * `/api/enrollment` is an operator endpoint, so reading it takes a session —
 * which is also the honest way to ask "what would an administrator be shown".
 */
async function claimed(options: {
  databasePath: string;
  enrollmentToken?: string | undefined;
}): Promise<Signed> {
  let claimCode = "";
  const app = await buildServer({
    databasePath: options.databasePath,
    ...(options.enrollmentToken !== undefined
      ? { enrollmentToken: options.enrollmentToken }
      : {}),
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

  const jar = new Map<string, string>();
  const remember = (response: { headers: Record<string, unknown> }) => {
    const raw = response.headers["set-cookie"];
    for (const pair of (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map(
      (value) => String(value).split(";")[0] ?? "",
    )) {
      const [name, ...rest] = pair.split("=");
      if (!name) continue;
      const value = rest.join("=");
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
  };
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  remember(
    await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { code: claimCode },
    }),
  );
  remember(
    await app.inject({
      method: "POST",
      url: "/api/auth/configure",
      headers: { cookie: cookie() },
      payload: { tenantId: TENANT, clientId: CLIENT },
    }),
  );
  const started = await app.inject({
    method: "POST",
    url: "/api/auth/code/start",
    headers: { cookie: cookie() },
    payload: {},
  });
  remember(started);
  const state =
    new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state") ?? "";
  remember(
    await app.inject({
      method: "GET",
      url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookie() },
    }),
  );
  return { app, cookie: cookie() };
}

/**
 * The fleet-wide enrollment token is a migration artefact, not an install step.
 *
 * A fresh Host enrols machines with one-time grants bound to a Node key. It has
 * nothing for a reusable fleet-wide string to do, so requiring one to boot is a
 * secret an operator has to invent, store, and eventually leak for no benefit —
 * and persisting one anyway leaves a credential in the settings table that
 * nothing was ever meant to accept.
 */
describe("resolveLegacyEnrollmentToken", () => {
  const generate = () => "generated-token";

  it("gives a fresh grant-only Host no token at all", () => {
    expect(
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: undefined,
        legacyNodes: 0,
        nodeEnv: "production",
        generate,
      }),
    ).toBeUndefined();
  });

  it("keeps the token an upgraded Host already stored", () => {
    expect(
      resolveLegacyEnrollmentToken({
        stored: "already-in-the-database",
        env: undefined,
        legacyNodes: 0,
        nodeEnv: "production",
        generate,
      }),
    ).toBe("already-in-the-database");
  });

  /*
   * The machines are the evidence. A Host carrying rows that authenticate with
   * a shared secret is mid-migration whatever its settings table lost, and
   * leaving it with no token would refuse the very Nodes the token exists for.
   */
  it("mints one for an upgrade whose token went missing", () => {
    expect(
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: undefined,
        legacyNodes: 2,
        nodeEnv: "production",
        generate,
      }),
    ).toBe("generated-token");
  });

  it("honours an explicitly configured token as a compatibility escape hatch", () => {
    expect(
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: "operator-chose-this",
        legacyNodes: 0,
        nodeEnv: "production",
        generate,
      }),
    ).toBe("operator-chose-this");
  });

  /*
   * The placeholder is the one value that is never a decision: it is what the
   * sample file ships with, so accepting it in production would turn "left the
   * example alone" into a fleet-wide credential every reader of the repository
   * already knows.
   */
  it("still refuses the shipped placeholder in production", () => {
    expect(() =>
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: "change-me",
        legacyNodes: 0,
        nodeEnv: "production",
        generate,
      }),
    ).toThrow(/ENROLLMENT_TOKEN/);
  });

  it("tolerates the placeholder outside production", () => {
    expect(
      resolveLegacyEnrollmentToken({
        stored: undefined,
        env: "change-me",
        legacyNodes: 0,
        nodeEnv: "development",
        generate,
      }),
    ).toBe("change-me");
  });
});

describe("a fresh production Host", () => {
  let app: FastifyInstance | undefined;
  let previousEnv: string | undefined;
  let previousToken: string | undefined;

  beforeEach(() => {
    previousEnv = process.env.NODE_ENV;
    previousToken = process.env.ENROLLMENT_TOKEN;
    process.env.NODE_ENV = "production";
    delete process.env.ENROLLMENT_TOKEN;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousToken === undefined) delete process.env.ENROLLMENT_TOKEN;
    else process.env.ENROLLMENT_TOKEN = previousToken;
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  /** Booting is the claim UI's only prerequisite; a legacy secret is not one. */
  it("starts and serves the claim surface without an ENROLLMENT_TOKEN", async () => {
    app = await buildServer({ databasePath: ":memory:", operatorPassword: "" });
    app.log.level = "silent";
    await app.ready();
    const status = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.statusCode).toBe(200);
    expect((status.json() as { state: string }).state).toBe("unclaimed");
  });

  it("persists no fleet-wide enrollment token", async () => {
    const databasePath = scratchDatabase();
    app = await buildServer({ databasePath, operatorPassword: "" });
    app.log.level = "silent";
    await app.ready();
    await app.close();
    app = undefined;
    const store = new FleetStore(databasePath);
    expect(store.getSetting("enrollment.token") ?? "").toBe("");
    store.close();
  }, 30_000);

  it("does not publish a legacy token from /api/enrollment", async () => {
    const signed = await claimed({ databasePath: ":memory:" });
    app = signed.app;
    const enrollment = await app.inject({
      method: "GET",
      url: "/api/enrollment",
      headers: { cookie: signed.cookie },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.json()).not.toHaveProperty("enrollmentToken");
  });

  /*
   * With no token there is nothing to match, and a registration that matched
   * nothing would be an unauthenticated way onto the fleet. The refusal names
   * the path that does work rather than reading as a broken endpoint.
   */
  it("refuses legacy token registration outright", async () => {
    app = await buildServer({
      databasePath: ":memory:",
      operatorPassword: "hunter2-hunter2",
    });
    app.log.level = "silent";
    await app.ready();
    const registered = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name: "worker-1",
        enrollmentToken: "anything-at-all",
        os: "linux",
        arch: "x64",
        version: "0.3.0",
        capabilities: [],
        maxSessions: 2,
        homeDir: "/home/fleet",
      },
    });
    expect(registered.statusCode).toBe(403);
    expect((registered.json() as { error: string }).error).toMatch(/Connect command/i);
  });
});

describe("a Host enforcing mutual Node authentication", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  /*
   * Enforcement is the operator declaring the shared secret over. Continuing to
   * hand its value out on an endpoint any caller may read would keep it alive
   * as an authority nobody is watching.
   */
  it("withholds the legacy token from /api/enrollment", async () => {
    const databasePath = scratchDatabase();
    const seed = new FleetStore(databasePath);
    seed.setMutualNodeAuthenticationRequired(true);
    seed.setSetting("enrollment.token", "still-stored");
    seed.close();

    const signed = await claimed({ databasePath });
    app = signed.app;
    const enrollment = await app.inject({
      method: "GET",
      url: "/api/enrollment",
      headers: { cookie: signed.cookie },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.json()).not.toHaveProperty("enrollmentToken");
    expect(
      (enrollment.json() as { mutualAuthenticationRequired: boolean })
        .mutualAuthenticationRequired,
    ).toBe(true);
  });
});
