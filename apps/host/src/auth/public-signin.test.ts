import { afterEach, describe, expect, it } from "vitest";
import { FleetStore } from "../store.js";
import {
  BUILT_IN_ENTRA_CONFIG,
  MICROSOFT_CORP_TENANT_ID,
  createEntraProvider,
  type EntraConfig,
  type EntraIdentity,
} from "./entra.js";
import { MICROSOFT_PERSONAL_TENANT_ID } from "./entra-token.js";
import { FleetAuth, type LoginSuccess } from "./service.js";
import { RECENT_REAUTH_MS } from "./sessions.js";

const PUBLIC: EntraConfig = {
  tenantId: "common",
  clientId: "11111111-2222-3333-4444-555555555555",
};
const ENTERPRISE: EntraConfig = {
  tenantId: MICROSOFT_CORP_TENANT_ID,
  clientId: "99999999-2222-3333-4444-555555555555",
};
const CORP: EntraIdentity = {
  tenantId: MICROSOFT_CORP_TENANT_ID,
  objectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  username: "operator@example.com",
  displayName: "Operator",
};
const PERSONAL: EntraIdentity = {
  tenantId: MICROSOFT_PERSONAL_TENANT_ID,
  objectId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  // Deliberately identical display metadata: never an authorization key.
  username: CORP.username,
  displayName: CORP.displayName,
};
const HOST = "localhost:8787";
const REDIRECT = `http://${HOST}/api/auth/entra/callback`;
const stores: FleetStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(
  config: EntraConfig = PUBLIC,
  environment: { envEntra?: EntraConfig; configuredPassword?: string } = {},
) {
  const store = new FleetStore(":memory:");
  stores.push(store);
  store.setSetting("auth.entraTenantId", config.tenantId);
  store.setSetting("auth.entraClientId", config.clientId);
  let claimCode = "";
  let now = Date.now();
  let nextIdentity = CORP;
  let redemption: Promise<EntraIdentity> | undefined;
  let flowSequence = 0;
  const cancelled: string[] = [];
  const revoked: string[] = [];
  let authenticationResets = 0;
  const auth = new FleetAuth({
    ...environment,
    store,
    now: () => now,
    announceClaimCode: (code) => {
      claimCode = code;
    },
    warn: () => {},
    externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
    onSessionsRevoked: (sessions) =>
      revoked.push(...sessions.map((row) => row.tokenHash)),
    onAuthenticationReset: () => {
      authenticationResets += 1;
    },
    entraProvider: (providerConfig) =>
      createEntraProvider(providerConfig, {
        deviceFlowEnabled: () => store.getSetting("auth.deviceFlowEnabled") === "1",
        loadMsal: async () => ({
          authorizationUrl: async ({ state }) =>
            `https://login.microsoftonline.com/${providerConfig.tenantId}/oauth2/v2.0/authorize?state=${state}&client_id=${providerConfig.clientId}`,
          redeem: async () => redemption ?? nextIdentity,
          deviceCode: async () => ({
            flowId: `device-${++flowSequence}`,
            userCode: "TEST-CODE",
            verificationUri: "https://microsoft.com/devicelogin",
            message: "Test sign-in",
            expiresAt: now + 600_000,
          }),
          pollDevice: async () => redemption ?? nextIdentity,
          cancelDevice: ({ flowId }) => {
            cancelled.push(flowId);
          },
        }),
      }),
  });
  const beginLogin = async (binding = "browser", invitation?: string) => {
    let bootstrapToken: string | undefined;
    if (!auth.claimed()) {
      const bootstrap = auth.redeemClaimCode(claimCode, binding, HOST);
      if (!bootstrap.ok) throw new Error(bootstrap.error);
      bootstrapToken = bootstrap.token;
    }
    const started = await auth.startCodeLogin({
      binding,
      bootstrapToken,
      host: HOST,
      redirectUri: REDIRECT,
      invitation,
    });
    if (!started.ok) throw new Error(started.error);
    return {
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      binding,
      code: "test-code",
      host: HOST,
    };
  };
  const login = async (identity = CORP, binding = "browser", invitation?: string) => {
    nextIdentity = identity;
    const outcome = await auth.completeCodeLogin(await beginLogin(binding, invitation));
    if (outcome.ok && !("session" in outcome)) {
      throw new Error("Expected a login, not an administrator addition");
    }
    return outcome;
  };
  const beginMigration = async (login: LoginSuccess, config = PUBLIC) => {
    const session = auth.verifySession(login.session.token);
    if (!session) throw new Error("Expected an active session");
    const result = await auth.startConfigurationChange({
      config,
      session,
      binding: "migration-browser",
      host: HOST,
      redirectUri: REDIRECT,
    });
    if (!result.ok) throw new Error(result.error);
    return {
      state: new URL(result.authorizationUrl).searchParams.get("state") ?? "",
      code: "migration-code",
      binding: "migration-browser",
      host: HOST,
    };
  };
  return {
    auth,
    store,
    cancelled,
    revoked,
    beginLogin,
    login,
    beginMigration,
    claimCode: () => claimCode,
    authenticationResets: () => authenticationResets,
    setIdentity: (identity: EntraIdentity) => {
      nextIdentity = identity;
    },
    setRedemption: (pending: Promise<EntraIdentity>) => {
      redemption = pending;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("live authentication erasure", () => {
  it("clears stored and in-memory browser authority while keeping the Host usable", async () => {
    const h = setup(PUBLIC, {
      envEntra: ENTERPRISE,
      configuredPassword: "legacy-env-password",
    });
    const owner = await h.login();
    if (!owner.ok || !owner.administrator) throw new Error("Expected a claimed Host");
    const session = h.auth.verifySession(owner.session.token);
    if (!session) throw new Error("Expected an active session");
    const oldClaimCode = h.claimCode();
    const csrf = h.auth.sessions.csrfToken(session.tokenHash);
    h.auth.enablePassword("Abcdefghij!1", owner.administrator.id);
    const password = h.auth.passwordLogin("Abcdefghij!1", HOST);
    if (!password.ok) throw new Error(password.error);
    const grant = h.auth.claim.grantTrusted("previous-bootstrap");
    const transaction = await h.beginLogin("pending-code");
    h.store.setSetting("auth.deviceFlowEnabled", "1");
    const device = await h.auth.startDeviceLogin({
      binding: "pending-device",
      bootstrapToken: undefined,
      host: HOST,
    });
    if (!device.ok) throw new Error(device.error);
    h.store.setSetting("host.publicUrl", "https://keep.example");

    expect(h.auth.eraseAuthentication(session)).toEqual({ ok: true });
    expect(h.authenticationResets()).toBe(1);
    expect(h.auth.state()).toBe("entra-unconfigured");
    expect(h.auth.passwordEnabled()).toBe(false);
    expect(h.auth.deviceFlowEnabled()).toBe(false);
    expect(h.auth.claim.verifyBootstrap(grant.token)).toBeUndefined();
    expect(h.auth.sessions.verifyCsrf(session.tokenHash, csrf)).toBe(false);
    expect(h.auth.verifySession(owner.session.token)).toBeUndefined();
    expect(h.auth.verifySession(password.session.token)).toBeUndefined();
    expect(h.revoked).toEqual(
      expect.arrayContaining([owner.session.tokenHash, password.session.tokenHash]),
    );
    expect(h.auth.passwordLogin("legacy-env-password", HOST)).toMatchObject({
      ok: false,
    });
    expect(h.claimCode()).not.toBe(oldClaimCode);
    expect(h.store.getSetting("host.publicUrl")).toBe("https://keep.example");
    expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
      ok: false,
      code: "expired",
    });
    expect(
      await h.auth.pollDeviceLogin({
        flowId: device.flow.flowId,
        binding: "pending-device",
        host: HOST,
      }),
    ).toMatchObject({ ok: false, code: "expired" });
    expect(h.cancelled).toHaveLength(1);

    h.auth.configureEntra(PUBLIC);
    expect((await h.login(PERSONAL)).ok).toBe(true);
    expect(h.auth.listAdministrators()).toMatchObject([{ objectId: PERSONAL.objectId }]);
  });

  it("refuses device, stale and revoked sessions without clearing authentication", async () => {
    const h = setup();
    const owner = await h.login();
    if (!owner.ok || !owner.administrator) throw new Error("Expected an administrator");
    const active = h.auth.verifySession(owner.session.token);
    if (!active) throw new Error("Expected a session");
    const device = h.auth.sessions.issue({
      administratorId: owner.administrator.id,
      authMethod: "microsoft-device",
    });
    const deviceSession = h.auth.verifySession(device.token);
    if (!deviceSession) throw new Error("Expected a session");
    expect(h.auth.eraseAuthentication(deviceSession)).toMatchObject({
      ok: false,
      status: 403,
    });
    h.advance(RECENT_REAUTH_MS + 1);
    expect(h.auth.eraseAuthentication(active)).toMatchObject({ ok: false, status: 403 });
    h.auth.logout(owner.session.token);
    expect(h.auth.eraseAuthentication(active)).toMatchObject({ ok: false, status: 403 });
    expect(h.auth.listAdministrators()).toHaveLength(1);
    expect(h.auth.entraConfig()).toEqual(PUBLIC);
  });

  it("will not let a token redemption in flight reclaim the erased Host", async () => {
    const h = setup();
    const owner = await h.login();
    if (!owner.ok) throw new Error(owner.error);
    const active = h.auth.verifySession(owner.session.token);
    if (!active) throw new Error("Expected a session");
    const transaction = await h.beginLogin("pending");
    let resolve: (identity: EntraIdentity) => void = () => {};
    h.setRedemption(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const finishing = h.auth.completeCodeLogin(transaction);
    expect(h.auth.eraseAuthentication(active)).toEqual({ ok: true });
    resolve(CORP);
    expect(await finishing).toMatchObject({ ok: false, code: "expired" });
    expect(h.auth.listAdministrators()).toHaveLength(0);
  });
});

describe("public Microsoft account authorization", () => {
  it.each([CORP, PERSONAL])(
    "lets $tenantId claim a fresh public Host",
    async (identity) => {
      const h = setup();
      const signedIn = await h.login(identity);
      expect(signedIn.ok).toBe(true);
      expect(h.auth.listAdministrators()).toMatchObject([
        {
          tenantId: identity.tenantId,
          objectId: identity.objectId,
        },
      ]);
      expect(h.auth.entraConfig()).toEqual(PUBLIC);
      expect((await h.login(identity)).ok).toBe(true);
    },
  );

  it("still requires console possession before starting a claim", async () => {
    const h = setup();
    expect(
      await h.auth.startCodeLogin({
        binding: "stranger",
        bootstrapToken: undefined,
        host: HOST,
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ ok: false, status: 401 });
    expect(h.auth.listAdministrators()).toHaveLength(0);
  });

  it("does not authorize another account even when its email and name match", async () => {
    const h = setup();
    await h.login(CORP);
    expect(await h.login(PERSONAL)).toMatchObject({
      ok: false,
      code: "not-authorized",
    });
    expect(h.auth.listAdministrators()).toHaveLength(1);
  });

  it("requires explicit approval before an invited personal account can administer", async () => {
    const h = setup();
    const owner = await h.login(CORP);
    if (!owner.ok || !owner.administrator) throw new Error("Expected a claimed Host");
    const invitation = h.auth.createInvitation(owner.administrator.id);
    expect(await h.login(PERSONAL, "candidate", invitation.token)).toMatchObject({
      ok: false,
      code: "pending-approval",
    });
    expect(h.auth.listAdministrators()).toHaveLength(1);
    expect(h.auth.approveCandidate(invitation.id, owner.administrator.id)).toBeDefined();
    expect((await h.login(PERSONAL, "candidate")).ok).toBe(true);
    expect(h.auth.listAdministrators()).toHaveLength(2);
  });

  it("keeps a fixed Microsoft corporate directory closed to personal accounts", async () => {
    const h = setup(ENTERPRISE);
    expect(await h.login(PERSONAL)).toMatchObject({ ok: false, code: "wrong-tenant" });
    expect(h.auth.listAdministrators()).toHaveLength(0);
    expect((await h.login(CORP)).ok).toBe(true);
  });

  it("does not accept common as a returned tenant identity", async () => {
    const h = setup();
    expect(await h.login({ ...CORP, tenantId: "common" })).toMatchObject({
      ok: false,
      code: "invalid-identity",
    });
  });

  it("does not let a spent bootstrap grant reconfigure a claimed Host", async () => {
    const h = setup();
    await h.login();
    expect(() => h.auth.configureEntra(ENTERPRISE)).toThrow(/claimed Host/);
    expect(h.auth.entraConfig()).toEqual(PUBLIC);
  });
});

describe("verified registration changes", () => {
  it("keeps the old configuration until the same administrator completes the new sign-in", async () => {
    const h = setup(ENTERPRISE);
    const owner = await h.login();
    if (!owner.ok) throw new Error(owner.error);
    const oldLogin = await h.beginLogin("another-browser");
    h.store.setSetting("auth.deviceFlowEnabled", "1");
    const oldDevice = await h.auth.startDeviceLogin({
      binding: "device-browser",
      bootstrapToken: undefined,
      host: HOST,
    });
    if (!oldDevice.ok) throw new Error(oldDevice.error);

    const migration = await h.beginMigration(owner);
    expect(h.auth.entraConfig()).toEqual(ENTERPRISE);
    const migrated = await h.auth.completeCodeLogin(migration);
    expect(migrated.ok).toBe(true);
    expect(h.auth.entraConfig()).toEqual(PUBLIC);
    expect(h.auth.deviceFlowEnabled()).toBe(false);
    expect(h.auth.listAdministrators()).toHaveLength(1);
    expect(h.revoked).toContain(owner.session.tokenHash);
    expect(h.auth.verifySession(owner.session.token)).toBeUndefined();
    if (!migrated.ok || !("session" in migrated)) {
      throw new Error("Expected a new session after migration");
    }
    expect(h.auth.verifySession(migrated.session.token)).toBeDefined();
    expect(await h.auth.completeCodeLogin(oldLogin)).toMatchObject({
      ok: false,
      code: "expired",
    });
    expect(
      await h.auth.pollDeviceLogin({
        flowId: oldDevice.flow.flowId,
        binding: "device-browser",
        host: HOST,
      }),
    ).toMatchObject({ ok: false, code: "expired" });
    expect(h.cancelled).toHaveLength(1);
    expect(await h.auth.completeCodeLogin(migration)).toMatchObject({
      ok: false,
      code: "expired",
    });
  });

  it("leaves the old registration and sessions intact for a different identity", async () => {
    const h = setup(ENTERPRISE);
    const owner = await h.login();
    if (!owner.ok) throw new Error(owner.error);
    const migration = await h.beginMigration(owner);
    h.setIdentity(PERSONAL);
    expect(await h.auth.completeCodeLogin(migration)).toMatchObject({
      ok: false,
      code: "not-authorized",
    });
    expect(h.auth.entraConfig()).toEqual(ENTERPRISE);
    expect(h.auth.verifySession(owner.session.token)).toBeDefined();
    expect(h.revoked).toHaveLength(0);
  });

  it("cancels a switch without removing the current authentication route", async () => {
    const h = setup(ENTERPRISE);
    const owner = await h.login();
    if (!owner.ok) throw new Error(owner.error);
    const migration = await h.beginMigration(owner);
    h.auth.cancelCodeLogin(migration.state, migration.binding);
    expect(await h.auth.completeCodeLogin(migration)).toMatchObject({
      ok: false,
      code: "expired",
    });
    expect(h.auth.entraConfig()).toEqual(ENTERPRISE);
  });

  it("rechecks the initiating administrator session before committing a switch", async () => {
    const h = setup(ENTERPRISE);
    const owner = await h.login();
    if (!owner.ok) throw new Error(owner.error);
    const migration = await h.beginMigration(owner);
    h.auth.logout(owner.session.token);
    expect(await h.auth.completeCodeLogin(migration)).toMatchObject({
      ok: false,
      code: "not-authorized",
    });
    expect(h.auth.entraConfig()).toEqual(ENTERPRISE);
  });

  it("requires a fresh authorization-code session, not a device session", async () => {
    const h = setup(ENTERPRISE);
    const owner = await h.login();
    if (!owner.ok || !owner.administrator) throw new Error("Expected an administrator");
    const device = h.auth.sessions.issue({
      administratorId: owner.administrator.id,
      authMethod: "microsoft-device",
    });
    const session = h.auth.verifySession(device.token);
    if (!session) throw new Error("Expected an active session");
    expect(
      await h.auth.startConfigurationChange({
        config: PUBLIC,
        session,
        binding: "migration-browser",
        host: HOST,
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    h.advance(RECENT_REAUTH_MS + 1);
    await expect(h.beginMigration(owner)).rejects.toThrow(
      /current Microsoft administrator/,
    );
  });

  it("rejects a result if configuration changes while token redemption is running", async () => {
    const h = setup(ENTERPRISE);
    const transaction = await h.beginLogin();
    let resolve: (identity: EntraIdentity) => void = () => {};
    h.setRedemption(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const finishing = h.auth.completeCodeLogin(transaction);
    h.auth.configureEntra(PUBLIC);
    resolve(CORP);
    expect(await finishing).toMatchObject({ ok: false, code: "expired" });
    expect(h.auth.listAdministrators()).toHaveLength(0);
  });

  it("invalidates transactions even when restored configuration has the same IDs", async () => {
    const h = setup();
    const transaction = await h.beginLogin();
    h.auth.adoptRestoredSecurity([]);
    expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
      ok: false,
      code: "expired",
    });
  });

  it("keeps device redemption single-use while the first poll waits for Microsoft", async () => {
    const h = setup();
    await h.login();
    h.store.setSetting("auth.deviceFlowEnabled", "1");
    const started = await h.auth.startDeviceLogin({
      binding: "device-browser",
      bootstrapToken: undefined,
      host: HOST,
    });
    if (!started.ok) throw new Error(started.error);
    let resolve: (identity: EntraIdentity) => void = () => {};
    h.setRedemption(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const input = { flowId: started.flow.flowId, binding: "device-browser", host: HOST };
    const first = h.auth.pollDeviceLogin(input);
    expect(await h.auth.pollDeviceLogin(input)).toMatchObject({
      ok: false,
      code: "expired",
    });
    resolve(CORP);
    expect((await first).ok).toBe(true);
  });
});

describe("conservative configuration pinning", () => {
  function authFor(store: FleetStore, envEntra?: EntraConfig) {
    return new FleetAuth({
      store,
      envEntra,
      legacyEntra: BUILT_IN_ENTRA_CONFIG,
      announceClaimCode: () => {},
      warn: () => {},
      externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
    });
  }

  it("does not install the borrowed client on a fresh Host", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    expect(authFor(store).state()).toBe("entra-unconfigured");
  });

  it("pins an existing built-in corporate Host rather than silently making it public", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    store.insertAdministrator({ ...CORP, addedVia: "claim" });
    expect(authFor(store, PUBLIC).entraConfig()).toEqual(BUILT_IN_ENTRA_CONFIG);
    expect(authFor(store, PUBLIC).entraConfig()).toEqual(BUILT_IN_ENTRA_CONFIG);
  });

  it("pins an existing environment-configured enterprise Host across later restarts", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    store.insertAdministrator({ ...CORP, addedVia: "claim" });
    expect(authFor(store, ENTERPRISE).entraConfig()).toEqual(ENTERPRISE);
    expect(authFor(store, PUBLIC).entraConfig()).toEqual(ENTERPRISE);
  });

  it("keeps a migrated public configuration when the environment changes", async () => {
    const h = setup(ENTERPRISE);
    const owner = await h.login();
    if (!owner.ok) throw new Error(owner.error);
    expect((await h.auth.completeCodeLogin(await h.beginMigration(owner))).ok).toBe(true);
    expect(authFor(h.store, ENTERPRISE).entraConfig()).toEqual(PUBLIC);
  });
});
