import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";

/** The cookie the browser carries an operator session in. */
export const OPERATOR_COOKIE = "fleet_operator";

/** How long a login lasts before the operator has to type the password again. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Where the password verifier lives when the operator did not supply one. */
export const PASSWORD_SETTING_KEY = "auth.operatorPassword";

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
  /** Reads the stored verifier; absent on a Host that has never generated one. */
  getStoredHash: () => string | undefined;
  setStoredHash: (hash: string) => void;
  /** `FLEET_OPERATOR_PASSWORD`, when the operator set one. */
  configuredPassword?: string | undefined;
  /** Told the generated password exactly once, on the boot that made it. */
  announce: (password: string) => void;
  now?: () => number;
};

export type LoginOutcome =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: 401 | 429; error: string };

/**
 * Who is allowed to drive this Host.
 *
 * The fleet's browser API is an administrative interface: it starts processes
 * on other people's machines and reads every transcript they produce. A tunnel
 * in front of it authenticates a person into a network path and authorises
 * nothing, so the password here is what separates "can reach the Host" from
 * "can run commands on every enrolled VM".
 *
 * Sessions are held in memory on purpose: a Host restart is rare, logging in
 * again is cheap, and a token that outlives the process would have to be
 * stored somewhere a backup could carry it off.
 */
export class OperatorAuth {
  private readonly sessions = new Map<string, number>();
  private failures: number[] = [];
  private readonly passwordHash: string;
  private readonly now: () => number;

  constructor(options: OperatorAuthOptions) {
    this.now = options.now ?? Date.now;
    if (options.configuredPassword) {
      this.passwordHash = hashPassword(options.configuredPassword);
      return;
    }
    const stored = options.getStoredHash();
    if (stored) {
      this.passwordHash = stored;
      return;
    }
    // A Host with no password configured would otherwise have to choose between
    // refusing to start and serving an administrative API to anyone who can
    // reach it. It does neither: it invents one and says so once.
    const password = generatePassword();
    this.passwordHash = hashPassword(password);
    options.setStoredHash(this.passwordHash);
    options.announce(password);
  }

  login(password: string): LoginOutcome {
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
    return { ok: true, ...this.issue() };
  }

  /** Whether a cookie value names a session that is still valid. */
  verify(token: string | undefined): boolean {
    if (!token) return false;
    const key = sessionKey(token);
    const expiresAt = this.sessions.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(sessionKey(token));
  }

  private issue(): { token: string; expiresAt: number } {
    this.sweep();
    const token = `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.sessions.set(sessionKey(token), expiresAt);
    return { token, expiresAt };
  }

  private allowAttempt(): boolean {
    const cutoff = this.now() - LOCKOUT_WINDOW_MS;
    this.failures = this.failures.filter((at) => at > cutoff);
    return this.failures.length < MAX_LOGIN_FAILURES;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(key);
    }
  }
}

/**
 * Sessions are keyed by digest so a heap dump — or a log line that printed the
 * map — cannot be replayed as a login.
 */
function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
  const parts = [`${OPERATOR_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
