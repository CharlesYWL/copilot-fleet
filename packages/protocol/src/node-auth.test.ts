import { createHash, createPrivateKey, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MUTUAL_AUTH_PROTOCOL } from "./index.js";
import {
  AuthenticatedChannel,
  CHANNEL_KEY_LABEL,
  ENROLLMENT_CHALLENGE_LABEL,
  ENROLLMENT_COMPLETION_LABEL,
  ENROLLMENT_GRANT_LABEL,
  HOST_CHALLENGE_LABEL,
  MAX_NODE_HTTP_PROOF_NONCE_LENGTH,
  NODE_HTTP_PROOF_WINDOW_MS,
  NODE_PROOF_LABEL,
  canonicalBodyHash,
  canonicalJson,
  createEphemeralKeyPair,
  createIdentityKeyPair,
  deriveChannelKeys,
  enrollmentReceiptTranscript,
  enrollmentTranscript,
  grantProof,
  grantSecretDigest,
  handshakeTranscript,
  identityFingerprint,
  registrationHash,
  signNodeHttpProof,
  signWithIdentity,
  transcriptBytes,
  verifyIdentitySignature,
  verifyNodeHttpProof,
  type IdentityKeyPair,
} from "./node-auth.js";

const enrollmentFields = {
  challengeId: "challenge-1",
  hostId: "host-1",
  hostNonce: randomBytes(32).toString("base64"),
  nodeNonce: randomBytes(32).toString("base64"),
  nodePublicKey: createIdentityKeyPair().publicKey,
  registrationHash: "a".repeat(64),
  dialedHostUrl: "https://fleet.example.com",
};

/**
 * Everything either side signs is a byte string, and the only thing that makes
 * a signature mean what it says is that nobody can produce the same bytes from
 * different fields. That is what these assert: a length prefix per field, a
 * domain per purpose, and a deterministic order.
 */
describe("transcript encoding", () => {
  it("produces the same bytes for the same fields every time", () => {
    const fields = [
      ["a", "one"],
      ["b", "two"],
    ] as const;
    expect(
      transcriptBytes("domain", fields).equals(transcriptBytes("domain", fields)),
    ).toBe(true);
  });

  it("cannot be made to agree by moving a delimiter into a value", () => {
    // Naive concatenation makes these two identical, which is how a signature
    // over "this key and this url" becomes a signature over somebody else's.
    const left = transcriptBytes("d", [
      ["nodeKey", "AAA"],
      ["url", "https://evil.example"],
    ]);
    const right = transcriptBytes("d", [
      ["nodeKey", "AAAurl"],
      ["", "https://evil.example"],
    ]);
    expect(left.equals(right)).toBe(false);
  });

  it("separates domains, so one purpose's signature is not another's", () => {
    const fields = [["a", "one"]] as const;
    expect(transcriptBytes("host", fields).equals(transcriptBytes("node", fields))).toBe(
      false,
    );
  });

  it("is binary safe: a value's bytes are carried, not its characters", () => {
    const value = Buffer.from([0, 1, 255, 254]).toString("base64");
    const encoded = transcriptBytes("d", [["v", value]]);
    expect(encoded.includes(Buffer.from(value, "utf8"))).toBe(true);
  });
});

