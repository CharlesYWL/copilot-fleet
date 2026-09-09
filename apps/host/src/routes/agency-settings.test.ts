import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { MICROSOFT_CORP_TENANT_ID, type EntraIdentity } from "../auth/entra.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function signIn(identity: EntraIdentity) {
  let claimCode = "";
  const app = await buildServer({
    databasePath: ":memory:",
    enrollmentToken: "test-token",
    operatorPassword: "",
    announceClaimCode: (code) => {
      claimCode = code;
    },
    entraProvider: () => ({
      authorizationUrl: async ({ state }) =>
        `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${state}`,
      redeemAuthorizationCode: async () => identity,
      startDeviceCode: async () => {
        throw new Error("Unused device flow");
      },
      pollDeviceCode: async () => {
        throw new Error("Unused device flow");
      },
      cancelDeviceCode: () => {},
    }),
  });
  apps.push(app);
  app.log.level = "silent";
  await app.ready();
  const cookies = new Map<string, string>();
  const request = async (options: InjectOptions) => {
    const response = await app.inject({
      ...options,
      headers: {
        ...options.headers,
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      },
    });
    const raw = response.headers["set-cookie"];
    for (const cookie of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const [name, ...value] = cookie.split(";")[0]!.split("=");
      if (name) cookies.set(name, value.join("="));
    }
    return response;
  };

  expect(
    (
      await request({
        method: "POST",
        url: "/api/auth/bootstrap",
        payload: { code: claimCode },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await request({
        method: "POST",
        url: "/api/auth/configure",
        payload: { tenantId: "common", clientId: "11111111-2222-3333-4444-555555555555" },
      })
    ).statusCode,
  ).toBe(200);
  const started = await request({
    method: "POST",
    url: "/api/auth/code/start",
    payload: {},
  });
  const url = started.json<{ authorizationUrl: string }>().authorizationUrl;
  const state = new URL(url).searchParams.get("state");
  expect(
    (
      await request({
        method: "GET",
        url: `/api/auth/entra/callback?code=test&state=${state}`,
      })
    ).statusCode,
  ).toBe(302);
  const csrfToken = (await request({ method: "GET", url: "/api/auth/csrf" })).json<{
    csrfToken: string;
  }>().csrfToken;
  return {
    read: () => request({ method: "GET", url: "/api/defaults" }),
    update: (payload: Record<string, unknown>) =>
      request({
        method: "POST",
        url: "/api/defaults",
        headers: { "x-csrf-token": csrfToken },
        payload,
      }),
  };
}

describe("staff-only Agency settings", () => {
  it("reports eligibility from the signed-in identity and preserves it across partial updates", async () => {
    const { read, update } = await signIn({
      tenantId: MICROSOFT_CORP_TENANT_ID,
      objectId: "staff",
      username: "Alias@Microsoft.com",
      displayName: "Staff",
    });
    expect((await read()).json()).toMatchObject({
      agencyModeAvailable: true,
      agencyMode: false,
    });
    const enabled = await update({ agencyMode: true });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      agencyModeAvailable: true,
      agencyMode: true,
      yolo: false,
    });
    expect((await update({ model: "deep" })).json()).toMatchObject({
      agencyModeAvailable: true,
      agencyMode: true,
      model: "deep",
    });
    expect((await update({ agencyMode: "true" })).statusCode).toBe(400);
    expect((await update({ agencyMode: false })).json()).toMatchObject({
      agencyModeAvailable: true,
      agencyMode: false,
      model: "deep",
    });
  });

  it.each([
    ["alias@outlook.com", "9188040d-6c67-4c5b-b112-36a304b66dad"],
    ["alias@example.com", MICROSOFT_CORP_TENANT_ID],
    ["alias@microsoft.com", "11111111-2222-3333-4444-555555555555"],
  ])(
    "hides and rejects Agency settings for %s outside the corporate identity",
    async (username, tenantId) => {
      const { read, update } = await signIn({
        tenantId,
        objectId: "non-staff",
        username,
        displayName: "Microsoft employee",
      });
      expect((await read()).json()).toMatchObject({ agencyModeAvailable: false });
      for (const agencyMode of [true, false]) {
        const refused = await update({
          agencyMode,
          agencyModeAvailable: true,
          yolo: true,
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error).toContain("@microsoft.com");
      }
      expect((await read()).json()).toMatchObject({ agencyMode: false, yolo: false });
      expect((await update({ yolo: true })).statusCode).toBe(200);
      expect((await read()).json()).toMatchObject({
        agencyModeAvailable: false,
        agencyMode: false,
        yolo: true,
      });
    },
  );
});
