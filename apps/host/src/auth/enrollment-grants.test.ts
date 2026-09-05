import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnrollmentGrant } from "@fleet/protocol";
import { ENROLLMENT_GRANT_TTL_MS, EnrollmentGrants } from "./enrollment-grants.js";
import { FleetStore } from "../store.js";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(now = () => 1_700_000_000_000) {
  const store = new FleetStore(":memory:");
  stores.push(store);
  const admin = store.insertAdministrator({
    tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    objectId: "object-a",
    username: "a@example.com",
    displayName: "A",
    addedVia: "claim",
  });
  return { store, admin, grants: new EnrollmentGrants({ store, now }) };
}

/**
 * A grant is the whole authorisation for a new machine to join the fleet, so
 * the properties below are the feature: one Node, fifteen minutes, one use, and
 * a database that holds nothing anybody could enrol with.
 */
describe("enrollment grants", () => {
  it("issues 256 bits of secret and stores only its digest", () => {
    const { store, admin, grants } = setup();
    const issued = grants.create(admin.id);
    const parts = parseEnrollmentGrant(issued.grant);

    expect(parts).toBeDefined();
    expect(parts?.id).toBe(issued.id);
    expect(Buffer.from(parts?.secret ?? "", "base64url")).toHaveLength(32);

    const stored = store.getEnrollmentGrant(issued.id);
    expect(stored?.tokenHash).toBe(
      createHash("sha256")
        .update(parts?.secret ?? "")
        .digest("hex"),
    );
    // Nothing in the row reproduces the secret.
    expect(JSON.stringify(stored)).not.toContain(parts?.secret ?? "unreachable");
  });

  it("expires fifteen minutes after it was created", () => {
    let clock = 1_700_000_000_000;
    const { admin, grants } = setup(() => clock);
    const issued = grants.create(admin.id);
    expect(new Date(issued.expiresAt).getTime()).toBe(clock + ENROLLMENT_GRANT_TTL_MS);

    clock += ENROLLMENT_GRANT_TTL_MS - 1;
    expect(grants.live(issued.id)).toBeDefined();
    clock += 2;
    expect(grants.live(issued.id)).toBeUndefined();
  });

  it("is spent by the first Node to complete with it", () => {
    const { admin, grants } = setup();
    const issued = grants.create(admin.id);

    expect(grants.consume(issued.id, "node-1")).toBe(true);
    expect(grants.consume(issued.id, "node-2")).toBe(false);
    expect(grants.live(issued.id)).toBeUndefined();
  });

  it("does not exist for an id nobody issued", () => {
    const { grants } = setup();
    expect(grants.live("made-up")).toBeUndefined();
    expect(grants.consume("made-up", "node-1")).toBe(false);
  });

  it("records who created it, which is the audit trail for a joined machine", () => {
    const { admin, grants, store } = setup();
    const issued = grants.create(admin.id);
    expect(store.getEnrollmentGrant(issued.id)?.createdByAdminId).toBe(admin.id);
  });
});

/**
 * A grant is authority to add a machine to the fleet. Moving one between Hosts
 * would mean a Connect command that outlives the Host it was printed by.
 */
describe("grants and backups", () => {
  it("is absent from the exported security envelope", () => {
    const { admin, grants, store } = setup();
    const issued = grants.create(admin.id);
    store.setSetting("auth.csrfKey", Buffer.alloc(32, 1).toString("base64"));
    store.setSetting("orchestrator.tokenKey", Buffer.alloc(32, 2).toString("base64"));
    store.setSetting("enrollment.token", "legacy-fleet-token");

    const payload = store.exportSecurityBackup();
    expect(JSON.stringify(payload)).not.toContain(issued.id);
    expect("enrollmentGrants" in payload).toBe(false);
  });

  it("is cleared by a portable restore rather than carried into the new Host", () => {
    const { admin, grants, store } = setup();
    const issued = grants.create(admin.id);
    store.setSetting("auth.csrfKey", Buffer.alloc(32, 1).toString("base64"));
    store.setSetting("orchestrator.tokenKey", Buffer.alloc(32, 2).toString("base64"));
    store.setSetting("enrollment.token", "legacy-fleet-token");
    const security = store.exportSecurityBackup();

    store.importPortableBackup({
      data: {
        exportedAt: new Date().toISOString(),
        tunnel: { enabled: false, provider: "cloudflare" },
        defaults: {
          yolo: false,
          autoResume: true,
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
      security: { ...security, administrators: security.administrators },
    });

    expect(store.getEnrollmentGrant(issued.id)).toBeUndefined();
    expect(admin.id).toBeTruthy();
  });
});
