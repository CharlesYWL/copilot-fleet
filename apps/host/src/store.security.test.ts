import { afterEach, describe, expect, it } from "vitest";
import { FleetStore } from "./store.js";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new FleetStore(":memory:");
  stores.push(store);
  return store;
}

const identity = (suffix: string) => ({
  tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
  objectId: `object-${suffix}`,
  username: `${suffix}@example.com`,
  displayName: suffix,
});

/**
 * Administrator membership is the whole authorization decision, so the table
 * that holds it is asserted for the properties the design calls invariants:
 * identity is `(tid, oid)`, the first claim is atomic, and the last
 * administrator cannot be removed.
 */
describe("administrators", () => {
  it("starts with nobody, which is what makes a Host unclaimed", () => {
    const store = setup();
    expect(store.countActiveAdministrators()).toBe(0);
    expect(store.listAdministrators()).toEqual([]);
  });

  it("keys an administrator by tenant and object id, not by email", () => {
    const store = setup();
    const created = store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    expect(store.findAdministrator(created.tenantId, created.objectId)).toMatchObject({
      id: created.id,
    });
    // A renamed account is the same person; a different object id is not.
    store.insertAdministrator({
      ...identity("a"),
      username: "renamed@example.com",
      addedVia: "invitation",
    });
    expect(store.countActiveAdministrators()).toBe(1);
    expect(store.findAdministrator(created.tenantId, "object-b")).toBeUndefined();
  });

  it("lets exactly one racing claim create the first administrator", () => {
    const store = setup();
    const first = store.claimFirstAdministrator(identity("a"));
    const second = store.claimFirstAdministrator(identity("b"));
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(store.countActiveAdministrators()).toBe(1);
  });

  it("disables an administrator instead of forgetting they existed", () => {
    const store = setup();
    const one = store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    const two = store.insertAdministrator({ ...identity("b"), addedVia: "invitation" });
    expect(store.disableAdministrator(two.id)).toBe(true);
    expect(store.countActiveAdministrators()).toBe(1);
    expect(store.findAdministrator(two.tenantId, two.objectId)).toBeUndefined();
    expect(store.listAdministrators().map((row) => row.id)).toEqual([one.id]);
  });

  it("refuses to remove the last administrator, which would orphan the Host", () => {
    const store = setup();
    const only = store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    expect(store.disableAdministrator(only.id)).toBe(false);
    expect(store.countActiveAdministrators()).toBe(1);
  });

  it("reactivates a previously disabled identity rather than duplicating it", () => {
    const store = setup();
    store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    const two = store.insertAdministrator({ ...identity("b"), addedVia: "invitation" });
    store.disableAdministrator(two.id);
    const again = store.insertAdministrator({ ...identity("b"), addedVia: "invitation" });
    expect(again.id).toBe(two.id);
    expect(store.countActiveAdministrators()).toBe(2);
  });

  it("caps how many administrators one Host will hold", () => {
    const store = setup();
    for (let index = 0; index < 20; index += 1) {
      store.insertAdministrator({ ...identity(`a${index}`), addedVia: "invitation" });
    }
    expect(() =>
      store.insertAdministrator({ ...identity("overflow"), addedVia: "invitation" }),
    ).toThrow(/20/);
  });
});

