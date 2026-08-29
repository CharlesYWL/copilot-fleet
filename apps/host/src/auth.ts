import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";

/** The cookie the browser carries an operator session in. */
export const OPERATOR_COOKIE = "fleet_operator";

/**
 * The short grant a correct console claim code buys.
 *
 * `SameSite=Strict`, because it is only ever sent by the first-run page itself.
 * That also means it is deliberately absent from the Microsoft callback, which
 * arrives as a top-level cross-site navigation — the login transaction carries
 * the grant across that gap instead.
 */
export const BOOTSTRAP_COOKIE = "fleet_bootstrap";

/**
 * Which browser this is, for the limits that are not allowed to key on an IP.
 *
 * `SameSite=Lax` so it survives the redirect back from Microsoft, and carrying
 * no authority of its own so that leaking it grants nothing.
 */
export const BINDING_COOKIE = "fleet_bind";

/** How long a browser keeps its binding identifier. */
export const BINDING_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How long the browser is asked to keep the cookie.
 *
 * Not an expiry so much as "until something revokes it": a login lasts until
 * the password changes or the operator signs out. A cookie with no Max-Age at
 * all would be a session cookie and would die with the browser window, which is
 * the opposite of what this is for.
 */
export const SESSION_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Where the password verifier lives. */
export const PASSWORD_SETTING_KEY = "auth.operatorPassword";

/** Where the key that signs operator cookies lives, so it outlives the process. */
export const SESSION_KEY_SETTING = "auth.sessionKey";

/** Failed logins tolerated inside {@link LOCKOUT_WINDOW_MS} before refusing. */
export const MAX_LOGIN_FAILURES = 10;
export const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;

/**
 * A password at rest.
 *
 * scrypt rather than a bare digest because this is the one secret a person
 * chooses, and a person's password is guessable at a rate a hash function is
 * not meant to survive.
 */
export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const derived = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = scryptSync(password, salt, expected.length / 2);
  const known = Buffer.from(expected, "hex");
  return derived.length === known.length && timingSafeEqual(derived, known);
}

/** A password nobody has to invent, for a Host started without one. */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

export type OperatorAuthOptions = {
  /** Reads the stored verifier; absent on a Host that has never made one. */
  getStoredHash: () => string | undefined;
  setStoredHash: (hash: string) => void;
  /** Reads and writes the cookie signing key, which must survive a restart. */
  getSessionKey?: (() => string | undefined) | undefined;
  setSessionKey?: ((key: string) => void) | undefined;
  /** `FLEET_OPERATOR_PASSWORD`, when the operator set one. */
  configuredPassword?: string | undefined;
  /** Told the generated password exactly once, on the boot that made it. */
  announce: (password: string) => void;
  now?: () => number;
};

export type LoginOutcome =
  { ok: true; token: string } | { ok: false; status: 401 | 429; error: string };

/**
 * Who is allowed to drive this Host.
 *
 * The fleet's browser API is an administrative interface: it starts processes
 * on other people's machines and reads every transcript they produce. A tunnel
 * in front of it authenticates a person into a network path and authorises
 * nothing, so the password here is what separates "can reach the Host" from
 * "can run commands on every enrolled VM".
 *
 * Sessions are signed rather than stored. They used to live in a Map, with the
 * reasoning that a restart is rare and logging in again is cheap — but a Host
 * in development restarts on every file save, and being signed out each time
 * made the UI unusable. Signing costs nothing to keep: the key is persisted,
 * and a cookie carries which password it was issued for, so changing the
 * password invalidates every cookie without anything having to be swept.
 */
export class OperatorAuth {
  /** Sign-outs seen by this process; see {@link revoke} for what that means. */
  private readonly revoked = new Set<string>();
  private failures: number[] = [];
  private readonly passwordHash: string;
  private readonly signingKey: Buffer;
  private readonly now: () => number;

  constructor(options: OperatorAuthOptions) {
    this.now = options.now ?? Date.now;
    this.passwordHash = resolvePasswordHash(options);
    this.signingKey = resolveSessionKey(options);
  }

  login(password: string): LoginOutcome {
    const checked = this.check(password);
    if (!checked.ok) return checked;
    return { ok: true, token: this.issue() };
  }

  /**
   * Whether a password is the right one, and whether we are still answering.
   *
   * Separate from {@link login} because the opaque server-side session that
   * replaced the signed cookie needs the credential decision without the token
   * that used to come with it. The lockout lives here so both callers get it:
   * a limit only one path enforces is not a limit.
   */
  check(
    password: string,
  ): { ok: true } | { ok: false; status: 401 | 429; error: string } {
    if (!this.allowAttempt()) {
      return {
        ok: false,
        status: 429,
        error: "Too many failed sign-ins. Wait a few minutes and try again.",
      };
    }
    if (!verifyPassword(password, this.passwordHash)) {
      this.failures.push(this.now());
      return { ok: false, status: 401, error: "Incorrect password" };
    }
    this.failures = [];
    return { ok: true };
  }

