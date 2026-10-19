import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TunnelProvider } from "@fleet/protocol";
import { systemRoutes } from "./system.js";
import { FleetStore } from "../store.js";
import { HostIdentityService } from "../auth/host-identity.js";
import { EnrollmentGrants } from "../auth/enrollment-grants.js";
import type { FleetAuth } from "../auth/service.js";
import type { ActiveSession } from "../auth/sessions.js";
import type { FleetService } from "../fleet-service.js";
import type { TunnelSupervisor } from "../tunnel.js";
import type { CorpDirectAccess } from "../corp-direct.js";
import { TEST_TLS_CERTIFICATE } from "../../../../packages/protocol/dist/test-tls-fixture.js";

const directUrl = "https://10.0.5.136:8787";
const tunnelUrl = "https://fleet-route.usw2.devtunnels.ms";
type Endpoint = { provider: TunnelProvider; url: string; tunnelId?: string };
const endpoints: Endpoint[] = [
  { provider: "corp-direct", url: directUrl },
  { provider: "devtunnel", url: tunnelUrl, tunnelId: "fleet-route.usw2" },
];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const fixture = async ({
  corporate = true,
  online = endpoints,
}: { corporate?: boolean; online?: Endpoint[] } = {}) => {
  const store = new FleetStore(":memory:");
  const owner = store.insertAdministrator({
    tenantId: corporate
      ? "72f988bf-86f1-41af-91ab-2d7cd011db47"
      : "9188040d-6c67-4c5b-b112-36a304b66dad",
    objectId: "route-owner",
    username: corporate ? "route-owner@microsoft.com" : "route-owner@outlook.com",
    displayName: "Synthetic owner",
    addedVia: "claim",
  });
  const identity = new HostIdentityService(store);
  const grants = new EnrollmentGrants({ store });
  const create = vi.spyOn(grants, "create");
  const setEnabled = vi.fn();
  const primary = corporate ? "corp-direct" : "cloudflare";
  const defaultUrl =
    online.find((entry) => entry.provider === primary)?.url ?? "http://127.0.0.1:8787";
  const tunnel = {
    primary,
    activeTunnelId: () => online.find((entry) => entry.provider === primary)?.tunnelId,
    enrollmentEndpoints: () => online,
    setEnabled,
    policy: () => ({
      kind: corporate ? "microsoft-corp" : "open",
      allowedProviders: corporate
        ? ["devtunnel", "corp-direct"]
        : ["cloudflare", "ngrok", "tailscale", "devtunnel"],
    }),
  } as unknown as TunnelSupervisor;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    reply
      .code(error instanceof Error && "issues" in error ? 400 : 500)
      .send({ error: error instanceof Error ? error.message : "Request failed" });
  });
  app.addHook("onRequest", async (request) => {
    request.fleetSession = {} as ActiveSession;
  });
  await app.register(systemRoutes, {
    service: { store } as FleetService,
    tunnel,
    corpDirect: {
      activeUrl: () => directUrl,
      info: () => ({ caCertificate: TEST_TLS_CERTIFICATE }),
    } as unknown as CorpDirectAccess,
    version: "test",
    enrollment: { token: undefined },
    auth: {
      noAuthEnabled: () => false,
      administratorFor: () => owner,
      agencyAvailableFor: () => corporate,
      audit: () => {},
    } as unknown as FleetAuth,
    identity,
    grants,
    fallbackPublicUrl: () => "http://127.0.0.1:8787",
    enrollmentHostUrl: () => defaultUrl,
  });
  cleanup.push(async () => {
    await app.close();
    store.close();
  });
  return {
    app,
    create,
    setEnabled,
    tunnel,
    get: () => app.inject({ method: "GET", url: "/api/enrollment" }),
    issue: (provider?: string) =>
      app.inject({
        method: "POST",
        url: "/api/enrollment-grants",
        ...(provider === undefined ? {} : { payload: { provider } }),
      }),
  };
};

