import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
} from "jose";
import {
  MICROSOFT_AUTHORITY,
  MICROSOFT_PERSONAL_TENANT_ID,
  verifyMicrosoftIdentity,
} from "./entra-token.js";
import { MICROSOFT_CORP_TENANT_ID, createMsalAdapter } from "./entra.js";

const CLIENT = "11111111-2222-3333-4444-555555555555";
const OBJECT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const config = { tenantId: "common", clientId: CLIENT };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
let jwk: Awaited<ReturnType<typeof exportJWK>> & { kid: string; issuer: string };

beforeAll(async () => {
  pair = await generateKeyPair("RS256", { extractable: true });
  jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-signing-key",
    issuer: `${MICROSOFT_AUTHORITY}/{tenantid}/v2.0`,
  };
  keys = createLocalJWKSet({ keys: [jwk] });
});

async function token(overrides: JWTPayload = {}, missing?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const claims: JWTPayload = {
    iss: `${MICROSOFT_AUTHORITY}/${MICROSOFT_CORP_TENANT_ID}/v2.0`,
    aud: CLIENT,
    sub: "pairwise-subject",
    tid: MICROSOFT_CORP_TENANT_ID,
    oid: OBJECT,
    ver: "2.0",
    iat: now,
    nbf: now,
    exp: now + 600,
    nonce: "transaction-nonce",
    preferred_username: "person@example.com",
    name: "Person",
    ...overrides,
  };
  if (missing) delete claims[missing];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .sign(pair.privateKey);
}

describe("Microsoft ID token validation", () => {
  it.each([
    MICROSOFT_CORP_TENANT_ID,
    MICROSOFT_PERSONAL_TENANT_ID,
    "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
  ])("accepts a signed v2 identity for tenant %s", async (tenantId) => {
    const signed = await token({
      tid: tenantId,
      iss: `${MICROSOFT_AUTHORITY}/${tenantId}/v2.0`,
    });
    await expect(
      verifyMicrosoftIdentity(signed, config, "transaction-nonce", keys),
    ).resolves.toEqual({
      tenantId,
      objectId: OBJECT,
      username: "person@example.com",
      displayName: "Person",
    });
  });

  it.each(["oid", "tid", "sub", "iss", "aud", "exp", "iat", "nbf", "ver"])(
    "refuses a missing %s claim instead of using a fallback identity",
    async (missing) => {
      await expect(
        verifyMicrosoftIdentity(await token({}, missing), config, undefined, keys),
      ).rejects.toThrow();
    },
  );

  it.each([
    ["non-Microsoft issuer", { iss: "https://other.example/tenant/v2.0" }],
    ["common issuer", { iss: `${MICROSOFT_AUTHORITY}/common/v2.0` }],
    ["issuer/tenant mismatch", { tid: MICROSOFT_PERSONAL_TENANT_ID }],
    ["nonconcrete tenant", { tid: "common" }],
    ["invalid object id", { oid: "pairwise-subject" }],
    ["wrong client", { aud: "99999999-2222-3333-4444-555555555555" }],
    ["multiple audiences", { aud: [CLIENT, "another-app"] }],
    ["wrong token version", { ver: "1.0" }],
    ["expired token", { exp: 1 }],
    ["future nbf", { nbf: 9_000_000_000 }],
    ["future iat", { iat: 9_000_000_000 }],
  ] satisfies [string, JWTPayload][])("refuses %s", async (_name, claims) => {
    await expect(
      verifyMicrosoftIdentity(await token(claims), config, undefined, keys),
    ).rejects.toThrow();
  });

  it("binds the ID token to the authorization transaction nonce", async () => {
    await expect(
      verifyMicrosoftIdentity(await token(), config, "another-nonce", keys),
    ).rejects.toThrow();
  });

  it("refuses a modified payload even when its principal looks valid", async () => {
    const signed = await token();
    const [header, , signature] = signed.split(".");
    const payload = Buffer.from(
      JSON.stringify({ tid: MICROSOFT_CORP_TENANT_ID, oid: OBJECT }),
    ).toString("base64url");
    await expect(
      verifyMicrosoftIdentity(
        `${header}.${payload}.${signature}`,
        config,
        undefined,
        keys,
      ),
    ).rejects.toThrow();
  });

  it("does not let a consumer-only signing key speak for an organizational tenant", async () => {
    const consumerKey = {
      ...jwk,
      issuer: `${MICROSOFT_AUTHORITY}/${MICROSOFT_PERSONAL_TENANT_ID}/v2.0`,
    };
    const consumerKeys = createLocalJWKSet({
      keys: [consumerKey],
    });
    await expect(
      verifyMicrosoftIdentity(await token(), config, undefined, consumerKeys),
    ).rejects.toThrow(/signing key/);
    await expect(
      verifyMicrosoftIdentity(
        await token({
          tid: MICROSOFT_PERSONAL_TENANT_ID,
          iss: `${MICROSOFT_AUTHORITY}/${MICROSOFT_PERSONAL_TENANT_ID}/v2.0`,
        }),
        config,
        undefined,
        consumerKeys,
      ),
    ).resolves.toMatchObject({ tenantId: MICROSOFT_PERSONAL_TENANT_ID });
  });

  it("refuses an unapproved signing algorithm", async () => {
    const signed = await new SignJWT({ tid: MICROSOFT_CORP_TENANT_ID, oid: OBJECT })
      .setProtectedHeader({ alg: "HS256", kid: jwk.kid })
      .sign(new Uint8Array(32));
    await expect(
      verifyMicrosoftIdentity(signed, config, undefined, keys),
    ).rejects.toThrow();
  });

  it("does not confuse a guest identity with the same person's home identity", async () => {
    const guestTenant = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
    const guest = await verifyMicrosoftIdentity(
      await token({
        tid: guestTenant,
        oid: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        iss: `${MICROSOFT_AUTHORITY}/${guestTenant}/v2.0`,
        idp: "live.com",
      }),
      config,
      undefined,
      keys,
    );
    expect(guest.tenantId).toBe(guestTenant);
    expect(guest.objectId).not.toBe(OBJECT);
  });
});

describe("verified MSAL identity boundary", () => {
  it.each(["invalid token", "mismatched result", "missing object id"])(
    "removes cached provider tokens and grants no identity for %s",
    async (failure) => {
      const account = {
        tenantId: MICROSOFT_CORP_TENANT_ID,
        localAccountId: OBJECT,
        username: "person@example.com",
      };
      const result = {
        tenantId: MICROSOFT_CORP_TENANT_ID,
        uniqueId: failure === "mismatched result" ? "different-subject" : OBJECT,
        idToken:
          failure === "invalid token"
            ? "not-a-token"
            : await token({}, failure === "missing object id" ? "oid" : undefined),
        account,
      };
      const removeAccount = vi.fn(async () => {});
      const adapter = createMsalAdapter(
        config,
        {
          getAuthCodeUrl: async () => "",
          acquireTokenByCode: async () => result,
          acquireTokenByDeviceCode: async () => result,
          removeAccount,
        },
        keys,
      );

      await expect(
        adapter.redeem({
          code: "code",
          codeVerifier: "verifier",
          nonce: "transaction-nonce",
          redirectUri: "http://localhost/api/auth/entra/callback",
        }),
      ).rejects.toMatchObject({ code: "invalid-identity" });
      expect(removeAccount).toHaveBeenCalledWith(account);
    },
  );
});