  /** Whether a cookie value names a session that is still valid. */
  verify(token: string | undefined): boolean {
    if (!token) return false;
    const [id, fingerprint, signature] = token.split(".");
    if (!id || !fingerprint || !signature) return false;
    // The password this was issued under, so rotating it signs everyone out.
    if (fingerprint !== this.passwordFingerprint()) return false;
    if (this.revoked.has(id)) return false;
    return equalStrings(signature, this.sign(`${id}.${fingerprint}`));
  }

  /**
   * Ends a session.
   *
   * The browser is told to drop the cookie, and this process refuses it from
   * then on. There is no stored list, so a cookie captured before a sign-out
   * would be accepted again after a restart — a real limit, and a small one
   * next to needing the password to obtain one in the first place. Changing
   * the password is what revokes unconditionally.
   */
  revoke(token: string | undefined): void {
    const id = token?.split(".")[0];
    if (id) this.revoked.add(id);
  }

  /** A fresh session, identified so a sign-out can name it. */
  private issue(): string {
    const body = `${randomUUID()}.${this.passwordFingerprint()}`;
    return `${body}.${this.sign(body)}`;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.signingKey).update(body).digest("base64url");
  }

  /** Short digest of the verifier: enough to notice a change, not to reverse. */
  private passwordFingerprint(): string {
    return createHash("sha256").update(this.passwordHash).digest("hex").slice(0, 16);
  }

  private allowAttempt(): boolean {
    const cutoff = this.now() - LOCKOUT_WINDOW_MS;
    this.failures = this.failures.filter((at) => at > cutoff);
    return this.failures.length < MAX_LOGIN_FAILURES;
  }
}

/**
 * The verifier this Host will check passwords against, kept stable across
 * restarts.
 *
 * A configured password used to be re-hashed on every boot, and `hashPassword`
 * salts randomly — so the verifier, and anything derived from it, changed each
 * time. Reusing the stored one when it is for the same password is what lets a
 * cookie say which password it belongs to.
 */
function resolvePasswordHash(options: OperatorAuthOptions): string {
  const stored = options.getStoredHash();
  if (options.configuredPassword) {
    if (stored && verifyPassword(options.configuredPassword, stored)) return stored;
    const hash = hashPassword(options.configuredPassword);
    options.setStoredHash(hash);
    return hash;
  }
  if (stored) return stored;
  // A Host with no password configured would otherwise have to choose between
  // refusing to start and serving an administrative API to anyone who can
  // reach it. It does neither: it invents one and says so once.
  const password = generatePassword();
  const hash = hashPassword(password);
  options.setStoredHash(hash);
  options.announce(password);
  return hash;
}

function resolveSessionKey(options: OperatorAuthOptions): Buffer {
  const existing = options.getSessionKey?.();
  if (existing) return Buffer.from(existing, "base64");
  const key = randomBytes(32);
  // Without somewhere to persist it every restart invents a new one, which is
  // the in-memory behaviour this replaced. Tests that pass neither accessor get
  // exactly that, and say so by not asking for persistence.
  options.setSessionKey?.(key.toString("base64"));
  return key;
}

function equalStrings(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The one cookie we care about, from a header that may hold many. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/**
 * `SameSite=Strict` is doing real work here: it is what keeps a page the
 * operator happens to have open from driving the fleet in the background, and
 * what keeps a rebound DNS name from borrowing the session.
 */
export function sessionCookie(token: string, secure: boolean, maxAgeMs: number): string {
  const parts = [
    `${OPERATOR_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(secure: boolean): string {
  const parts = [
    `${OPERATOR_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * A cookie carrying no authority, only an identity for the rate limits.
 *
 * `SameSite=Lax` rather than `Strict` because the Microsoft callback is a
 * top-level navigation from another site, and a `Strict` cookie would not be
 * sent with it — leaving the Host unable to tell which browser it had started
 * the login for.
 */
export function bindingCookie(value: string, secure: boolean): string {
  const parts = [
    `${BINDING_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(BINDING_MAX_AGE_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** The bootstrap grant, which never leaves the first-run page's own origin. */
export function bootstrapCookie(
  value: string,
  secure: boolean,
  maxAgeMs: number,
): string {
  const parts = [
    `${BOOTSTRAP_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedBootstrapCookie(secure: boolean): string {
  return bootstrapCookie("", secure, 0);
}
