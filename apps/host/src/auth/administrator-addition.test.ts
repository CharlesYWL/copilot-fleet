import { createHash } from "node:crypto";
import type { AuthorizationUrlRequest } from "@azure/msal-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetStore } from "../store.js";
import {
  AUTH_TRANSACTION_TTL_MS,
  EntraAuthenticationFailedError,
  MICROSOFT_CORP_TENANT_ID,
  createEntraProvider,
  createMsalAdapter,
  type EntraIdentity,
  type RedeemAuthorizationCodeInput,
} from "./entra.js";
import { MICROSOFT_PERSONAL_TENANT_ID } from "./entra-token.js";
import { FleetAuth } from "./service.js";
import { RECENT_REAUTH_MS } from "./sessions.js";

const CONFIG = {
  tenantId: "common",
  clientId: "11111111-2222-3333-4444-555555555555",
};
const CORP: EntraIdentity = {
  tenantId: MICROSOFT_CORP_TENANT_ID,
  objectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  username: "operator@example.com",
  displayName: "Operator",
};
const PERSONAL: EntraIdentity = {
  ...CORP,
  tenantId: MICROSOFT_PERSONAL_TENANT_ID,
  objectId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
};
const HOST = "localhost:8787";
const REDIRECT = `http://${HOST}/api/auth/entra/callback`;
const stores: FleetStore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function setup(ownerIdentity = CORP, target = PERSONAL) {
  const store = new FleetStore(":memory:");
  stores.push(store);
  store.setSetting("auth.entraTenantId", CONFIG.tenantId);
  store.setSetting("auth.entraClientId", CONFIG.clientId);
  const owner = store.insertAdministrator({ ...ownerIdentity, addedVia: "claim" });
  let now = Date.now();
  const redeem = vi.fn(async (_input: RedeemAuthorizationCodeInput) => target);
  const getAuthCodeUrl = vi.fn(async (input: AuthorizationUrlRequest) => {
    const params = new URLSearchParams({
      state: input.state ?? "",
      prompt: input.prompt ?? "",
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  });
  const revoked = vi.fn();
  const auth = new FleetAuth({
    store,
    now: () => now,
    announceClaimCode: () => {},
    warn: () => {},
    externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
    onSessionsRevoked: revoked,
    entraProvider: (config) =>
      createEntraProvider(config, {
        loadMsal: async () => ({
          ...createMsalAdapter(config, {
            getAuthCodeUrl,
            acquireTokenByCode: async () => {
              throw new Error("Unexpected token request in test");
            },
            acquireTokenByDeviceCode: async () => null,
            removeAccount: async () => {},
          }),
          redeem,
        }),
      }),
  });
  const source = auth.sessions.issue({
    administratorId: owner.id,
    authMethod: "microsoft-code",
  });
  const session = auth.sessions.inspect(source.tokenHash);
  if (!session) throw new Error("Expected an active source session");
  const startInput = {
    session,
    binding: "browser",
    host: HOST,
    redirectUri: REDIRECT,
  };
  const begin = async () => {
    const started = await auth.startAdministratorAddition(startInput);
    if (!started.ok) throw new Error(started.error);
    const url = new URL(started.authorizationUrl);
    return {
      state: url.searchParams.get("state") ?? "",
      code: "add-code",
      binding: startInput.binding,
      host: HOST,
    };
  };
  return {
    auth,
    store,
    owner,
    source,
    session,
    startInput,
    begin,
    redeem,
    getAuthCodeUrl,
    revoked,
    advance: (ms: number) => void (now += ms),
  };
}

describe("preauthorized administrator additions", () => {
  it.each([
    { ownerIdentity: CORP, target: PERSONAL },
    { ownerIdentity: PERSONAL, target: CORP },
  ])(
    "adds $target.tenantId without signing in as it",
    async ({ ownerIdentity, target }) => {
      const h = setup(ownerIdentity, target);
      const original = h.store.getOperatorSession(h.source.tokenHash);
      const originalCsrf = h.auth.sessions.csrfToken(h.source.tokenHash);
      const transaction = await h.begin();
      expect(h.auth.listAdministrators()).toHaveLength(1);
      const outcome = await h.auth.completeCodeLogin(transaction);
      expect(outcome).toMatchObject({
        ok: true,
        addedAdministrator: {
          ...target,
          addedVia: "administrator-add",
          addedByAdminId: h.owner.id,
          lastLoginAt: "",
        },
      });
      expect(outcome).not.toHaveProperty("session");
      expect(h.auth.listAdministrators()).toHaveLength(2);
      expect(h.store.countOperatorSessions()).toBe(1);
      expect(h.store.getOperatorSession(h.source.tokenHash)).toEqual(original);
      expect(h.auth.sessions.csrfToken(h.source.tokenHash)).toBe(originalCsrf);
      expect(h.auth.sessions.inspect(h.source.tokenHash)).toEqual(h.session);
      expect(h.revoked).not.toHaveBeenCalled();
      const added = h.store.findAdministrator(target.tenantId, target.objectId);
      expect(h.store.listSecurityAudit(10)).toContainEqual(
        expect.objectContaining({
          eventType: "administrator_addition_completed",
          actorKind: "administrator",
          actorId: h.owner.id,
          targetId: added?.id,
          outcome: "allowed",
          detail: `added; tenant ${target.tenantId}; object ${target.objectId}`,
        }),
      );
    },
  );

  it("forces the account picker and redeems the same PKCE, nonce, and redirect", async () => {
    const h = setup();
    const transaction = await h.begin();
    const authorization = h.getAuthCodeUrl.mock.calls[0]?.[0];
    expect(authorization).toMatchObject({
      prompt: "select_account",
      state: transaction.state,
      redirectUri: REDIRECT,
      codeChallengeMethod: "S256",
      responseMode: "query",
    });
    expect(authorization?.nonce).toBeTruthy();
    await h.auth.completeCodeLogin(transaction);
    const redemption = h.redeem.mock.calls[0]?.[0];
    expect(redemption).toMatchObject({
      code: "add-code",
      nonce: authorization?.nonce,
      redirectUri: REDIRECT,
    });
    expect(
      createHash("sha256")
        .update(redemption?.codeVerifier ?? "")
        .digest("base64url"),
    ).toBe(authorization?.codeChallenge);
  });

  it("safely handles an already-active account without changing its provenance", async () => {
    const h = setup(CORP, CORP);
    const outcome = await h.auth.completeCodeLogin(await h.begin());
    expect(outcome).toEqual({ ok: true, addedAdministrator: h.owner });
    expect(h.auth.listAdministrators()).toEqual([h.owner]);
    expect(h.store.countOperatorSessions()).toBe(1);
    expect(h.revoked).not.toHaveBeenCalled();
  });

  it.each(["password", "recovery", "microsoft-device"] as const)(
    "does not let a %s session authorize an addition",
    async (authMethod) => {
      const h = setup();
      const issued = h.auth.sessions.issue({
        administratorId: authMethod === "microsoft-device" ? h.owner.id : "",
        authMethod,
      });
      const session = h.auth.sessions.inspect(issued.tokenHash);
      if (!session) throw new Error("Expected a session");
      expect(
        await h.auth.startAdministratorAddition({ ...h.startInput, session }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(h.auth.transactions.size()).toBe(0);
      expect(h.getAuthCodeUrl).not.toHaveBeenCalled();
    },
  );

  it("refuses stale and logged-out source sessions at start", async () => {
    const h = setup();
    h.advance(RECENT_REAUTH_MS);
    expect(await h.auth.startAdministratorAddition(h.startInput)).toMatchObject({
      ok: false,
      status: 403,
    });
    h.auth.logout(h.source.token);
    expect(await h.auth.startAdministratorAddition(h.startInput)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(h.auth.transactions.size()).toBe(0);
  });

  it.each(["logout", "revocation", "administrator removal", "stale reauth"] as const)(
    "revalidates the source session after %s during the flow",
    async (change) => {
      const h = setup();
      h.advance(RECENT_REAUTH_MS - 60_000);
      const transaction = await h.begin();
      if (change === "logout") h.auth.logout(h.source.token);
      if (change === "revocation") h.store.revokeAllOperatorSessions();
      if (change === "administrator removal") {
        h.store.insertAdministrator({ ...CORP, objectId: "backup", addedVia: "claim" });
        h.auth.removeAdministrator(h.owner.id);
      }
      if (change === "stale reauth") h.advance(60_000);
      expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
        ok: false,
        code: "not-authorized",
      });
      expect(
        h.store.findAdministrator(PERSONAL.tenantId, PERSONAL.objectId),
      ).toBeUndefined();
      expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
        ok: false,
        code: "expired",
      });
    },
  );

  it("does not transfer an addition to a newer session after the source logs out", async () => {
    const h = setup();
    const transaction = await h.begin();
    h.auth.logout(h.source.token);
    h.auth.sessions.issue({ administratorId: h.owner.id, authMethod: "microsoft-code" });
    expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
      ok: false,
      code: "not-authorized",
    });
    expect(h.auth.listAdministrators()).toHaveLength(1);
  });

  it("checks revocation again after awaiting Microsoft", async () => {
    const h = setup();
    const transaction = await h.begin();
    let resolve: (identity: EntraIdentity) => void = () => {};
    h.redeem.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const completing = h.auth.completeCodeLogin(transaction);
    await vi.waitFor(() => expect(h.redeem).toHaveBeenCalled());
    h.auth.logout(h.source.token);
    resolve(PERSONAL);
    expect(await completing).toMatchObject({ ok: false, code: "not-authorized" });
    expect(h.auth.listAdministrators()).toHaveLength(1);
  });

  it.each(["binding", "cancel", "expiry", "replacement", "configuration"] as const)(
    "adds nobody after transaction %s failure",
    async (failure) => {
      const h = setup();
      const transaction = await h.begin();
      if (failure === "binding") transaction.binding = "another-browser";
      if (failure === "cancel")
        h.auth.cancelCodeLogin(transaction.state, transaction.binding);
      if (failure === "expiry") h.advance(AUTH_TRANSACTION_TTL_MS);
      if (failure === "replacement") await h.begin();
      if (failure === "configuration") {
        h.store.setSetting("auth.entraClientId", "99999999-2222-3333-4444-555555555555");
      }
      expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
        ok: false,
        code: "expired",
      });
      expect(h.redeem).not.toHaveBeenCalled();
      expect(h.auth.listAdministrators()).toHaveLength(1);
      expect(h.store.countOperatorSessions()).toBe(1);
      expect(
        await h.auth.completeCodeLogin({ ...transaction, binding: "browser" }),
      ).toMatchObject({ ok: false, code: "expired" });
    },
  );

  it.each(["configuration", "generation", "expiry"] as const)(
    "rejects %s changes while awaiting Microsoft",
    async (change) => {
      const h = setup();
      const transaction = await h.begin();
      let resolve: (identity: EntraIdentity) => void = () => {};
      h.redeem.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const completing = h.auth.completeCodeLogin(transaction);
      await vi.waitFor(() => expect(h.redeem).toHaveBeenCalled());
      if (change === "configuration") {
        h.store.setSetting("auth.entraClientId", "99999999-2222-3333-4444-555555555555");
      }
      if (change === "generation") h.auth.adoptRestoredSecurity([]);
      if (change === "expiry") h.advance(AUTH_TRANSACTION_TTL_MS);
      resolve(PERSONAL);
      expect(await completing).toMatchObject({ ok: false, code: "expired" });
      expect(h.auth.listAdministrators()).toHaveLength(1);
    },
  );

  it("consumes state before token redemption, including concurrent callbacks", async () => {
    const h = setup();
    const transaction = await h.begin();
    let resolve: (identity: EntraIdentity) => void = () => {};
    h.redeem.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const completing = h.auth.completeCodeLogin(transaction);
    expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
      ok: false,
      code: "expired",
    });
    resolve(PERSONAL);
    expect(await completing).toHaveProperty("addedAdministrator");
    expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
      ok: false,
      code: "expired",
    });
    expect(h.auth.listAdministrators()).toHaveLength(2);
    expect(h.store.countOperatorSessions()).toBe(1);
    expect(h.redeem).toHaveBeenCalledTimes(1);
  });

  it("adds nobody when Microsoft rejects the identity and cannot replay the state", async () => {
    const h = setup();
    const transaction = await h.begin();
    h.redeem.mockRejectedValueOnce(
      new EntraAuthenticationFailedError("invalid-identity", "Invalid identity"),
    );
    expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
      ok: false,
      code: "invalid-identity",
    });
    expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
      ok: false,
      code: "expired",
    });
    expect(h.auth.listAdministrators()).toHaveLength(1);
  });

  it("rolls back the addition if its audit cannot be persisted", async () => {
    const h = setup();
    const transaction = await h.begin();
    vi.spyOn(h.store, "recordSecurityAudit").mockImplementationOnce(() => {
      throw new Error("Audit write failed");
    });
    await expect(h.auth.completeCodeLogin(transaction)).rejects.toThrow(
      "Audit write failed",
    );
    expect(h.auth.listAdministrators()).toHaveLength(1);
    expect(h.store.countOperatorSessions()).toBe(1);
    expect(await h.auth.completeCodeLogin(transaction)).toMatchObject({
      ok: false,
      code: "expired",
    });
  });

  it("keeps ordinary sign-in and generic invitations separate from preauthorization", async () => {
    const h = setup();
    const pending = await h.begin();
    const invitation = h.auth.createInvitation(h.owner.id);
    const ordinary = async (token?: string) => {
      const started = await h.auth.startCodeLogin({
        binding: "candidate",
        bootstrapToken: undefined,
        host: HOST,
        redirectUri: REDIRECT,
        invitation: token,
      });
      if (!started.ok) throw new Error(started.error);
      return h.auth.completeCodeLogin({
        state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
        code: "ordinary-code",
        binding: "candidate",
        host: HOST,
      });
    };
    expect(await ordinary()).toMatchObject({ ok: false, code: "not-authorized" });
    expect(await ordinary(invitation.token)).toMatchObject({
      ok: false,
      code: "pending-approval",
    });
    h.auth.cancelCodeLogin(pending.state, pending.binding);
    expect(h.auth.listPendingCandidates()).toHaveLength(1);
    expect(h.auth.listAdministrators()).toHaveLength(1);
    expect(h.store.countOperatorSessions()).toBe(1);
  });
});