describe("canonical JSON", () => {
  it("orders object keys so two spellings of one payload hash alike", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("keeps array order, which is part of the value", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("refuses values it cannot encode deterministically", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });

  it("hashes a registration payload independently of key order", () => {
    const payload = { name: "alpha", maxSessions: 2, capabilities: ["a", "b"] };
    const reordered = { capabilities: ["a", "b"], name: "alpha", maxSessions: 2 };
    expect(registrationHash(payload)).toBe(registrationHash(reordered));
    expect(registrationHash(payload)).toMatch(/^[a-f0-9]{64}$/);
    expect(registrationHash({ ...payload, name: "beta" })).not.toBe(
      registrationHash(payload),
    );
  });
});

describe("persistent identities", () => {
  it("mints an Ed25519 pair whose fingerprint is the digest of its public key", () => {
    const identity = createIdentityKeyPair();
    expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.fingerprint).toBe(
      createHash("sha256")
        .update(Buffer.from(identity.publicKey, "base64"))
        .digest("hex"),
    );
    expect(identityFingerprint(identity.publicKey)).toBe(identity.fingerprint);
    // PKCS8 for the private half, SPKI for the public one, both base64 DER.
    expect(() =>
      createPrivateKey({
        key: Buffer.from(identity.privateKey, "base64"),
        format: "der",
        type: "pkcs8",
      }),
    ).not.toThrow();
  });

  it("signs and verifies exactly the bytes it was given", () => {
    const identity = createIdentityKeyPair();
    const message = transcriptBytes("d", [["a", "one"]]);
    const signature = signWithIdentity(identity.privateKey, message);
    expect(verifyIdentitySignature(identity.publicKey, message, signature)).toBe(true);
    expect(
      verifyIdentitySignature(
        identity.publicKey,
        transcriptBytes("d", [["a", "two"]]),
        signature,
      ),
    ).toBe(false);
    expect(
      verifyIdentitySignature(createIdentityKeyPair().publicKey, message, signature),
    ).toBe(false);
  });

  it("answers false for a malformed key or signature instead of throwing", () => {
    const identity = createIdentityKeyPair();
    const message = transcriptBytes("d", [["a", "one"]]);
    expect(verifyIdentitySignature("not-a-key", message, "AAAA")).toBe(false);
    expect(verifyIdentitySignature(identity.publicKey, message, "AAAA")).toBe(false);
    expect(verifyIdentitySignature("", message, "")).toBe(false);
  });
});

/**
 * The enrollment transcript is what makes a one-time grant unusable for any
 * other Node key or any other Host: three parties sign over the same fields
 * under three different domains.
 */
describe("enrollment transcript", () => {
  it("binds the Host challenge, the Node completion and the grant apart", () => {
    const challenge = enrollmentTranscript(ENROLLMENT_CHALLENGE_LABEL, enrollmentFields);
    const completion = enrollmentTranscript(
      ENROLLMENT_COMPLETION_LABEL,
      enrollmentFields,
    );
    const grant = enrollmentTranscript(ENROLLMENT_GRANT_LABEL, enrollmentFields);
    expect(challenge.equals(completion)).toBe(false);
    expect(challenge.equals(grant)).toBe(false);
    expect(completion.equals(grant)).toBe(false);
  });

  it("changes when any bound field changes", () => {
    const base = enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, enrollmentFields);
    for (const field of [
      "challengeId",
      "hostId",
      "hostNonce",
      "nodeNonce",
      "nodePublicKey",
      "registrationHash",
      "dialedHostUrl",
    ] as const) {
      const altered = enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, {
        ...enrollmentFields,
        [field]: `${enrollmentFields[field]}x`,
      });
      expect(altered.equals(base), `${field} is not bound`).toBe(false);
    }
  });
});

/**
 * The receipt is the last frame of enrolment and the first thing a Node
 * persists, so it is the last place a relay can substitute itself. It is signed
 * over the transcript both ends already authenticated, plus the nodeId being
 * issued — which is what makes it un-swappable for another Node's receipt.
 */
