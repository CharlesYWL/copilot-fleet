import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Where the signing key lives, so it outlives the process that made it. */
export const LEAD_TOKEN_KEY_SETTING = "orchestrator.tokenKey";

/** The claim set this Host issues. A later one is a different number. */
export const LEAD_TOKEN_VERSION = 1 as const;

/**
 * A bound on a credential nobody has authenticated yet.
 *
 * Everything past this point — the HMAC, the base64 decode, the JSON parse —
 * is work done on behalf of an unauthenticated caller, so the length is
 * checked before any of it happens.
 */
export const MAX_LEAD_TOKEN_LENGTH = 4_096;

export type TokenKeyStore = {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
};

/**
 * What a lead token says, and therefore what can be re-checked later.
 *
 * The session alone was not enough: it says who is calling but not what they
 * were authorised for, so a token minted for one run kept working after the
 * session was moved onto another. Naming the run and the node makes the
 * authorisation checkable against the fleet as it is now rather than as it was
 * when the token was written.
 */
export const LeadTokenClaimsSchema = z.object({
  version: z.literal(LEAD_TOKEN_VERSION),
  sessionId: z.string().min(1).max(200),
  runId: z.string().max(200),
  nodeId: z.string().max(200),
  issuedAt: z.string().min(1).max(64),
});
export type LeadTokenClaims = z.infer<typeof LeadTokenClaimsSchema>;

/** The three facts a token is minted about. */
export type LeadTokenSubject = {
  sessionId: string;
  runId: string;
  nodeId: string;
};

export type LeadTokensOptions = { now?: (() => number) | undefined };

/**
 * The bearer tokens orchestrator sessions authenticate their tool calls with.
 *
 * Signed rather than stored. An earlier version kept a map of hashes in memory,
 * which made a Host restart silently take an orchestrator's tools away: the
 * session itself survives — the Node keeps the agent alive — so nothing settles
 * it, nothing resumes it, and nothing ever mints it a replacement. It went on
 * running with a token the Host no longer recognised, and every tool call came
 * back 401. Under `tsx watch` that happened on every file save.
 *
 * A signature has no such lifetime. The key is persisted, so a restart changes
 * nothing and there is no table to fall out of step with the sessions.
 *
 * Revocation is therefore not the absence of an entry but the state of the
 * fleet: {@link resolve} answers with the claims that were signed, and the
 * caller checks each one against a live lead. Stopping one, cancelling its
 * run, or deleting the machine it was placed on takes its tools away on the
 * very next call, which is the only revocation this needs.
 */
export class LeadTokens {
  private key: Buffer;
  private readonly now: () => number;

  constructor(store: TokenKeyStore, options: LeadTokensOptions = {}) {
    this.now = options.now ?? Date.now;
    const existing = store.getSetting(LEAD_TOKEN_KEY_SETTING);
    if (existing) {
      this.key = Buffer.from(existing, "base64");
      return;
    }
    this.key = randomBytes(32);
    store.setSetting(LEAD_TOKEN_KEY_SETTING, this.key.toString("base64"));
  }

  /**
   * A token for one lead, as it stands right now.
   *
   * Minting again does not withdraw an earlier token: both are signed by the
   * same key and describe the same lead, so a resume cannot leave a running
   * agent holding something the Host has stopped recognising.
   */
  mint(subject: LeadTokenSubject): string {
    const claims: LeadTokenClaims = {
      version: LEAD_TOKEN_VERSION,
      sessionId: subject.sessionId,
      runId: subject.runId,
      nodeId: subject.nodeId,
      issuedAt: new Date(this.now()).toISOString(),
    };
    const payload = encode(JSON.stringify(claims));
    return `flt_${payload}.${this.sign(payload)}`;
  }

  /**
   * The claims this token carries, or nothing if it was not signed here.
   *
   * Answering with the claims rather than a session id is what lets the caller
   * ask the question the signature cannot: whether the fleet still looks the
   * way the token says it did.
   */
  resolve(token: string): LeadTokenClaims | undefined {
    if (!token.startsWith("flt_") || token.length > MAX_LEAD_TOKEN_LENGTH) {
      return undefined;
    }

    const [payload, signature] = token.slice(4).split(".");
    if (!payload || !signature) return undefined;
    if (!equal(signature, this.sign(payload))) return undefined;
    const decoded = decode(payload);
    if (decoded === undefined) return undefined;
    const claims = LeadTokenClaimsSchema.safeParse(decoded);
    return claims.success ? claims.data : undefined;
  }

  /** Adopts the key restored with a portable Host identity without a restart. */
  adoptKey(encoded: string): void {
    this.key = Buffer.from(encoded, "base64");
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** A signed payload is still arbitrary bytes until it parses. */
function decode(payload: string): unknown {
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  // Both are fixed-width digests; the length check only guards a mangled token.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
