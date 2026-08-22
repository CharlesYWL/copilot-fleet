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
  /** Stands in for the settings table, so a "restart" can reuse the same one. */
  const settings = () => {
    const values = new Map<string, string>();
    return {
      getSessionKey: () => values.get("key"),
      setSessionKey: (key: string) => void values.set("key", key),
    };
  };

  const setup = (
    overrides: Partial<{
      stored: string | undefined;
      configured: string | undefined;
      now: () => number;
      keys: ReturnType<typeof settings>;
    }> = {},
  ) => {
    const announced: string[] = [];
    let stored = overrides.stored;
    const keys = overrides.keys ?? settings();
    const auth = new OperatorAuth({
      getStoredHash: () => stored,
      setStoredHash: (hash) => {
        stored = hash;
      },
      ...keys,
      configuredPassword: overrides.configured,
      announce: (password) => announced.push(password),
      ...(overrides.now ? { now: overrides.now } : {}),
    });
    return { auth, announced, keys, storedHash: () => stored };
  };

  it("accepts the configured password and nothing else", () => {
    const { auth, announced } = setup({ configured: "from-env" });
    expect(auth.login("from-env").ok).toBe(true);
    expect(auth.login("from-envy").ok).toBe(false);
    // Nothing was invented, so nothing was announced.
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

  it("keeps a session valid across a Host restart", () => {
    /*
     * The reported problem: every refresh asked for the password again. The
     * cookie was fine — the sessions were a Map, and a Host under `tsx watch`
     * restarts on every file save, so each one signed the operator out.
     */
    const keys = settings();
    const stored = hashPassword("pw");
    const first = setup({ configured: "pw", stored, keys });
    const outcome = first.auth.login("pw");
    if (!outcome.ok) throw new Error("expected a successful login");

    const afterRestart = setup({ configured: "pw", stored: first.storedHash(), keys });

    expect(afterRestart.auth.verify(outcome.token)).toBe(true);
  });

  it("signs everyone out when the password changes", () => {
    const keys = settings();
    const before = setup({ configured: "old", keys });
    const outcome = before.auth.login("old");
    if (!outcome.ok) throw new Error("expected a successful login");

    const after = setup({ configured: "new", stored: before.storedHash(), keys });

    expect(after.auth.verify(outcome.token)).toBe(false);
  });

  it("will not take a cookie another Host signed", () => {
    const outcome = setup({ configured: "pw" }).auth.login("pw");
    if (!outcome.ok) throw new Error("expected a successful login");

    // Same password, different signing key: the token is not transferable.
    expect(setup({ configured: "pw" }).auth.verify(outcome.token)).toBe(false);
  });

  it("keeps one verifier for a configured password, so its salt is stable", () => {
    // Re-hashing on every boot salts anew, and anything derived from the
    // verifier — including which password a cookie was issued for — moved with
    // it. Reusing the stored one is what makes a session outlive a restart.
    const first = setup({ configured: "pw" });
    const second = setup({ configured: "pw", stored: first.storedHash() });

    expect(second.storedHash()).toBe(first.storedHash());
    expect(second.auth.login("pw").ok).toBe(true);
  });

  it("replaces the verifier when the configured password no longer matches it", () => {
    const first = setup({ configured: "old" });
    const second = setup({ configured: "new", stored: first.storedHash() });

    expect(second.storedHash()).not.toBe(first.storedHash());
    expect(second.auth.login("new").ok).toBe(true);
    expect(second.auth.login("old").ok).toBe(false);
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