describe("provider-specific connection commands", () => {
  it("lists concurrent corporate routes without minting credentials", async () => {
    const f = await fixture();
    const info = (await f.get()).json();
    expect(info.connections).toEqual([
      {
        provider: "corp-direct",
        label: "Corp direct (private IP)",
        hostUrl: directUrl,
        corpDirectCa: TEST_TLS_CERTIFICATE,
      },
      {
        provider: "devtunnel",
        label: "Dev Tunnels",
        hostUrl: tunnelUrl,
        tunnelId: "fleet-route.usw2",
      },
    ]);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("issues the requested route without mixing trust or changing the default", async () => {
    const f = await fixture();
    const direct = (await f.issue("corp-direct")).json();
    const tunnel = (await f.issue("devtunnel")).json();
    expect(direct.command).toMatchObject({
      hostUrl: directUrl,
      corpDirectCa: TEST_TLS_CERTIFICATE,
    });
    expect(direct.command).not.toHaveProperty("tunnelId");
    expect(tunnel.command).toMatchObject({
      provider: "devtunnel",
      hostUrl: tunnelUrl,
      tunnelId: "fleet-route.usw2",
    });
    expect(tunnel.command).not.toHaveProperty("corpDirectCa");
    expect(direct.grant).not.toBe(tunnel.grant);
    expect(f.tunnel.primary).toBe("corp-direct");
    expect(f.setEnabled).not.toHaveBeenCalled();
    expect((await f.issue()).json().command.hostUrl).toBe(directUrl);
  });

  it("refuses disabled and forbidden selections before creating a grant", async () => {
    const f = await fixture();
    expect((await f.issue("ngrok")).statusCode).toBe(403);
    endpoints.splice(1, 1);
    try {
      expect((await f.issue("devtunnel")).statusCode).toBe(409);
    } finally {
      endpoints.push({
        provider: "devtunnel",
        url: tunnelUrl,
        tunnelId: "fleet-route.usw2",
      });
    }
    expect((await f.issue("not-a-provider")).statusCode).toBe(400);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("offers concurrent public providers for noncorporate administrators and refuses Corp direct", async () => {
    const f = await fixture({
      corporate: false,
      online: [
        { provider: "cloudflare", url: "https://fleet.trycloudflare.com" },
        { provider: "ngrok", url: "https://fleet.ngrok.app" },
        ...endpoints,
      ],
    });
    const info = (await f.get()).json();
    expect(info.connections.map((entry: { provider: string }) => entry.provider)).toEqual(
      ["cloudflare", "ngrok", "devtunnel"],
    );
    expect((await f.issue("corp-direct")).statusCode).toBe(403);
    const issued = (await f.issue("ngrok")).json();
    expect(issued.command.hostUrl).toBe("https://fleet.ngrok.app");
    expect(issued.command).not.toHaveProperty("corpDirectCa");
    expect(issued.command).not.toHaveProperty("tunnelId");
  });

  it("resolves selections at mint time and ignores caller-supplied endpoint/trust fields", async () => {
    const online: Endpoint[] = [
      { provider: "cloudflare", url: "https://first.trycloudflare.com" },
      { provider: "ngrok", url: "https://fleet.ngrok.app" },
    ];
    const f = await fixture({ corporate: false, online });
    await f.get();
    online[0]!.url = "https://rotated.trycloudflare.com";
    const result = await f.app.inject({
      method: "POST",
      url: "/api/enrollment-grants",
      payload: {
        provider: "cloudflare",
        hostUrl: "https://attacker.invalid",
        corpDirectCa: TEST_TLS_CERTIFICATE,
        tunnelId: "wrong-tunnel",
      },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().command.hostUrl).toBe("https://rotated.trycloudflare.com");
    expect(result.json().command).not.toHaveProperty("corpDirectCa");
    expect(result.json().command).not.toHaveProperty("tunnelId");
  });

  it("retains the configured fallback when no provider is online", async () => {
    const f = await fixture({ corporate: false, online: [] });
    expect((await f.get()).json().connections).toEqual([
      {
        provider: "direct",
        label: "Configured Host URL",
        hostUrl: "http://127.0.0.1:8787",
      },
    ]);
    expect((await f.issue("direct")).statusCode).toBe(201);
  });
});
