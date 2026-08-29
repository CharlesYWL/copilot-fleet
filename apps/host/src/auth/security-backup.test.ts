import { describe, expect, it } from "vitest";
import {
  MIN_BACKUP_PASSPHRASE_LENGTH,
  openSecurityEnvelope,
  sealSecurityEnvelope,
  type SecurityBackupPayload,
  type SecurityEnvelope,
} from "./security-backup.js";

const payload = (): SecurityBackupPayload => ({
  version: 1,
  enrollmentToken: "legacy-enrollment-token",
  auth: {
    mode: "microsoft-only",
    passwordEnabled: false,
    passwordVerifier: "",
    passwordIsRecovery: false,
    entraTenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    entraClientId: "11111111-2222-3333-4444-555555555555",
    deviceFlowEnabled: false,
    csrfKey: Buffer.alloc(32, 7).toString("base64"),
  },
  leadTokenKey: Buffer.alloc(32, 9).toString("base64"),
  // Enforcement travels with the fleet, so it is part of what a passphrase
  // seals: an archive that dropped it would restore a Host quietly accepting
  // the shared Node secret its operator had retired.
  node: { mutualAuthenticationRequired: false },
  administrators: [
    {
      id: "admin-1",
      tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      objectId: "alice-object-id",
      username: "alice@example.com",
      displayName: "Alice",
      addedVia: "claim",
      addedByAdminId: "",
      createdAt: "2026-08-27T10:00:00.000Z",
      lastLoginAt: "",
      disabledAt: "",
    },
  ],
  nodeAuth: [
    {
      nodeId: "node-1",
      authProtocol: "legacy-secret",
      secretHash: "a".repeat(64),
      publicKey: "",
    },
  ],
});

const PASSPHRASE = "a-long-enough-passphrase";

/**
 * The one part of a portable backup that must survive being copied to a USB
 * stick, a chat message, or a cloud drive.
 *
 * Everything in it — the administrator table, the CSRF key, the lead-token
 * signing key, the material Nodes authenticate against — is the Host's
 * authority in a file, so the file itself has to be the boundary rather than
 * wherever it happens to be stored.
 */
describe("security envelope", () => {
  it("returns the same security state the passphrase sealed", () => {
    const sealed = sealSecurityEnvelope(payload(), PASSPHRASE);

    expect(openSecurityEnvelope(sealed, PASSPHRASE)).toEqual({
      ok: true,
      payload: payload(),
    });
  });

  it("carries no security state in the clear", () => {
    const sealed = sealSecurityEnvelope(payload(), PASSPHRASE);

    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("alice-object-id");
    expect(serialized).not.toContain(payload().leadTokenKey);
    expect(serialized).not.toContain(payload().auth.csrfKey);
    expect(serialized).not.toContain(PASSPHRASE);
  });

  it("names the parameters it derived its key with, so a later Host can follow", () => {
    const sealed = sealSecurityEnvelope(payload(), PASSPHRASE);

    expect(sealed).toMatchObject({
      cipher: "aes-256-gcm",
      kdf: { algorithm: "scrypt", version: 1, keyLength: 32 },
    });
    // 16 bytes of salt and a 12-byte GCM nonce, both random per export.
    expect(Buffer.from(sealed.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(sealed.nonce, "base64")).toHaveLength(12);
    expect(Buffer.from(sealed.authTag, "base64")).toHaveLength(16);
    expect(sealed.kdf.N).toBeGreaterThanOrEqual(16_384);
  });

  it("derives a different key every time, even for one passphrase", () => {
    const first = sealSecurityEnvelope(payload(), PASSPHRASE);
    const second = sealSecurityEnvelope(payload(), PASSPHRASE);

    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("refuses the wrong passphrase without saying anything else", () => {
    const sealed = sealSecurityEnvelope(payload(), PASSPHRASE);

    expect(openSecurityEnvelope(sealed, "not-the-passphrase-1")).toEqual({
      ok: false,
      error: "That passphrase does not open this backup.",
    });
  });

  it("refuses an envelope somebody edited", () => {
    // The authentication tag is the point: a backup an attacker can rewrite is
    // a backup that can insert their own administrator.
    const sealed = sealSecurityEnvelope(payload(), PASSPHRASE);
    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0);

    const opened = openSecurityEnvelope(
      { ...sealed, ciphertext: flipped.toString("base64") },
      PASSPHRASE,
    );

    expect(opened.ok).toBe(false);
  });

  it("refuses an envelope whose salt was swapped for another export's", () => {
    const sealed = sealSecurityEnvelope(payload(), PASSPHRASE);
    const other = sealSecurityEnvelope(payload(), PASSPHRASE);

    expect(openSecurityEnvelope({ ...sealed, salt: other.salt }, PASSPHRASE).ok).toBe(
      false,
    );
  });

  it("refuses to seal anything under a passphrase short enough to guess", () => {
    expect(() => sealSecurityEnvelope(payload(), "short")).toThrow(
      new RegExp(String(MIN_BACKUP_PASSPHRASE_LENGTH)),
    );
    expect(MIN_BACKUP_PASSPHRASE_LENGTH).toBe(14);
  });

  it("refuses work parameters below the ones it ships", () => {
    // A file names its own KDF cost, so a file is a way to ask for a cheap
    // one. The floor is the Host's, not the archive's.
    const sealed = sealSecurityEnvelope(payload(), PASSPHRASE);

    const weakened = openSecurityEnvelope(
      { ...sealed, kdf: { ...sealed.kdf, N: 2 } } as unknown as SecurityEnvelope,
      PASSPHRASE,
    );

    expect(weakened.ok).toBe(false);
  });

  it("refuses an envelope larger than any security state it writes", () => {
    const sealed = sealSecurityEnvelope(payload(), PASSPHRASE);

    const oversized = openSecurityEnvelope(
      { ...sealed, ciphertext: "A".repeat(9_000_000) },
      PASSPHRASE,
    );

    expect(oversized.ok).toBe(false);
  });
});
