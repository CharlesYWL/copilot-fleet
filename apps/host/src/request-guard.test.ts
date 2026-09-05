import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  NODE_ID_HEADER,
  NODE_PROOF_NONCE_HEADER,
  NODE_PROOF_SIGNATURE_HEADER,
  NODE_PROOF_TIMESTAMP_HEADER,
  NODE_SECRET_HEADER,
  parseEnrollmentGrant,
} from "@fleet/protocol";
import {
  ENROLLMENT_COMPLETION_LABEL,
  ENROLLMENT_GRANT_LABEL,
  NODE_HTTP_PROOF_WINDOW_MS,
  createIdentityKeyPair,
  enrollmentTranscript,
  grantProof,
  grantSecretDigest,
  registrationHash,
  signNodeHttpProof,
  signWithIdentity,
} from "@fleet/protocol/node-auth";
import { buildServer } from "./server.js";
import type { EntraIdentity } from "./auth/entra.js";
import {
  NodeProofNonces,
  allowedHostnames,
  hostnameOf,
  nameAllowed,
  nodeReachable,
} from "./request-guard.js";

describe("nodeReachable", () => {
  it("lets a node reach the catalog it relays for its own config page", () => {
    expect(nodeReachable("GET", "/api/workspaces")).toBe(true);
    expect(nodeReachable("POST", "/api/workspaces")).toBe(true);
    expect(nodeReachable("PATCH", "/api/workspaces/w1")).toBe(true);
    expect(nodeReachable("GET", "/api/placements")).toBe(true);
    expect(nodeReachable("POST", "/api/placements")).toBe(true);
    expect(nodeReachable("patch", "/api/placements/p1")).toBe(true);
    expect(nodeReachable("GET", "/api/sessions")).toBe(true);
    expect(nodeReachable("POST", "/api/sessions")).toBe(true);
    expect(nodeReachable("POST", "/api/sessions/adopt")).toBe(true);
  });

  it("keeps a node out of everything else, including the fleet's transcripts", () => {
    expect(nodeReachable("GET", "/api/snapshot")).toBe(false);
    expect(nodeReachable("GET", "/api/enrollment")).toBe(false);
    expect(nodeReachable("GET", "/api/backup")).toBe(false);
    expect(nodeReachable("GET", "/api/sessions/s1/events")).toBe(false);
    expect(nodeReachable("DELETE", "/api/workspaces/w1")).toBe(false);
    // Deeper paths must not ride in on a prefix.
    expect(nodeReachable("GET", "/api/placements/p1/sessions")).toBe(false);
  });
});

describe("hostnameOf", () => {
  it("takes the name out of whatever shape the header arrives in", () => {
    expect(hostnameOf("localhost:8787")).toBe("localhost");
    expect(hostnameOf("https://Fleet.Example.com/path")).toBe("fleet.example.com");
    expect(hostnameOf("[::1]:8787")).toBe("::1");
    expect(hostnameOf("http://[::1]:8787")).toBe("::1");
    expect(hostnameOf("")).toBeUndefined();
    expect(hostnameOf(undefined)).toBeUndefined();
  });
});

/**
 * A signature says who made a proof, never that it has not been made before.
 * The cache is what turns "this Node signed this call" into "this Node is
 * making this call now", and it has to be bounded: it is fed by anything that
 * can reach the Host with a node id header.
 */
describe("NodeProofNonces", () => {
  it("accepts a nonce once and refuses the same one after", () => {
    const nonces = new NodeProofNonces({ ttlMs: 1_000, limit: 10 });
    expect(nonces.claim("node-1", "a", 0)).toBe(true);
    expect(nonces.claim("node-1", "a", 0)).toBe(false);
    // Scoped per Node: two machines picking the same random value are not a
    // replay of each other.
    expect(nonces.claim("node-2", "a", 0)).toBe(true);
  });

  it("forgets a nonce once no proof carrying it could still be in the window", () => {
    const nonces = new NodeProofNonces({ ttlMs: 1_000, limit: 10 });
    expect(nonces.claim("node-1", "a", 0)).toBe(true);
    expect(nonces.claim("node-1", "a", 999)).toBe(false);
    expect(nonces.claim("node-1", "a", 1_001)).toBe(true);
  });

  it("stays bounded however many proofs arrive", () => {
    const nonces = new NodeProofNonces({ ttlMs: 60_000, limit: 4 });
    for (let index = 0; index < 50; index += 1) {
      expect(nonces.claim("node-1", `n${index}`, index)).toBe(true);
    }
    expect(nonces.size).toBeLessThanOrEqual(4);
    // The most recent are the ones still inside anyone's clock window.
    expect(nonces.claim("node-1", "n49", 50)).toBe(false);
  });
});

