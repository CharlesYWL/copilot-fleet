import { afterEach, describe, expect, it } from "vitest";
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

/**
 * A refused callback is still a person standing in front of a browser.
 *
 * The callback is a full-page navigation, so whatever it answers with is what
 * the operator is left looking at. A JSON body or a framework 500 in the
 * address bar gives them no explanation, no next step, and no way back to the
 * console — which is why every outcome has to end as a redirect into the app
 * carrying a code the app has its own words for.
 */
describe("a Microsoft sign-in that Entra refuses", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let redeem: () => Promise<EntraIdentity> = async () => alice;

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
        redeemAuthorizationCode: () => redeem(),
        startDeviceCode: async () => {
          throw new Error("not used");
        },
        pollDeviceCode: async () => alice,
        cancelDeviceCode: () => {},
      }),
    });
    built.log.level = "silent";
    await built.ready();
    return built;
  };

  const startLogin = async (): Promise<{ cookies: string[]; state: string }> => {
    const cookies: string[] = [];
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: { host: "localhost:8787" },
      payload: { code: claimCode },
    });
    for (const raw of [bootstrap.headers["set-cookie"] ?? []].flat()) {
      cookies.push(String(raw).split(";")[0] ?? "");
    }
    await app.inject({
      method: "POST",
      url: "/api/auth/configure",
      headers: { cookie: cookies.join("; "), host: "localhost:8787" },
      payload: { tenantId: TENANT, clientId: CLIENT },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/code/start",
      headers: { cookie: cookies.join("; "), host: "localhost:8787" },
      payload: {},
    });
    for (const raw of [started.headers["set-cookie"] ?? []].flat()) {
      cookies.push(String(raw).split(";")[0] ?? "");
    }
    const url = new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    );
    return { cookies, state: url.searchParams.get("state") ?? "" };
  };

  const callback = async () => {
    const { cookies, state } = await startLogin();
    return app.inject({
      method: "GET",
      url: `/api/auth/entra/callback?code=abc&state=${state}`,
      headers: { cookie: cookies.join("; "), host: "localhost:8787" },
    });
  };

  afterEach(async () => {
    redeem = async () => alice;
    await app.close();
  });

  it("redirects with a named code when the authorization code was already spent", async () => {
    app = await build();
    redeem = async () => {
      throw Object.assign(new Error("AADSTS54005: code already redeemed"), {
        errorCode: "invalid_grant",
      });
    };
    const response = await callback();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("auth_error=expired");
  });

  it("redirects when the id token nonce does not match", async () => {
    app = await build();
    redeem = async () => {
      throw new Error("nonce_mismatch_error: the nonce does not match");
    };
    const response = await callback();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("auth_error=expired");
  });

  it("redirects when the Host cannot reach Microsoft at all", async () => {
    app = await build();
    redeem = async () => {
      throw new Error("getaddrinfo ENOTFOUND login.microsoftonline.com");
    };
    const response = await callback();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("auth_error=provider-unavailable");
  });

  /*
   * The one case that is genuinely a bug in Fleet still has to leave the
   * operator somewhere they can act. It is logged as an error and redirected
   * like the rest, because a stack trace in an address bar helps nobody.
   */
  it("redirects rather than answering with JSON when something unexpected breaks", async () => {
    app = await build();
    redeem = async () => {
      throw new TypeError("cannot read properties of undefined");
    };
    const response = await callback();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("auth_error=provider-unavailable");
    expect(response.headers["content-type"] ?? "").not.toContain("application/json");
  });

  /*
   * Whatever Microsoft said about the account belongs in the Host's log, not in
   * a URL the operator may paste into a ticket.
   */
  it("keeps provider text out of the redirect", async () => {
    app = await build();
    redeem = async () => {
      throw new Error("AADSTS50126: Error validating credentials for bob@contoso.com");
    };
    const response = await callback();
    expect(String(response.headers.location)).not.toContain("bob%40contoso.com");
    expect(String(response.headers.location)).not.toContain("AADSTS50126");
  });
});
