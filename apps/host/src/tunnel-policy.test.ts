import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { TunnelInfo } from "@fleet/protocol";
import { buildServer } from "./server.js";
import { FleetStore } from "./store.js";
import { providerSpecs } from "./tunnel-providers.js";

/**
 * Each of these builds a whole Host and signs an operator in with a password,
 * which means a KDF per test. That is genuinely slow rather than stuck, and the
 * default five seconds is a limit the suite trips over only when the rest of
 * the workspace is running beside it.
 */
const SLOW_INTEGRATION_MS = 30_000;

/**
 * Which door the operator console may be reachable through.
 *
 * The UI can grey a switch out, but a switch is not a policy: the refusal has
 * to be the Host's, because `POST /api/tunnel` is reachable by anything holding
 * an operator session, including a script that never renders the panel.
 */
describe("tunnel provider policy", () => {
  it("starts a fresh Host on the private provider, not an anonymous public one", () => {
    const store = new FleetStore(":memory:");
    // Nothing has chosen yet: the first tunnel a Host offers is the one whose
    // URL grants nobody anything by itself.
    expect(store.getTunnelProvider()).toBe("devtunnel");
    store.close();
  });

  it("marks the plain-HTTP relay ineligible for the control plane", () => {
    expect(providerSpecs.bore.externalScheme).toBe("http");
    expect(providerSpecs.bore.controlPlaneEligible).toBe(false);
    expect(providerSpecs.devtunnel.access).toBe("creator-private");
    expect(providerSpecs.devtunnel.controlPlaneEligible).toBe(true);
    expect(providerSpecs.cloudflare.access).toBe("public");
  });

  describe("with a claimed Host", () => {
    let app: FastifyInstance;
    const jar = new Map<string, string>();
    const cookieHeader = () =>
      [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const remember = <T extends { headers: Record<string, unknown> }>(response: T): T => {
      const raw = response.headers["set-cookie"];
      const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
      for (const cookie of list.map((value) => String(value).split(";")[0] ?? "")) {
        const [name, ...rest] = cookie.split("=");
        if (!name) continue;
        const value = rest.join("=");
        if (value === "") jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };

    beforeEach(async () => {
      jar.clear();
      // A password Host is the shortest route to an operator session; the
      // provider refusal is about the endpoint, not about who is asking.
      app = await buildServer({
        databasePath: ":memory:",
        enrollmentToken: "test-token",
        operatorPassword: "hunter2",
      });
      app.log.level = "silent";
      await app.ready();
      remember(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: "hunter2" },
        }),
      );
    });

    afterEach(async () => {
      await app.close();
    });

    const csrf = async () =>
      (
        (
          await app.inject({
            method: "GET",
            url: "/api/auth/csrf",
            headers: { cookie: cookieHeader() },
          })
        ).json() as { csrfToken: string }
      ).csrfToken;

    it(
      "refuses to expose the operator console over a plain-HTTP relay",
      async () => {
        const refused = await app.inject({
          method: "POST",
          url: "/api/tunnel",
          headers: { cookie: cookieHeader(), "x-csrf-token": await csrf() },
          payload: { provider: "bore", enabled: true },
        });

        expect(refused.statusCode).toBe(400);
        expect(String((refused.json() as { error: string }).error)).toMatch(
          /plain HTTP|not encrypted|HTTPS/i,
        );
        const info = (
          await app.inject({
            method: "GET",
            url: "/api/tunnel",
            headers: { cookie: cookieHeader() },
          })
        ).json() as TunnelInfo;
        expect(info.tunnels.find((entry) => entry.provider === "bore")?.enabled).toBe(
          false,
        );
      },
      SLOW_INTEGRATION_MS,
    );

    it(
      "still lets that provider be switched off",
      async () => {
        const off = await app.inject({
          method: "POST",
          url: "/api/tunnel",
          headers: { cookie: cookieHeader(), "x-csrf-token": await csrf() },
          payload: { provider: "bore", enabled: false },
        });
        expect(off.statusCode).toBe(200);
      },
      SLOW_INTEGRATION_MS,
    );

    it(
      "publishes each provider's scheme and access so the panel can warn",
      async () => {
        const info = (
          await app.inject({
            method: "GET",
            url: "/api/tunnel",
            headers: { cookie: cookieHeader() },
          })
        ).json() as TunnelInfo;

        expect(info.providers.find((spec) => spec.id === "devtunnel")).toMatchObject({
          access: "creator-private",
          externalScheme: "https",
          controlPlaneEligible: true,
        });
        expect(info.providers.find((spec) => spec.id === "bore")).toMatchObject({
          access: "public",
          externalScheme: "http",
          controlPlaneEligible: false,
        });
      },
      SLOW_INTEGRATION_MS,
    );
  });
});
