import { describe, expect, it } from "vitest";
import {
  LOCKOUT_WINDOW_MS,
  MAX_LOGIN_FAILURES,
  OPERATOR_COOKIE,
  OperatorAuth,
  clearedCookie,
  generatePassword,
  hashPassword,
  readCookie,
  sessionCookie,
  verifyPassword,
} from "./auth.js";

/**
 * The password is the only thing between "reached the Host" and "runs commands
 * on every enrolled machine", so the rules it keeps are asserted here rather
 * than inferred from the routes that lean on them.
 */
describe("password storage", () => {
  it("verifies a password it hashed and rejects any other", () => {
    const stored = hashPassword("correct horse");
    expect(verifyPassword("correct horse", stored)).toBe(true);
    expect(verifyPassword("Correct horse", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("salts, so the same password never lands on the same verifier", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("refuses a verifier it does not recognise instead of throwing", () => {
    for (const stored of ["", "plain", "md5$salt$abcd", "scrypt$$", "scrypt$salt$"]) {
      expect(verifyPassword("anything", stored)).toBe(false);
    }
  });

  it("generates a password long enough to be worth generating", () => {
    const password = generatePassword();
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(password).not.toBe(generatePassword());
  });
});

describe("OperatorAuth", () => {
  it("checks the selected verifier without issuing a session", () => {
    const auth = new OperatorAuth(hashPassword("pw"));
    expect(auth.check("pw")).toEqual({ ok: true });
    expect(auth.check("wrong")).toMatchObject({ ok: false, status: 401 });
  });

  it("stops answering guesses once there have been too many", () => {
    let now = 0;
    const auth = new OperatorAuth(hashPassword("pw"), () => now);
    for (let attempt = 0; attempt < MAX_LOGIN_FAILURES; attempt += 1) {
      expect(auth.check("wrong")).toMatchObject({ ok: false, status: 401 });
    }
    expect(auth.check("wrong")).toMatchObject({ ok: false, status: 429 });
    // Locked out means locked out: the right password does not reopen it,
    // or a guesser could use one to test whether it had found the other.
    expect(auth.check("pw")).toMatchObject({ ok: false, status: 429 });

    now += LOCKOUT_WINDOW_MS + 1;
    expect(auth.check("pw").ok).toBe(true);
  });

  it("forgets earlier failures after a successful sign-in", () => {
    const auth = new OperatorAuth(hashPassword("pw"));
    for (let attempt = 0; attempt < MAX_LOGIN_FAILURES - 1; attempt += 1) {
      auth.check("wrong");
    }
    expect(auth.check("pw").ok).toBe(true);
    for (let attempt = 0; attempt < MAX_LOGIN_FAILURES - 1; attempt += 1) {
      expect(auth.check("wrong")).toMatchObject({ ok: false, status: 401 });
    }
  });
});

describe("cookies", () => {
  it("reads one cookie out of a header carrying several", () => {
    const header = `theme=dark; ${OPERATOR_COOKIE}=abc%20123; other=x`;
    expect(readCookie(header, OPERATOR_COOKIE)).toBe("abc 123");
    expect(readCookie(header, "theme")).toBe("dark");
    expect(readCookie(header, "absent")).toBeUndefined();
    expect(readCookie(undefined, OPERATOR_COOKIE)).toBeUndefined();
  });

  it("keeps the session cookie out of scripts, cross-site requests, and caches", () => {
    const cookie = sessionCookie("token", false, 60_000);
    expect(cookie).toContain(`${OPERATOR_COOKIE}=token`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=60");
    // Plain HTTP is the tunnel-less local case; marking it Secure there would
    // make the cookie undeliverable and the Host unusable.
    expect(cookie).not.toContain("Secure");
    expect(sessionCookie("token", true, 60_000)).toContain("Secure");
  });

  it("clears with the same attributes it set", () => {
    const cleared = clearedCookie(true);
    expect(cleared).toContain(`${OPERATOR_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Strict");
    expect(cleared).toContain("Secure");
  });
});