describe("allowedHostnames", () => {
  it("always answers to the names that mean this machine", () => {
    const names = allowedHostnames({});
    expect(names.has("localhost")).toBe(true);
    expect(names.has("127.0.0.1")).toBe(true);
    expect(names.has("::1")).toBe(true);
  });

  it("collects the names the Host is currently reachable at", () => {
    const names = allowedHostnames({
      extra: " fleet.internal , spare.example.com ",
      publicUrl: () => "https://fleet.example.com:8787",
      tunnelUrls: () => ["https://abc123-8787.usw2.devtunnels.ms"],
    });
    expect(names.has("fleet.example.com")).toBe(true);
    expect(names.has("abc123-8787.usw2.devtunnels.ms")).toBe(true);
    expect(names.has("fleet.internal")).toBe(true);
    expect(names.has("spare.example.com")).toBe(true);
  });

  it("survives a Host that has no public URL and no tunnel yet", () => {
    const names = allowedHostnames({ publicUrl: () => undefined, tunnelUrls: () => [] });
    expect(names.has("localhost")).toBe(true);
    expect(names.has("undefined")).toBe(false);
  });
});

describe("nameAllowed", () => {
  const allowed = allowedHostnames({ extra: "fleet.example.com" });

  it("accepts a listed name and any address that is this machine", () => {
    expect(nameAllowed("fleet.example.com:8787", allowed)).toBe(true);
    expect(nameAllowed("https://fleet.example.com", allowed)).toBe(true);
    expect(nameAllowed("127.0.0.1:8787", allowed)).toBe(true);
    expect(nameAllowed("127.4.5.6", allowed)).toBe(true);
  });

  it("refuses an unlisted name, and a missing one", () => {
    expect(nameAllowed("evil.example.com", allowed)).toBe(false);
    expect(nameAllowed("127.0.0.1.evil.example.com", allowed)).toBe(false);
    expect(nameAllowed(undefined, allowed)).toBe(false);
    expect(nameAllowed("", allowed)).toBe(false);
  });

  it("refuses the unspecified addresses, which reach loopback without naming it", () => {
    // A page fetching http://0.0.0.0:8787 gets this Host on most platforms;
    // accepting the name would leave a hole beside the one being closed.
    expect(nameAllowed("0.0.0.0:8787", allowed)).toBe(false);
    expect(nameAllowed("[::]:8787", allowed)).toBe(false);
  });

  it("lets an operator opt out entirely with a star", () => {
    expect(nameAllowed("anything.example.com", allowedHostnames({ extra: "*" }))).toBe(
      true,
    );
  });
});

/**
 * The guard is the whole of the Host's access control, so it is asserted
 * against a real server: a rule that is only true in a unit test is a rule an
 * added route can quietly escape.
 */
