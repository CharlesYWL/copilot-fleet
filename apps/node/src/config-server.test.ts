import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MUTUAL_AUTH_PROTOCOL,
  NODE_ID_HEADER,
  NODE_PROOF_NONCE_HEADER,
  NODE_PROOF_SIGNATURE_HEADER,
  NODE_PROOF_TIMESTAMP_HEADER,
  NODE_SECRET_HEADER,
  type NodeBackup,
} from "@fleet/protocol";
import { createIdentityKeyPair, verifyNodeHttpProof } from "@fleet/protocol/node-auth";
import {
  createConfigRouter,
  refuseRequest,
  type ConfigServerOptions,
  type FleetApi,
} from "./config-server.js";
import type { Credentials } from "./config.js";
import { settingsFromEnv } from "./settings.js";

const workspace = { id: "ws-1", name: "fleet", description: "" };
const placement = {
  id: "pl-1",
  workspaceId: "ws-1",
  nodeId: "node-1",
  localPath: "/tmp/fleet",
};

/** Everything the router needs except the Host client, which varies by test. */
const baseOptions = (): Omit<ConfigServerOptions, "fleet"> => ({
  getSettings: () => settingsFromEnv({}),
  getStatus: () => ({
    nodeId: "node-1",
    version: "0.1.0",
    connected: true,
    activeSessions: 0,
    mockAgent: false,
  }),
  applySettings: vi.fn(async () => {}),
  getCredentials: () => ({
    hostUrl: "http://127.0.0.1:8787",
    nodeId: "node-1",
    authProtocol: "legacy-secret",
    secret: "secret",
    name: "node",
  }),
  applyBackup: vi.fn(async () => {}),
  log: () => {},
  inspectPath: (path) =>
    path.trim() === "/tmp/fleet"
      ? { ok: true, kind: "directory" }
      : { ok: false, reason: "No such folder" },
});

function router(overrides: Partial<ConfigServerOptions> = {}) {
  const fleet: FleetApi = {
    listWorkspaces: vi.fn(async () => [workspace]),
    listOwnPlacements: vi.fn(async () => [placement]),
    createWorkspace: vi.fn(async () => workspace),
    updateWorkspace: vi.fn(async () => workspace),
    createOwnPlacement: vi.fn(async () => placement),
    updateOwnPlacementPath: vi.fn(async () => placement),
  };
  const options: ConfigServerOptions = { ...baseOptions(), fleet, ...overrides };
  return { route: createConfigRouter(options), fleet, options };
}

/**
 * The same router with the Host client the process actually builds.
 *
 * `router` above replaces it with a stub, which is right for the endpoint
 * behaviour and wrong for the one thing that has to be asserted here: what this
 * process puts on the wire on the page's behalf.
 */
function relayingRouter(overrides: Partial<ConfigServerOptions> = {}) {
  return createConfigRouter({ ...baseOptions(), ...overrides });
}

/**
 * The page this server serves can repoint the node at a different Host, which
 * on a machine that runs agents is a full compromise, so what a browser is
 * allowed to reach it with is asserted directly.
 */
describe("refuseRequest", () => {
  const base = { method: "GET", host: "127.0.0.1:8788", port: 8788 };

  it("allows the page's own requests", () => {
    expect(refuseRequest(base)).toBeUndefined();
    expect(refuseRequest({ ...base, host: "localhost:8788" })).toBeUndefined();
    expect(refuseRequest({ ...base, host: "[::1]:8788" })).toBeUndefined();
    expect(
      refuseRequest({
        ...base,
        method: "POST",
        origin: "http://127.0.0.1:8788",
        contentType: "application/json",
      }),
    ).toBeUndefined();
  });

  it("refuses a name that resolves here but is not here", () => {
    // The shape of DNS rebinding: the attacker's own name, pointed at
    // loopback, which makes their page same-origin with this server.
    expect(refuseRequest({ ...base, host: "config.attacker.example" })).toMatchObject({
      status: 403,
    });
    expect(refuseRequest({ ...base, host: undefined })).toMatchObject({ status: 403 });
    // A loopback name on the wrong port is another server's page.
    expect(refuseRequest({ ...base, host: "127.0.0.1:9999" })).toMatchObject({
      status: 403,
    });
  });

  it("refuses a request another page made", () => {
    expect(
      refuseRequest({ ...base, method: "POST", origin: "https://attacker.example" }),
    ).toMatchObject({ status: 403 });
    expect(
      refuseRequest({ ...base, method: "GET", origin: "http://127.0.0.1:8787" }),
    ).toMatchObject({ status: 403 });
  });

  it("insists on a content type a cross-site form cannot send", () => {
    for (const contentType of [
      undefined,
      "text/plain",
      "application/x-www-form-urlencoded",
    ]) {
      expect(
        refuseRequest({
          ...base,
          method: "POST",
          ...(contentType ? { contentType } : {}),
        }),
      ).toMatchObject({ status: 415 });
    }
    expect(
      refuseRequest({
        ...base,
        method: "POST",
        contentType: "application/json; charset=utf-8",
      }),
    ).toBeUndefined();
    // Reads are exempt: they carry no body to have declared.
    expect(refuseRequest({ ...base, method: "HEAD" })).toBeUndefined();
  });
});

