import { afterEach, describe, expect, it } from "vitest";
import { MUTUAL_AUTH_PROTOCOL } from "@fleet/protocol";
import { createIdentityKeyPair } from "@fleet/protocol/node-auth";
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

const registration = {
  name: "alpha",
  os: "linux",
  arch: "x64",
  version: "0.3.0",
  revision: "abc1234",
  capabilities: ["copilot-acp"],
  agents: [],
  maxSessions: 2,
  homeDir: "/home/alpha",
};

function keyed(store: FleetStore, name = "alpha") {
  const identity = createIdentityKeyPair();
  const node = store.registerNodeWithKey({
    ...registration,
    name,
    publicKey: identity.publicKey,
  });
  return { identity, node };
}

/**
 * A Node's row is what the gateway checks a connection against, so what it
 * records about authentication has to be exact: which protocol this machine
 * speaks, and — for the new one — the single public key it may prove itself
 * with.
 */
describe("node authentication records", () => {
  it("registers a Node against the exact public key it enrolled with", () => {
    const store = setup();
    const { identity, node } = keyed(store);

    expect(node.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    expect(store.nodePublicKey(node.id)).toBe(identity.publicKey);
    // No reusable secret is minted for a key-based Node, so there is nothing
    // for the old hello path to accept.
    expect(store.authenticateNode(node.id, "")).toBe(false);
  });

  it("still registers a legacy Node with a shared secret", () => {
    const store = setup();
    const { node, secret } = store.registerNode(registration);

    expect(node.authProtocol).toBe("legacy-secret");
    expect(store.authenticateNode(node.id, secret)).toBe(true);
    expect(store.nodePublicKey(node.id)).toBe("");
  });

  /**
   * The migration that is left.
   *
   * A legacy machine cannot be upgraded over its own connection — the secret
   * that authenticated it has already reached whatever relayed it — so it runs
   * a fresh Connect command instead. Enrolling under the name it already holds
   * reclaims the row, which is what keeps its id, its placements and its
   * session history while replacing the credential.
   */
  it("migrates a legacy Node by reclaiming its row against a key", () => {
    const store = setup();
    const { node, secret } = store.registerNode(registration);
    const identity = createIdentityKeyPair();

    const reclaimed = store.registerNodeWithKey({
      ...registration,
      publicKey: identity.publicKey,
    });

    expect(reclaimed.id).toBe(node.id);
    expect(store.getNode(node.id)?.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    expect(store.nodePublicKey(node.id)).toBe(identity.publicKey);
    // The old secret went with the row it was written over: a credential that
    // has been disclosed must not survive the migration away from it.
    expect(store.authenticateNode(node.id, secret)).toBe(false);
  });

  it("counts a legacy Node as legacy until it has actually re-enrolled", () => {
    const store = setup();
    store.registerNode(registration);

    expect(store.nodeAuthenticationSummary()).toEqual({
      total: 1,
      mutualAuth: 0,
      legacy: 1,
    });

    store.registerNodeWithKey({
      ...registration,
      publicKey: createIdentityKeyPair().publicKey,
    });
    expect(store.nodeAuthenticationSummary()).toEqual({
      total: 1,
      mutualAuth: 1,
      legacy: 0,
    });
  });

  it("refuses a key-based registration with no key at all", () => {
    const store = setup();
    expect(() => store.registerNodeWithKey({ ...registration, publicKey: "" })).toThrow(
      /public key/i,
    );
  });

  /**
   * The last step of the migration, and the one that makes it irreversible.
   *
   * While both proofs exist, a Node that is rolled back can still get in — and
   * so can anything that learned the secret. Enforcement is the operator saying
   * that is over, so the weaker proof has to actually go.
   */
  it("deletes the shared secrets of Nodes that no longer need them", () => {
    const store = setup();
    const upgraded = store.registerNode({ ...registration, name: "upgraded" });
    // A machine that re-enrolled through a Connect command, which is the only
    // way a row moves off `legacy-secret`.
    const key = createIdentityKeyPair();
    store.registerNodeWithKey({
      ...registration,
      name: "upgraded",
      publicKey: key.publicKey,
    });
    const enrolled = keyed(store, "enrolled");
    const stillLegacy = store.registerNode({ ...registration, name: "legacy" });

    // The reclaim already cleared this one's secret, so there is nothing left
    // for enforcement to delete.
    expect(store.clearLegacyNodeSecrets()).toBe(0);
    expect(store.authenticateNode(upgraded.node.id, upgraded.secret)).toBe(false);
    expect(store.nodePublicKey(upgraded.node.id)).toBe(key.publicKey);
    expect(store.nodePublicKey(enrolled.node.id)).toBe(enrolled.identity.publicKey);
    // A machine that has not upgraded keeps the only proof it has; enforcement
    // refuses it at the gateway rather than by making it unauthenticatable.
    expect(store.authenticateNode(stillLegacy.node.id, stillLegacy.secret)).toBe(true);
  });

  it("reclaims a name a key-based Node already holds, replacing its key", () => {
    const store = setup();
    const first = keyed(store);
    const second = keyed(store);

    // Re-enrolling the same machine name is how a rebuilt box keeps its
    // placements; the row's key has to become the new machine's.
    expect(second.node.id).toBe(first.node.id);
    expect(store.nodePublicKey(second.node.id)).toBe(second.identity.publicKey);
    expect(store.nodePublicKey(second.node.id)).not.toBe(first.identity.publicKey);
  });

  it("counts which Nodes still authenticate with a shared secret", () => {
    const store = setup();
    store.registerNode({ ...registration, name: "legacy" });
    keyed(store, "modern");

    expect(store.nodeAuthenticationSummary()).toEqual({
      total: 2,
      mutualAuth: 1,
      legacy: 1,
    });
  });
});

/**
 * A fleet mid-migration has both kinds of Node, and a move has to carry both or
 * the machines it did not describe come back unauthenticated.
 */
describe("node authentication in a portable backup", () => {
  function keysReady(store: FleetStore) {
    store.setSetting("auth.csrfKey", Buffer.alloc(32, 1).toString("base64"));
    store.setSetting("orchestrator.tokenKey", Buffer.alloc(32, 2).toString("base64"));
    // Legacy only, but still authority-bearing until every Node has upgraded.
    store.setSetting("enrollment.token", "legacy-fleet-token");
    store.insertAdministrator({
      tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      objectId: "object-a",
      username: "a@example.com",
      displayName: "A",
      addedVia: "claim",
    });
  }

  it("exports the protocol and public key of a key-based Node", () => {
    const store = setup();
    keysReady(store);
    const { identity, node } = keyed(store);

    const payload = store.exportSecurityBackup();
    expect(payload.nodeAuth).toEqual([
      {
        nodeId: node.id,
        authProtocol: MUTUAL_AUTH_PROTOCOL,
        secretHash: "",
        publicKey: identity.publicKey,
      },
    ]);
    // The private half is the Node's alone; nothing here could impersonate it.
    expect(JSON.stringify(payload)).not.toContain(identity.privateKey);
  });

  it("exports a legacy Node's secret hash unchanged", () => {
    const store = setup();
    keysReady(store);
    const { node } = store.registerNode(registration);

    const [record] = store.exportSecurityBackup().nodeAuth;
    expect(record?.nodeId).toBe(node.id);
    expect(record?.authProtocol).toBe("legacy-secret");
    expect(record?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.publicKey).toBe("");
  });

  it("restores both kinds so every Node reconnects on the new machine", () => {
    const store = setup();
    keysReady(store);
    const legacy = store.registerNode({ ...registration, name: "legacy" });
    const modern = keyed(store, "modern");
    const security = store.exportSecurityBackup();
    const data = {
      exportedAt: new Date().toISOString(),
      tunnel: { enabled: false, provider: "cloudflare" as const },
      defaults: { yolo: false, autoResume: true, notificationLifecycleEnabled: true },
      nodes: store.listNodes(),
      workspaces: [],
      placements: [],
      sessions: [],
      events: [],
      runs: [],
      runSteps: [],
      runNotes: [],
      notifications: [],
      notificationPreferences: [],
    };

    const target = setup();
    target.importPortableBackup({ data, security });

    expect(target.authenticateNode(legacy.node.id, legacy.secret)).toBe(true);
    expect(target.nodePublicKey(modern.node.id)).toBe(modern.identity.publicKey);
    expect(target.getNode(modern.node.id)?.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
  });

  it("refuses an archive whose key-based Node has no key to restore", () => {
    const store = setup();
    keysReady(store);
    const { node } = keyed(store);
    const security = store.exportSecurityBackup();
    const data = {
      exportedAt: new Date().toISOString(),
      tunnel: { enabled: false, provider: "cloudflare" as const },
      defaults: { yolo: false, autoResume: true, notificationLifecycleEnabled: true },
      nodes: store.listNodes(),
      workspaces: [],
      placements: [],
      sessions: [],
      events: [],
      runs: [],
      runSteps: [],
      runNotes: [],
      notifications: [],
      notificationPreferences: [],
    };

    const target = setup();
    expect(() =>
      target.importPortableBackup({
        data,
        security: {
          ...security,
          nodeAuth: [
            {
              nodeId: node.id,
              authProtocol: MUTUAL_AUTH_PROTOCOL,
              secretHash: "",
              publicKey: "",
            },
          ],
        },
      }),
    ).toThrow(/authentication record/i);
  });
});
