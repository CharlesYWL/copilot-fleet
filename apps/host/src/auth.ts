import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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

/** Where the password verifier lives. */
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

/** A random password for explicit console recovery. */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Password verification and lockout. FleetAuth owns configuration and sessions. */
export class OperatorAuth {
  private failures: number[] = [];
  constructor(
    private readonly passwordHash: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the password matches and this verifier is still accepting attempts. */
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

  private allowAttempt(): boolean {
    const cutoff = this.now() - LOCKOUT_WINDOW_MS;
    this.failures = this.failures.filter((at) => at > cutoff);
    return this.failures.length < MAX_LOGIN_FAILURES;
  }
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
  return cookie(OPERATOR_COOKIE, token, secure, "Strict", maxAgeMs);
}

export function clearedCookie(secure: boolean): string {
  return sessionCookie("", secure, 0);
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
  return cookie(BINDING_COOKIE, value, secure, "Lax", BINDING_MAX_AGE_MS);
}

/** The bootstrap grant, which never leaves the first-run page's own origin. */
export function bootstrapCookie(
  value: string,
  secure: boolean,
  maxAgeMs: number,
): string {
  return cookie(BOOTSTRAP_COOKIE, value, secure, "Strict", maxAgeMs);
}

export function clearedBootstrapCookie(secure: boolean): string {
  return bootstrapCookie("", secure, 0);
}

function cookie(
  name: string,
  value: string,
  secure: boolean,
  sameSite: "Strict" | "Lax",
  maxAgeMs: number,
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