describe("operator sessions", () => {
  it("revokes every session belonging to a removed administrator, atomically", () => {
    const store = setup();
    const admin = store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    const other = store.insertAdministrator({ ...identity("b"), addedVia: "invitation" });
    const at = new Date().toISOString();
    store.insertOperatorSession({
      tokenHash: "hash-a",
      administratorId: admin.id,
      authMethod: "microsoft-code",
      authenticatedAt: at,
      lastSeenAt: at,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.insertOperatorSession({
      tokenHash: "hash-b",
      administratorId: other.id,
      authMethod: "microsoft-code",
      authenticatedAt: at,
      lastSeenAt: at,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const closed = store.disableAdministratorAndRevoke(other.id);

    expect(closed).toEqual([{ tokenHash: "hash-b", administratorId: other.id }]);
    expect(store.getOperatorSession("hash-b")?.revokedAt).not.toBe("");
    expect(store.getOperatorSession("hash-a")?.revokedAt).toBe("");
  });
});

describe("administrator invitations", () => {
  it("records only a hash and consumes an invitation exactly once", () => {
    const store = setup();
    const admin = store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    const created = store.createInvitation({
      tokenHash: "invitation-hash",
      createdByAdminId: admin.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(created.id).toBeTruthy();

    const first = store.consumeInvitation("invitation-hash", identity("candidate"));
    expect(first).toMatchObject({ candidateObjectId: "object-candidate" });
    expect(store.consumeInvitation("invitation-hash", identity("other"))).toBeUndefined();
  });

  it("refuses an expired invitation without consuming it", () => {
    const store = setup();
    const admin = store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    store.createInvitation({
      tokenHash: "old",
      createdByAdminId: admin.id,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    expect(store.consumeInvitation("old", identity("candidate"))).toBeUndefined();
  });

  it("keeps a consumed invitation pending until an administrator decides", () => {
    const store = setup();
    const admin = store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    const created = store.createInvitation({
      tokenHash: "hash",
      createdByAdminId: admin.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.consumeInvitation("hash", identity("candidate"));

    expect(store.listPendingCandidates()).toHaveLength(1);
    // Redeeming granted nothing on its own; that is the point of the candidate.
    expect(store.countActiveAdministrators()).toBe(1);

    const approved = store.approveCandidate(created.id, admin.id);
    expect(approved).toMatchObject({ objectId: "object-candidate" });
    expect(store.countActiveAdministrators()).toBe(2);
    expect(store.listPendingCandidates()).toHaveLength(0);
    // A second approval must not create a second administrator.
    expect(store.approveCandidate(created.id, admin.id)).toBeUndefined();
  });

  it("rejects a candidate without ever granting access", () => {
    const store = setup();
    const admin = store.insertAdministrator({ ...identity("a"), addedVia: "claim" });
    const created = store.createInvitation({
      tokenHash: "hash",
      createdByAdminId: admin.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.consumeInvitation("hash", identity("candidate"));

    expect(store.rejectCandidate(created.id, admin.id)).toBe(true);
    expect(store.countActiveAdministrators()).toBe(1);
    expect(store.listPendingCandidates()).toHaveLength(0);
    expect(store.approveCandidate(created.id, admin.id)).toBeUndefined();
  });
});

describe("security audit", () => {
  it("keeps what happened and never the secret it happened to", () => {
    const store = setup();
    store.recordSecurityAudit({
      eventType: "bootstrap_code_rejected",
      actorKind: "anonymous",
      outcome: "denied",
      requestHost: "localhost:8787",
      detail: "wrong code",
    });
    const [entry] = store.listSecurityAudit(10);
    expect(entry).toMatchObject({
      eventType: "bootstrap_code_rejected",
      actorKind: "anonymous",
      outcome: "denied",
    });
    expect(entry?.createdAt).toBeTruthy();
  });

  it("truncates a detail rather than storing whatever a caller sent", () => {
    const store = setup();
    store.recordSecurityAudit({
      eventType: "microsoft_login_denied_not_admin",
      actorKind: "anonymous",
      outcome: "denied",
      detail: "x".repeat(5_000),
    });
    expect(store.listSecurityAudit(1)[0]?.detail.length).toBe(500);
  });

  it("keeps only the newest ten thousand rows", () => {
    const store = setup();
    for (let index = 0; index < 10_050; index += 1) {
      store.recordSecurityAudit({
        eventType: "operator_session_revoked",
        actorKind: "operator",
        outcome: "allowed",
        detail: String(index),
      });
    }
    expect(store.countSecurityAudit()).toBe(10_000);
    expect(store.listSecurityAudit(1)[0]?.detail).toBe("10049");
  });
});
