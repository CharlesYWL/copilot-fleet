import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  SECURITY_ENVELOPE_FORMAT,
  SecurityBackupPayloadSchema,
  SecurityEnvelopeSchema,
  type SecurityBackupPayload,
  type SecurityEnvelope,
  type SecurityEnvelopeKdf,
} from "@fleet/protocol";

export type { SecurityBackupPayload, SecurityEnvelope } from "@fleet/protocol";

/**
 * Short enough to type, long enough that guessing it offline is the attack it
 * is meant to be.
 *
 * The file is the boundary here: an archive on a USB stick or in a chat thread
 * is the Host's administrator table and every key it signs with, so the only
 * thing standing between whoever has the file and the fleet is the work of
 * deriving this key.
 */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 14;

/** A bound, so a passphrase field cannot be a way to spend the Host's memory. */
export const MAX_BACKUP_PASSPHRASE_LENGTH = 1_024;

/**
 * What this Host derives with today, recorded in the file it writes.
 *
 * Versioned rather than implied: raising the cost later must not make every
 * archive written before the change unreadable, and lowering it must not be
 * something an archive can ask for.
 */
export const BACKUP_KDF: SecurityEnvelopeKdf = {
  algorithm: "scrypt",
  version: 1,
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 32,
};

/** scrypt needs `128 * N * r` bytes; Node's default ceiling is exactly that. */
const scryptMemory = (kdf: SecurityEnvelopeKdf): number => 256 * kdf.N * kdf.r;

const SALT_BYTES = 16;
const NONCE_BYTES = 12;

/** One answer for every way a file fails to open under a passphrase. */
const CANNOT_OPEN = "That passphrase does not open this backup.";
const NOT_AN_ENVELOPE = "That file does not carry a Copilot Fleet security envelope.";
const NOT_READABLE = "That backup's security section is not one this Host can read.";

export type OpenedEnvelope =
  { ok: true; payload: SecurityBackupPayload } | { ok: false; error: string };

function deriveKey(passphrase: string, salt: Buffer, kdf: SecurityEnvelopeKdf): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, kdf.keyLength, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: scryptMemory(kdf),
  });
}

/**
 * Seals the Host's authority under a passphrase nobody stores.
 *
 * A fresh salt and nonce every time, so two exports of the same Host under the
 * same passphrase share neither a key nor a keystream — and the authentication
 * tag is what makes editing the file a failure rather than a way to add an
 * administrator to somebody else's fleet.
 */
export function sealSecurityEnvelope(
  payload: SecurityBackupPayload,
  passphrase: string,
): SecurityEnvelope {
  if (passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new Error(
      `A backup passphrase must be at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters.`,
    );
  }
  if (passphrase.length > MAX_BACKUP_PASSPHRASE_LENGTH) {
    throw new Error(
      `A backup passphrase must be at most ${MAX_BACKUP_PASSPHRASE_LENGTH} characters.`,
    );
  }
  const parsed = SecurityBackupPayloadSchema.parse(payload);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveKey(passphrase, salt, BACKUP_KDF),
    nonce,
  );
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(parsed), "utf8")),
    cipher.final(),
  ]);
  return {
    format: SECURITY_ENVELOPE_FORMAT,
    cipher: "aes-256-gcm",
    kdf: BACKUP_KDF,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Opens one, or says only that it did not.
 *
 * The three failures — a file that is not an envelope, a passphrase that does
 * not derive the key, and contents this Host cannot read — are told apart in
 * the return value rather than in the error text, because which half of a
 * failed decryption failed is precisely what an attacker with the file wants
 * to be told.
 */
export function openSecurityEnvelope(
  envelope: SecurityEnvelope,
  passphrase: string,
): OpenedEnvelope {
  if (
    passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH ||
    passphrase.length > MAX_BACKUP_PASSPHRASE_LENGTH
  ) {
    return { ok: false, error: CANNOT_OPEN };
  }
  const parsed = SecurityEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return { ok: false, error: NOT_AN_ENVELOPE };
  const sealed = parsed.data;
  // Version 1 accepts exactly one bounded parameter set. A tampered archive
  // never gets to choose how much synchronous CPU or memory the Host spends.
  if (
    sealed.kdf.N !== BACKUP_KDF.N ||
    sealed.kdf.r !== BACKUP_KDF.r ||
    sealed.kdf.p !== BACKUP_KDF.p ||
    sealed.kdf.keyLength !== BACKUP_KDF.keyLength
  ) {
    return { ok: false, error: NOT_AN_ENVELOPE };
  }
  const salt = Buffer.from(sealed.salt, "base64");
  const nonce = Buffer.from(sealed.nonce, "base64");
  const authTag = Buffer.from(sealed.authTag, "base64");
  if (
    salt.length !== SALT_BYTES ||
    nonce.length !== NONCE_BYTES ||
    authTag.length !== 16
  ) {
    return { ok: false, error: NOT_AN_ENVELOPE };
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(passphrase, salt, sealed.kdf),
      nonce,
    );
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    // Narrow on purpose: the only thing this catch may mean is "the tag did
    // not verify", and it returns a refusal rather than falling through to
    // anything that would treat the archive as opened.
    return { ok: false, error: CANNOT_OPEN };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext.toString("utf8"));
  } catch {
    return { ok: false, error: NOT_READABLE };
  }
  const contents = SecurityBackupPayloadSchema.safeParse(decoded);
  if (!contents.success) return { ok: false, error: NOT_READABLE };
  return { ok: true, payload: contents.data };
}
