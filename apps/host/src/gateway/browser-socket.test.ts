import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildServer } from "../server.js";
import { AUTHENTICATION_CLOSE_CODE } from "./browser-registry.js";
import type { EntraIdentity } from "../auth/entra.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";

const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};
const bob: EntraIdentity = {
  tenantId: TENANT,
  objectId: "bob-object-id",
  username: "bob@example.com",
  displayName: "Bob",
};

/**
 * The revocation that matters most.
 *
 * A REST check happens once and ends; this socket streams every transcript in
 * the fleet for as long as the tab stays open, so an administrator removed
 * while watching is exactly the case where "their cookie stops working" is not
 * enough.
 */
describe("browser socket revocation", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let nextIdentity: EntraIdentity = alice;
  let baseUrl = "";

  const jarFor = () => {
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

  type Browser = ReturnType<typeof jarFor>;

  const signIn = async (browser: Browser) => {
    const started = browser.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: browser.cookie() },
        payload: {},
      }),
    );
    if (started.statusCode !== 200) return started;
    const state = new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    return browser.remember(
      await app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=c&state=${encodeURIComponent(state ?? "")}`,
        headers: { cookie: browser.cookie() },
      }),
    );
  };

  const csrfFor = async (browser: Browser) =>
    (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/csrf",
          headers: { cookie: browser.cookie() },
        })
      ).json() as { csrfToken: string }
    ).csrfToken;

  /** Opens a real socket, so the assertion is about the wiring and not a stub. */
  const openSocket = (cookie: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}/ws/browser`, { headers: { cookie } });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });

  const closeCodeOf = (socket: WebSocket) =>
    new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket stayed open")), 5_000);
      socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

  beforeEach(async () => {
    nextIdentity = alice;
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "",
      announceClaimCode: (code) => {
        claimCode = code;
      },
      entraProvider: () => ({
        authorizationUrl: async ({ state }) =>
          `https://login.example/authorize?state=${state}`,
        redeemAuthorizationCode: async () => nextIdentity,
        startDeviceCode: async () => {
          throw new Error("device flow is not enabled on this Host");
        },
        pollDeviceCode: async () => nextIdentity,
        // The Host stops a flow it has discarded; the fake records nothing.
        cancelDeviceCode: () => {},
      }),
    });
    app.log.level = "silent";
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it("refuses a stream to a browser that has not signed in", async () => {
    await expect(openSocket("")).rejects.toThrow(/401/);
  });

  it("closes the stream the moment its administrator is removed", async () => {
    const owner = jarFor();
    owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { cookie: owner.cookie() },
        payload: { code: claimCode },
      }),
    );
    owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/configure",
        headers: { cookie: owner.cookie() },
        payload: { tenantId: TENANT, clientId: CLIENT },
      }),
    );
    await signIn(owner);

    // A second administrator, so removing the first is even allowed.
    const invitation = (
      await app.inject({
        method: "POST",
        url: "/api/auth/administrator-invitations",
        headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
        payload: {},
      })
    ).json() as { id: string; token: string };
    nextIdentity = bob;
    const candidate = jarFor();
    const started = candidate.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: candidate.cookie() },
        payload: { invitation: invitation.token },
      }),
    );
    const state = new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    await app.inject({
      method: "GET",
      url: `/api/auth/entra/callback?code=c&state=${encodeURIComponent(state ?? "")}`,
      headers: { cookie: candidate.cookie() },
    });
    await app.inject({
      method: "POST",
      url: `/api/auth/administrator-invitations/${invitation.id}/approve`,
      headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
      payload: {},
    });

    const bobBrowser = jarFor();
    await signIn(bobBrowser);
    const socket = await openSocket(bobBrowser.cookie());
    const closed = closeCodeOf(socket);

    const administrators = (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/administrators",
          headers: { cookie: owner.cookie() },
        })
      ).json() as { administrators: { id: string; objectId: string }[] }
    ).administrators;
    const bobId =
      administrators.find((row) => row.objectId === "bob-object-id")?.id ?? "";

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/auth/administrators/${bobId}`,
      headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
    });
    expect(removed.statusCode).toBe(200);

    expect(await closed).toBe(AUTHENTICATION_CLOSE_CODE);
  });

  it("closes the stream when the operator signs out", async () => {
    const owner = jarFor();
    owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: { cookie: owner.cookie() },
        payload: { code: claimCode },
      }),
    );
    owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/configure",
        headers: { cookie: owner.cookie() },
        payload: { tenantId: TENANT, clientId: CLIENT },
      }),
    );
    await signIn(owner);

    const socket = await openSocket(owner.cookie());
    const closed = closeCodeOf(socket);

    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
    });

    expect(await closed).toBe(AUTHENTICATION_CLOSE_CODE);
  });
});
