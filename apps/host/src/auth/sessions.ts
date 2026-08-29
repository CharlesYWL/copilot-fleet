import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  FleetStore,
  OperatorAuthMethod,
  OperatorSessionRow,
  RevokedSession,
} from "../store.js";

/**
 * How long a session survives without being used.
 *
 * A week rather than the ten years the signed cookie carried: long enough that
 * an overnight run does not end in a login prompt, short enough that a laptop
 * left in a taxi stops being a fleet credential.
 */
export const OPERATOR_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** The ceiling no amount of activity raises. */
export const OPERATOR_SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/** How fresh an authorization-code login must be for a high-impact action. */
export const RECENT_REAUTH_MS = 10 * 60 * 1000;

export type IssuedSession = {
  token: string;
  tokenHash: string;
  expiresAt: number;
  absoluteExpiresAt: number;
};

export type ActiveSession = {
  tokenHash: string;
  administratorId: string;
  authMethod: OperatorAuthMethod;
  authenticatedAt: number;
  expiresAt: number;
};

export type OperatorSessionsOptions = {
  store: FleetStore;
  /** Persisted, so the proof a browser holds survives a restart. */
  csrfKey: Buffer;
  now?: (() => number) | undefined;
};

/**
 * Browser sessions, held by the Host rather than by the browser.
 *
 * The scheme this replaces signed a token and checked the signature, which made
 * a session something the Host could recognise but not withdraw: a stolen
 * cookie stayed good until the password changed, and a removed administrator
 * kept working until someone thought to rotate it. Here the browser holds a
 * random value and the database holds its digest, so revocation is a row and
 * expiry is a comparison rather than a promise.
 */
export class OperatorSessions {
  private readonly store: FleetStore;
  private csrfKey: Buffer;
  private readonly now: () => number;

  constructor(options: OperatorSessionsOptions) {
    this.store = options.store;
    this.csrfKey = options.csrfKey;
    this.now = options.now ?? Date.now;
  }

  issue(input: {
    administratorId: string;
    authMethod: OperatorAuthMethod;
  }): IssuedSession {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = digest(token);
    const at = this.now();
    const absoluteExpiresAt = at + OPERATOR_SESSION_ABSOLUTE_MS;
    this.store.insertOperatorSession({
      tokenHash,
      administratorId: input.administratorId,
      authMethod: input.authMethod,
      authenticatedAt: new Date(at).toISOString(),
      lastSeenAt: new Date(at).toISOString(),
      expiresAt: new Date(absoluteExpiresAt).toISOString(),
    });
    return {
      token,
      tokenHash,
      expiresAt: Math.min(at + OPERATOR_SESSION_IDLE_MS, absoluteExpiresAt),
      absoluteExpiresAt,
    };
  }

  /**
   * Whether a cookie names a session that is still allowed to act, and moves
   * the idle clock when it is.
   *
   * Both clocks are checked on every request rather than swept in the
   * background, because a sweep that has not run yet is a session that has not
   * expired.
   */
  verify(token: string | undefined): ActiveSession | undefined {
    if (!token) return undefined;
    const tokenHash = digest(token);
    const row = this.store.getOperatorSession(tokenHash);
    if (!row || row.revokedAt !== "") return undefined;
    const now = this.now();
    const absolute = Date.parse(row.expiresAt);
    const lastSeen = Date.parse(row.lastSeenAt);
    if (!Number.isFinite(absolute) || !Number.isFinite(lastSeen)) return undefined;
    if (now >= absolute) return undefined;
    if (now - lastSeen >= OPERATOR_SESSION_IDLE_MS) return undefined;
    this.store.touchOperatorSession(tokenHash, new Date(now).toISOString());
    return toActive(row, absolute);
  }

  /** The same question without moving the idle clock, for revalidation. */
  inspect(tokenHash: string): ActiveSession | undefined {
    const row = this.store.getOperatorSession(tokenHash);
    if (!row || row.revokedAt !== "") return undefined;
    const now = this.now();
    const absolute = Date.parse(row.expiresAt);
    const lastSeen = Date.parse(row.lastSeenAt);
    if (!Number.isFinite(absolute) || !Number.isFinite(lastSeen)) return undefined;
    if (now >= absolute) return undefined;
    if (now - lastSeen >= OPERATOR_SESSION_IDLE_MS) return undefined;
    return toActive(row, absolute);
  }

  revoke(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const tokenHash = digest(token);
    this.store.revokeOperatorSession(tokenHash);
    return tokenHash;
  }

  revokeForAdministrator(administratorId: string): RevokedSession[] {
    return this.store.revokeSessionsForAdministrator(administratorId);
  }

  revokeByMethod(authMethod: OperatorAuthMethod): RevokedSession[] {
    return this.store.revokeSessionsByMethod(authMethod);
  }

  pruneExpired(): number {
    return this.store.deleteExpiredOperatorSessions(new Date(this.now()).toISOString());
  }

  /**
   * The browser-visible CSRF proof.
   *
   * Derived rather than stored, so there is no second per-session secret to
   * keep in step with the first, and no row to forget to delete. Keyed on the
   * session digest, so a proof is worthless against any other session.
   */
  csrfToken(tokenHash: string): string {
    return csrfProof(this.csrfKey, tokenHash);
  }

  verifyCsrf(tokenHash: string, presented: string | undefined): boolean {
    if (!presented) return false;
    return equalStrings(presented, this.csrfToken(tokenHash));
  }

  /**
   * Adopts a key a restore just wrote.
   *
   * The proof is derived from the key rather than stored, so a Host that kept
   * deriving with the old one after a portable restore would be issuing proofs
   * against a key it no longer has — and the next process to start would
   * reject every one of them.
   */
  adoptCsrfKey(key: Buffer): void {
    this.csrfKey = key;
  }
}

export function csrfProof(key: Buffer, tokenHash: string): string {
  return createHmac("sha256", key).update(tokenHash).digest("base64url");
}

/**
 * Whether a session may perform an action that cannot be undone.
 *
 * Only an authorization-code login counts. A device-code login can be started
 * by an attacker and completed by a phished administrator, which is exactly the
 * situation in which removing the other administrators is most attractive; a
 * password is a shared secret and proves no individual at all.
 */
export function hasRecentCodeReauth(
  session: { authMethod: OperatorAuthMethod; authenticatedAt: number },
  now: number,
): boolean {
  if (session.authMethod !== "microsoft-code") return false;
  return now - session.authenticatedAt < RECENT_REAUTH_MS;
}

function toActive(row: OperatorSessionRow, absolute: number): ActiveSession {
  return {
    tokenHash: row.tokenHash,
    administratorId: row.administratorId,
    authMethod: row.authMethod,
    authenticatedAt: Date.parse(row.authenticatedAt),
    expiresAt: absolute,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalStrings(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
