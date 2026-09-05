import { describe, expect, it } from "vitest";
import {
  AUTH_TRANSACTION_TTL_MS,
  EntraConfigSchema,
  EntraProviderUnavailableError,
  EntraTransactions,
  createMsalAdapter,
  createEntraProvider,
  entraConfigFrom,
} from "./entra.js";

describe("EntraConfigSchema", () => {
  it("accepts a tenant and client id and rejects anything shaped like a secret", () => {
    const parsed = EntraConfigSchema.parse({
      tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      clientId: "11111111-2222-3333-4444-555555555555",
    });
    expect(parsed.tenantId).toBe("72f988bf-86f1-41af-91ab-2d7cd011db47");
    expect(EntraConfigSchema.safeParse({ tenantId: "", clientId: "x" }).success).toBe(
      false,
    );
    expect(
      EntraConfigSchema.safeParse({ tenantId: "not a guid", clientId: "x" }).success,
    ).toBe(false);
  });
});

describe("entraConfigFrom", () => {
  const tenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
  const clientId = "11111111-2222-3333-4444-555555555555";

  it("prefers what an administrator stored over the environment", () => {
    expect(
      entraConfigFrom({
        stored: { tenantId, clientId },
        env: { tenantId: "00000000-0000-0000-0000-000000000000", clientId },
      }),
    ).toEqual({ tenantId, clientId });
  });

  it("falls back to the environment for a preconfigured distribution", () => {
    expect(entraConfigFrom({ stored: undefined, env: { tenantId, clientId } })).toEqual({
      tenantId,
      clientId,
    });
  });

  it("is undefined when neither half is present, rather than half-configured", () => {
    expect(entraConfigFrom({ stored: undefined, env: undefined })).toBeUndefined();
    expect(
      entraConfigFrom({ stored: undefined, env: { tenantId, clientId: "" } }),
    ).toBeUndefined();
  });
});

/**
 * The pending half of a login: state, nonce and PKCE verifier live here, in
 * bounded memory, because a transaction that outlived a restart would be a
 * credential nobody could revoke.
 */
describe("EntraTransactions", () => {
  function setup(start = 1_000) {
    let now = start;
    const transactions = new EntraTransactions({ now: () => now });
    return { transactions, advance: (ms: number) => void (now += ms) };
  }

  it("generates a distinct state, nonce and verifier per transaction", () => {
    const { transactions } = setup();
    const first = transactions.start({ binding: "a", bootstrap: false });
    const second = transactions.start({ binding: "b", bootstrap: false });
    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    // RFC 7636 requires 43-128 characters for the verifier.
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(first.codeChallenge).not.toBe(first.codeVerifier);
  });

  it("redeems a transaction exactly once", () => {
    const { transactions } = setup();
    const started = transactions.start({ binding: "a", bootstrap: true });
    const claimed = transactions.consume(started.state);
    expect(claimed).toMatchObject({ binding: "a", bootstrap: true });
    expect(transactions.consume(started.state)).toBeUndefined();
  });

  it("refuses a state it never issued", () => {
    const { transactions } = setup();
    transactions.start({ binding: "a", bootstrap: false });
    expect(transactions.consume("made-up")).toBeUndefined();
  });

  it("expires a transaction after ten minutes", () => {
    const { transactions, advance } = setup();
    const started = transactions.start({ binding: "a", bootstrap: false });
    advance(AUTH_TRANSACTION_TTL_MS + 1);
    expect(transactions.consume(started.state)).toBeUndefined();
  });

  it("keeps one transaction per binding, so a public URL cannot pile them up", () => {
    const { transactions } = setup();
    const first = transactions.start({ binding: "a", bootstrap: false });
    const second = transactions.start({ binding: "a", bootstrap: false });
    expect(transactions.consume(first.state)).toBeUndefined();
    expect(transactions.consume(second.state)).toBeDefined();
  });

  it("caps how many concurrent transactions exist at all", () => {
    const { transactions } = setup();
    for (let index = 0; index < 5_000; index += 1) {
      transactions.start({ binding: `b${index}`, bootstrap: false });
    }
    expect(transactions.size()).toBeLessThanOrEqual(500);
  });
});

/**
 * The Host does not hand-roll OAuth. Until MSAL is wired the provider must fail
 * closed with a named reason rather than pretend a login succeeded.
 */
