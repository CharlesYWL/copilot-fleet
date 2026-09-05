import { afterEach, describe, expect, it } from "vitest";
import { MUTUAL_AUTH_PROTOCOL } from "@fleet/protocol";
import { createIdentityKeyPair } from "@fleet/protocol/node-auth";
import { FleetStore } from "./store.js";
import type { SecurityBackupPayload } from "./auth/security-backup.js";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(): FleetStore {
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

/** A Host somebody owns: administrators, keys, and an identity of its own. */
function secured(store: FleetStore): FleetStore {
  store.insertAdministrator({ ...identity("alice"), addedVia: "claim" });
  store.setSetting("auth.mode", "microsoft-only");
  store.setSetting("auth.entraTenantId", identity("alice").tenantId);
  store.setSetting("auth.entraClientId", "11111111-2222-3333-4444-555555555555");
  store.setSetting("auth.deviceFlowEnabled", "1");
  store.setSetting("auth.csrfKey", "csrf-key-of-this-host");
  store.setSetting("auth.passwordEnabled", "1");
  store.setSetting("auth.operatorPassword", "scrypt$verifier$of$this$host");
  store.setSetting("auth.passwordIsRecovery", "0");
  store.setSetting("orchestrator.tokenKey", "lead-token-key-of-this-host");
  store.setSetting("host.identity.id", "host-identity-1");
  store.setSetting("host.identity.privateKey", "host-private-key");
  store.setSetting("host.identity.publicKey", "host-public-key");
  store.setSetting("host.identity.fingerprint", "SHA256:host");
  store.setSetting("enrollment.token", "secured-enrollment-token");
  return store;
}

function portableData(store: FleetStore) {
  const backup = store.exportHostBackup({
    enrollmentToken: store.getSetting("enrollment.token") ?? "legacy-token",
  });
  const {
    enrollmentToken: _token,
    nodes,
    kind: _kind,
    version: _version,
    ...data
  } = backup;
  return {
    ...data,
    nodes: nodes.map(({ secretHash: _secretHash, ...node }) => node),
  };
}

/** Somebody else's Fleet, as a version 1 archive. */
function foreignBackup() {
  const other = setup();
  other.registerNode({
    name: "their-box",
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    capabilities: ["copilot-acp"],
    maxSessions: 2,
  });
  other.createWorkspace("their-repo", "");
  return other.exportHostBackup({ enrollmentToken: "their-token" });
}

/** A machine that authenticates with a key pair rather than a shared secret. */
function keyedNode(store: FleetStore, name = "keyed-box") {
  const identity = createIdentityKeyPair();
  const node = store.registerNodeWithKey({
    name,
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    capabilities: ["copilot-acp"],
    maxSessions: 2,
    publicKey: identity.publicKey,
  });
  return { identity, node };
}

/**
 * A data restore is not a change of ownership.
 *
 * The archive predates the security envelope it is being restored into, and
 * knows nothing about the administrators of the Host receiving it — so
 * anything it erased would be erased on the authority of a file, which is the
 * one authority a Host must not accept for that question.
 */
describe("version 1 data restore", () => {
  it("keeps every setting that decides who owns the Host", () => {
    const store = secured(setup());

    store.replaceHostBackup(foreignBackup());

    expect(store.countActiveAdministrators()).toBe(1);
    expect(store.listAdministrators()[0]?.username).toBe("alice@example.com");
    for (const [key, value] of [
      ["auth.mode", "microsoft-only"],
      ["auth.entraClientId", "11111111-2222-3333-4444-555555555555"],
      ["auth.deviceFlowEnabled", "1"],
      ["auth.csrfKey", "csrf-key-of-this-host"],
      ["auth.passwordEnabled", "1"],
      ["auth.operatorPassword", "scrypt$verifier$of$this$host"],
      ["auth.passwordIsRecovery", "0"],
      // Erasing this one would not lock anybody out; it would silently stop
      // every running orchestrator's tools, which is the failure the signed
      // lead token exists to make impossible.
      ["orchestrator.tokenKey", "lead-token-key-of-this-host"],
      ["host.identity.id", "host-identity-1"],
      ["host.identity.privateKey", "host-private-key"],
      ["host.identity.publicKey", "host-public-key"],
      ["host.identity.fingerprint", "SHA256:host"],
    ] as const) {
      expect(store.getSetting(key), key).toBe(value);
    }
  });

  it("still replaces the catalog it is meant to replace", () => {
    const store = secured(setup());
    store.createWorkspace("ours", "");

    store.replaceHostBackup(foreignBackup());

    expect(store.listWorkspaces().map((entry) => entry.name)).toContain("their-repo");
    expect(store.listWorkspaces().map((entry) => entry.name)).not.toContain("ours");
    expect(store.listNodes().map((entry) => entry.name)).toEqual(["their-box"]);
    expect(store.getSetting("enrollment.token")).toBe("their-token");
  });
});

/**
 * A version 1 archive has no security envelope, so it carries no Node keys —
 * only the fact that a machine had one. Restoring it therefore has exactly two
 * honest outcomes for a key-based Node: keep the key this Host already holds
 * for that row, or refuse. Writing `mutual-auth-v1` over an empty public key is
 * neither: the gateway refuses every connection that machine makes afterwards,
 * so a restore that reported success silently drops it out of the fleet.
 */
describe("version 1 data restore with key-based Nodes", () => {
  it("keeps the key this Host already holds for the machine", () => {
    const store = secured(setup());
    const { identity, node } = keyedNode(store);
    const archive = store.exportHostBackup({ enrollmentToken: "our-token" });
    store.createWorkspace("added-after-the-archive", "");

    store.replaceHostBackup(archive);

    const restored = store.getNode(node.id);
    expect(restored?.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    // The one field the archive could not carry, and the only copy of it.
    expect(store.nodePublicKey(node.id)).toBe(identity.publicKey);
    expect(store.listWorkspaces().map((entry) => entry.name)).not.toContain(
      "added-after-the-archive",
    );
  });

  it("keeps each machine's own key when there are several", () => {
    const store = secured(setup());
    const first = keyedNode(store, "alpha");
    const second = keyedNode(store, "beta");
    const { node: legacy, secret } = store.registerNode({
      name: "gamma",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 2,
    });

    store.replaceHostBackup(store.exportHostBackup({ enrollmentToken: "our-token" }));

    expect(store.nodePublicKey(first.node.id)).toBe(first.identity.publicKey);
    expect(store.nodePublicKey(second.node.id)).toBe(second.identity.publicKey);
    // A shared-secret machine still comes back on the hash the archive carries.
    expect(store.nodePublicKey(legacy.id)).toBe("");
    expect(store.authenticateNode(legacy.id, secret)).toBe(true);
  });

  /*
   * Somebody else's archive, or this Host's own from before the row existed.
   * Either way the key is nowhere: not in the file, and not in this database.
   */
  it("refuses a key-based Node it has no key for, and says what to do instead", () => {
    const origin = secured(setup());
    keyedNode(origin, "their-keyed-box");
    const archive = origin.exportHostBackup({ enrollmentToken: "their-token" });

    const destination = secured(setup());
    expect(() => destination.replaceHostBackup(archive)).toThrow(
      /portable archive|re-enrol/i,
    );
  });

  it("changes nothing at all when it refuses", () => {
    const origin = secured(setup());
    keyedNode(origin, "their-keyed-box");
    const archive = origin.exportHostBackup({ enrollmentToken: "their-token" });

    const destination = secured(setup());
    destination.createWorkspace("ours", "");
    const resident = destination.registerNode({
      name: "our-box",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 2,
    });

    expect(() => destination.replaceHostBackup(archive)).toThrow();

    expect(destination.listWorkspaces().map((entry) => entry.name)).toContain("ours");
    expect(destination.listNodes().map((entry) => entry.name)).toEqual(["our-box"]);
    expect(destination.authenticateNode(resident.node.id, resident.secret)).toBe(true);
    expect(destination.getSetting("enrollment.token")).toBe("secured-enrollment-token");
  });

  /*
   * The same Host, after the row was deleted: an id that used to exist is not
   * an id whose key can be produced, and the machine would come back as a Node
   * nothing can authenticate.
   */
  it("refuses when the row it would reclaim the key from is gone", () => {
    const store = secured(setup());
    const { node } = keyedNode(store);
    const archive = store.exportHostBackup({ enrollmentToken: "our-token" });
    store.deleteNode(node.id);

    expect(() => store.replaceHostBackup(archive)).toThrow(/re-enrol/i);
    expect(store.getNode(node.id)).toBeUndefined();
  });

  /** Whatever else happens, this row must never exist. */
  it("never leaves a mutual-auth Node with an empty public key", () => {
    const origin = secured(setup());
    keyedNode(origin, "their-keyed-box");
    const archive = origin.exportHostBackup({ enrollmentToken: "their-token" });
    const destination = secured(setup());

    try {
      destination.replaceHostBackup(archive);
    } catch {
      // The refusal is asserted above; this test is about what is left behind.
    }

    for (const node of destination.listNodes()) {
      if (node.authProtocol !== MUTUAL_AUTH_PROTOCOL) continue;
      expect(destination.nodePublicKey(node.id)).not.toBe("");
    }
  });
});

/**
 * The portable half: a Host that can be moved to another machine.
 *
 * Everything here is the Host's authority rather than its contents, which is
 * why it travels encrypted and why what it leaves behind matters as much as
 * what it carries.
 */
describe("portable security backup", () => {
  it("exports the authority a Host needs in order to be itself elsewhere", () => {
    const store = secured(setup());
    const node = store.registerNode({
      name: "box",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 2,
    });

    const payload = store.exportSecurityBackup();

    expect(payload).toMatchObject({
      version: 1,
      enrollmentToken: "secured-enrollment-token",
      leadTokenKey: "lead-token-key-of-this-host",
      auth: {
        mode: "microsoft-only",
        passwordEnabled: true,
        passwordVerifier: "scrypt$verifier$of$this$host",
        entraClientId: "11111111-2222-3333-4444-555555555555",
        deviceFlowEnabled: true,
        csrfKey: "csrf-key-of-this-host",
      },
      hostIdentity: {
        id: "host-identity-1",
        privateKey: "host-private-key",
        publicKey: "host-public-key",
        fingerprint: "SHA256:host",
      },
    });
    expect(payload.administrators.map((row) => row.username)).toEqual([
      "alice@example.com",
    ]);
    // Node authentication as it exists today: a legacy secret hash, named as
    // such so the record can carry a key instead once Nodes have one.
    expect(payload.nodeAuth).toEqual([
      {
        nodeId: node.node.id,
        authProtocol: "legacy-secret",
        secretHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        publicKey: "",
      },
    ]);
  });

  it("leaves behind everything that belongs to the machine it is leaving", () => {
    const store = secured(setup());
    const admin = store.listAdministrators()[0]!;
    const at = new Date().toISOString();
    store.insertOperatorSession({
      tokenHash: "session-hash-that-must-not-travel",
      administratorId: admin.id,
      authMethod: "microsoft-code",
      authenticatedAt: at,
      lastSeenAt: at,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.createInvitation({
      tokenHash: "invitation-hash-that-must-not-travel",
      createdByAdminId: admin.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const serialized = JSON.stringify(store.exportSecurityBackup());

    expect(serialized).not.toContain("session-hash-that-must-not-travel");
    expect(serialized).not.toContain("invitation-hash-that-must-not-travel");
  });

  it("makes a fresh Host into the one that was exported", () => {
    const origin = secured(setup());
    const registered = origin.registerNode({
      name: "box",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 2,
    });
    const data = portableData(origin);
    const security = origin.exportSecurityBackup();

    const moved = setup();
    moved.importPortableBackup({ data, security });

    expect(moved.countActiveAdministrators()).toBe(1);
    expect(
      moved.findAdministrator(identity("alice").tenantId, "object-alice"),
    ).toBeDefined();
    expect(moved.getSetting("auth.csrfKey")).toBe("csrf-key-of-this-host");
    expect(moved.getSetting("orchestrator.tokenKey")).toBe("lead-token-key-of-this-host");
    expect(moved.getSetting("host.identity.privateKey")).toBe("host-private-key");
    expect(moved.getSetting("auth.entraTenantId")).toBe(identity("alice").tenantId);
    // The whole point of moving Node authentication with the Host: a machine
    // that still has its `node.json` reconnects without being re-enrolled.
    expect(moved.authenticateNode(registered.node.id, registered.secret)).toBe(true);
    expect(moved.listWorkspaces().map((entry) => entry.name)).toContain("Chats");
  });

  /**
   * The portable half of the same question: a version 2 archive *does* carry
   * Node keys, in the encrypted envelope, and they have to be visible to the
   * data half — a row inserted with an empty key and corrected afterwards is
   * exactly the state a failure between the two halves would commit.
   */
  it("restores a key-based Node from the key in its encrypted envelope", () => {
    const origin = secured(setup());
    const { identity: nodeKey, node } = keyedNode(origin);
    const data = portableData(origin);
    const security = origin.exportSecurityBackup();

    const moved = setup();
    moved.importPortableBackup({ data, security });

    expect(moved.getNode(node.id)?.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    expect(moved.nodePublicKey(node.id)).toBe(nodeKey.publicKey);
  });

  it("refuses an envelope with no key for a Node that authenticates with one", () => {
    const origin = secured(setup());
    keyedNode(origin);
    const data = portableData(origin);
    const exported = origin.exportSecurityBackup();
    const security: SecurityBackupPayload = {
      ...exported,
      // A machine that would come back as `mutual-auth-v1` with nothing to
      // verify against: refused, rather than restored into silence.
      nodeAuth: exported.nodeAuth.map((entry) => ({
        ...entry,
        publicKey: "",
        secretHash: "a".repeat(64),
      })),
    };

    const destination = secured(setup());
    destination.createWorkspace("ours", "");

    expect(() => destination.importPortableBackup({ data, security })).toThrow(
      /envelope/i,
    );
    expect(destination.listWorkspaces().map((entry) => entry.name)).toContain("ours");
    expect(destination.listNodes()).toEqual([]);
  });

  it("ends every session the receiving Host had open", () => {
    const origin = secured(setup());
    const data = portableData(origin);
    const security = origin.exportSecurityBackup();

    const destination = secured(setup());
    const resident = destination.insertAdministrator({
      ...identity("bob"),
      addedVia: "invitation",
    });
    const at = new Date().toISOString();
    destination.insertOperatorSession({
      tokenHash: "resident-session",
      administratorId: resident.id,
      authMethod: "microsoft-code",
      authenticatedAt: at,
      lastSeenAt: at,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const { revokedSessions } = destination.importPortableBackup({ data, security });

    expect(revokedSessions.map((row) => row.tokenHash)).toContain("resident-session");
    expect(destination.getOperatorSession("resident-session")?.revokedAt).not.toBe("");
    // Bob was an administrator of the machine, not of the Host being restored.
    expect(
      destination.findAdministrator(identity("bob").tenantId, "object-bob"),
    ).toBeUndefined();
    expect(destination.listPendingCandidates()).toHaveLength(0);
  });

  it("refuses an archive that would leave the Host with no administrator", () => {
    const origin = secured(setup());
    const data = portableData(origin);
    const security: SecurityBackupPayload = {
      ...origin.exportSecurityBackup(),
      administrators: [],
    };

    const destination = secured(setup());
    expect(() => destination.importPortableBackup({ data, security })).toThrow();
    expect(destination.countActiveAdministrators()).toBe(1);
  });

  it("changes nothing at all when the archive cannot be applied", () => {
    // Atomicity is the property that makes a failed restore survivable: a
    // half-applied one is a Host with somebody else's data and its own keys.
    const origin = secured(setup());
    const data = portableData(origin);
    const exported = origin.exportSecurityBackup();
    const clashing = { ...exported.administrators[0]!, id: "one-id-for-two-people" };
    const security: SecurityBackupPayload = {
      ...exported,
      administrators: [
        { ...clashing, objectId: "object-one" },
        { ...clashing, objectId: "object-two" },
      ],
    };

    const destination = secured(setup());
    destination.createWorkspace("ours", "");

    expect(() => destination.importPortableBackup({ data, security })).toThrow();

    expect(destination.listWorkspaces().map((entry) => entry.name)).toContain("ours");
    expect(destination.getSetting("enrollment.token")).not.toBe("moved");
    expect(destination.listAdministrators()[0]?.username).toBe("alice@example.com");
  });

  it("refuses outer Node authority that is absent from the encrypted envelope", () => {
    const origin = secured(setup());
    const data = portableData(origin);
    const security = origin.exportSecurityBackup();
    const foreign = setup().registerNode({
      name: "injected",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: [],
      maxSessions: 1,
    }).node;
    const destination = secured(setup());

    expect(() =>
      destination.importPortableBackup({
        data: { ...data, nodes: [...data.nodes, foreign] },
        security,
      }),
    ).toThrow(/Node data/i);
    expect(destination.listNodes()).toEqual([]);
  });
});
