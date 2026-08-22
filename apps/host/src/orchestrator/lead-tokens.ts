import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Where the signing key lives, so it outlives the process that made it. */
export const LEAD_TOKEN_KEY_SETTING = "orchestrator.tokenKey";

export type TokenKeyStore = {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
};

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
 * session: {@link resolve} only answers with a session id, and the caller
 * checks it is still a live orchestrator. Stopping one takes its tools away
 * immediately, which is the only revocation this needs.
 */
export class LeadTokens {
  private readonly key: Buffer;

  constructor(store: TokenKeyStore) {
    const existing = store.getSetting(LEAD_TOKEN_KEY_SETTING);
    if (existing) {
      this.key = Buffer.from(existing, "base64");
      return;
    }
    this.key = randomBytes(32);
    store.setSetting(LEAD_TOKEN_KEY_SETTING, this.key.toString("base64"));
  }

  /**
   * A token for this session.
   *
   * Deterministic, so a start and a later resume produce the same one and there
   * is no window where a session is holding a token that has been replaced.
   */
  mint(sessionId: string): string {
    return `flt_${encode(sessionId)}.${this.sign(sessionId)}`;
  }

  /** The session this token speaks for, or nothing if it was not signed here. */
  resolve(token: string): string | undefined {
    if (!token.startsWith("flt_")) return undefined;
    const [encoded, signature] = token.slice(4).split(".");
    if (!encoded || !signature) return undefined;
    const sessionId = Buffer.from(encoded, "base64url").toString("utf8");
    if (!sessionId) return undefined;
    return equal(signature, this.sign(sessionId)) ? sessionId : undefined;
  }

  private sign(sessionId: string): string {
    return createHmac("sha256", this.key).update(sessionId).digest("base64url");
  }
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  // Both are fixed-width digests; the length check only guards a mangled token.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