describe("guarded server", () => {
  let app: FastifyInstance;
  let cookie = "";
  let csrfToken = "";

  const enroll = async (name: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name,
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities: ["copilot-acp"],
        maxSessions: 1,
        enrollmentToken: "test-token",
      },
    });
    const body = response.json() as { nodeId: string; secret: string };
    return {
      [NODE_ID_HEADER]: body.nodeId,
      [NODE_SECRET_HEADER]: body.secret,
      nodeId: body.nodeId,
    };
  };

  beforeEach(async () => {
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "test-password",
    });
    app.log.level = "silent";
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "test-password" },
    });
    cookie = (login.headers["set-cookie"] as string).split(";")[0] ?? "";
    const csrf = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie },
    });
    csrfToken = (csrf.json() as { csrfToken: string }).csrfToken;
  });

  afterEach(async () => {
    await app.close();
  });

  it("answers health and the sign-in question before anyone has signed in", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(
      200,
    );
    const status = await app.inject({ method: "GET", url: "/api/auth/status" });
    // The answer grew a state, because "not signed in" and "nobody owns this
    // Host yet" need different pages in front of them.
    expect(status.json()).toMatchObject({
      authenticated: false,
      state: "legacy-password",
    });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } })
      ).json(),
    ).toMatchObject({ authenticated: true });
  });

  it("refuses every other API route without a session", async () => {
    for (const url of [
      "/api/snapshot",
      "/api/nodes",
      "/api/workspaces",
      "/api/enrollment",
      "/api/backup",
      "/api/logs",
      "/api/settings",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("keeps the enrollment token behind the session that guards everything else", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/enrollment" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toContain("test-token");
  });

  it("refuses a live transcript stream to a browser that has not signed in", async () => {
    const response = await app.inject({ method: "GET", url: "/ws/browser" });
    expect(response.statusCode).toBe(401);
  });

  it("stops honouring a session once it has been signed out", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/snapshot", headers: { cookie } }))
        .statusCode,
    ).toBe(200);
    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/snapshot", headers: { cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it("refuses a name this Host does not answer to, session or not", async () => {
    const rebound = await app.inject({
      method: "GET",
      url: "/api/snapshot",
      headers: { cookie, host: "fleet.attacker.example" },
    });
    expect(rebound.statusCode).toBe(403);
  });

  it("refuses a request a page on another origin made", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie, "x-csrf-token": csrfToken, origin: "https://attacker.example" },
      payload: { name: "theirs", description: "" },
    });
    expect(response.statusCode).toBe(403);

    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        host: "localhost:8787",
        origin: "http://localhost:8787",
      },
      payload: { name: "ours", description: "" },
    });
    expect(sameOrigin.statusCode).toBe(201);
  });

  it("refuses another localhost port instead of treating every localhost page as same-origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        host: "localhost:8787",
        origin: "http://localhost:3000",
      },
      payload: { name: "cross-port", description: "" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("marks every answer as not for framing and not for sniffing", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("same-origin");
  });

  describe("node credentials", () => {
    it("reach the catalog the node relays, and nothing else", async () => {
      const headers = await enroll("box");
      expect(
        (await app.inject({ method: "GET", url: "/api/workspaces", headers })).statusCode,
      ).toBe(200);
      const forbidden = await app.inject({
        method: "GET",
        url: "/api/snapshot",
        headers,
      });
      expect(forbidden.statusCode).toBe(403);
      expect(
        (await app.inject({ method: "GET", url: "/api/enrollment", headers })).statusCode,
      ).toBe(403);
    });

    it("are rejected when the secret is wrong", async () => {
      const headers = await enroll("box");
      const response = await app.inject({
        method: "GET",
        url: "/api/workspaces",
        headers: { ...headers, [NODE_SECRET_HEADER]: "not-the-secret" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("cannot place a workspace onto another node", async () => {
      const box = await enroll("box");
      const other = await enroll("other");
      const workspace = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { cookie, "x-csrf-token": csrfToken },
        payload: { name: "repo", description: "" },
      });
      const workspaceId = (workspace.json() as { id: string }).id;

      const mine = await app.inject({
        method: "POST",
        url: "/api/placements",
        headers: box,
        payload: { workspaceId, nodeId: box.nodeId, localPath: "/tmp/repo" },
      });
      expect(mine.statusCode).toBe(201);

      const theirs = await app.inject({
        method: "POST",
        url: "/api/placements",
        headers: box,
        payload: { workspaceId, nodeId: other.nodeId, localPath: "/tmp/repo" },
      });
      expect(theirs.statusCode).toBe(403);
    });

    it("cannot repoint another node's checkout", async () => {
      const box = await enroll("box");
      const other = await enroll("other");
      const workspace = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { cookie, "x-csrf-token": csrfToken },
        payload: { name: "repo", description: "" },
      });
      const placement = await app.inject({
        method: "POST",
        url: "/api/placements",
        headers: box,
        payload: {
          workspaceId: (workspace.json() as { id: string }).id,
          nodeId: box.nodeId,
          localPath: "/tmp/repo",
        },
      });
      const placementId = (placement.json() as { id: string }).id;

      const hijack = await app.inject({
        method: "PATCH",
        url: `/api/placements/${placementId}`,
        headers: other,
        payload: { localPath: "/tmp/elsewhere" },
      });
      expect(hijack.statusCode).toBe(403);

      const own = await app.inject({
        method: "PATCH",
        url: `/api/placements/${placementId}`,
        headers: box,
        payload: { localPath: "/tmp/elsewhere" },
      });
      expect(own.statusCode).toBe(200);
    });

    it("cannot create or adopt a session on another node's placement", async () => {
      const box = await enroll("box");
      const other = await enroll("other");
      const workspace = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: box,
        payload: { name: "repo", description: "" },
      });
      const placement = await app.inject({
        method: "POST",
        url: "/api/placements",
        headers: box,
        payload: {
          workspaceId: (workspace.json() as { id: string }).id,
          nodeId: box.nodeId,
          localPath: "/tmp/repo",
        },
      });
      const placementId = (placement.json() as { id: string }).id;

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: other,
            payload: { placementId, prompt: "hijack" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/sessions/adopt",
            headers: other,
            payload: { placementId, agentSessionId: "acp-secret" },
          })
        ).statusCode,
      ).toBe(403);
    });

    /**
     * A node relays the catalog for its own config page, and that page only
     * ever shows this machine's checkouts. Handing it the whole fleet's
     * placements makes every node's credential a map of every other node —
     * absolute paths, machine names and all — filtered by whoever happens to be
     * asking rather than by the Host. Scoping it here is the difference
     * between a relay and a directory service.
     */
    it("sees only its own placements, never the rest of the fleet's", async () => {
      const box = await enroll("box");
      const other = await enroll("other");
      const workspace = await app.inject({
        method: "POST",
        url: "/api/workspaces",

        headers: { cookie, "x-csrf-token": csrfToken },
        payload: { name: "repo", description: "" },
      });
      const workspaceId = (workspace.json() as { id: string }).id;
      await app.inject({
        method: "POST",
        url: "/api/placements",
        headers: box,
        payload: { workspaceId, nodeId: box.nodeId, localPath: "/tmp/box" },
      });
      await app.inject({
        method: "POST",
        url: "/api/placements",
        headers: other,
        payload: { workspaceId, nodeId: other.nodeId, localPath: "/tmp/other" },
      });

      const mine = (
        await app.inject({ method: "GET", url: "/api/placements", headers: box })
      ).json() as { nodeId: string; localPath: string }[];
      expect(mine.map((placement) => placement.nodeId)).toEqual([box.nodeId]);
      expect(JSON.stringify(mine)).not.toContain("/tmp/other");

      // The operator's console is the surface that arranges the whole fleet,
      // so nothing is hidden from it.
      const all = (
        await app.inject({ method: "GET", url: "/api/placements", headers: { cookie } })
      ).json() as { nodeId: string }[];
      expect(all.map((placement) => placement.nodeId).sort()).toEqual(
        [box.nodeId, other.nodeId].sort(),
      );
    });
  });

  /**
   * The orchestrator's control plane, seen from the guard.
   *
   * `/mcp` used to be an early `return` — indistinguishable from having no
   * rule at all — on the grounds that the route authenticates itself. It does,
   * but the name a request claims to have arrived under and whether a browser
   * sent it are the guard's questions everywhere else, and answering them for
   * every principal except this one is how an endpoint reachable from the
   * internet ends up with one check instead of three.
   */
  describe("the lead control plane", () => {
    const mcp = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...headers,
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });

    it("refuses a name this Host does not answer to before looking at the token", async () => {
      const response = await mcp({
        host: "fleet.attacker.example",
        authorization: "Bearer flt_whatever.whatever",
      });

      expect(response.statusCode).toBe(403);
    });

    it("refuses anything a browser sent, however it names this Host", async () => {
      const response = await mcp({
        host: "localhost:8787",
        origin: "http://localhost:8787",
        authorization: "Bearer flt_whatever.whatever",
      });

      expect(response.statusCode).toBe(403);
    });

    it("lets a name it does answer to through to the token check", async () => {
      const response = await mcp({
        host: "127.0.0.1:8787",
        authorization: "Bearer flt_whatever.whatever",
      });

      // 401 rather than 403: the guard was satisfied and the route was not.
      expect(response.statusCode).toBe(401);
    });

    it("does not accept an operator session in place of a lead token", async () => {
      const response = await mcp({ host: "localhost:8787", cookie });

      expect(response.statusCode).toBe(401);
    });
  });
});

