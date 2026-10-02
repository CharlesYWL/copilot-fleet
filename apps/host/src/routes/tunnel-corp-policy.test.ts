import type { FastifyInstance, InjectOptions } from "fastify";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { TunnelInfo } from "@fleet/protocol";
import { buildServer } from "../server.js";
import { MICROSOFT_CORP_TENANT_ID, type EntraIdentity } from "../auth/entra.js";
import { BinaryProbe, TunnelSupervisor } from "../tunnel.js";

/** Each Host here is built and claimed through a real sign-in; slow, not stuck. */
const SLOW_INTEGRATION_MS = 30_000;

const apps: FastifyInstance[] = [];
let start: MockInstance<TunnelSupervisor["setEnabled"]>;

beforeEach(() => {
  vi.spyOn(BinaryProbe.prototype, "present").mockResolvedValue(true);
  start = vi.spyOn(TunnelSupervisor.prototype, "setEnabled").mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

async function claimAs(identity: EntraIdentity) {
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

  await request({
    method: "POST",
    url: "/api/auth/bootstrap",
    payload: { code: claimCode },
  });
  await request({
    method: "POST",
    url: "/api/auth/configure",
    payload: { tenantId: "common", clientId: "11111111-2222-3333-4444-555555555555" },
  });
  const started = await request({
    method: "POST",
    url: "/api/auth/code/start",
    payload: {},
  });
  const state = new URL(
    started.json<{ authorizationUrl: string }>().authorizationUrl,
  ).searchParams.get("state");
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
    info: async () =>
      (await request({ method: "GET", url: "/api/tunnel" })).json<TunnelInfo>(),
    toggle: (provider: string, enabled: boolean) =>
      request({
        method: "POST",
        url: "/api/tunnel",
        headers: { "x-csrf-token": csrfToken },
        payload: { provider, enabled },
      }),
  };
}

describe("tunnel providers for Microsoft corporate accounts", () => {
  it(
    "offers and starts only Dev Tunnels once an @microsoft.com account owns the Host",
    async () => {
      const host = await claimAs({
        tenantId: MICROSOFT_CORP_TENANT_ID,
        objectId: "staff",
        username: "Alias@Microsoft.com",
        displayName: "Staff",
      });
      const info = await host.info();
      expect(info.policy).toEqual({
        kind: "microsoft-corp",
        allowedProviders: ["devtunnel"],
      });

      for (const provider of ["cloudflare", "ngrok", "tailscale"]) {
        const refused = await host.toggle(provider, true);
        expect(refused.statusCode).toBe(400);
        expect(refused.json().error).toMatch(/not approved for Microsoft corporate use/);
      }
      expect(start).not.toHaveBeenCalled();
      // Switching a provider off is never refused, so a stray one can be stopped.
      expect((await host.toggle("cloudflare", false)).statusCode).toBe(200);
      expect((await host.toggle("devtunnel", true)).statusCode).toBe(200);
      expect(start).toHaveBeenCalledWith("devtunnel", true, true);
    },
    SLOW_INTEGRATION_MS,
  );

  it.each([
    ["alias@outlook.com", "9188040d-6c67-4c5b-b112-36a304b66dad"],
    ["alias@example.com", MICROSOFT_CORP_TENANT_ID],
    ["alias@microsoft.com", "11111111-2222-3333-4444-555555555555"],
  ])(
    "keeps every provider for %s outside the corporate identity",
    async (username, tenantId) => {
      const host = await claimAs({
        tenantId,
        objectId: "someone",
        username,
        displayName: "Someone",
      });
      const info = await host.info();
      expect(info.policy?.kind).toBe("open");
      expect(info.policy?.allowedProviders).toEqual(
        expect.arrayContaining(["cloudflare", "tailscale", "ngrok", "devtunnel"]),
      );
      expect((await host.toggle("cloudflare", true)).statusCode).toBe(200);
      expect(start).toHaveBeenCalledWith("cloudflare", true, true);
    },
    SLOW_INTEGRATION_MS,
  );
});
