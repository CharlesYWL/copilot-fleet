import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a printed claim code stays usable before it must be reprinted. */
export const CLAIM_CODE_TTL_MS = 30 * 60 * 1000;

/** How long the grant a correct code buys stays usable. */
export const BOOTSTRAP_GRANT_TTL_MS = 10 * 60 * 1000;

export const MAX_CLAIM_ATTEMPTS_PER_BINDING = 5;
export const CLAIM_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

/** Bindings remembered at once, so a public URL cannot grow the map. */
export const MAX_TRACKED_BINDINGS = 1_000;

/** Claim checks the whole Host will answer per window, from everyone. */
export const GLOBAL_CLAIM_BUCKET_CAPACITY = 60;
export const GLOBAL_CLAIM_REFILL_MS = 1_000;

export type ClaimRedeemOutcome =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: 401 | 429 | 409; error: string };

export type BootstrapGrant = {
  binding: string;
  expiresAt: number;
};

export type ClaimCodeOptions = {
  now?: (() => number) | undefined;
  /**
   * Where the code is printed.
   *
   * Deliberately a callback: the real one writes to stdout directly rather than
   * through the logger, because the logger's buffer is readable over HTTP and
   * this is the one string that must never be.
   */
  announce: (code: string) => void;
};

type BindingRecord = {
  failures: number[];
  grantHash: string | undefined;
  lastSeen: number;
};

/**
 * A single answer for every wrong code.
 *
 * Distinguishing "expired" from "wrong" tells a guesser that the code they
 * tried was once real, which is most of what they wanted to know.
 */
const INVALID = "Invalid claim code";

/**
 * The bootstrap proof a network attacker cannot obtain.
 *
 * Every current tunnel provider relays into loopback, so the Host cannot tell a
 * request from the next room apart from one from the internet — which rules out
 * "trust local callers" as a way to decide who gets to claim a fresh Host. What
 * it can do is print a secret somewhere only console access reaches, and demand
 * it back. The code authorises nothing on its own: it is the second half of a
 * proof whose first half is a Microsoft identity.
 */
export class ClaimCodeService {
  private readonly now: () => number;
  private readonly announce: (code: string) => void;
  private codeHash: string | undefined;
  private codeExpiresAt = 0;
  private readonly bindings = new Map<string, BindingRecord>();
  private readonly grants = new Map<string, BootstrapGrant>();
  private tokens = GLOBAL_CLAIM_BUCKET_CAPACITY;
  private lastRefill: number;

  constructor(options: ClaimCodeOptions) {
    this.now = options.now ?? Date.now;
    this.announce = options.announce;
    this.lastRefill = this.now();
  }

  /** Prints a fresh code, replacing any that was outstanding. */
  issue(): void {
    const code = randomBytes(16).toString("base64url");
    this.codeHash = digest(code);
    this.codeExpiresAt = this.now() + CLAIM_CODE_TTL_MS;
    this.announce(code);
  }

  /** The console command: print a new one and retire the old. */
  regenerate(): void {
    this.issue();
  }

  /** Stops accepting any code, which is what a successful claim does. */
  clear(): void {
    this.codeHash = undefined;
    this.codeExpiresAt = 0;
    this.grants.clear();
    this.bindings.clear();
  }

  status(): { active: boolean; expiresAt: number } {
    return { active: this.active(), expiresAt: this.codeExpiresAt };
  }

  /** The digest, for tests and diagnostics. Never the code. */
  codeFingerprint(): string | undefined {
    return this.active() ? this.codeHash : undefined;
  }

  bindingCount(): number {
    return this.bindings.size;
  }

  /**
   * Exchanges a printed code for a short bootstrap grant.
   *
   * The two limits do different jobs. The per-binding counter stops one browser
   * from working through the keyspace; the global bucket stops a crowd of them
   * from doing it in parallel. Neither ever invalidates the code itself — that
   * would turn a trivial flood into a denial of the only way to claim the Host.
   */
  redeem(code: string, binding: string): ClaimRedeemOutcome {
    if (!this.takeGlobalToken()) {
      return { ok: false, status: 429, error: "Too many attempts. Try again shortly." };
    }
    const record = this.binding(binding);
    if (this.recentFailures(record) >= MAX_CLAIM_ATTEMPTS_PER_BINDING) {
      return {
        ok: false,
        status: 429,
        error: "Too many attempts from this browser. Wait a few minutes.",
      };
    }
    if (!this.active() || !this.codeHash || !equalDigests(digest(code), this.codeHash)) {
      record.failures.push(this.now());
      return { ok: false, status: 401, error: INVALID };
    }
    record.failures = [];
    return { ok: true, ...this.grant(record, binding) };
  }