describe("enrollment receipt transcript", () => {
  const receiptFields = { ...enrollmentFields, nodeId: "node-1" };

  it("is a different domain from every other enrollment signature", () => {
    const receipt = enrollmentReceiptTranscript(receiptFields);
    for (const label of [
      ENROLLMENT_CHALLENGE_LABEL,
      ENROLLMENT_COMPLETION_LABEL,
      ENROLLMENT_GRANT_LABEL,
    ]) {
      expect(receipt.equals(enrollmentTranscript(label, enrollmentFields))).toBe(false);
    }
  });

  it("binds the issued nodeId, so one Node's receipt is not another's", () => {
    const base = enrollmentReceiptTranscript(receiptFields);
    expect(
      enrollmentReceiptTranscript({ ...receiptFields, nodeId: "node-2" }).equals(base),
    ).toBe(false);
  });

  it("changes when any field of the original transcript changes", () => {
    const base = enrollmentReceiptTranscript(receiptFields);
    for (const field of [
      "challengeId",
      "hostId",
      "hostNonce",
      "nodeNonce",
      "nodePublicKey",
      "registrationHash",
      "dialedHostUrl",
    ] as const) {
      const altered = enrollmentReceiptTranscript({
        ...receiptFields,
        [field]: `${receiptFields[field]}x`,
      });
      expect(altered.equals(base), `${field} is not bound`).toBe(false);
    }
  });

  it("verifies only against the Host key that signed it", () => {
    const host = createIdentityKeyPair();
    const relay = createIdentityKeyPair();
    const transcript = enrollmentReceiptTranscript(receiptFields);
    const signature = signWithIdentity(host.privateKey, transcript);

    expect(verifyIdentitySignature(host.publicKey, transcript, signature)).toBe(true);
    expect(verifyIdentitySignature(relay.publicKey, transcript, signature)).toBe(false);
    expect(
      verifyIdentitySignature(
        host.publicKey,
        enrollmentReceiptTranscript({ ...receiptFields, nodeId: "node-2" }),
        signature,
      ),
    ).toBe(false);
  });
});

/**
 * The proof a keyed Node puts on the catalog calls its config page relays.
 *
 * A shared secret answered "who is calling" by handing the answer over on every
 * request; a signature answers it without ever sending anything reusable. What
 * has to be bound is everything the Host will act on — the method, the exact
 * path and the body — or a proof minted for a read is a proof for a write.
 */
describe("node HTTP proof", () => {
  const nodeId = "node-1";
  const at = Date.parse("2026-08-28T12:00:00.000Z");

  const proofFor = (
    keys: IdentityKeyPair,
    overrides: Partial<{ method: string; path: string; body: string; now: number }> = {},
  ) =>
    signNodeHttpProof({
      privateKey: keys.privateKey,
      nodeId,
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/api/workspaces",
      ...(overrides.body === undefined ? {} : { body: overrides.body }),
      now: overrides.now ?? at,
    });

  const verify = (
    keys: IdentityKeyPair,
    headers: ReturnType<typeof signNodeHttpProof>,
    overrides: Partial<{
      method: string;
      path: string;
      body: string;
      now: number;
      publicKey: string;
      nodeId: string;
    }> = {},
  ) =>
    verifyNodeHttpProof({
      publicKey: overrides.publicKey ?? keys.publicKey,
      nodeId: overrides.nodeId ?? nodeId,
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/api/workspaces",
      ...(overrides.body === undefined ? {} : { body: overrides.body }),
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      signature: headers.signature,
      now: overrides.now ?? at,
    });

  it("hashes an absent body the same way both ends do", () => {
    expect(canonicalBodyHash("")).toBe(createHash("sha256").update("").digest("hex"));
    expect(canonicalBodyHash(undefined)).toBe(canonicalBodyHash(""));
    expect(canonicalBodyHash('{"a":1}')).not.toBe(canonicalBodyHash('{"a":2}'));
  });

  it("verifies a proof the Node signed with the key the Host enrolled", () => {
    const keys = createIdentityKeyPair();
    const headers = proofFor(keys);

    expect(headers.nonce).not.toBe(proofFor(keys).nonce);
    expect(verify(keys, headers)).toEqual({ ok: true });
  });

  it("does not carry to another method, path, body or Node", () => {
    const keys = createIdentityKeyPair();
    const read = proofFor(keys);
    expect(verify(keys, read, { method: "POST" })).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verify(keys, read, { path: "/api/placements" })).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verify(keys, read, { nodeId: "node-2" })).toEqual({
      ok: false,
      reason: "signature",
    });

    const write = proofFor(keys, { method: "POST", body: '{"name":"a"}' });
    expect(
      verifyNodeHttpProof({
        publicKey: keys.publicKey,
        nodeId,
        method: "POST",
        path: "/api/workspaces",
        body: '{"name":"a"}',
        timestamp: write.timestamp,
        nonce: write.nonce,
        signature: write.signature,
        now: at,
      }),
    ).toEqual({ ok: true });
    // The body is bound, so a relay cannot rewrite what the Host will act on.
    expect(
      verifyNodeHttpProof({
        publicKey: keys.publicKey,
        nodeId,
        method: "POST",
        path: "/api/workspaces",
        body: '{"name":"b"}',
        timestamp: write.timestamp,
        nonce: write.nonce,
        signature: write.signature,
        now: at,
      }),
    ).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a proof signed by a key the Host did not enrol", () => {
    const keys = createIdentityKeyPair();
    expect(
      verify(keys, proofFor(keys), { publicKey: createIdentityKeyPair().publicKey }),
    ).toEqual({ ok: false, reason: "signature" });
    expect(verify(keys, proofFor(keys), { publicKey: "" })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a proof from outside a narrow clock window, in either direction", () => {
    const keys = createIdentityKeyPair();
    const headers = proofFor(keys);

    expect(verify(keys, headers, { now: at + NODE_HTTP_PROOF_WINDOW_MS - 1 })).toEqual({
      ok: true,
    });
    expect(verify(keys, headers, { now: at + NODE_HTTP_PROOF_WINDOW_MS + 1 })).toEqual({
      ok: false,
      reason: "clock",
    });
    // A timestamp from the future is as much a replay tool as a stale one.
    expect(verify(keys, headers, { now: at - NODE_HTTP_PROOF_WINDOW_MS - 1 })).toEqual({
      ok: false,
      reason: "clock",
    });
  });

  it("refuses anything that is not a proof at all", () => {
    const keys = createIdentityKeyPair();
    const headers = proofFor(keys);
    const bad = (overrides: Record<string, string>) =>
      verifyNodeHttpProof({
        publicKey: keys.publicKey,
        nodeId,
        method: "GET",
        path: "/api/workspaces",
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        signature: headers.signature,
        now: at,
        ...overrides,
      });

    expect(bad({ timestamp: "not-a-number" })).toEqual({ ok: false, reason: "clock" });
    expect(bad({ timestamp: "" })).toEqual({ ok: false, reason: "clock" });
    expect(bad({ nonce: "" })).toEqual({ ok: false, reason: "malformed" });
    expect(bad({ nonce: "n".repeat(MAX_NODE_HTTP_PROOF_NONCE_LENGTH + 1) })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(bad({ signature: "" })).toEqual({ ok: false, reason: "malformed" });
    expect(bad({ signature: "not-base64!!" })).toEqual({
      ok: false,
      reason: "signature",
    });
  });
});

