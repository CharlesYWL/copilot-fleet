import { afterEach, describe, expect, it } from "vitest";
import { OperatorPasswordSchema } from "@fleet/protocol";
import { verifyPassword } from "../auth.js";
import { FleetStore } from "../store.js";
import { FleetAuth } from "./service.js";
import { MICROSOFT_CORP_TENANT_ID } from "./entra.js";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(
  overrides: {
    configuredPassword?: string | undefined;
    store?: FleetStore;
  } = {},
) {
  const store = overrides.store ?? new FleetStore(":memory:");
  if (!overrides.store) stores.push(store);
  const announced: string[] = [];
  const warnings: string[] = [];
  const revoked: string[] = [];
  const auth = new FleetAuth({
    store,
    configuredPassword: overrides.configuredPassword,
    announceClaimCode: (code) => announced.push(code),
    warn: (message) => warnings.push(message),
    externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
    onSessionsRevoked: (sessions) => {
      for (const session of sessions) revoked.push(session.tokenHash);
    },
  });
  return { auth, store, announced, warnings, revoked };
}

describe("FleetAuth", () => {
  describe("Agency staff eligibility", () => {
    it.each([
      ["alias@microsoft.com", MICROSOFT_CORP_TENANT_ID, true],
      [" Alias@MICROSOFT.COM ", MICROSOFT_CORP_TENANT_ID.toUpperCase(), true],
      ["alias@outlook.com", MICROSOFT_CORP_TENANT_ID, false],
      ["alias@example.com", MICROSOFT_CORP_TENANT_ID, false],
      ["alias@microosft.com", MICROSOFT_CORP_TENANT_ID, false],
      ["alias@notmicrosoft.com", MICROSOFT_CORP_TENANT_ID, false],
      ["alias@microsoft.com.example.com", MICROSOFT_CORP_TENANT_ID, false],
      [
        "alias_microsoft.com#EXT#@example.onmicrosoft.com",
        MICROSOFT_CORP_TENANT_ID,
        false,
      ],
      ["alias@example.com@microsoft.com", MICROSOFT_CORP_TENANT_ID, false],
      ["@microsoft.com", MICROSOFT_CORP_TENANT_ID, false],
      ["", MICROSOFT_CORP_TENANT_ID, false],
      ["alias@microsoft.com", "9188040d-6c67-4c5b-b112-36a304b66dad", false],
      ["alias@microsoft.com", "11111111-2222-3333-4444-555555555555", false],
    ] as const)(
      "checks verified tenant and exact domain for %s in %s",
      (username, tenantId, expected) => {
        const { auth, store } = setup();
        const administrator = store.insertAdministrator({
          tenantId,
          objectId: "staff",
          username,
          displayName: "Staff",
          addedVia: "claim",
        });
        const issued = auth.sessions.issue({
          administratorId: administrator.id,
          authMethod: "microsoft-code",
        });
        expect(auth.agencyAvailableFor(auth.verifySession(issued.token))).toBe(expected);
      },
    );

    it.each([
      ["microsoft-code", true],
      ["microsoft-device", true],
      ["password", false],
      ["recovery", false],
    ] as const)(
      "requires a corporate sign-in, not just a linked administrator (%s)",
      (authMethod, expected) => {
        const { auth, store } = setup();
        const administrator = store.insertAdministrator({
          tenantId: MICROSOFT_CORP_TENANT_ID,
          objectId: "staff",
          username: "alias@microsoft.com",
          displayName: "Staff",
          addedVia: "claim",
        });
        const issued = auth.sessions.issue({
          administratorId: administrator.id,
          authMethod,
        });
        expect(auth.agencyAvailableFor(auth.verifySession(issued.token))).toBe(expected);
      },
    );

    it("fails closed without a current administrator or signed-in session", () => {
      const { auth, store } = setup();
      expect(auth.agencyAvailableFor(undefined)).toBe(false);
      const administrator = store.insertAdministrator({
        tenantId: MICROSOFT_CORP_TENANT_ID,
        objectId: "staff",
        username: "alias@microsoft.com",
        displayName: "Staff",
        addedVia: "claim",
      });
      const issued = auth.sessions.issue({
        administratorId: administrator.id,
        authMethod: "microsoft-code",
      });
      const session = auth.verifySession(issued.token);
      expect(auth.agencyAvailableFor(session)).toBe(true);
      store.insertAdministrator({
        tenantId: MICROSOFT_CORP_TENANT_ID,
        objectId: "remaining-administrator",
        username: "remaining@microsoft.com",
        displayName: "Remaining administrator",
        addedVia: "invitation",
      });
      expect(auth.removeAdministrator(administrator.id)).toBe(true);
      expect(auth.agencyAvailableFor(session)).toBe(false);
    });
  });

  it("prints a claim code on an unclaimed Host and generates no password", () => {
    const { auth, announced, store } = setup();
    expect(announced).toHaveLength(1);
    expect(auth.state()).toBe("entra-unconfigured");
    expect(auth.passwordEnabled()).toBe(false);
    expect(store.getSetting("auth.operatorPassword")).toBe("");
  });

  it("keeps password mode across a restart without the environment", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    setup({ store, configuredPassword: "from-env" });
    // A second boot with the variable gone: the verifier was persisted, so the
    // Host does not silently lock its operator out mid-migration.
    const restarted = setup({ store });
    expect(restarted.auth.passwordEnabled()).toBe(true);
    expect(restarted.auth.state()).toBe("legacy-password");
  });

  it("does not resurrect a password that was explicitly disabled", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    const first = setup({ store, configuredPassword: "from-env" });
    first.auth.disablePassword();

    const restarted = setup({ store, configuredPassword: "from-env" });
    expect(restarted.auth.passwordEnabled()).toBe(false);
    expect(restarted.warnings.join(" ")).toContain("FLEET_OPERATOR_PASSWORD");
    expect(restarted.auth.passwordLogin("from-env", "localhost:8787")).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("ends every password session when the password is turned off", () => {
    const { auth, revoked } = setup({ configuredPassword: "pw" });
    const signedIn = auth.passwordLogin("pw", "localhost:8787");
    if (!signedIn.ok) throw new Error("expected the password to be accepted");

    auth.disablePassword();

    expect(revoked).toContain(signedIn.session.tokenHash);
    expect(auth.verifySession(signedIn.session.token)).toBeUndefined();
  });

  it("lets an administrator explicitly enable a new password", () => {
    const { auth, store } = setup();
    store.insertAdministrator({
      tenantId: "t",
      objectId: "admin",
      username: "a@example.com",
      displayName: "A",
      addedVia: "claim",
    });

    auth.enablePassword("A-new-operator-password", "admin");

    expect(auth.state()).toBe("hybrid");
    expect(auth.passwordEnabled()).toBe(true);
    expect(auth.passwordLogin("A-new-operator-password", "localhost:8787").ok).toBe(true);
  });

  it("retires a legacy password when a claimed Host restarts", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    setup({ store, configuredPassword: "legacy-password" });
    store.insertAdministrator({
      tenantId: "t",
      objectId: "admin",
      username: "a@example.com",
      displayName: "A",
      addedVia: "claim",
    });

    const restarted = setup({ store, configuredPassword: "legacy-password" });

    expect(restarted.auth.state()).toBe("microsoft-only");
    expect(restarted.auth.passwordEnabled()).toBe(false);
  });

  it("keeps a password that an administrator explicitly enabled", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    store.insertAdministrator({
      tenantId: "t",
      objectId: "admin",
      username: "a@example.com",
      displayName: "A",
      addedVia: "claim",
    });
    const first = setup({ store });
    first.auth.enablePassword("A-new-operator-password", "admin");

    const restarted = setup({ store, configuredPassword: "stale-env-password" });

    expect(restarted.auth.state()).toBe("hybrid");
    expect(
      restarted.auth.passwordLogin("A-new-operator-password", "localhost:8787").ok,
    ).toBe(true);
  });

  it("refuses a password sign-in over a known plain-HTTP relay", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    const announced: string[] = [];
    const auth = new FleetAuth({
      store,
      configuredPassword: "pw",
      announceClaimCode: (code) => announced.push(code),
      warn: () => {},
      externalScheme: {
        publicUrl: () => undefined,
        tunnels: () => [{ provider: "bore", url: "http://bore.pub:45871" }],
      },
    });
    expect(auth.passwordLogin("pw", "bore.pub:45871")).toMatchObject({
      ok: false,
      status: 403,
    });
    // The same credential over loopback is fine: the refusal is about the
    // endpoint, not the password.
    expect(auth.passwordLogin("pw", "localhost:8787").ok).toBe(true);
  });

  it("names a temporary local recovery password as its own state", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    const { auth } = setup({ store });
    store.insertAdministrator({
      tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      objectId: "admin",
      username: "a@example.com",
      displayName: "A",
      addedVia: "claim",
    });
    expect(auth.state()).toBe("microsoft-only");

    const password = auth.enableRecoveryPassword();

    expect(OperatorPasswordSchema.safeParse(password).success).toBe(true);
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(auth.state()).toBe("recovery");
    expect(
      verifyPassword(password, store.getSetting("auth.operatorPassword") ?? ""),
    ).toBe(true);
    expect(auth.passwordLogin(password, "localhost:8787").ok).toBe(true);
    expect(
      store
        .listSecurityAudit(10)
        .some((row) => row.eventType === "recovery_password_enabled"),
    ).toBe(true);

    auth.disablePassword();
    expect(auth.state()).toBe("microsoft-only");
  });

  it("enforces the new-password rules before writing a verifier", () => {
    const { auth, store } = setup();
    for (const password of [
      "short",
      "lowercase-only-password",
      "UppercaseNoSpecial123",
    ]) {
      expect(() => auth.enablePassword(password, "admin")).toThrow();
      expect(auth.passwordEnabled()).toBe(false);
      expect(store.getSetting("auth.operatorPassword")).toBe("");
    }
    auth.enablePassword("Abcdefghij!1", "admin");
    expect(auth.passwordLogin("Abcdefghij!1", "localhost:8787").ok).toBe(true);
  });

  it("stops honouring a session whose administrator was removed", () => {
    const { auth, store } = setup();
    const kept = store.insertAdministrator({
      tenantId: "t",
      objectId: "kept",
      username: "",
      displayName: "",
      addedVia: "claim",
    });
    const removed = store.insertAdministrator({
      tenantId: "t",
      objectId: "removed",
      username: "",
      displayName: "",
      addedVia: "invitation",
    });
    const session = auth.sessions.issue({
      administratorId: removed.id,
      authMethod: "microsoft-code",
    });
    const live = auth.verifySession(session.token);
    if (!live) throw new Error("expected a live session");
    expect(auth.sessionStillAuthorized(live)).toBe(true);

    auth.removeAdministrator(removed.id);

    expect(auth.verifySession(session.token)).toBeUndefined();
    expect(auth.listAdministrators().map((row) => row.id)).toEqual([kept.id]);
  });

  it("will not treat a password session as a Microsoft administrator", () => {
    const { auth } = setup({ configuredPassword: "pw" });
    const signedIn = auth.passwordLogin("pw", "localhost:8787");
    if (!signedIn.ok) throw new Error("expected the password to be accepted");
    const live = auth.verifySession(signedIn.session.token);
    if (!live) throw new Error("expected a live session");

    expect(auth.administratorFor(live)).toBeUndefined();
    // High-impact settings need an authorization-code login, which a shared
    // password is not and cannot become.
    expect(auth.requireRecentReauth(live)).toBe(false);
  });
});
