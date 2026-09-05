import { describe, expect, it } from "vitest";
import {
  HOST_BACKUP_KIND,
  HostBackupSchema,
  HostPortableBackupSchema,
  PORTABLE_BACKUP_VERSION,
  SecurityBackupPayloadSchema,
  SecurityEnvelopeSchema,
  backupFormatVersion,
} from "./index.js";

const data = {
  kind: HOST_BACKUP_KIND,
  exportedAt: "2026-08-28T12:00:00.000Z",
  tunnel: { enabled: false, provider: "cloudflare" },
  defaults: { yolo: false, autoResume: true },
  nodes: [],
  workspaces: [],
  placements: [],
  sessions: [],
  events: [],
};
const legacyData = { ...data, enrollmentToken: "t" };

const envelope = {
  format: 1,
  cipher: "aes-256-gcm",
  kdf: { algorithm: "scrypt", version: 1, N: 32_768, r: 8, p: 1, keyLength: 32 },
  salt: Buffer.alloc(16, 1).toString("base64"),
  nonce: Buffer.alloc(12, 2).toString("base64"),
  authTag: Buffer.alloc(16, 3).toString("base64"),
  ciphertext: Buffer.from("sealed").toString("base64"),
};

/**
 * Two archive formats, told apart by a number.
 *
 * Version 1 moves data and is refused the security half; version 2 carries the
 * Host's authority as an encrypted envelope. The formats have to be
 * distinguishable before anything is applied, because the endpoint that
 * restores data is not the endpoint that may change who owns a Host.
 */
describe("portable host archives", () => {
  it("parses a version 2 archive with its sealed security envelope", () => {
    const parsed = HostPortableBackupSchema.parse({
      ...data,
      version: PORTABLE_BACKUP_VERSION,
      security: envelope,
    });

    expect(parsed.version).toBe(2);
    expect(parsed.security.cipher).toBe("aes-256-gcm");
    // The data half is the same shape as version 1, defaults and all.
    expect(parsed.runs).toEqual([]);
  });

  it("refuses a version 2 archive as a version 1 data restore", () => {
    expect(
      HostBackupSchema.safeParse({
        ...legacyData,
        version: PORTABLE_BACKUP_VERSION,
        security: envelope,
      }).success,
    ).toBe(false);
  });

  it("refuses a version 1 archive as a portable one, envelope or not", () => {
    expect(
      HostPortableBackupSchema.safeParse({ ...legacyData, version: 1 }).success,
    ).toBe(false);
    expect(
      HostPortableBackupSchema.safeParse({ ...data, version: PORTABLE_BACKUP_VERSION })
        .success,
    ).toBe(false);
  });

  it("reads the format version off a file before trusting anything in it", () => {
    expect(backupFormatVersion({ ...legacyData, version: 1 })).toBe(1);
    expect(backupFormatVersion({ ...data, version: 2 })).toBe(2);
    expect(backupFormatVersion({ version: "2" })).toBeUndefined();
    expect(backupFormatVersion(null)).toBeUndefined();
  });

  it("refuses an envelope that names a cipher or KDF it does not use", () => {
    expect(
      SecurityEnvelopeSchema.safeParse({ ...envelope, cipher: "aes-128-cbc" }).success,
    ).toBe(false);
    expect(
      SecurityEnvelopeSchema.safeParse({
        ...envelope,
        kdf: { ...envelope.kdf, N: 1_048_576, r: 64, p: 16 },
      }).success,
    ).toBe(false);
    expect(
      SecurityEnvelopeSchema.safeParse({
        ...envelope,
        kdf: { ...envelope.kdf, algorithm: "pbkdf2" },
      }).success,
    ).toBe(false);
  });

  it("bounds the ciphertext, so an archive cannot be a denial of service", () => {
    expect(
      SecurityEnvelopeSchema.safeParse({
        ...envelope,
        ciphertext: "A".repeat(9_000_000),
      }).success,
    ).toBe(false);
  });

  it("keeps room for Node keys without inventing them", () => {
    // Nodes authenticate with a shared secret today and a key pair later. The
    // record names the protocol, so the same archive format can carry either.
    const payload = SecurityBackupPayloadSchema.parse({
      version: 1,
      enrollmentToken: "legacy-token",
      auth: {
        mode: "microsoft-only",
        passwordEnabled: false,
        entraTenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
        entraClientId: "11111111-2222-3333-4444-555555555555",
        csrfKey: "a2V5",
      },
      leadTokenKey: "a2V5",
      administrators: [
        {
          id: "admin-1",
          tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
          objectId: "alice-object-id",
          username: "alice@example.com",
          displayName: "Alice",
          addedVia: "claim",
          createdAt: "2026-08-27T10:00:00.000Z",
        },
      ],
      nodeAuth: [{ nodeId: "node-1", secretHash: "a".repeat(64) }],
    });

    expect(payload.nodeAuth[0]).toEqual({
      nodeId: "node-1",
      authProtocol: "legacy-secret",
      secretHash: "a".repeat(64),
      publicKey: "",
    });
    expect(payload.hostIdentity).toBeUndefined();
    expect(payload.auth.passwordVerifier).toBe("");
  });

  it("refuses a security payload that carries a browser session", () => {
    // Sessions belong to the machine that issued them; a moved Host must not
    // resurrect one, so there is nowhere in the format to put it.
    const parsed = SecurityBackupPayloadSchema.safeParse({
      version: 1,
      enrollmentToken: "legacy-token",
      auth: {
        mode: "microsoft-only",
        passwordEnabled: false,
        entraTenantId: "t",
        entraClientId: "c",
        csrfKey: "a2V5",
      },
      leadTokenKey: "a2V5",
      administrators: [],
      nodeAuth: [],
      operatorSessions: [{ tokenHash: "abc" }],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && "operatorSessions" in parsed.data).toBe(false);
  });
});
