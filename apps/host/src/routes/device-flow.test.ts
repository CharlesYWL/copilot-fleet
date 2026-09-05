import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { EntraProviderUnavailableError, type EntraIdentity } from "../auth/entra.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";

const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};

/**
 * Device flow is the fallback, not the default.
 *
 * Microsoft recommends blocking it, a tenant's Conditional Access may do so,
 * and an attacker can start one and ask an administrator to type the attacker's
 * code. So it stays off until a Host has been shown its tenant permits it, and
 * a Host that has not been shown that says so rather than failing vaguely.
 */
describe("device flow", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let deviceEnabled = false;

  const build = async () => {
    const built = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "",
      announceClaimCode: (code) => {
        claimCode = code;
      },
      entraProvider: () => ({
        authorizationUrl: async ({ state }) =>
          `https://login.example/authorize?state=${state}`,
        redeemAuthorizationCode: async () => alice,
        startDeviceCode: async () => {
          // The same refusal the production provider raises when this Host has
          // not verified that its tenant permits the flow.
          if (!deviceEnabled) {
            throw new EntraProviderUnavailableError(
              "device sign-in is disabled until this tenant's policy has been verified",
            );
          }
          return {
            flowId: "provider-flow",
            userCode: "ABC-DEF",
            verificationUri: "https://microsoft.com/devicelogin",
            expiresAt: Date.now() + 600_000,
            message: "Enter ABC-DEF at https://microsoft.com/devicelogin",
          };
        },
        pollDeviceCode: async () => alice,
        // The Host stops a flow it has discarded; the fake records nothing.
        cancelDeviceCode: () => {},
      }),
    });
    built.log.level = "silent";
    await built.ready();
    return built;
  };

  const configure = async (cookies: string[]) => {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { code: claimCode },
    });
    for (const raw of [bootstrap.headers["set-cookie"] ?? []].flat()) {
      cookies.push(String(raw).split(";")[0] ?? "");
    }
    await app.inject({
      method: "POST",
      url: "/api/auth/configure",
      headers: { cookie: cookies.join("; ") },
      payload: { tenantId: TENANT, clientId: CLIENT },
    });
  };

  beforeEach(async () => {
    deviceEnabled = false;
    app = await build();
  });

  afterEach(async () => {
    await app.close();
  });

  it("refuses to start a device login on a Host that has not enabled it", async () => {
    const cookies: string[] = [];
    await configure(cookies);
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/device/start",
      headers: { cookie: cookies.join("; ") },
      payload: {},
    });
    // A named refusal, not a 404 and not a generic failure: the page tells the
    // operator to use a local forward and the loopback flow instead.
    expect(started.statusCode).toBe(503);
    expect((started.json() as { error: string }).error).toMatch(/device/i);
  });

  it("refuses to poll a flow that was never started", async () => {
    const polled = await app.inject({
      method: "POST",
      url: "/api/auth/device/poll/made-up-flow",
      payload: {},
    });
    expect([400, 401, 503]).toContain(polled.statusCode);
    expect(polled.headers["set-cookie"]).toBeUndefined();
  });

  it("hands out a user code once the tenant has been verified", async () => {
    deviceEnabled = true;
    const cookies: string[] = [];
    await configure(cookies);
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/device/start",
      headers: { cookie: cookies.join("; ") },
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    const body = started.json() as {
      flowId: string;
      userCode: string;
      verificationUri: string;
    };
    expect(body.userCode).toBe("ABC-DEF");
    expect(body.flowId).toBeTruthy();
    // The flow id is the Host's own, not the provider's, so a caller cannot
    // guess it from anything Microsoft displayed.
    expect(body.flowId).not.toBe("provider-flow");
  });

  it("will not let another browser exchange a flow it did not start", async () => {
    deviceEnabled = true;
    const cookies: string[] = [];
    await configure(cookies);
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/device/start",
      headers: { cookie: cookies.join("; ") },
      payload: {},
    });
    const { flowId } = started.json() as { flowId: string };

    const stranger = await app.inject({
      method: "POST",
      url: `/api/auth/device/poll/${flowId}`,
      payload: {},
    });
    expect(stranger.statusCode).toBe(400);
    expect(stranger.headers["set-cookie"]).toBeUndefined();
  });

  it("claims the Host through a completed device flow bound to its browser", async () => {
    deviceEnabled = true;
    const cookies: string[] = [];
    await configure(cookies);
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/device/start",
      headers: { cookie: cookies.join("; ") },
      payload: {},
    });
    for (const raw of [started.headers["set-cookie"] ?? []].flat()) {
      cookies.push(String(raw).split(";")[0] ?? "");
    }
    const { flowId } = started.json() as { flowId: string };

    const polled = await app.inject({
      method: "POST",
      url: `/api/auth/device/poll/${flowId}`,
      headers: { cookie: cookies.join("; ") },
      payload: {},
    });
    expect(polled.statusCode).toBe(200);
    const session = [polled.headers["set-cookie"] ?? []]
      .flat()
      .map(String)
      .find((value) => value.startsWith("fleet_operator="));
    expect(session).toBeTruthy();

    const status = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect((status.json() as { state: string }).state).toBe("microsoft-only");
  });

  it("does not accept a device sign-in as recent reauthentication", async () => {
    deviceEnabled = true;
    const cookies: string[] = [];
    await configure(cookies);
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/device/start",
      headers: { cookie: cookies.join("; ") },
      payload: {},
    });
    for (const raw of [started.headers["set-cookie"] ?? []].flat()) {
      cookies.push(String(raw).split(";")[0] ?? "");
    }
    const { flowId } = started.json() as { flowId: string };
    const polled = await app.inject({
      method: "POST",
      url: `/api/auth/device/poll/${flowId}`,
      headers: { cookie: cookies.join("; ") },
      payload: {},
    });
    const sessionCookie =
      [polled.headers["set-cookie"] ?? []]
        .flat()
        .map(String)
        .find((value) => value.startsWith("fleet_operator="))
        ?.split(";")[0] ?? "";

    const csrf = (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/csrf",
          headers: { cookie: sessionCookie },
        })
      ).json() as { csrfToken: string }
    ).csrfToken;

    // A device login can be started by an attacker and finished by a phished
    // administrator, which is exactly when removing everyone else is most
    // attractive. So it authenticates, and it does not authorise this.
    const invited = await app.inject({
      method: "POST",
      url: "/api/auth/administrator-invitations",
      headers: { cookie: sessionCookie, "x-csrf-token": csrf },
      payload: {},
    });
    expect(invited.statusCode).toBe(403);
  });
});
