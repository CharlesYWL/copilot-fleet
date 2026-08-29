import { randomUUID } from "node:crypto";
import { HostIdentitySchema, type HostIdentity } from "@fleet/protocol";
import {
  createIdentityKeyPair,
  identityFingerprint,
  signWithIdentity,
} from "@fleet/protocol/node-auth";
import type { FleetStore } from "../store.js";

export const HOST_IDENTITY_ID_SETTING = "host.identity.id";
export const HOST_IDENTITY_PRIVATE_KEY_SETTING = "host.identity.privateKey";
export const HOST_IDENTITY_PUBLIC_KEY_SETTING = "host.identity.publicKey";
export const HOST_IDENTITY_FINGERPRINT_SETTING = "host.identity.fingerprint";

/**
 * The key pair that makes this Host recognisable to its own machines.
 *
 * A Node pins the fingerprint on the Connect card and refuses to speak to
 * anything that cannot sign for it, which means the identity has to be exactly
 * as durable as the fleet: minted once, kept across restarts, moved by a
 * portable backup, and never rotated as a side effect of restoring data. That
 * durability is the whole feature — a Host that mints a second identity has
 * silently locked every enrolled machine out.
 *
 * The private half lives in the settings table under the same file permissions
 * as the rest of the database and is never returned by any route: what callers
 * get is {@link HostIdentity}, which has three fields and no way to carry it.
 */
export class HostIdentityService {
  private cached: HostIdentity | undefined;
  private privateKey = "";

  constructor(private readonly store: FleetStore) {}

  identity(): HostIdentity {
    if (!this.cached) this.load();
    // `load` always leaves one behind: it either read a complete identity or
    // minted a replacement.
    return this.cached!;
  }

  sign(message: Buffer): string {
    this.identity();
    return signWithIdentity(this.privateKey, message);
  }

  /**
   * Re-reads the settings, for a Host that has just become a different one.
   *
   * A portable restore writes another Host's identity underneath a service that
   * read this one's at startup. Without this the Host would keep signing
   * challenges with a key no Node has ever been told about.
   */
  reload(): void {
    this.cached = undefined;
    this.privateKey = "";
    this.identity();
  }

  /** The private half, for the sealed section of a portable backup only. */
  exportPrivateKeyForBackup(): string {
    this.identity();
    return this.privateKey;
  }

  private load(): void {
    const stored = {
      hostId: this.store.getSetting(HOST_IDENTITY_ID_SETTING) ?? "",
      privateKey: this.store.getSetting(HOST_IDENTITY_PRIVATE_KEY_SETTING) ?? "",
      publicKey: this.store.getSetting(HOST_IDENTITY_PUBLIC_KEY_SETTING) ?? "",
    };
    if (stored.hostId && stored.privateKey && stored.publicKey) {
      const parsed = HostIdentitySchema.safeParse({
        hostId: stored.hostId,
        publicKey: stored.publicKey,
        // Recomputed rather than read: the stored fingerprint is a convenience
        // for display, and a Host that trusted it would advertise a digest that
        // does not match the key it actually signs with.
        fingerprint: identityFingerprint(stored.publicKey),
      });
      if (parsed.success) {
        this.cached = parsed.data;
        this.privateKey = stored.privateKey;
        // Corrects a fingerprint written by an older build or left behind by a
        // half-finished restore.
        this.store.setSetting(HOST_IDENTITY_FINGERPRINT_SETTING, parsed.data.fingerprint);
        return;
      }
    }
    this.mint();
  }

  /**
   * Writes a fresh identity, replacing anything unusable that was there.
   *
   * A partially written identity — a public key with no private half, a crash
   * between two writes — cannot be repaired by reading it, and keeping it would
   * mean a Host that advertises a key it cannot sign with. Nodes enrolled
   * against the old one have to be re-enrolled either way; failing loudly at
   * the handshake is a better outcome than signing nothing.
   */
  private mint(): void {
    const keys = createIdentityKeyPair();
    const hostId = randomUUID();
    this.store.setSetting(HOST_IDENTITY_ID_SETTING, hostId);
    this.store.setSetting(HOST_IDENTITY_PRIVATE_KEY_SETTING, keys.privateKey);
    this.store.setSetting(HOST_IDENTITY_PUBLIC_KEY_SETTING, keys.publicKey);
    this.store.setSetting(HOST_IDENTITY_FINGERPRINT_SETTING, keys.fingerprint);
    this.privateKey = keys.privateKey;
    this.cached = {
      hostId,
      publicKey: keys.publicKey,
      fingerprint: keys.fingerprint,
    };
  }
}