describe("grant proof", () => {
  it("keys the HMAC with the digest the Host stores, not the secret", () => {
    const secret = randomBytes(32).toString("base64url");
    const digest = grantSecretDigest(secret);
    expect(digest).toBe(createHash("sha256").update(secret).digest("hex"));

    const transcript = enrollmentTranscript(ENROLLMENT_GRANT_LABEL, enrollmentFields);
    // The Node holds the secret; the Host holds only the digest. Both arrive at
    // the same proof, which is the only reason the Host can check it at all.
    expect(grantProof(digest, transcript)).toBe(
      grantProof(grantSecretDigest(secret), transcript),
    );
  });

  it("does not carry to another transcript", () => {
    const digest = grantSecretDigest("secret-value");
    const mine = enrollmentTranscript(ENROLLMENT_GRANT_LABEL, enrollmentFields);
    const theirs = enrollmentTranscript(ENROLLMENT_GRANT_LABEL, {
      ...enrollmentFields,
      nodePublicKey: createIdentityKeyPair().publicKey,
    });
    expect(grantProof(digest, mine)).not.toBe(grantProof(digest, theirs));
  });
});

const handshakeFields = () => {
  const hostEphemeral = createEphemeralKeyPair();
  const nodeEphemeral = createEphemeralKeyPair();
  return {
    hostEphemeral,
    nodeEphemeral,
    transcript: {
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId: "host-1",
      nodeId: "node-1",
      connectionId: "connection-1",
      hostNonce: randomBytes(32).toString("base64"),
      nodeNonce: randomBytes(32).toString("base64"),
      hostPublicKey: createIdentityKeyPair().publicKey,
      nodePublicKey: createIdentityKeyPair().publicKey,
      hostEphemeralPublicKey: hostEphemeral.publicKey,
      nodeEphemeralPublicKey: nodeEphemeral.publicKey,
      dialedHostUrl: "https://fleet.example.com",
    },
  };
};

