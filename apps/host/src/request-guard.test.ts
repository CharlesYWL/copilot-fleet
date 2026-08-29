import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { NODE_ID_HEADER, NODE_SECRET_HEADER } from "@fleet/protocol";
import { buildServer } from "./server.js";
import {
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
  });

  afterEach(async () => {
    await app.close();
  });

  it("answers health and the sign-in question before anyone has signed in", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(
      200,
    );
    const status = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.json()).toEqual({ authenticated: false });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } })
      ).json(),
    ).toEqual({ authenticated: true });
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
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
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
      headers: { cookie, origin: "https://attacker.example" },
      payload: { name: "theirs", description: "" },
    });
    expect(response.statusCode).toBe(403);

    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie, origin: "http://localhost:8787" },
      payload: { name: "ours", description: "" },
    });
    expect(sameOrigin.statusCode).toBe(201);
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
        headers: { cookie },
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
        headers: { cookie },
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
  });
});