/**
 * A name this Host published over plain HTTP.
 *
 * The console already refuses to issue a session over one, but the console is
 * not the only credential that crosses this wire. A lead token authorises the
 * orchestrator's whole tool surface and travels in an `Authorization` header;
 * a legacy registration answers with a reusable node secret in the response
 * body. Both are readable to anyone on the path of a `bore` relay or a LAN
 * address, and neither is protected by a rule that only covers cookies.
 */
describe("credentials over a plain-HTTP address this Host published", () => {
  let app: FastifyInstance;
  let previousPublicUrl: string | undefined;

  beforeEach(async () => {
    previousPublicUrl = process.env.FLEET_PUBLIC_URL;
    process.env.FLEET_PUBLIC_URL = "http://fleet.lan:8787";
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "test-password",
    });
    app.log.level = "silent";
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (previousPublicUrl === undefined) delete process.env.FLEET_PUBLIC_URL;
    else process.env.FLEET_PUBLIC_URL = previousPublicUrl;
  });

  it("refuses a lead token presented over it", async () => {
    const refused = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "fleet.lan:8787",
        authorization: "Bearer whatever",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    // 403 rather than 401: the address is the refusal, not the token.
    expect(refused.statusCode).toBe(403);
    expect(String((refused.json() as { error: string }).error)).toMatch(
      /plain HTTP|not encrypted|HTTPS/i,
    );
  });

  it("still serves the same endpoint on loopback", async () => {
    const reached = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "127.0.0.1:8787",
        authorization: "Bearer whatever",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(reached.statusCode).toBe(401);
  });

  it("refuses to mint a reusable node secret over it", async () => {
    const refused = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      headers: { host: "fleet.lan:8787" },
      payload: {
        name: "over-the-wire",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities: ["copilot-acp"],
        maxSessions: 1,
        enrollmentToken: "test-token",
      },
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain("secret");
  });

  it("still registers a legacy machine over loopback", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      headers: { host: "127.0.0.1:8787" },
      payload: {
        name: "on-the-box",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities: ["copilot-acp"],
        maxSessions: 1,
        enrollmentToken: "test-token",
      },
    });
    expect(registered.statusCode).toBe(201);
  });
});

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const alice: EntraIdentity = {
  tenantId: TENANT,
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
};

