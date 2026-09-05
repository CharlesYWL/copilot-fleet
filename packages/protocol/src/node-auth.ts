import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import type { AuthenticatedEnvelope } from "./index.js";

/**
 * The cryptography behind Node enrollment and the authenticated channel.
 *
 * Kept out of the protocol index because the browser bundle imports that file
 * and must not pull in `node:crypto`. Kept out of the Host and the Node because
 * every byte either of them signs has to be produced the same way on both ends
 * — two implementations of one transcript is two implementations that will
 * disagree exactly once, on the frame nobody tested.
 */

/** Every field's length travels with it, so no value can pose as a delimiter. */
const LENGTH_PREFIX_BYTES = 4;

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
  prefix.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([prefix, bytes]);
}

/**
 * The bytes a signature, an HMAC or a key derivation is actually over.
 *
 * A domain, then each field's name and value, each length-prefixed. Both halves
 * matter: without the domain, a Host's challenge signature is byte-identical to
 * the Node proof it is waiting for; without the lengths, a URL ending in the
 * next field's name produces the same bytes as a different pair of fields, so a
 * signature over one Node's key reads as a signature over another's.
 */
export function transcriptBytes(
  domain: string,
  fields: readonly (readonly [string, string])[],
): Buffer {
  const parts = [lengthPrefixed(domain)];
  for (const [name, value] of fields) {
    parts.push(lengthPrefixed(name), lengthPrefixed(value));
  }
  return Buffer.concat(parts);
}

/**
 * JSON with every object's keys in one order.
 *
 * The Node commits to a registration payload by hashing it before the Host has
 * seen it, so the two have to agree on the bytes without having agreed on a key
 * order. Anything that cannot be encoded the same way twice — `undefined`, a
 * non-finite number, a function — is refused rather than silently dropped,
 * because a dropped field is a payload the Host would authorise without ever
 * having been shown it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("A canonical payload cannot hold a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`A canonical payload cannot hold a ${typeof value}.`);
}

/** What the Node commits to before the Host has seen the payload. */
export function registrationHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export type IdentityKeyPair = {
  /** Base64 PKCS8 DER. Written with user-only permissions, never sent. */
  privateKey: string;
  /** Base64 SPKI DER. */
  publicKey: string;
  fingerprint: string;
};

export function createIdentityKeyPair(): IdentityKeyPair {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  return {
    privateKey: pair.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
    publicKey,
    fingerprint: identityFingerprint(publicKey),
  };
}

/**
 * The short name a human compares.
 *
 * Over the encoded public key rather than over the raw curve point, so that the
 * value an operator reads off the Connect card is the digest of exactly the
 * bytes a Node stores and checks.
 */
export function identityFingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
}

export function signWithIdentity(privateKey: string, message: Buffer): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, message, key).toString("base64");
}

/**
 * Whether these bytes were signed by the holder of this key.
 *
 * Both arguments arrive from the network, so a malformed key or signature is an
 * expected answer rather than an exception: the narrow catch below converts
 * "this is not a key" into the same `false` as "this is not the signature",
 * which is the only distinction a caller is entitled to.
 */