describe("config router", () => {
  it("serves settings and status together", async () => {
    const { route } = router();
    const response = await route("GET", "/api/config", "");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: { nodeId: "node-1" } });
  });

  it("rejects settings the schema refuses without calling applySettings", async () => {
    const applySettings = vi.fn(async () => {});
    const { route } = router({ applySettings });
    const response = await route(
      "POST",
      "/api/config",
      JSON.stringify({ hostUrl: "nope" }),
    );
    expect(response.status).toBe(400);
    expect(applySettings).not.toHaveBeenCalled();
  });

  it("applies valid settings", async () => {
    const applySettings = vi.fn(async () => {});
    const { route } = router({ applySettings });
    const response = await route(
      "POST",
      "/api/config",
      JSON.stringify(settingsFromEnv({ FLEET_HOST_URL: "https://new.example" })),
    );
    expect(response.status).toBe(200);
    expect(applySettings).toHaveBeenCalledOnce();
  });

  it("keeps the fallback Host addresses a save never mentions", async () => {
    // The page posts back only the fields it shows. Parsing that as the whole
    // settings object would drop the addresses the Host announced, which are
    // the only way back if the current one stops resolving.
    const applySettings = vi.fn(async () => {});
    const { route } = router({
      applySettings,
      getSettings: () => ({
        ...settingsFromEnv({}),
        knownHostUrls: ["https://previous.trycloudflare.com"],
      }),
    });
    const form = settingsFromEnv({ FLEET_HOST_URL: "https://typed-by-hand.example" });
    const response = await route("POST", "/api/config", JSON.stringify(form));

    expect(response.status).toBe(200);
    expect(applySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        hostUrl: "https://typed-by-hand.example",
        knownHostUrls: ["https://previous.trycloudflare.com"],
      }),
    );
  });

  it("reports a Host that cannot be reached as 502, not 500", async () => {
    const { route, fleet } = router();
    vi.mocked(fleet.listWorkspaces).mockRejectedValueOnce(new Error("fetch failed"));
    const response = await route("GET", "/api/fleet", "");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "fetch failed" });
  });

  /**
   * The page cannot call the Host itself — different origin, no CORS — so this
   * process relays for it. A keyed Node has no shared secret to relay with, and
   * for a while that meant every catalog call on its config page came back a
   * 401. It signs with the same key that authenticates its WebSocket instead.
   */
  describe("relaying the catalog for a keyed Node", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const keys = createIdentityKeyPair();
    const keyed: Credentials = {
      hostUrl: "http://127.0.0.1:8787",
      nodeId: "node-1",
      name: "node",
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      host: { hostId: "host-1", publicKey: keys.publicKey, fingerprint: "a".repeat(64) },
    };

    const relayed = () => {
      const calls: { url: string; headers: Headers }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: URL | string, init?: RequestInit) => {
          calls.push({ url: String(input), headers: new Headers(init?.headers ?? {}) });
          return new Response("[]", { status: 200 });
        }),
      );
      return calls;
    };

    it("signs the calls it makes on behalf of the page", async () => {
      const calls = relayed();
      // No `fleet` override: the client the router builds is what is under test.
      const route = relayingRouter({ getCredentials: () => keyed });

      const response = await route("GET", "/api/fleet", "");

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.headers.get(NODE_ID_HEADER)).toBe("node-1");
        expect(call.headers.has(NODE_SECRET_HEADER)).toBe(false);
        expect(
          verifyNodeHttpProof({
            publicKey: keys.publicKey,
            nodeId: "node-1",
            method: "GET",
            path: new URL(call.url).pathname,
            timestamp: call.headers.get(NODE_PROOF_TIMESTAMP_HEADER) ?? "",
            nonce: call.headers.get(NODE_PROOF_NONCE_HEADER) ?? "",
            signature: call.headers.get(NODE_PROOF_SIGNATURE_HEADER) ?? "",
          }),
        ).toEqual({ ok: true });
      }
    });

    it("still relays a legacy Node's secret, because that is all it has", async () => {
      const calls = relayed();
      const route = relayingRouter();

      await route("GET", "/api/fleet", "");

      expect(calls[0]?.headers.get(NODE_SECRET_HEADER)).toBe("secret");
      expect(calls[0]?.headers.has(NODE_PROOF_SIGNATURE_HEADER)).toBe(false);
    });
  });

  it("refuses a placement path this machine cannot open", async () => {
    const { route, fleet } = router();
    const response = await route(
      "POST",
      "/api/placements",
      JSON.stringify({ workspaceId: "ws-1", localPath: "/nope" }),
    );
    expect(response.status).toBe(400);
    expect(fleet.createOwnPlacement).not.toHaveBeenCalled();
  });

  it("creates a placement once the path checks out", async () => {
    const { route, fleet } = router();
    const response = await route(
      "POST",
      "/api/placements",
      JSON.stringify({ workspaceId: "ws-1", localPath: " /tmp/fleet " }),
    );
    expect(response.status).toBe(200);
    expect(fleet.createOwnPlacement).toHaveBeenCalledWith("ws-1", "/tmp/fleet");
  });

  it("routes a workspace id to update instead of create", async () => {
    const { route, fleet } = router();
    await route(
      "POST",
      "/api/workspaces",
      JSON.stringify({ id: "ws-1", name: "renamed" }),
    );
    expect(fleet.updateWorkspace).toHaveBeenCalledWith("ws-1", "renamed", "");
    expect(fleet.createWorkspace).not.toHaveBeenCalled();
  });

  it("turns a thrown handler into a logged 500", async () => {
    const log = vi.fn();
    const { route } = router({ log });
    const response = await route("POST", "/api/config", "not json");
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalled();
  });

  it("exports the stored identity", async () => {
    const { route } = router();
    const response = await route("GET", "/api/backup", "");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      kind: "copilot-fleet-node",
      version: 1,
      credentials: { nodeId: "node-1", secret: "secret" },
    });
  });

  it("refuses to export before the node has credentials", async () => {
    const { route } = router({ getCredentials: () => undefined });
    const response = await route("GET", "/api/backup", "");
    expect(response.status).toBe(409);
  });

  it("imports a node archive", async () => {
    const applyBackup = vi.fn(async (_archive: NodeBackup) => {});
    const { route } = router({ applyBackup });
    const archive = {
      kind: "copilot-fleet-node",
      version: 1,
      exportedAt: "2026-08-14T12:00:00.000Z",
      credentials: {
        hostUrl: "https://fleet.example.com",
        nodeId: "moved",
        authProtocol: "legacy-secret",
        secret: "other-secret",
        name: "moved-box",
      },
      settings: {
        hostUrl: "https://fleet.example.com",
        nodeName: "moved-box",
        maxSessions: 8,
        copilotCommand: "",
        permissionTimeoutMs: 30_000,
      },
    };
    const response = await route("POST", "/api/backup", JSON.stringify(archive));
    expect(response.status).toBe(200);
    expect(applyBackup).toHaveBeenCalledOnce();
    expect(applyBackup.mock.calls[0]?.[0].credentials.nodeId).toBe("moved");
  });

  it("refuses a Host archive on the node import endpoint", async () => {
    const applyBackup = vi.fn(async (_archive: NodeBackup) => {});
    const { route } = router({ applyBackup });
    const response = await route(
      "POST",
      "/api/backup",
      JSON.stringify({
        kind: "copilot-fleet-host",
        version: 1,
        exportedAt: "2026-08-14T12:00:00.000Z",
        enrollmentToken: "x",
        tunnel: { enabled: false, provider: "cloudflare" },
        defaults: { yolo: true, autoResume: true },
        nodes: [],
        workspaces: [],
        placements: [],
        sessions: [],
        events: [],
      }),
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("Settings → General"),
    });
    expect(applyBackup).not.toHaveBeenCalled();
  });

  it("answers 404 for anything else", async () => {
    const { route } = router();
    expect((await route("GET", "/api/nope", "")).status).toBe(404);
    expect((await route("DELETE", "/api/config", "")).status).toBe(404);
  });
});