describe("createEntraProvider", () => {
  const config = {
    tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    clientId: "11111111-2222-3333-4444-555555555555",
  };

  it("fails closed with a named error when MSAL is unavailable", async () => {
    const provider = createEntraProvider(config, {
      loadMsal: async () => {
        throw new Error("Cannot find package '@azure/msal-node'");
      },
    });
    await expect(
      provider.authorizationUrl({
        redirectUri: "http://localhost:8787/api/auth/entra/callback",
        state: "s",
        nonce: "n",
        codeChallenge: "c",
      }),
    ).rejects.toBeInstanceOf(EntraProviderUnavailableError);
  });

  it("refuses an identity issued by a tenant it was not configured for", async () => {
    const provider = createEntraProvider(config, {
      loadMsal: async () => ({
        redeem: async () => ({
          tenantId: "00000000-0000-0000-0000-000000000000",
          objectId: "abc",
          username: "someone@other.example",
          displayName: "Someone",
        }),
      }),
    });
    await expect(
      provider.redeemAuthorizationCode({
        code: "c",
        codeVerifier: "v",
        nonce: "n",
        redirectUri: "http://localhost:8787/api/auth/entra/callback",
      }),
    ).rejects.toThrow(/tenant/i);
  });

  it("returns the validated identity when the tenant matches", async () => {
    const provider = createEntraProvider(config, {
      loadMsal: async () => ({
        redeem: async () => ({
          tenantId: config.tenantId,
          objectId: "abc",
          username: "person@example.com",
          displayName: "Person",
        }),
      }),
    });
    await expect(
      provider.redeemAuthorizationCode({
        code: "c",
        codeVerifier: "v",
        nonce: "n",
        redirectUri: "http://localhost:8787/api/auth/entra/callback",
      }),
    ).resolves.toMatchObject({ tenantId: config.tenantId, objectId: "abc" });
  });

  it("refuses device flow until a Host has verified its tenant allows it", async () => {
    const provider = createEntraProvider(config, {
      loadMsal: async () => ({ redeem: async () => ({}) as never }),
      deviceFlowEnabled: () => false,
    });
    await expect(provider.startDeviceCode()).rejects.toThrow(/device/i);
  });
});

describe("MSAL adapter", () => {
  const config = {
    tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    clientId: "11111111-2222-3333-4444-555555555555",
  };
  const account = {
    tenantId: config.tenantId,
    localAccountId: "object-id",
    username: "person@example.com",
    name: "Person",
  };
  const result = {
    tenantId: config.tenantId,
    uniqueId: "object-id",
    account,
  };

  it("builds the authorization URL with identity scopes, PKCE, state, and nonce", async () => {
    let request: Record<string, unknown> | undefined;
    const adapter = createMsalAdapter(config, {
      getAuthCodeUrl: async (input) => {
        request = input;
        return "https://login.microsoftonline.com/authorize";
      },
      acquireTokenByCode: async () => result,
      acquireTokenByDeviceCode: async () => result,
      removeAccount: async () => {},
    });

    await adapter.authorizationUrl?.({
      redirectUri: "http://localhost:8787/api/auth/entra/callback",
      state: "state",
      nonce: "nonce",
      codeChallenge: "challenge",
    });

    expect(request).toMatchObject({
      scopes: ["openid", "profile", "email"],
      redirectUri: "http://localhost:8787/api/auth/entra/callback",
      state: "state",
      nonce: "nonce",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      responseMode: "query",
      prompt: "select_account",
    });
  });

  it("redeems the code with the same PKCE values and removes tokens from cache", async () => {
    let request: Record<string, unknown> | undefined;
    const removed: unknown[] = [];
    const adapter = createMsalAdapter(config, {
      getAuthCodeUrl: async () => "",
      acquireTokenByCode: async (input) => {
        request = input;
        return result;
      },
      acquireTokenByDeviceCode: async () => result,
      removeAccount: async (value) => void removed.push(value),
    });

    await expect(
      adapter.redeem({
        code: "code",
        codeVerifier: "verifier",
        nonce: "nonce",
        redirectUri: "http://localhost:8787/api/auth/entra/callback",
      }),
    ).resolves.toEqual({
      tenantId: config.tenantId,
      objectId: "object-id",
      username: "person@example.com",
      displayName: "Person",
    });
    expect(request).toMatchObject({
      scopes: ["openid", "profile", "email"],
      code: "code",
      codeVerifier: "verifier",
      nonce: "nonce",
      redirectUri: "http://localhost:8787/api/auth/entra/callback",
    });
    expect(removed).toEqual([account]);
  });

  it("starts one background device flow and exposes its eventual identity by flow id", async () => {
    const adapter = createMsalAdapter(config, {
      getAuthCodeUrl: async () => "",
      acquireTokenByCode: async () => result,
      acquireTokenByDeviceCode: async (input) => {
        input.deviceCodeCallback({
          userCode: "ABCD-EFGH",
          deviceCode: "device-code",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresIn: 900,
          interval: 5,
          message: "Enter ABCD-EFGH",
        });
        return result;
      },
      removeAccount: async () => {},
    });

    const started = await adapter.deviceCode?.();
    expect(started).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUri: "https://microsoft.com/devicelogin",
      message: "Enter ABCD-EFGH",
    });
    await expect(
      adapter.pollDevice?.({ flowId: started!.flowId }),
    ).resolves.toMatchObject({
      tenantId: config.tenantId,
      objectId: "object-id",
    });
  });
});
