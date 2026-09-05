import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { FleetStore } from "../store.js";
import {
  OPERATOR_SESSION_ABSOLUTE_MS,
  OPERATOR_SESSION_IDLE_MS,
  OperatorSessions,
  RECENT_REAUTH_MS,
  csrfProof,
  hasRecentCodeReauth,
} from "./sessions.js";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(start = Date.UTC(2026, 0, 1)) {
  let now = start;
  const store = new FleetStore(":memory:");
  stores.push(store);
  const sessions = new OperatorSessions({
    store,
    csrfKey: Buffer.from("csrf-key-for-tests-only-0123456789ab"),
    now: () => now,
  });
  return {
    store,
    sessions,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

/**
 * Sessions are the credential the browser actually carries, so the properties
 * that make a stolen cookie survivable — server-side storage, revocation, and
 * two independent clocks — are asserted rather than assumed.
 */
describe("OperatorSessions", () => {
  it("hands the browser a value the database never stores", () => {
    const { sessions, store } = setup();
    const issued = sessions.issue({ administratorId: "", authMethod: "password" });
    expect(issued.token.length).toBeGreaterThanOrEqual(32);
    expect(store.getOperatorSession(issued.token)).toBeUndefined();
    expect(
      store.getOperatorSession(createHash("sha256").update(issued.token).digest("hex")),
    ).toBeDefined();
  });

  it("verifies a token it issued and refuses anything else", () => {
    const { sessions } = setup();
    const issued = sessions.issue({ administratorId: "", authMethod: "password" });
    expect(sessions.verify(issued.token)).toMatchObject({ authMethod: "password" });
    expect(sessions.verify(`${issued.token}x`)).toBeUndefined();
    expect(sessions.verify("")).toBeUndefined();
    expect(sessions.verify(undefined)).toBeUndefined();
  });

  it("survives a Host restart, because the row outlives the process", () => {
    const { sessions, store } = setup();
    const issued = sessions.issue({ administratorId: "", authMethod: "password" });
    const restarted = new OperatorSessions({
      store,
      csrfKey: Buffer.from("csrf-key-for-tests-only-0123456789ab"),
      now: () => Date.UTC(2026, 0, 1),
    });
    expect(restarted.verify(issued.token)).toBeDefined();
  });

  it("refuses a session issued by another Host", () => {
    const first = setup();
    const second = setup();
    const issued = first.sessions.issue({ administratorId: "", authMethod: "password" });
    expect(second.sessions.verify(issued.token)).toBeUndefined();
  });

  it("lets an idle session lapse after seven days", () => {
    const { sessions, store, advance, at } = setup();
    const issued = sessions.issue({ administratorId: "", authMethod: "password" });
    const originalLastSeen = store.getOperatorSession(issued.tokenHash)?.lastSeenAt;
    advance(OPERATOR_SESSION_IDLE_MS - 1);
    expect(sessions.inspect(issued.tokenHash)).toBeDefined();
    expect(store.getOperatorSession(issued.tokenHash)?.lastSeenAt).toBe(originalLastSeen);
    expect(sessions.verify(issued.token)).toBeDefined();
    expect(store.getOperatorSession(issued.tokenHash)?.lastSeenAt).toBe(
      new Date(at()).toISOString(),
    );
    // Verifying just now moved the idle clock, so another almost-seven days is
    // still fine — that is what "idle" means.
    advance(OPERATOR_SESSION_IDLE_MS - 1);
    expect(sessions.verify(issued.token)).toBeDefined();
    advance(OPERATOR_SESSION_IDLE_MS + 1);
    expect(sessions.inspect(issued.tokenHash)).toBeUndefined();
    expect(sessions.verify(issued.token)).toBeUndefined();
  });

  it.each(["expiresAt", "lastSeenAt"] as const)(
    "refuses invalid %s in both session verification paths without touching the row",
    (field) => {
      const { sessions, store, at } = setup();
      const tokenHash = createHash("sha256").update("invalid-clock").digest("hex");
      const row = {
        tokenHash,
        administratorId: "",
        authMethod: "password" as const,
        authenticatedAt: new Date(at()).toISOString(),
        lastSeenAt: new Date(at()).toISOString(),
        expiresAt: new Date(at() + OPERATOR_SESSION_ABSOLUTE_MS).toISOString(),
        [field]: "invalid",
      };
      store.insertOperatorSession(row);

      expect(sessions.inspect(tokenHash)).toBeUndefined();
      expect(sessions.verify("invalid-clock")).toBeUndefined();
      expect(store.getOperatorSession(tokenHash)?.lastSeenAt).toBe(row.lastSeenAt);
    },
  );

  it("ends a session at thirty days however busy it was", () => {
    const { sessions, advance } = setup();
    const issued = sessions.issue({ administratorId: "", authMethod: "password" });
    for (let day = 0; day < 30; day += 1) {
      advance(24 * 60 * 60 * 1000);
      sessions.verify(issued.token);
    }
    advance(1);
    expect(sessions.verify(issued.token)).toBeUndefined();
    expect(OPERATOR_SESSION_ABSOLUTE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("revokes one session without touching another", () => {
    const { sessions } = setup();
    const first = sessions.issue({ administratorId: "", authMethod: "password" });
    const second = sessions.issue({ administratorId: "", authMethod: "password" });
    sessions.revoke(first.token);
    expect(sessions.inspect(first.tokenHash)).toBeUndefined();
    expect(sessions.verify(first.token)).toBeUndefined();
    expect(sessions.verify(second.token)).toBeDefined();
  });

  it("revokes every session an administrator holds, in one call", () => {
    const { sessions, store } = setup();
    const admin = store.insertAdministrator({
      tenantId: "t",
      objectId: "o",
      username: "a@example.com",
      displayName: "A",
      addedVia: "claim",
    });
    const first = sessions.issue({
      administratorId: admin.id,
      authMethod: "microsoft-code",
    });
    const second = sessions.issue({
      administratorId: admin.id,
      authMethod: "microsoft-code",
    });
    const other = sessions.issue({ administratorId: "", authMethod: "password" });

    const closed = sessions.revokeForAdministrator(admin.id);

    expect(closed.map((row) => row.tokenHash).sort()).toEqual(
      [first.tokenHash, second.tokenHash].sort(),
    );
    expect(sessions.verify(first.token)).toBeUndefined();
    expect(sessions.verify(second.token)).toBeUndefined();
    expect(sessions.verify(other.token)).toBeDefined();
  });

  it("revokes password sessions when the password is disabled", () => {
    const { sessions, store } = setup();
    const admin = store.insertAdministrator({
      tenantId: "t",
      objectId: "o",
      username: "",
      displayName: "",
      addedVia: "claim",
    });
    const legacy = sessions.issue({ administratorId: "", authMethod: "password" });
    const microsoft = sessions.issue({
      administratorId: admin.id,
      authMethod: "microsoft-code",
    });

    sessions.revokeByMethod("password");

    expect(sessions.verify(legacy.token)).toBeUndefined();
    expect(sessions.verify(microsoft.token)).toBeDefined();
  });
});

describe("CSRF proof", () => {
  it("derives from the session hash rather than storing a second secret", () => {
    const key = Buffer.from("csrf-key");
    const hash = createHash("sha256").update("token").digest("hex");
    expect(csrfProof(key, hash)).toBe(csrfProof(key, hash));
    expect(csrfProof(key, hash)).not.toBe(csrfProof(key, `${hash}0`));
    expect(csrfProof(Buffer.from("other"), hash)).not.toBe(csrfProof(key, hash));
    // The proof must not be the session, or handing it to a script would hand
    // over the session too.
    expect(csrfProof(key, hash)).not.toContain(hash);
  });

  it("is checked in constant time and refuses a wrong or absent value", () => {
    const { sessions } = setup();
    const issued = sessions.issue({ administratorId: "", authMethod: "password" });
    const proof = sessions.csrfToken(issued.tokenHash);
    expect(sessions.verifyCsrf(issued.tokenHash, proof)).toBe(true);
    expect(sessions.verifyCsrf(issued.tokenHash, `${proof}x`)).toBe(false);
    expect(sessions.verifyCsrf(issued.tokenHash, undefined)).toBe(false);
    expect(sessions.verifyCsrf(issued.tokenHash, "")).toBe(false);
  });
});

describe("recent reauthentication", () => {
  it("accepts only a fresh authorization-code sign-in", () => {
    const at = Date.UTC(2026, 0, 1);
    const code = { authMethod: "microsoft-code" as const, authenticatedAt: at };
    expect(hasRecentCodeReauth(code, at + RECENT_REAUTH_MS - 1)).toBe(true);
    expect(hasRecentCodeReauth(code, at + RECENT_REAUTH_MS + 1)).toBe(false);
  });

  it("refuses device and password sign-ins for high-impact actions", () => {
    const at = Date.UTC(2026, 0, 1);
    expect(
      hasRecentCodeReauth({ authMethod: "microsoft-device", authenticatedAt: at }, at),
    ).toBe(false);
    expect(hasRecentCodeReauth({ authMethod: "password", authenticatedAt: at }, at)).toBe(
      false,
    );
  });
});

describe("cleanup", () => {
  it("does not keep expired rows forever", () => {
    const { sessions, store, advance } = setup();
    sessions.issue({ administratorId: "", authMethod: "password" });
    advance(OPERATOR_SESSION_ABSOLUTE_MS + 1);
    expect(sessions.pruneExpired()).toBe(1);
    expect(store.countOperatorSessions()).toBe(0);
  });
});
