import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

/**
 * Route-level coverage.
 *
 * Every rule below used to live inside one 800-line closure with no way in
 * from a test, so the only thing ever asserted about the Host was its handful
 * of exported pure functions.
 */
describe("host routes", () => {
  let app: FastifyInstance;

  const enroll = async (name: string, capabilities = ["copilot-acp", "host-yolo"]) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name,
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities,
        maxSessions: 1,
        enrollmentToken: "test-token",
      },
    });
    return response.json() as { nodeId: string; secret: string };
  };

  beforeEach(async () => {
    app = await buildServer({ databasePath: ":memory:", enrollmentToken: "test-token" });
    app.log.level = "silent";
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("reports health and an empty snapshot", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapshot.json()).toMatchObject({
      nodes: [],
      workspaces: [],
      placements: [],
      sessions: [],
    });
    // Whatever commit the suite runs from, the snapshot has to carry one, or
    // the browser has nothing to compare a node's revision against.
    expect(snapshot.json()).toHaveProperty("hostRevision");
  });

  it("refuses enrollment with the wrong token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name: "intruder",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        capabilities: [],
        maxSessions: 1,
        enrollmentToken: "not-the-token",
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it("issues a secret once and reclaims the node on re-enrollment", async () => {
    const first = await enroll("weili-pc");
    const second = await enroll("weili-pc");
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.secret).not.toBe(first.secret);

    const nodes = await app.inject({ method: "GET", url: "/api/nodes" });
    expect(nodes.json()).toHaveLength(1);
    // The secret must never travel back out over a listing route.
    expect(JSON.stringify(nodes.json())).not.toContain(second.secret);
  });

  it("rejects a duplicate workspace name", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "fleet", description: "" },
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "fleet", description: "" },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("answers 404 for unknown ids instead of throwing", async () => {
    const routes = [
      { method: "PATCH" as const, url: "/api/nodes/missing", payload: { name: "x" } },
      {
        method: "PATCH" as const,
        url: "/api/workspaces/missing",
        payload: { name: "x", description: "" },
      },
      {
        method: "PATCH" as const,
        url: "/api/placements/missing",
        payload: { localPath: "/tmp" },
      },
      { method: "GET" as const, url: "/api/sessions/missing/events" },
      { method: "PATCH" as const, url: "/api/sessions/missing", payload: { name: "x" } },
      { method: "DELETE" as const, url: "/api/sessions/missing" },
    ];
    for (const route of routes) {
      const response = await app.inject(route);
      expect(response.statusCode, route.url).toBe(404);
    }
  });

  it("maps schema violations to 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { description: "no name" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a session on an offline node", async () => {
    const { nodeId } = await enroll("offline-node");
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "fleet", description: "" },
    });
    const placement = await app.inject({
      method: "POST",
      url: "/api/placements",
      payload: {
        workspaceId: (workspace.json() as { id: string }).id,
        nodeId,
        localPath: "/tmp/fleet",
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        placementId: (placement.json() as { id: string }).id,
        prompt: "hello",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "Node is offline" });
  });

  it("refuses a placement for an unknown node", async () => {
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "fleet", description: "" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/placements",
      payload: {
        workspaceId: (workspace.json() as { id: string }).id,
        nodeId: "missing",
        localPath: "/tmp/fleet",
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("round-trips the session defaults", async () => {
    // Both are on when unset, so each toggle has to be able to turn its own off.
    const read = async () =>
      (await app.inject({ method: "GET", url: "/api/defaults" })).json();
    expect(await read()).toEqual({ yolo: true, autoResume: true });

    await app.inject({ method: "POST", url: "/api/defaults", payload: { yolo: false } });
    // A client that knows about one setting must not reset the other simply by
    // not mentioning it.
    expect(await read()).toEqual({ yolo: false, autoResume: true });

    await app.inject({
      method: "POST",
      url: "/api/defaults",
      payload: { autoResume: false },
    });
    expect(await read()).toEqual({ yolo: false, autoResume: false });
  });

  it("serves the enrollment command inputs", async () => {
    const response = await app.inject({ method: "GET", url: "/api/enrollment" });
    expect(response.json()).toMatchObject({ enrollmentToken: "test-token" });
    expect((response.json() as { hostUrl: string }).hostUrl).toMatch(/^http/);
  });

  it("exports and replaces the fleet from a Host archive", async () => {
    const enrolled = await enroll("box");
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "repo", description: "" },
    });
    expect(created.statusCode).toBe(201);

    const exported = await app.inject({ method: "GET", url: "/api/backup" });
    expect(exported.statusCode).toBe(200);
    const backup = exported.json() as {
      kind: string;
      enrollmentToken: string;
      publicUrl?: string;
    };
    expect(backup.kind).toBe("copilot-fleet-host");
    expect(backup.enrollmentToken).toBe("test-token");
    expect(backup.publicUrl).toBeUndefined();

    backup.enrollmentToken = "restored-token";
    const imported = await app.inject({
      method: "POST",
      url: "/api/backup",
      payload: backup,
    });
    expect(imported.statusCode).toBe(200);

    const snapshot = (
      await app.inject({ method: "GET", url: "/api/snapshot" })
    ).json() as {
      nodes: { id: string }[];
      workspaces: { name: string }[];
    };
    expect(snapshot.nodes.map((node) => node.id)).toContain(enrolled.nodeId);
    expect(snapshot.workspaces.map((workspace) => workspace.name)).toContain("repo");
    expect(
      (await app.inject({ method: "GET", url: "/api/enrollment" })).json(),
    ).toMatchObject({
      enrollmentToken: "restored-token",
    });
  });

  it("refuses a Node identity file on the Host import endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/backup",
      payload: {
        kind: "copilot-fleet-node",
        version: 1,
        exportedAt: new Date().toISOString(),
        credentials: {
          hostUrl: "https://fleet.example.com",
          nodeId: "n1",
          secret: "s",
          name: "box",
        },
        settings: {
          hostUrl: "https://fleet.example.com",
          nodeName: "box",
          maxSessions: 4,
          copilotCommand: "",
          permissionTimeoutMs: 30_000,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("node's config page"),
    });
  });

  it("keeps unknown API paths as JSON 404s", async () => {
    const response = await app.inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
  });
});
