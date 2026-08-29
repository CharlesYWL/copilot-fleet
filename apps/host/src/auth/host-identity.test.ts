import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { verifyIdentitySignature } from "@fleet/protocol/node-auth";
import { HostIdentityService } from "./host-identity.js";
import { FleetStore } from "../store.js";

const stores: FleetStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new FleetStore(":memory:");
  stores.push(store);
  return store;
}

/**
 * The Host's identity is what a Node pins, so the only thing worse than not
 * having one is having a different one after a restart: every enrolled machine
 * would refuse to talk to the Host it enrolled with, and the recovery is
 * re-enrolling the whole fleet by hand.
 */
describe("host identity", () => {
  it("mints an Ed25519 identity the first time it is asked for one", () => {
    const store = setup();
    const identity = new HostIdentityService(store).identity();

    expect(identity.hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.fingerprint).toBe(
      createHash("sha256")
        .update(Buffer.from(identity.publicKey, "base64"))
        .digest("hex"),
    );
    expect(store.getSetting("host.identity.privateKey")).toBeTruthy();
    expect(store.getSetting("host.identity.publicKey")).toBe(identity.publicKey);
    expect(store.getSetting("host.identity.fingerprint")).toBe(identity.fingerprint);
  });

  it("keeps the same identity across a restart", () => {
    const store = setup();
    const first = new HostIdentityService(store).identity();
    // A second service over the same database is what a Host restart is.
    const second = new HostIdentityService(store).identity();

    expect(second).toEqual(first);
  });

  it("adopts the identity a portable restore wrote instead of minting a new one", () => {
    const store = setup();
    const service = new HostIdentityService(store);
    const before = service.identity();

    const moved = new HostIdentityService(setup()).identity();
    store.setSetting("host.identity.id", moved.hostId);
    store.setSetting("host.identity.publicKey", moved.publicKey);
    store.setSetting("host.identity.fingerprint", moved.fingerprint);
    store.setSetting(
      "host.identity.privateKey",
      // The moved Host's private half travels inside the sealed envelope.
      new HostIdentityService(setup()).exportPrivateKeyForBackup(),
    );
    service.reload();

    expect(service.identity().hostId).toBe(moved.hostId);
    expect(service.identity().hostId).not.toBe(before.hostId);
  });

  it("signs with the private half and verifies with the public one", () => {
    const store = setup();
    const service = new HostIdentityService(store);
    const message = Buffer.from("bytes to sign");
    const signature = service.sign(message);

    expect(
      verifyIdentitySignature(service.identity().publicKey, message, signature),
    ).toBe(true);
    expect(
      verifyIdentitySignature(
        service.identity().publicKey,
        Buffer.from("other bytes"),
        signature,
      ),
    ).toBe(false);
  });

  it("has no way to return the private key to an API caller", () => {
    const store = setup();
    const identity = new HostIdentityService(store).identity();

    // The published identity is a DTO with exactly three fields, so a route
    // that spreads it cannot leak the half that must never leave this machine.
    expect(Object.keys(identity).sort()).toEqual(["fingerprint", "hostId", "publicKey"]);
    expect(JSON.stringify(identity)).not.toContain(
      store.getSetting("host.identity.privateKey") ?? "unreachable",
    );
  });

  it("replaces a half-written identity rather than trusting it", () => {
    const store = setup();
    // A crash between the two writes used to leave a public key with no private
    // half, which signs nothing and cannot be recovered from by reading.
    store.setSetting("host.identity.id", "host-1");
    store.setSetting("host.identity.publicKey", "not-a-key");
    store.setSetting("host.identity.privateKey", "");
    const identity = new HostIdentityService(store).identity();

    expect(identity.hostId).not.toBe("host-1");
    expect(store.getSetting("host.identity.privateKey")).toBeTruthy();
  });
});