/** The cookies a browser would keep, so a login flow can be driven by hand. */
function cookieJar() {
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
}

/**
 * A keyed Node has no shared secret, so it proves each relayed call instead.
 *
 * The proof has to be worth less than the secret it replaces or the exchange
 * is a downgrade: bound to one method, one path and one body, valid for a
 * minute, and refused the second time it is presented.
 */
describe("a keyed node's signed calls", () => {
  let app: FastifyInstance;
  let claimCode = "";
  let owner: ReturnType<typeof cookieJar>;

  const csrfFor = async (browser: ReturnType<typeof cookieJar>) =>
    (
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/csrf",
          headers: { cookie: browser.cookie() },
        })
      ).json() as { csrfToken: string }
    ).csrfToken;

  beforeEach(async () => {
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: "",
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

    // A grant is minted only by an administrator with a recent Microsoft
    // login, so getting a keyed Node onto this Host means running that flow.
    owner = cookieJar();
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
    const started = owner.remember(
      await app.inject({
        method: "POST",
        url: "/api/auth/code/start",
        headers: { cookie: owner.cookie() },
        payload: {},
      }),
    );
    const state = new URL(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    owner.remember(
      await app.inject({
        method: "GET",
        url: `/api/auth/entra/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`,
        headers: { cookie: owner.cookie() },
      }),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  /** A machine on the protocol the keys replace, for the confusion tests. */
  const enroll = async (name: string) => {
    const body = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: {
          name,
          os: "linux",
          arch: "x64",
          version: "0.1.0",
          capabilities: ["copilot-acp"],
          maxSessions: 1,
          enrollmentToken: "test-token",
        },
      })
    ).json() as { nodeId: string; secret: string };
    return { nodeId: body.nodeId, secret: body.secret };
  };

  const enrollKeyed = async (name: string) => {
    const issued = (
      await app.inject({
        method: "POST",
        url: "/api/enrollment-grants",
        headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
        payload: {},
      })
    ).json() as { grant: string };
    const parts = parseEnrollmentGrant(issued.grant);
    const keys = createIdentityKeyPair();
    const payload = {
      name,
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      revision: "",
      capabilities: ["copilot-acp"],
      agents: [],
      maxSessions: 1,
      homeDir: "/home/box",
    };
    const nodeNonce = randomBytes(32).toString("base64");
    const dialedHostUrl = "https://fleet.example.com";
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/enrollment/challenge",
        payload: {
          grantId: parts?.id,
          nodeNonce,
          nodePublicKey: keys.publicKey,
          registrationHash: registrationHash(payload),
          dialedHostUrl,
        },
      })
    ).json() as { challengeId: string; hostId: string; hostNonce: string };
    const fields = {
      challengeId: challenge.challengeId,
      hostId: challenge.hostId,
      hostNonce: challenge.hostNonce,
      nodeNonce,
      nodePublicKey: keys.publicKey,
      registrationHash: registrationHash(payload),
      dialedHostUrl,
    };
    const receipt = (
      await app.inject({
        method: "POST",
        url: "/api/nodes/register",
        payload: {
          challengeId: challenge.challengeId,
          registration: payload,
          nodeSignature: signWithIdentity(
            keys.privateKey,
            enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, fields),
          ),
          grantProof: grantProof(
            grantSecretDigest(parts?.secret ?? ""),
            enrollmentTranscript(ENROLLMENT_GRANT_LABEL, fields),
          ),
        },
      })
    ).json() as { nodeId: string };
    return { keys, nodeId: receipt.nodeId };
  };

  const proofHeaders = (
    node: { keys: ReturnType<typeof createIdentityKeyPair>; nodeId: string },
    input: { method: string; path: string; body?: string },
  ) =>
    signNodeHttpProof({
      privateKey: node.keys.privateKey,
      nodeId: node.nodeId,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
    });

  const headersFor = (
    node: { keys: ReturnType<typeof createIdentityKeyPair>; nodeId: string },
    input: { method: string; path: string; body?: string },
  ) => {
    const proof = proofHeaders(node, input);
    return {
      [NODE_ID_HEADER]: node.nodeId,
      [NODE_PROOF_TIMESTAMP_HEADER]: proof.timestamp,
      [NODE_PROOF_NONCE_HEADER]: proof.nonce,
      [NODE_PROOF_SIGNATURE_HEADER]: proof.signature,
    };
  };

  it("reaches the catalog it relays, and nothing else", async () => {
    const node = await enrollKeyed("keyed");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/workspaces",
          headers: headersFor(node, { method: "GET", path: "/api/workspaces" }),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: headersFor(node, { method: "GET", path: "/api/snapshot" }),
        })
      ).statusCode,
    ).toBe(403);
  });

  it("is the node it signed as, so its own placement is the one it may write", async () => {
    const node = await enrollKeyed("keyed");
    const other = await enroll("other");
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
      payload: { name: "repo", description: "" },
    });
    const workspaceId = (workspace.json() as { id: string }).id;

    const body = JSON.stringify({
      workspaceId,
      nodeId: node.nodeId,
      localPath: "/tmp/repo",
    });
    const mine = await app.inject({
      method: "POST",
      url: "/api/placements",
      headers: {
        ...headersFor(node, { method: "POST", path: "/api/placements", body }),
        "content-type": "application/json",
      },
      payload: body,
    });
    expect(mine.statusCode).toBe(201);

    const theirs = JSON.stringify({
      workspaceId,
      nodeId: other.nodeId,
      localPath: "/tmp/repo",
    });
    const refused = await app.inject({
      method: "POST",
      url: "/api/placements",
      headers: {
        ...headersFor(node, {
          method: "POST",
          path: "/api/placements",
          body: theirs,
        }),
        "content-type": "application/json",
      },
      payload: theirs,
    });
    expect(refused.statusCode).toBe(403);
  });

  /**
   * The same scoping, on the protocol that replaced the secret.
   *
   * A signature says which machine is calling exactly the way a secret did, so
   * the answer has to narrow the same way. Leaving the keyed path unscoped
   * would make upgrading a fleet the thing that widened it.
   */
  it("reads back only its own placements", async () => {
    const node = await enrollKeyed("keyed");
    const other = await enroll("other");
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: owner.cookie(), "x-csrf-token": await csrfFor(owner) },
      payload: { name: "repo", description: "" },
    });
    const workspaceId = (workspace.json() as { id: string }).id;

    const body = JSON.stringify({
      workspaceId,
      nodeId: node.nodeId,
      localPath: "/tmp/keyed",
    });
    await app.inject({
      method: "POST",
      url: "/api/placements",
      headers: {
        ...headersFor(node, { method: "POST", path: "/api/placements", body }),
        "content-type": "application/json",
      },
      payload: body,
    });
    await app.inject({
      method: "POST",
      url: "/api/placements",
      headers: {
        [NODE_ID_HEADER]: other.nodeId,
        [NODE_SECRET_HEADER]: other.secret,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        workspaceId,
        nodeId: other.nodeId,
        localPath: "/tmp/other",
      }),
    });

    const mine = (
      await app.inject({
        method: "GET",
        url: "/api/placements",
        headers: headersFor(node, { method: "GET", path: "/api/placements" }),
      })
    ).json() as { nodeId: string; localPath: string }[];
    // Its own workspace checkout and the Chats row every machine gets — both
    // this node's, and nothing else's.
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((placement) => placement.nodeId))).toEqual(
      new Set([node.nodeId]),
    );
    expect(JSON.stringify(mine)).not.toContain("/tmp/other");
  });
  it("refuses a proof replayed even one second later", async () => {
    const node = await enrollKeyed("keyed");
    const headers = headersFor(node, { method: "GET", path: "/api/workspaces" });

    expect(
      (await app.inject({ method: "GET", url: "/api/workspaces", headers })).statusCode,
    ).toBe(200);
    // The same nonce a second time is a captured proof being reused, which is
    // the one thing a signature alone does not stop.
    expect(
      (await app.inject({ method: "GET", url: "/api/workspaces", headers })).statusCode,
    ).toBe(401);
  });

  it("refuses a proof minted for a different request", async () => {
    const node = await enrollKeyed("keyed");
    const read = headersFor(node, { method: "GET", path: "/api/workspaces" });

    // Same signature, different path: the proof authorises one call.
    expect(
      (await app.inject({ method: "GET", url: "/api/placements", headers: read }))
        .statusCode,
    ).toBe(401);
    const body = JSON.stringify({ name: "repo", description: "" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/workspaces",
          headers: {
            ...headersFor(node, {
              method: "POST",
              path: "/api/workspaces",
              body: JSON.stringify({ name: "other", description: "" }),
            }),
            "content-type": "application/json",
          },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
  });

  it("refuses a proof signed by a key this Host never enrolled", async () => {
    const node = await enrollKeyed("keyed");
    const impostor = { keys: createIdentityKeyPair(), nodeId: node.nodeId };
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/workspaces",
          headers: headersFor(impostor, { method: "GET", path: "/api/workspaces" }),
        })
      ).statusCode,
    ).toBe(401);
  });

  it("refuses a stale proof, and one from a clock far ahead", async () => {
    const node = await enrollKeyed("keyed");
    const stale = signNodeHttpProof({
      privateKey: node.keys.privateKey,
      nodeId: node.nodeId,
      method: "GET",
      path: "/api/workspaces",
      now: Date.now() - NODE_HTTP_PROOF_WINDOW_MS - 1_000,
    });
    const ahead = signNodeHttpProof({
      privateKey: node.keys.privateKey,
      nodeId: node.nodeId,
      method: "GET",
      path: "/api/workspaces",
      now: Date.now() + NODE_HTTP_PROOF_WINDOW_MS + 1_000,
    });
    for (const proof of [stale, ahead]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/workspaces",
            headers: {
              [NODE_ID_HEADER]: node.nodeId,
              [NODE_PROOF_TIMESTAMP_HEADER]: proof.timestamp,
              [NODE_PROOF_NONCE_HEADER]: proof.nonce,
              [NODE_PROOF_SIGNATURE_HEADER]: proof.signature,
            },
          })
        ).statusCode,
      ).toBe(401);
    }
  });

  it("does not let a legacy Node's secret pass as a signature, or the reverse", async () => {
    const legacy = await enroll("box");
    const node = await enrollKeyed("keyed");

    // A legacy secret on a row that has a key instead.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/workspaces",
          headers: { [NODE_ID_HEADER]: node.nodeId, [NODE_SECRET_HEADER]: "anything" },
        })
      ).statusCode,
    ).toBe(401);
    // And a signature for a row that has no key.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/workspaces",
          headers: headersFor(
            { keys: createIdentityKeyPair(), nodeId: legacy.nodeId },
            { method: "GET", path: "/api/workspaces" },
          ),
        })
      ).statusCode,
    ).toBe(401);
  });
});