describe("handshake key agreement", () => {
  it("derives the same directional keys on both ends", () => {
    const { hostEphemeral, nodeEphemeral, transcript } = handshakeFields();
    const bytes = handshakeTranscript(CHANNEL_KEY_LABEL, transcript);
    const host = deriveChannelKeys({
      privateKey: hostEphemeral.privateKey,
      peerPublicKey: nodeEphemeral.publicKey,
      transcript: bytes,
    });
    const node = deriveChannelKeys({
      privateKey: nodeEphemeral.privateKey,
      peerPublicKey: hostEphemeral.publicKey,
      transcript: bytes,
    });

    expect(host.hostToNode.equals(node.hostToNode)).toBe(true);
    expect(host.nodeToHost.equals(node.nodeToHost)).toBe(true);
    // Two directions, two keys: one compromised direction is not both.
    expect(host.hostToNode.equals(host.nodeToHost)).toBe(false);
    expect(host.hostToNode).toHaveLength(32);
  });

  it("derives different keys when the transcript differs", () => {
    const { hostEphemeral, nodeEphemeral, transcript } = handshakeFields();
    const mine = deriveChannelKeys({
      privateKey: hostEphemeral.privateKey,
      peerPublicKey: nodeEphemeral.publicKey,
      transcript: handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
    });
    const tampered = deriveChannelKeys({
      privateKey: hostEphemeral.privateKey,
      peerPublicKey: nodeEphemeral.publicKey,
      transcript: handshakeTranscript(CHANNEL_KEY_LABEL, {
        ...transcript,
        connectionId: "connection-2",
      }),
    });
    expect(mine.hostToNode.equals(tampered.hostToNode)).toBe(false);
  });

  it("refuses a peer key that is not an X25519 public key", () => {
    const { hostEphemeral, transcript } = handshakeFields();
    expect(() =>
      deriveChannelKeys({
        privateKey: hostEphemeral.privateKey,
        peerPublicKey: "not-a-key",
        transcript: handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
      }),
    ).toThrow();
    expect(() =>
      deriveChannelKeys({
        privateKey: hostEphemeral.privateKey,
        // An Ed25519 key is the right shape and the wrong curve.
        peerPublicKey: createIdentityKeyPair().publicKey,
        transcript: handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
      }),
    ).toThrow();
  });

  it("signs the Host challenge and the Node proof under different domains", () => {
    const { transcript } = handshakeFields();
    expect(
      handshakeTranscript(HOST_CHALLENGE_LABEL, transcript).equals(
        handshakeTranscript(NODE_PROOF_LABEL, transcript),
      ),
    ).toBe(false);
    expect(
      handshakeTranscript(HOST_CHALLENGE_LABEL, transcript).equals(
        handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
      ),
    ).toBe(false);
  });

  it("binds every handshake field, so nothing can be swapped in flight", () => {
    const { transcript } = handshakeFields();
    const base = handshakeTranscript(HOST_CHALLENGE_LABEL, transcript);
    for (const field of Object.keys(transcript) as (keyof typeof transcript)[]) {
      const altered = handshakeTranscript(HOST_CHALLENGE_LABEL, {
        ...transcript,
        [field]: `${transcript[field]}x`,
      });
      expect(altered.equals(base), `${String(field)} is not bound`).toBe(false);
    }
  });
});

function channelPair() {
  const { hostEphemeral, nodeEphemeral, transcript } = handshakeFields();
  const bytes = handshakeTranscript(CHANNEL_KEY_LABEL, transcript);
  const keys = deriveChannelKeys({
    privateKey: hostEphemeral.privateKey,
    peerPublicKey: nodeEphemeral.publicKey,
    transcript: bytes,
  });
  const binding = {
    protocol: MUTUAL_AUTH_PROTOCOL,
    hostId: transcript.hostId,
    nodeId: transcript.nodeId,
    connectionId: transcript.connectionId,
  };
  return {
    binding,
    keys,
    host: new AuthenticatedChannel({ keys, binding, seals: "host-to-node" }),
    node: new AuthenticatedChannel({ keys, binding, seals: "node-to-host" }),
  };
}