describe("config router · dev tunnel rebuild", () => {
  it("rebuilds the tunnel when this node has one", async () => {
    const rebuildDevTunnel = vi.fn();
    const { route } = router({ rebuildDevTunnel });
    const response = await route("POST", "/api/devtunnel/rebuild", "");
    expect(response.status).toBe(200);
    expect(rebuildDevTunnel).toHaveBeenCalledTimes(1);
  });

  it("refuses on a node that dials the Host directly", async () => {
    // A node with no tunnel has nothing to rebuild, and a button that silently
    // does nothing is indistinguishable from one that is broken.
    const { route } = router();
    const response = await route("POST", "/api/devtunnel/rebuild", "");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: expect.stringContaining("directly") });
  });

  it("reports that the rebuild started rather than that it succeeded", async () => {
    // The CLI still has to come back with a port, and the node still has to
    // dial through it; claiming success here would be a guess.
    const { route } = router({ rebuildDevTunnel: vi.fn() });
    expect((await route("POST", "/api/devtunnel/rebuild", "")).body).toEqual({
      started: true,
    });
  });
});

describe("config router · logs", () => {
  it("serves what the node has been saying", async () => {
    const entries = [
      {
        at: "2026-08-18T21:04:22.000Z",
        level: "error" as const,
        message: "ECONNREFUSED",
      },
    ];
    const { route } = router({ recentLogs: () => entries });
    const response = await route("GET", "/api/logs", "");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ entries });
  });

  it("answers with an empty list rather than failing when nothing records logs", async () => {
    const { route } = router();
    expect(await route("GET", "/api/logs", "")).toEqual({
      status: 200,
      body: { entries: [] },
    });
  });
});
