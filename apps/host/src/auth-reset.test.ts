import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ERASE_AUTH_CONFIRMATION } from "@fleet/protocol";
import { createIdentityKeyPair } from "@fleet/protocol/node-auth";
import { HostIdentityService } from "./auth/host-identity.js";
import { hashPassword } from "./auth.js";
import { buildServer } from "./server.js";
import { FleetStore, PRESERVED_SETTING_KEYS } from "./store.js";

const stores = new Set<FleetStore>();
const directories: string[] = [];
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function open(path: string, exclusive = true) {
  const store = new FleetStore(path, { exclusive, secureFiles: () => {} });
  stores.add(store);
  return store;
}

function close(store: FleetStore) {
  store.close();
  stores.delete(store);
}

function fixture(exclusive = true) {
  const directory = mkdtempSync(join(tmpdir(), "fleet-auth-reset-"));
  directories.push(directory);
  const path = join(directory, "fleet.db");
  const store = open(path, exclusive);
  const administrator = store.insertAdministrator({
    tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    objectId: "old-administrator",
    username: "old@example.com",
    displayName: "Old administrator",
    addedVia: "claim",
  });
  const authSettings: Record<string, string> = {
    "auth.mode": "hybrid",
    "auth.passwordEnabled": "1",
    "auth.passwordExplicitlyEnabled": "1",
    "auth.operatorPassword": hashPassword("old-password"),
    "auth.passwordIsRecovery": "1",
    "auth.entraTenantId": administrator.tenantId,
    "auth.entraClientId": "11111111-2222-3333-4444-555555555555",
    "auth.deviceFlowEnabled": "1",
    "auth.csrfKey": Buffer.alloc(32, 1).toString("base64"),
    "auth.sessionKey": "old-session-key",
  };
  const keptSettings: Record<string, string> = {
    "host.publicUrl": "https://fleet.example.com",
    "tunnel.provider": "ngrok",
    "tunnel.ngrok.id": "kept-tunnel-id",
    "tunnel.ngrok.enabled": "0",
    "enrollment.token": "kept-enrollment-token",
    "node.mutualAuthentication.required": "1",
    "orchestrator.tokenKey": Buffer.alloc(32, 2).toString("base64"),
    "defaults.yolo": "0",
  };
  for (const [key, value] of Object.entries({ ...authSettings, ...keptSettings })) {
    store.setSetting(key, value);
  }
  const hostIdentity = new HostIdentityService(store).identity();
  for (const key of PRESERVED_SETTING_KEYS.filter((key) =>
    key.startsWith("host.identity."),
  )) {
    keptSettings[key] = store.getSetting(key)!;
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const token = "old-browser-session";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  store.insertOperatorSession({
    tokenHash,
    administratorId: administrator.id,
    authMethod: "microsoft-code",
    authenticatedAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  const invitation = store.createInvitation({
    tokenHash: "old-invitation",
    createdByAdminId: administrator.id,
    expiresAt,
  });
  const enrollment = store.createEnrollmentGrant({
    tokenHash: "kept-enrollment-grant",
    createdByAdminId: administrator.id,
    createdAt: now,
    expiresAt,
  });
  const nodeInput = {
    name: "legacy-node",
    os: "win32",
    arch: "x64",
    version: "0.4.0",
    capabilities: ["copilot-acp"],
    maxSessions: 2,
  };
  const legacy = store.registerNode(nodeInput);
  const nodeKeys = createIdentityKeyPair();
  const keyed = store.registerNodeWithKey({
    ...nodeInput,
    name: "keyed-node",
    publicKey: nodeKeys.publicKey,
  });
  const workspace = store.createWorkspace("keep-this-repo", "");
  const placement = store.createPlacement(workspace.id, keyed.id, "C:\\kept-repo");
  const session = store.createSession(placement, "Keep this agent session");
  store.recordSecurityAudit({
    eventType: "previous_event",
    actorKind: "administrator",
    actorId: administrator.id,
    outcome: "allowed",
  });
  return {
    path,
    store,
    authSettings,
    keptSettings,
    hostIdentity,
    token,
    tokenHash,
    invitation,
    enrollment,
    legacy,
    keyed,
    nodeKeys,
    workspace,
    placement,
    session,
  };
}

function workingData(store: FleetStore) {
  const { exportedAt: _exportedAt, ...data } = store.exportHostBackup({
    enrollmentToken: "kept-enrollment-token",
    publicUrl: "https://fleet.example.com",
  });
  return data;
}

describe("auth-only Host reset", () => {
  it("requires administrator, CSRF and confirmation proofs for a live erase", async () => {
    const h = fixture(false);
    close(h.store);
    vi.stubEnv("FLEET_ENTRA_TENANT_ID", "old-invalid-tenant");
    vi.stubEnv("FLEET_ENTRA_CLIENT_ID", "old-invalid-client");
    vi.stubEnv("FLEET_OPERATOR_PASSWORD", "old-env-password");
    const announced: string[] = [];
    app = await buildServer({
      databasePath: h.path,
      announceClaimCode: (code) => announced.push(code),
    });
    app.log.level = "silent";
    const headers = { host: "localhost:8787", cookie: `fleet_operator=${h.token}` };
    const token = (
      await app.inject({
        method: "GET",
        url: "/api/auth/csrf",
        headers,
      })
    ).json<{ csrfToken: string }>().csrfToken;
    const payload = { confirmation: ERASE_AUTH_CONFIRMATION };

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/erase",
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/erase",
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/erase",
          headers: { ...headers, "x-csrf-token": token },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/erase",
          headers: { ...headers, "x-csrf-token": token, origin: "https://other.example" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(announced).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/status",
          headers,
        })
      ).json(),
    ).toMatchObject({ authenticated: true });

    const erased = await app.inject({
      method: "POST",
      url: "/api/auth/erase",
      headers: { ...headers, "x-csrf-token": token },
      payload,
    });
    expect(erased.statusCode).toBe(200);
    expect(erased.json()).toEqual({ ok: true });
    expect(announced).toHaveLength(1);
    expect(erased.body).not.toContain(announced[0]);
    expect(erased.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/fleet_operator=;.*Max-Age=0/),
        expect.stringMatching(/fleet_bootstrap=;.*Max-Age=0/),
      ]),
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/status",
          headers,
        })
      ).json(),
    ).toMatchObject({
      state: "entra-unconfigured",
      authenticated: false,
      entraConfigured: false,
      passwordEnabled: false,
      deviceFlowEnabled: false,
      claimCodeRequired: true,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/erase",
          headers: { ...headers, "x-csrf-token": token },
          payload,
        })
      ).statusCode,
    ).toBe(401);

    await app.close();
    app = undefined;
    const store = open(h.path, false);
    for (const [key, value] of Object.entries(h.keptSettings)) {
      expect(store.getSetting(key), key).toBe(value);
    }
    expect(store.nodePublicKey(h.keyed.id)).toBe(h.nodeKeys.publicKey);
    expect(store.getEnrollmentGrant(h.enrollment.id)).toEqual(h.enrollment);
    expect(store.getSession(h.session.id)?.initialPrompt).toBe("Keep this agent session");
  });

  it("does not let a shared password session erase administrator identities", async () => {
    const h = fixture(false);
    close(h.store);
    app = await buildServer({ databasePath: h.path, announceClaimCode: () => {} });
    app.log.level = "silent";
    const signed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "old-password" },
    });
    expect(signed.statusCode).toBe(200);
    const cookie = String(signed.headers["set-cookie"]).split(";")[0];
    const token = (
      await app.inject({
        method: "GET",
        url: "/api/auth/csrf",
        headers: { cookie },
      })
    ).json<{ csrfToken: string }>().csrfToken;
    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/erase",
      headers: { cookie, "x-csrf-token": token },
      payload: { confirmation: ERASE_AUTH_CONFIRMATION },
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/status",
          headers: { cookie: `fleet_operator=${h.token}` },
        })
      ).json(),
    ).toMatchObject({ authenticated: true });
  });

  it("leaves live authentication usable when another database connection blocks erasure", async () => {
    const h = fixture(false);
    close(h.store);
    const announced: string[] = [];
    app = await buildServer({
      databasePath: h.path,
      announceClaimCode: (code) => announced.push(code),
    });
    app.log.level = "silent";
    const headers = { cookie: `fleet_operator=${h.token}` };
    const token = (
      await app.inject({
        method: "GET",
        url: "/api/auth/csrf",
        headers,
      })
    ).json<{ csrfToken: string }>().csrfToken;
    const reader = open(h.path, false);
    const request = {
      method: "POST" as const,
      url: "/api/auth/erase",
      headers: { ...headers, "x-csrf-token": token },
      payload: { confirmation: ERASE_AUTH_CONFIRMATION },
    };
    const refused = await app.inject(request);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: expect.stringMatching(/Another process/),
    });
    expect(announced).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/status",
          headers,
        })
      ).json(),
    ).toMatchObject({ authenticated: true, entraConfigured: true });
    expect(reader.countActiveAdministrators()).toBe(1);
    close(reader);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(announced).toHaveLength(1);
  });

  it("clears browser identity and credentials without deleting Nodes or working data", () => {
    const h = fixture();
    const before = workingData(h.store);
    h.store.resetOperatorAuthentication();

    expect(h.store.countActiveAdministrators()).toBe(0);
    expect(h.store.getOperatorSession(h.tokenHash)).toBeUndefined();
    expect(h.store.getInvitation(h.invitation.id)).toBeUndefined();
    for (const key of Object.keys(h.authSettings)) {
      expect(h.store.getSetting(key), key).toBeUndefined();
    }
    for (const [key, value] of Object.entries(h.keptSettings)) {
      expect(h.store.getSetting(key), key).toBe(value);
    }
    expect(workingData(h.store)).toEqual(before);
    expect(h.store.nodePublicKey(h.keyed.id)).toBe(h.nodeKeys.publicKey);
    expect(new HostIdentityService(h.store).identity()).toEqual(h.hostIdentity);
    expect(h.store.getEnrollmentGrant(h.enrollment.id)).toEqual(h.enrollment);
    expect(h.store.listSecurityAudit(10).map((entry) => entry.eventType)).toEqual(
      expect.arrayContaining(["previous_event", "operator_authentication_reset"]),
    );
  });

  it("does not expose reset on an ordinary live Host store", () => {
    const h = fixture(false);
    expect(() => h.store.resetOperatorAuthentication()).toThrow(/exclusive, offline/);
    expect(h.store.countActiveAdministrators()).toBe(1);
  });

  it("refuses an active database before erasing any authentication", () => {
    const h = fixture(false);
    expect(() => open(h.path)).toThrow(/Stop the Host/);
    expect(h.store.countActiveAdministrators()).toBe(1);
    expect(h.store.getOperatorSession(h.tokenHash)).toBeDefined();
    expect(h.store.getSetting("auth.entraClientId")).toBe(
      h.authSettings["auth.entraClientId"],
    );
    close(h.store);
    const stopped = open(h.path);
    expect(() => stopped.resetOperatorAuthentication()).not.toThrow();
  });

  it("rolls back the whole reset if a settings deletion fails", () => {
    const h = fixture(false);
    close(h.store);
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TRIGGER reject_auth_reset BEFORE DELETE ON settings
      WHEN OLD.key='auth.entraClientId'
      BEGIN SELECT RAISE(ABORT, 'test reset failure'); END;
    `);
    db.close();
    const store = open(h.path);
    expect(() => store.resetOperatorAuthentication()).toThrow(/test reset failure/);
    expect(store.countActiveAdministrators()).toBe(1);
    expect(store.getOperatorSession(h.tokenHash)).toBeDefined();
    expect(store.getInvitation(h.invitation.id)).toBeDefined();
    expect(store.getSetting("auth.mode")).toBe("hybrid");
  });

  it("starts unconfigured despite old auth environment values and preserves Node identities", async () => {
    const h = fixture();
    close(h.store);
    vi.stubEnv("FLEET_ENTRA_TENANT_ID", "old-invalid-tenant");
    vi.stubEnv("FLEET_ENTRA_CLIENT_ID", "old-invalid-client");
    vi.stubEnv("FLEET_OPERATOR_PASSWORD", "old-env-password");
    const announced: string[] = [];
    app = await buildServer({
      databasePath: h.path,
      resetOperatorAuth: true,
      useBuiltInEntra: true,
      announceClaimCode: (code) => announced.push(code),
    });
    app.log.level = "silent";
    const status = await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { host: "localhost:8787", cookie: `fleet_operator=${h.token}` },
    });
    expect(status.json()).toMatchObject({
      state: "entra-unconfigured",
      authenticated: false,
      entraConfigured: false,
      passwordEnabled: false,
      deviceFlowEnabled: false,
      claimCodeRequired: true,
    });
    expect(announced).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/snapshot",
          headers: { host: "localhost:8787", cookie: `fleet_operator=${h.token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(() => open(h.path, false)).toThrow();
    await app.close();
    app = undefined;

    const reopened = open(h.path, false);
    for (const [key, value] of Object.entries(h.keptSettings)) {
      expect(reopened.getSetting(key), key).toBe(value);
    }
    expect(reopened.listNodes()).toHaveLength(2);
    expect(reopened.nodePublicKey(h.keyed.id)).toBe(h.nodeKeys.publicKey);
    expect(reopened.getSession(h.session.id)?.initialPrompt).toBe(
      "Keep this agent session",
    );
    expect(reopened.getSetting("auth.csrfKey")).not.toBe(h.authSettings["auth.csrfKey"]);
    expect(reopened.getSetting("auth.entraClientId")).toBeUndefined();
  });
});
