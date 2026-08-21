import { describe, expect, it } from "vitest";
import {
  LOCKOUT_WINDOW_MS,
  MAX_LOGIN_FAILURES,
  OPERATOR_COOKIE,
  OperatorAuth,
  SESSION_TTL_MS,
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
  const setup = (
    overrides: Partial<{
      stored: string | undefined;
      configured: string | undefined;
      now: () => number;
    }> = {},
  ) => {
    const announced: string[] = [];
    let stored = overrides.stored;
    const auth = new OperatorAuth({
      getStoredHash: () => stored,
      setStoredHash: (hash) => {
        stored = hash;
      },
      configuredPassword: overrides.configured,
      announce: (password) => announced.push(password),
      ...(overrides.now ? { now: overrides.now } : {}),
    });
    return { auth, announced, storedHash: () => stored };
  };

  it("accepts the configured password and nothing else", () => {
    const { auth, announced } = setup({ configured: "from-env" });
    expect(auth.login("from-env").ok).toBe(true);
    expect(auth.login("from-envy").ok).toBe(false);
    // Nothing was invented, so nothing was announced or persisted.
    expect(announced).toEqual([]);
  });

  it("prefers the configured password over a stored verifier", () => {
    const { auth } = setup({ configured: "from-env", stored: hashPassword("from-db") });
    expect(auth.login("from-env").ok).toBe(true);
    expect(auth.login("from-db").ok).toBe(false);
  });

  it("reuses the stored verifier across restarts", () => {
    const { auth, announced } = setup({ stored: hashPassword("from-db") });
    expect(auth.login("from-db").ok).toBe(true);
    expect(announced).toEqual([]);
  });

  it("invents a password once when there is none, and says so", () => {
    const { auth, announced, storedHash } = setup();
    expect(announced).toHaveLength(1);
    expect(auth.login(announced[0]!).ok).toBe(true);
    // Persisted, so the next boot does not invent a second one.
    expect(verifyPassword(announced[0]!, storedHash()!)).toBe(true);
  });

  it("issues a session the cookie can be checked against, and revokes it", () => {
    const { auth } = setup({ configured: "pw" });
    const outcome = auth.login("pw");
    if (!outcome.ok) throw new Error("expected a successful login");

    expect(auth.verify(outcome.token)).toBe(true);
    expect(auth.verify(`${outcome.token}x`)).toBe(false);
    expect(auth.verify(undefined)).toBe(false);

    auth.revoke(outcome.token);
    expect(auth.verify(outcome.token)).toBe(false);
  });

  it("expires a session rather than trusting it forever", () => {
    let now = 1_000;
    const { auth } = setup({ configured: "pw", now: () => now });
    const outcome = auth.login("pw");
    if (!outcome.ok) throw new Error("expected a successful login");
    expect(outcome.expiresAt).toBe(1_000 + SESSION_TTL_MS);

    now += SESSION_TTL_MS - 1;
    expect(auth.verify(outcome.token)).toBe(true);
    now += 1;
    expect(auth.verify(outcome.token)).toBe(false);
  });

  it("stops answering guesses once there have been too many", () => {
    let now = 0;
    const { auth } = setup({ configured: "pw", now: () => now });
    for (let attempt = 0; attempt < MAX_LOGIN_FAILURES; attempt += 1) {
      expect(auth.login("wrong")).toMatchObject({ ok: false, status: 401 });
    }
    expect(auth.login("wrong")).toMatchObject({ ok: false, status: 429 });
    // Locked out means locked out: the right password does not reopen it,
    // or a guesser could use one to test whether it had found the other.
    expect(auth.login("pw")).toMatchObject({ ok: false, status: 429 });

    now += LOCKOUT_WINDOW_MS + 1;
    expect(auth.login("pw").ok).toBe(true);
  });

  it("forgets earlier failures after a successful sign-in", () => {
    const { auth } = setup({ configured: "pw" });
    for (let attempt = 0; attempt < MAX_LOGIN_FAILURES - 1; attempt += 1) {
      auth.login("wrong");
    }
    expect(auth.login("pw").ok).toBe(true);
    for (let attempt = 0; attempt < MAX_LOGIN_FAILURES - 1; attempt += 1) {
      expect(auth.login("wrong")).toMatchObject({ ok: false, status: 401 });
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
