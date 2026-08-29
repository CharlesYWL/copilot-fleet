import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../auth.js";
import { deriveAuthState, resolvePasswordMode } from "./state.js";

/**
 * Which of the six ownership states a Host is in decides what it will answer at
 * all, so the derivation is asserted directly rather than inferred from the
 * routes that branch on it.
 */
describe("deriveAuthState", () => {
  const base = {
    administrators: 0,
    passwordEnabled: false,
    entraConfigured: false,
    recoveryPassword: false,
  };

  it("starts a fresh Host with nowhere to go but configuration", () => {
    expect(deriveAuthState(base)).toBe("entra-unconfigured");
  });

  it("moves to unclaimed once Entra is configured and nobody owns it", () => {
    expect(deriveAuthState({ ...base, entraConfigured: true })).toBe("unclaimed");
  });

  it("names an upgraded password-only Host legacy-password", () => {
    expect(deriveAuthState({ ...base, passwordEnabled: true })).toBe("legacy-password");
    // Configuration alone does not claim it, so the password still rules.
    expect(
      deriveAuthState({ ...base, passwordEnabled: true, entraConfigured: true }),
    ).toBe("legacy-password");
  });

  it("is hybrid while administrators and a password both work", () => {
    expect(
      deriveAuthState({
        ...base,
        administrators: 1,
        passwordEnabled: true,
        entraConfigured: true,
      }),
    ).toBe("hybrid");
  });

  it("is microsoft-only once the password is gone", () => {
    expect(deriveAuthState({ ...base, administrators: 2, entraConfigured: true })).toBe(
      "microsoft-only",
    );
  });

  it("reports recovery ahead of hybrid, because the password is temporary", () => {
    expect(
      deriveAuthState({
        ...base,
        administrators: 1,
        passwordEnabled: true,
        entraConfigured: true,
        recoveryPassword: true,
      }),
    ).toBe("recovery");
  });

  it("does not let a recovery flag invent administrators", () => {
    // A recovery password on an unclaimed Host is still just a password.
    expect(
      deriveAuthState({ ...base, passwordEnabled: true, recoveryPassword: true }),
    ).toBe("legacy-password");
  });
});

/**
 * The precedence rules, in the order the design fixes them. Each one exists
 * because the alternative silently re-enables a password somebody disabled.
 */
describe("resolvePasswordMode", () => {
  it("generates nothing for a fresh Host, which is the whole point", () => {
    const mode = resolvePasswordMode({
      persistedEnabled: undefined,
      storedHash: undefined,
      configuredPassword: undefined,
    });
    expect(mode.enabled).toBe(false);
    expect(mode.hash).toBeUndefined();
    expect(mode.source).toBe("none");
  });

  it("lets a stale environment password be overruled by an explicit disable", () => {
    const mode = resolvePasswordMode({
      persistedEnabled: false,
      storedHash: hashPassword("old"),
      configuredPassword: "still-in-the-env",
    });
    expect(mode.enabled).toBe(false);
    expect(mode.hash).toBeUndefined();
    expect(mode.source).toBe("disabled");
    expect(mode.warning).toContain("FLEET_OPERATOR_PASSWORD");
  });

  it("keeps an upgraded Host signing in with the verifier it already had", () => {
    const stored = hashPassword("from-db");
    const mode = resolvePasswordMode({
      persistedEnabled: undefined,
      storedHash: stored,
      configuredPassword: undefined,
    });
    expect(mode.enabled).toBe(true);
    expect(mode.hash).toBe(stored);
    expect(mode.source).toBe("migrated");
  });

  it("treats a configured password on a fresh Host as an opt-in, and says so", () => {
    const mode = resolvePasswordMode({
      persistedEnabled: undefined,
      storedHash: undefined,
      configuredPassword: "opt-in",
    });
    expect(mode.enabled).toBe(true);
    expect(mode.source).toBe("configured");
    expect(verifyPassword("opt-in", mode.hash ?? "")).toBe(true);
    expect(mode.warning).toContain("FLEET_OPERATOR_PASSWORD");
  });

  it("reuses a matching verifier so its salt, and any session, survives", () => {
    const stored = hashPassword("same");
    const mode = resolvePasswordMode({
      persistedEnabled: true,
      storedHash: stored,
      configuredPassword: "same",
    });
    expect(mode.hash).toBe(stored);
    expect(mode.warning).toBeUndefined();
  });

  it("replaces a verifier the configured password no longer matches", () => {
    const stored = hashPassword("old");
    const mode = resolvePasswordMode({
      persistedEnabled: true,
      storedHash: stored,
      configuredPassword: "new",
    });
    expect(mode.hash).not.toBe(stored);
    expect(verifyPassword("new", mode.hash ?? "")).toBe(true);
    expect(verifyPassword("old", mode.hash ?? "")).toBe(false);
  });

  it("honours an explicit enable that has a verifier but no environment value", () => {
    const stored = hashPassword("recovered");
    const mode = resolvePasswordMode({
      persistedEnabled: true,
      storedHash: stored,
      configuredPassword: undefined,
    });
    expect(mode.enabled).toBe(true);
    expect(mode.source).toBe("stored");
  });

  it("stays disabled when an enable was recorded but the verifier is gone", () => {
    // Disabling deletes the verifier; a leftover flag must not resurrect it as
    // an unauthenticated hole.
    const mode = resolvePasswordMode({
      persistedEnabled: true,
      storedHash: undefined,
      configuredPassword: undefined,
    });
    expect(mode.enabled).toBe(false);
    expect(mode.source).toBe("none");
  });
});
