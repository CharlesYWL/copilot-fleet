import { execFile } from "node:child_process";
import type * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import { announceClaimCode } from "./claim-announcement.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: vi.fn(() => {
    throw new Error("Unexpected OS clipboard access");
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("claim startup fixtures", () => {
  it("does not execute clipboard commands for an ordinary unclaimed test Host", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    vi.stubEnv("DISPLAY", ":0");
    const app = await buildServer({
      databasePath: ":memory:",
      operatorPassword: "",
      useBuiltInEntra: true,
    });
    try {
      expect(output.mock.calls.flat().join("")).toContain("Copilot Fleet is unclaimed");
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { authority: "common", tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad" },
    {
      authority: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    },
  ])(
    "configures $authority and claims from the printed dev link with host-scoped cookies",
    async ({ authority, tenantId }) => {
      vi.stubEnv("npm_lifecycle_event", "dev");
      vi.stubEnv("PORT", "8787");
      vi.stubEnv("FLEET_ENTRA_CLIENT_ID", undefined);
      vi.stubEnv("FLEET_ENTRA_TENANT_ID", undefined);
      const configuration = {
        tenantId: authority,
        clientId: "11111111-2222-4333-8444-555555555555",
      };
      let claimCode = "";
      let announcement = "";
      let callbackUri = "";
      const app = await buildServer({
        databasePath: ":memory:",
        operatorPassword: "",
        useBuiltInEntra: true,
        announceClaimCode: (code) => {
          claimCode = code;
          void announceClaimCode(code, {
            development: true,
            publicUrl: "http://127.0.0.1:8787",
            write: (message) => {
              announcement += message;
            },
            copy: async () => false,
          });
        },
        entraProvider: () => ({
          authorizationUrl: async ({ state, redirectUri }) => {
            callbackUri = redirectUri;
            return `https://login.microsoftonline.com/authorize?state=${state}`;
          },
          redeemAuthorizationCode: async () => ({
            tenantId,
            objectId: "test-operator",
            username: "operator@example.com",
            displayName: "Operator",
          }),
          startDeviceCode: async () => {
            throw new Error("unused");
          },
          pollDeviceCode: async () => {
            throw new Error("unused");
          },
          cancelDeviceCode: () => {},
        }),
      });
      // Host-only cookies cross ports, but never cross from 127.0.0.1 to localhost.
      const jar = new Map<string, Map<string, { pair: string; strict: boolean }>>();
      const cookieHeader = (url: URL, crossSite = false) =>
        [...(jar.get(url.hostname)?.values() ?? [])]
          .filter((cookie) => !crossSite || !cookie.strict)
          .map((cookie) => cookie.pair)
          .join("; ");
      const request = async (url: URL, payload?: object, crossSite = false) => {
        const response = await app.inject({
          method: payload ? "POST" : "GET",
          url: url.pathname + url.search,
          headers: {
            host: url.host,
            cookie: cookieHeader(url, crossSite),
            ...(payload ? { origin: url.origin } : {}),
          },
          ...(payload ? { payload } : {}),
        });
        const raw = response.headers["set-cookie"];
        const cookies = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
        const hostCookies = jar.get(url.hostname) ?? new Map();
        jar.set(url.hostname, hostCookies);
        for (const cookie of cookies) {
          expect(cookie).not.toMatch(/;\s*Domain=/i);
          expect(cookie).toContain("Path=/");
          const pair = cookie.split(";")[0]!;
          const [name, value] = pair.split("=");
          if (!value) hostCookies.delete(name!);
          else
            hostCookies.set(name!, { pair, strict: cookie.includes("SameSite=Strict") });
        }
        return response;
      };
      try {
        const link = new URL(announcement.match(/Claim it at (\S+)/)![1]!);
        const initial = await request(new URL("/api/auth/status", link));
        expect(initial.json()).toMatchObject({
          state: "entra-unconfigured",
          entraConfigured: false,
          claimCodeRequired: true,
          authenticated: false,
        });
        expect(
          (await request(new URL("/api/auth/configure", link), configuration)).statusCode,
        ).toBe(401);
        expect(
          (await request(new URL("/api/auth/bootstrap", link), { code: claimCode }))
            .statusCode,
        ).toBe(200);
        expect(cookieHeader(link)).toContain("fleet_bootstrap=");
        expect(cookieHeader(new URL("http://127.0.0.1:5173"))).toBe("");
        const configured = await request(
          new URL("/api/auth/configure", link),
          configuration,
        );
        expect(configured.statusCode).toBe(200);
        expect(configured.json()).toMatchObject(configuration);
        expect((await request(new URL("/api/auth/status", link))).json()).toMatchObject({
          state: "unclaimed",
          entraConfigured: true,
          authenticated: false,
        });
        const started = await request(new URL("/api/auth/code/start", link), {});
        expect(started.statusCode).toBe(200);
        const state = new URL(started.json().authorizationUrl).searchParams.get("state")!;
        const callback = new URL(callbackUri);
        expect(callback.origin).toBe("http://localhost:8787");
        expect(callback.pathname).toBe("/api/auth/entra/callback");
        expect(cookieHeader(callback, true)).toContain("fleet_bind=");
        expect(cookieHeader(callback, true)).not.toContain("fleet_bootstrap=");
        callback.searchParams.set("code", "synthetic-auth-code");
        callback.searchParams.set("state", state);
        const finished = await request(callback, undefined, true);
        expect(finished.statusCode).toBe(302);
        expect(finished.headers.location).toBe(new URL("/?welcome=1", link).href);
        const status = await request(
          new URL("/api/auth/status", String(finished.headers.location)),
        );
        expect(status.json()).toMatchObject({
          state: "microsoft-only",
          authenticated: true,
          entra: configuration,
          identity: { username: "operator@example.com" },
        });
        const logs = await request(new URL("/api/logs", link));
        expect(logs.statusCode).toBe(200);
        expect(logs.body).not.toContain(claimCode);
      } finally {
        await app.close();
      }
    },
  );
});