/**
 * The envelope is the only thing either end reads after the handshake, so it
 * has to carry the whole answer: is this from the peer, is it this connection,
 * is it the next thing they said, and has it been edited.
 */
describe("authenticated envelopes", () => {
  it("carries a frame from one end to the other", () => {
    const { host, node } = channelPair();
    const sealed = host.seal(JSON.stringify({ type: "welcome", nodeId: "node-1" }));

    expect(sealed.type).toBe("envelope");
    expect(sealed.connectionId).toBe("connection-1");
    expect(sealed.sequence).toBe(0);
    // Nothing recognisable survives into the frame that goes on the wire.
    expect(sealed.ciphertext).not.toContain("welcome");

    const opened = node.open(sealed);
    expect(opened.ok && JSON.parse(opened.plaintext)).toEqual({
      type: "welcome",
      nodeId: "node-1",
    });
  });

  it("numbers each direction independently and strictly upwards", () => {
    const { host, node } = channelPair();
    expect(host.seal("a").sequence).toBe(0);
    expect(host.seal("b").sequence).toBe(1);
    // The Node's own counter is untouched by what the Host has sent.
    expect(node.seal("c").sequence).toBe(0);
  });

  it("refuses a replayed envelope", () => {
    const { host, node } = channelPair();
    const first = host.seal("a");
    expect(node.open(first).ok).toBe(true);
    const replayed = node.open(first);
    expect(replayed.ok).toBe(false);
    expect(!replayed.ok && replayed.reason).toBe("sequence");
  });

  it("refuses a gap and refuses arrival out of order", () => {
    const { host, node } = channelPair();
    const first = host.seal("a");
    const second = host.seal("b");
    // The second frame alone: the first is missing, so the stream is not the
    // one that was authenticated.
    expect(node.open(second).ok).toBe(false);
    // And having refused, the channel does not quietly resynchronise.
    expect(node.open(first).ok).toBe(false);
  });

  it("refuses a tampered ciphertext or tag", () => {
    const { host, node } = channelPair();
    const sealed = host.seal("hello");
    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const edited = node.open({ ...sealed, ciphertext: flipped.toString("base64") });
    expect(edited.ok).toBe(false);
    expect(!edited.ok && edited.reason).toBe("authentication");

    const { host: host2, node: node2 } = channelPair();
    const sealed2 = host2.seal("hello");
    expect(
      node2.open({ ...sealed2, authenticationTag: randomBytes(16).toString("base64") })
        .ok,
    ).toBe(false);
  });

  it("refuses an envelope addressed to another connection", () => {
    const { host, node } = channelPair();
    const sealed = host.seal("hello");
    const wrong = node.open({ ...sealed, connectionId: "connection-2" });
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.reason).toBe("connection");
  });

  it("refuses an envelope sealed under another node's binding", () => {
    const { keys, binding } = channelPair();
    const impostor = new AuthenticatedChannel({
      keys,
      binding: { ...binding, nodeId: "node-2" },
      seals: "host-to-node",
    });
    const receiver = new AuthenticatedChannel({ keys, binding, seals: "node-to-host" });
    // Same keys, different authenticated data: the tag cannot verify.
    const opened = receiver.open(impostor.seal("hello"));
    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.reason).toBe("authentication");
  });

  it("refuses an envelope from a relay that never had the keys", () => {
    const { node } = channelPair();
    const other = channelPair();
    expect(node.open(other.host.seal("hello")).ok).toBe(false);
  });

  it("gives each frame its own nonce, derived from direction and sequence", () => {
    const { host, node } = channelPair();
    const first = host.seal("same");
    const second = host.seal("same");
    // Identical plaintext, different keystream: a repeated nonce under one key
    // is the failure mode GCM does not survive.
    expect(first.ciphertext).not.toBe(second.ciphertext);
    // And the two directions do not share a nonce space either.
    expect(node.seal("same").ciphertext).not.toBe(first.ciphertext);
  });
});