export function verifyIdentitySignature(
  publicKey: string,
  message: Buffer,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** Constant time, because a fingerprint check is a comparison against a secret-adjacent value. */
export function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const ENROLLMENT_CHALLENGE_LABEL = "fleet-enrollment-host-challenge-v1";
export const ENROLLMENT_COMPLETION_LABEL = "fleet-enrollment-node-completion-v1";
export const ENROLLMENT_GRANT_LABEL = "fleet-enrollment-grant-proof-v1";
export const ENROLLMENT_RECEIPT_LABEL = "fleet-enrollment-host-receipt-v1";

export type EnrollmentTranscriptInput = {
  challengeId: string;
  hostId: string;
  hostNonce: string;
  nodeNonce: string;
  nodePublicKey: string;
  registrationHash: string;
  dialedHostUrl: string;
};

/**
 * The fields a grant authorises, which is what makes it single-purpose.
 *
 * All three parties sign over the same set under different domains: the Host so
 * the Node can tell it from a relay, the Node so its key cannot be swapped, and
 * the grant HMAC so neither can be replayed against a different challenge.
 */
export function enrollmentTranscript(
  label: string,
  input: EnrollmentTranscriptInput,
): Buffer {
  return transcriptBytes(label, [
    ["challengeId", input.challengeId],
    ["hostId", input.hostId],
    ["hostNonce", input.hostNonce],
    ["nodeNonce", input.nodeNonce],
    ["nodePublicKey", input.nodePublicKey],
    ["registrationHash", input.registrationHash],
    ["dialedHostUrl", input.dialedHostUrl],
  ]);
}

/**
 * What the Host signs when it tells a Node which id it now answers to.
 *
 * The same fields the challenge and the completion were signed over, plus the
 * id being issued. Both halves matter. Without the transcript, a receipt is a
 * frame a relay can compose from scratch — and it names the Host key the Node
 * will pin for the rest of its life, so composing it is owning that machine.
 * Without the nodeId, one Node's receipt verifies as another's, and a relay
 * that enrolled a machine of its own can hand that receipt to the real one.
 */
export function enrollmentReceiptTranscript(
  input: EnrollmentTranscriptInput & { nodeId: string },
): Buffer {
  return transcriptBytes(ENROLLMENT_RECEIPT_LABEL, [
    ["challengeId", input.challengeId],
    ["hostId", input.hostId],
    ["hostNonce", input.hostNonce],
    ["nodeNonce", input.nodeNonce],
    ["nodePublicKey", input.nodePublicKey],
    ["registrationHash", input.registrationHash],
    ["dialedHostUrl", input.dialedHostUrl],
    ["nodeId", input.nodeId],
  ]);
}

/** What the Host stores, and — because it is the HMAC key — all it needs. */
export function grantSecretDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
export function grantProof(secretDigest: string, transcript: Buffer): string {
  return createHmac("sha256", Buffer.from(secretDigest, "hex"))
    .update(transcript)
    .digest("base64");
}

const NODE_HTTP_PROOF_LABEL = "fleet-node-http-proof-v1";

/**
 * How far apart two clocks may be before a proof is refused.
 *
 * Narrow on purpose: the window is the interval during which a captured proof
 * is worth capturing, and the nonce cache the Host keeps has to remember every
 * proof for exactly as long. A minute survives ordinary drift between two
 * machines an operator owns; an hour would be a bounded cache pretending to be
 * an unbounded one.
 */
export const NODE_HTTP_PROOF_WINDOW_MS = 60_000;

/** Bounded because the Host stores one per in-flight proof. */
export const MAX_NODE_HTTP_PROOF_NONCE_LENGTH = 64;

/**
 * The body, as both ends see it.
 *
 * The raw request bytes rather than a re-serialised object: the Host acts on
 * what arrived, so that is what has to be signed. Re-encoding either end would
 * make two JSON writers the thing the signature depends on.
 */
export function canonicalBodyHash(body: string | undefined): string {
  return createHash("sha256")
    .update(body ?? "", "utf8")
    .digest("hex");
}

function nodeHttpProofTranscript(input: {
  nodeId: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): Buffer {
  return transcriptBytes(NODE_HTTP_PROOF_LABEL, [
    ["nodeId", input.nodeId],
    ["method", input.method.toUpperCase()],
    ["path", input.path],
    ["timestamp", input.timestamp],
    ["nonce", input.nonce],
    ["bodyHash", input.bodyHash],
  ]);
}

export type NodeHttpProof = { timestamp: string; nonce: string; signature: string };

/**
 * What a keyed Node puts on an HTTP call it relays for its own config page.
 *
 * The page cannot reach the Host itself, so this process calls on its behalf —
 * and a Node with a key pair has no shared secret to identify itself with. It
 * signs instead, which is strictly less to lose: a secret authorises every
 * future call the moment it is observed, and this authorises one call that has
 * already been made.
 *
 * Everything the Host will act on is bound: the method and the exact path,
 * because a proof for a read must not be a proof for a write; the body,
 * because otherwise a relay chooses what the write says; and a timestamp and
 * nonce, because a signature says who made a proof and never that it is new.
 */
export function signNodeHttpProof(input: {
  privateKey: string;
  nodeId: string;
  method: string;
  path: string;
  body?: string;
  now?: number;
  nonce?: string;
}): NodeHttpProof {
  const timestamp = String(input.now ?? Date.now());
  const nonce = input.nonce ?? randomBytes(18).toString("base64url");
  return {
    timestamp,
    nonce,
    signature: signWithIdentity(
      input.privateKey,
      nodeHttpProofTranscript({
        nodeId: input.nodeId,
        method: input.method,
        path: input.path,
        timestamp,
        nonce,
        bodyHash: canonicalBodyHash(input.body),
      }),
    ),
  };
}

export type NodeHttpProofOutcome =
  { ok: true } | { ok: false; reason: "malformed" | "clock" | "signature" };

/**
 * Whether this call was made, just now, by the holder of that key.
 *
 * Replay is deliberately not answered here: it needs state the Host keeps and
 * a caller could not supply, and folding a "seen this" cache into a pure
 * verifier is how the two end up disagreeing about which nonces exist. The
 * caller claims the nonce; this says whether there was ever a proof to claim.
 */
export function verifyNodeHttpProof(input: {
  publicKey: string;
  nodeId: string;
  method: string;
  path: string;
  body?: string;
  timestamp: string;
  nonce: string;
  signature: string;
  now?: number;
  windowMs?: number;
}): NodeHttpProofOutcome {
  if (!input.publicKey || !input.signature) return { ok: false, reason: "malformed" };
  if (!input.nonce || input.nonce.length > MAX_NODE_HTTP_PROOF_NONCE_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  // A timestamp that is not a number is not a late proof, but the answer an
  // unparseable one deserves is the same as a stale one: it is not in the
  // window, because it is not on the clock at all.
  if (!/^\d{1,15}$/.test(input.timestamp)) return { ok: false, reason: "clock" };
  const skew = Math.abs((input.now ?? Date.now()) - Number(input.timestamp));
  if (skew > (input.windowMs ?? NODE_HTTP_PROOF_WINDOW_MS)) {
    return { ok: false, reason: "clock" };
  }
  const verified = verifyIdentitySignature(
    input.publicKey,
    nodeHttpProofTranscript({
      nodeId: input.nodeId,
      method: input.method,
      path: input.path,
      timestamp: input.timestamp,
      nonce: input.nonce,
      bodyHash: canonicalBodyHash(input.body),
    }),
    input.signature,
  );
  return verified ? { ok: true } : { ok: false, reason: "signature" };
}

export const HOST_CHALLENGE_LABEL = "fleet-node-channel-host-challenge-v1";
export const NODE_PROOF_LABEL = "fleet-node-channel-node-proof-v1";
export const CHANNEL_KEY_LABEL = "fleet-node-channel-keys-v1";
const CHANNEL_AAD_LABEL = "fleet-node-channel-aad-v1";

export type HandshakeTranscriptInput = {
  protocol: string;
  hostId: string;
  nodeId: string;
  connectionId: string;
  hostNonce: string;
  nodeNonce: string;
  hostPublicKey: string;
  nodePublicKey: string;
  hostEphemeralPublicKey: string;
  nodeEphemeralPublicKey: string;
  dialedHostUrl: string;
};

/**
 * Everything both ends know by the end of the handshake, in one order.
 *
 * The persistent keys are in here alongside the ephemeral ones: that is what
 * binds "this Host and this Node" to "this connection's keys", and it is the
 * difference between a relay that can forward a genuine proof and one that can
 * use it.
 */
export function handshakeTranscript(
  label: string,
  input: HandshakeTranscriptInput,
): Buffer {
  return transcriptBytes(label, [
    ["protocol", input.protocol],
    ["hostId", input.hostId],
    ["nodeId", input.nodeId],
    ["connectionId", input.connectionId],
    ["hostNonce", input.hostNonce],
    ["nodeNonce", input.nodeNonce],
    ["hostPublicKey", input.hostPublicKey],
    ["nodePublicKey", input.nodePublicKey],
    ["hostEphemeralPublicKey", input.hostEphemeralPublicKey],
    ["nodeEphemeralPublicKey", input.nodeEphemeralPublicKey],
    ["dialedHostUrl", input.dialedHostUrl],
  ]);
}

export type EphemeralKeyPair = { privateKey: KeyObject; publicKey: string };

export function createEphemeralKeyPair(): EphemeralKeyPair {
  const pair = generateKeyPairSync("x25519");
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

export type ChannelKeys = { hostToNode: Buffer; nodeToHost: Buffer };

const KEY_BYTES = 32;

/**
 * One shared secret, two keys.
 *
 * The transcript hash is the HKDF salt, so keys derived from the same X25519
 * exchange under a different handshake do not match — a replayed `host_challenge`
 * produces a channel the other end cannot read rather than one it can.
 */
export function deriveChannelKeys(input: {
  privateKey: KeyObject;
  peerPublicKey: string;
  transcript: Buffer;
}): ChannelKeys {
  const peer = createPublicKey({
    key: Buffer.from(input.peerPublicKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (peer.asymmetricKeyType !== "x25519") {
    throw new Error("An ephemeral key exchange needs an X25519 public key.");
  }
  const shared = diffieHellman({ privateKey: input.privateKey, publicKey: peer });
  const salt = createHash("sha256").update(input.transcript).digest();
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(info, "utf8"), KEY_BYTES));
  return {
    hostToNode: derive("fleet-host-to-node"),
    nodeToHost: derive("fleet-node-to-host"),
  };
}

export type ChannelDirection = "host-to-node" | "node-to-host";

export type ChannelBinding = {
  protocol: string;
  hostId: string;
  nodeId: string;
  connectionId: string;
};

export type ChannelFailure = "connection" | "sequence" | "authentication";

export type OpenedFrame =
  { ok: true; plaintext: string } | { ok: false; reason: ChannelFailure };

/** Four bytes of direction, eight of sequence: no nonce is ever reused. */
const DIRECTION_NONCE_PREFIX: Record<ChannelDirection, Buffer> = {
  "host-to-node": Buffer.from([0x48, 0x32, 0x4e, 0x01]),
  "node-to-host": Buffer.from([0x4e, 0x32, 0x48, 0x01]),
};

const TAG_BYTES = 16;

function channelNonce(direction: ChannelDirection, sequence: number): Buffer {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(sequence), 0);
  return Buffer.concat([DIRECTION_NONCE_PREFIX[direction], counter]);
}

function additionalData(binding: ChannelBinding, sequence: number): Buffer {
  return transcriptBytes(CHANNEL_AAD_LABEL, [
    ["protocol", binding.protocol],
    ["hostId", binding.hostId],
    ["nodeId", binding.nodeId],
    ["connectionId", binding.connectionId],
    ["sequence", String(sequence)],
  ]);
}

/**
 * One end of an authenticated, sequenced channel.
 *
 * Every application frame goes through here after the handshake, so the four
 * questions a receiver has — is this the peer, is this this connection, is this
 * the next thing they said, and has it been edited — are answered once, in one
 * place, rather than by each caller remembering to ask.
 *
 * A refusal is terminal: the counter does not advance past a frame that failed,
 * and the caller closes the connection. Resynchronising would be indistinguishable
 * from accepting whatever an attacker chose to drop or reorder.
 */
export class AuthenticatedChannel {
  private readonly keys: ChannelKeys;
  private readonly binding: ChannelBinding;
  private readonly seals: ChannelDirection;
  private readonly opens: ChannelDirection;
  private outgoing = 0;
  private incoming = 0;
  /**
   * The first refusal, kept so every later frame gets the same answer.
   *
   * The caller closes the connection on a refusal, but the channel must not
   * depend on that: resuming after a rejected frame would accept a stream an
   * attacker had chosen the shape of, which is the whole point of refusing.
   */
  private failure: ChannelFailure | undefined;

  constructor(input: {
    keys: ChannelKeys;
    binding: ChannelBinding;
    seals: ChannelDirection;
  }) {
    this.keys = input.keys;
    this.binding = input.binding;
    this.seals = input.seals;
    this.opens = input.seals === "host-to-node" ? "node-to-host" : "host-to-node";
  }

  private keyFor(direction: ChannelDirection): Buffer {
    return direction === "host-to-node" ? this.keys.hostToNode : this.keys.nodeToHost;
  }

  seal(plaintext: string): AuthenticatedEnvelope {
    const sequence = this.outgoing;
    this.outgoing += 1;
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.keyFor(this.seals),
      channelNonce(this.seals, sequence),
    );
    cipher.setAAD(additionalData(this.binding, sequence));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    return {
      type: "envelope",
      connectionId: this.binding.connectionId,
      sequence,
      ciphertext: ciphertext.toString("base64"),
      authenticationTag: cipher.getAuthTag().toString("base64"),
    };
  }

  open(envelope: AuthenticatedEnvelope): OpenedFrame {
    if (this.failure) return { ok: false, reason: this.failure };
    if (envelope.connectionId !== this.binding.connectionId) {
      return this.refuse("connection");
    }
    // Equality rather than "greater than": a gap is as much a broken stream as
    // a replay, and both are the peer failing to be the peer.
    if (envelope.sequence !== this.incoming) return this.refuse("sequence");
    const tag = Buffer.from(envelope.authenticationTag, "base64");
    if (tag.length !== TAG_BYTES) return this.refuse("authentication");
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.keyFor(this.opens),
        channelNonce(this.opens, envelope.sequence),
      );
      decipher.setAAD(additionalData(this.binding, envelope.sequence));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
    } catch {
      // Narrow on purpose: the only thing this can mean is that the tag did not
      // verify, and the answer is a refusal rather than anything that continues.
      return this.refuse("authentication");
    }
    this.incoming += 1;
    return { ok: true, plaintext: plaintext.toString("utf8") };
  }

  private refuse(reason: ChannelFailure): OpenedFrame {
    this.failure = reason;
    return { ok: false, reason };
  }
}
