import { createRemoteJWKSet, jwtVerify, type LocalJWKSet, type RemoteJWKSet } from "jose";
import type { EntraConfig, EntraIdentity } from "./entra.js";

export const GUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
export const MICROSOFT_PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

const signingKeys = createRemoteJWKSet(
  new URL(`${MICROSOFT_AUTHORITY}/common/discovery/v2.0/keys`),
);

export class MicrosoftIdentityValidationError extends Error {}

/**
 * MSAL acquires tokens; Fleet independently validates the identity that may
 * become an administrator. Never fetch keys from a URL supplied by a token.
 */
export async function verifyMicrosoftIdentity(
  idToken: string,
  config: EntraConfig,
  nonce?: string,
  keys: LocalJWKSet | RemoteJWKSet = signingKeys,
): Promise<EntraIdentity> {
  const { payload, protectedHeader } = await jwtVerify(idToken, keys, {
    algorithms: ["RS256"],
    audience: config.clientId,
    requiredClaims: ["iss", "aud", "exp", "iat", "nbf", "tid", "oid", "sub", "ver"],
    clockTolerance: 60,
  });
  if (
    typeof payload.tid !== "string" ||
    !GUID_RE.test(payload.tid) ||
    typeof payload.oid !== "string" ||
    !GUID_RE.test(payload.oid) ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.ver !== "2.0" ||
    payload.aud !== config.clientId ||
    typeof payload.iat !== "number" ||
    payload.iat > Date.now() / 1_000 + 60 ||
    (nonce !== undefined && payload.nonce !== nonce)
  ) {
    throw new MicrosoftIdentityValidationError(
      "Microsoft returned invalid identity claims.",
    );
  }

  const tenantId = payload.tid.toLowerCase();
  const issuer = `${MICROSOFT_AUTHORITY}/${tenantId}/v2.0`;
  if (payload.iss !== issuer) {
    throw new MicrosoftIdentityValidationError(
      "Microsoft returned an invalid identity issuer.",
    );
  }

  // Microsoft's shared key set also contains tenant-specific keys. A valid
  // signature alone must not let such a key speak for a different tenant.
  const key = keys
    .jwks()
    ?.keys.find(
      (candidate) => candidate.kid === protectedHeader.kid && candidate.kty === "RSA",
    );
  const keyIssuer = key && "issuer" in key ? key.issuer : undefined;
  if (
    !protectedHeader.kid ||
    typeof keyIssuer !== "string" ||
    keyIssuer.replace("{tenantid}", tenantId) !== issuer
  ) {
    throw new MicrosoftIdentityValidationError(
      "Microsoft's signing key does not match the identity issuer.",
    );
  }

  return {
    tenantId,
    objectId: payload.oid.toLowerCase(),
    username:
      typeof payload.preferred_username === "string" ? payload.preferred_username : "",
    displayName: typeof payload.name === "string" ? payload.name : "",
  };
}
