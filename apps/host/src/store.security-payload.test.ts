import { afterEach, describe, expect, it } from "vitest";
import { SecurityBackupPayloadSchema } from "@fleet/protocol";
import { FleetStore } from "./store.js";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(): FleetStore {
  const store = new FleetStore(":memory:");
  stores.push(store);
  // Both keys are written on the first boot that needs one; an archive missing
  // either restores a Host whose sessions cannot be verified.
  store.setSetting("auth.csrfKey", Buffer.alloc(32, 7).toString("base64"));
  store.setSetting("orchestrator.tokenKey", Buffer.alloc(32, 9).toString("base64"));
  return store;
}

const administrator = {
  tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
  objectId: "alice-object-id",
  username: "alice@example.com",
  displayName: "Alice",
  addedVia: "claim",
};

/**
 * Enforcement is a security decision, so it belongs in the sealed half.
 *
 * "This fleet no longer accepts a shared Node secret" is exactly as much a part
 * of who may talk to a Host as the administrator table is. An archive that left
 * it behind would restore a fleet that quietly went back to accepting the
 * credential its operator had retired — and would bring the fleet-wide
 * enrollment token back with it.
 */
describe("the sealed security payload", () => {
  it("carries whether mutual Node authentication is required", () => {
    const store = setup();
    store.insertAdministrator(administrator);
    store.setMutualNodeAuthenticationRequired(true);

    const payload = store.exportSecurityBackup();
    expect(payload.node.mutualAuthenticationRequired).toBe(true);
    // Parsing it back is what proves the field is part of the format rather
    // than an extra property a strict schema would drop.
    expect(
      SecurityBackupPayloadSchema.parse(payload).node.mutualAuthenticationRequired,
    ).toBe(true);
  });

  it("defaults to not enforced for an archive written before the field existed", () => {
    const parsed = SecurityBackupPayloadSchema.parse({
      version: 1,
      auth: {
        passwordEnabled: false,
        csrfKey: Buffer.alloc(32, 7).toString("base64"),
      },
      leadTokenKey: Buffer.alloc(32, 9).toString("base64"),
      administrators: [],
    });
    expect(parsed.node.mutualAuthenticationRequired).toBe(false);
    expect(parsed.enrollmentToken).toBe("");
  });

  /*
   * A fresh Host has no fleet-wide token to carry. Requiring one would make the
   * grant-only install the one configuration that cannot be backed up.
   */
  it("exports a grant-only Host with no enrollment token", () => {
    const store = setup();
    store.insertAdministrator(administrator);
    expect(store.exportSecurityBackup().enrollmentToken).toBe("");
  });

  it("restores enforcement and leaves the retired token behind", () => {
    const origin = setup();
    origin.insertAdministrator(administrator);
    origin.setSetting("enrollment.token", "retired-token");
    origin.setMutualNodeAuthenticationRequired(true);
    const payload = origin.exportSecurityBackup();

    const destination = setup();
    destination.importPortableBackup({
      data: {
        exportedAt: new Date().toISOString(),
        tunnel: { enabled: false, provider: "devtunnel" },
        defaults: {
          yolo: false,
          autoResume: false,
          notificationLifecycleEnabled: true,
        },
        nodes: [],
        workspaces: [],
        placements: [],
        sessions: [],
        events: [],
        runs: [],
        runSteps: [],
        runNotes: [],
        notifications: [],
        notificationPreferences: [],
      },
      security: payload,
    });

    expect(destination.mutualNodeAuthenticationRequired()).toBe(true);
    expect(destination.getSetting("enrollment.token") ?? "").toBe("");
  });

  it("restores the token for a fleet that is still mid-migration", () => {
    const origin = setup();
    origin.insertAdministrator(administrator);
    origin.setSetting("enrollment.token", "still-needed");
    const payload = origin.exportSecurityBackup();
    expect(payload.enrollmentToken).toBe("still-needed");

    const destination = setup();
    destination.importPortableBackup({
      data: {
        exportedAt: new Date().toISOString(),
        tunnel: { enabled: false, provider: "devtunnel" },
        defaults: {
          yolo: false,
          autoResume: false,
          notificationLifecycleEnabled: true,
        },
        nodes: [],
        workspaces: [],
        placements: [],
        sessions: [],
        events: [],
        runs: [],
        runSteps: [],
        runNotes: [],
        notifications: [],
        notificationPreferences: [],
      },
      security: payload,
    });

    expect(destination.getSetting("enrollment.token")).toBe("still-needed");
    expect(destination.mutualNodeAuthenticationRequired()).toBe(false);
  });
});