  /**
   * The grant an already-proven caller is owed, with no code involved.
   *
   * An upgraded Host's operator signs in with the password that Host has always
   * had, which is the same authority the printed code stands for: whoever holds
   * it holds the machine. Demanding the console code as well is asking them to
   * walk to the server room to prove something they have already proved — and
   * on a fleet reached only through a tunnel, that is where migrations stop.
   *
   * Deliberately not `redeem` with the code handed to the caller: the code is a
   * separate secret with a separate audience, and a path that revealed it would
   * turn one operator's session into console-equivalent knowledge that outlives
   * the session. Everything else about the grant is identical — same TTL, same
   * browser binding, same single use — because the claim that follows must be
   * the same claim.
   */
  grantTrusted(binding: string): { token: string; expiresAt: number } {
    const record = this.binding(binding);
    record.failures = [];
    return this.grant(record, binding);
  }

  /**
   * The grant behind a bootstrap cookie, if it is still live.
   *
   * `binding` is checked when the caller can supply one: a grant belongs to the
   * browser that earned it, and a copied cookie used from elsewhere is exactly
   * the case this refuses.
   */
  verifyBootstrap(
    token: string | undefined,
    binding?: string,
  ): BootstrapGrant | undefined {
    if (!token) return undefined;
    const hash = digest(token);
    const grant = this.grants.get(hash);
    if (!grant) return undefined;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(hash);
      return undefined;
    }
    if (binding !== undefined && grant.binding !== binding) return undefined;
    return grant;
  }

  /** Spends a grant. The first caller wins; there is no second. */
  consumeBootstrap(token: string | undefined): boolean {
    if (!token) return false;
    const hash = digest(token);
    const grant = this.grants.get(hash);
    if (!grant || grant.expiresAt <= this.now()) return false;
    this.grants.delete(hash);
    const record = this.bindings.get(grant.binding);
    if (record?.grantHash === hash) record.grantHash = undefined;
    return true;
  }

  private active(): boolean {
    return this.codeHash !== undefined && this.codeExpiresAt > this.now();
  }

  private grant(
    record: BindingRecord,
    binding: string,
  ): { token: string; expiresAt: number } {
    // One live grant per browser: a second redemption replaces the first rather
    // than adding to a pile that all stay valid for ten minutes.
    if (record.grantHash) this.grants.delete(record.grantHash);
    const token = randomBytes(32).toString("base64url");
    const hash = digest(token);
    const expiresAt = this.now() + BOOTSTRAP_GRANT_TTL_MS;
    this.grants.set(hash, { binding, expiresAt });
    record.grantHash = hash;
    return { token, expiresAt };
  }

  private binding(binding: string): BindingRecord {
    const existing = this.bindings.get(binding);
    if (existing) {
      existing.lastSeen = this.now();
      return existing;
    }
    this.evictBindings();
    const record: BindingRecord = {
      failures: [],
      grantHash: undefined,
      lastSeen: this.now(),
    };
    this.bindings.set(binding, record);
    return record;
  }

  /**
   * Keeps the map bounded by dropping the least recently used entries.
   *
   * Dropping a record forgets its failures, which sounds like a way around the
   * per-binding limit — but reaching the eviction threshold takes hundreds of
   * distinct bindings, and the global bucket is what answers that.
   */
  private evictBindings(): void {
    if (this.bindings.size < MAX_TRACKED_BINDINGS) return;
    const ordered = [...this.bindings].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    const excess = this.bindings.size - MAX_TRACKED_BINDINGS + 1;
    for (const [key, record] of ordered.slice(0, excess)) {
      if (record.grantHash) this.grants.delete(record.grantHash);
      this.bindings.delete(key);
    }
  }

  private recentFailures(record: BindingRecord): number {
    const cutoff = this.now() - CLAIM_ATTEMPT_WINDOW_MS;
    record.failures = record.failures.filter((at) => at > cutoff);
    return record.failures.length;
  }

  private takeGlobalToken(): boolean {
    const now = this.now();
    const refilled = Math.floor((now - this.lastRefill) / GLOBAL_CLAIM_REFILL_MS);
    if (refilled > 0) {
      this.tokens = Math.min(GLOBAL_CLAIM_BUCKET_CAPACITY, this.tokens + refilled);
      this.lastRefill = now;
    }
    if (this.tokens <= 0) return false;
    this.tokens -= 1;
    return true;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigests(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
