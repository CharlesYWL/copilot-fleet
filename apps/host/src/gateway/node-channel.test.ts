import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MUTUAL_AUTH_PROTOCOL, type NodeClientHello } from "@fleet/protocol";
import {
  NODE_PROOF_LABEL,
  createEphemeralKeyPair,
  createIdentityKeyPair,
  handshakeTranscript,
  identityFingerprint,
  signWithIdentity,
  type HandshakeTranscriptInput,
} from "@fleet/protocol/node-auth";
import { HostChannelHandshake } from "./node-channel.js";

/**
 * The handshake is reached before anything has authenticated.
 *
 * Every field in `client_hello` arrives from whoever opened the socket, and
 * schema validation only says a value is a base64 string of a plausible length
 * — not that it decodes to an X25519 point. So the crypto underneath can be
 * handed rubbish by design, and what it does then is the whole question: a
 * throw here is not a refused connection, it is an exception raised inside a
 * WebSocket `message` listener, which no caller is in a position to catch.
 */
const hostKeys = createIdentityKeyPair();

const identity = {
  hostId: "host-1",
  publicKey: hostKeys.publicKey,
  fingerprint: identityFingerprint(hostKeys.publicKey),
};

const handshake = (sign?: (message: Buffer) => string) =>
  new HostChannelHandshake({
    identity,
    sign: sign ?? ((message) => signWithIdentity(hostKeys.privateKey, message)),
  });

const hello = (overrides: Partial<NodeClientHello> = {}): NodeClientHello => ({
  type: "client_hello",
  protocol: MUTUAL_AUTH_PROTOCOL,
  nodeId: "node-1",
  hostId: identity.hostId,
  nodeNonce: randomBytes(32).toString("base64"),
  nodeEphemeralPublicKey: createEphemeralKeyPair().publicKey,
  dialedHostUrl: "https://fleet.example.com",
  ...overrides,
});

describe("HostChannelHandshake.begin", () => {
  it("answers a well-formed hello with a signed challenge", () => {
    const nodeKeys = createIdentityKeyPair();
    const begun = handshake().begin(hello(), nodeKeys.publicKey);
    expect(begun.ok).toBe(true);
  });

  /*
   * Signing is a call into the platform's crypto over a key this Host read at
   * startup, and a Host whose key file was replaced under it — by a half-
   * finished restore, by a disk that lost the row — fails on the next
   * connection. That is a connection to refuse, not a process to end.
   */
  it("refuses rather than throws when the Host cannot sign", () => {
    const refusing = handshake(() => {
      throw new Error("host key is unusable");
    });
    const begun = refusing.begin(hello(), createIdentityKeyPair().publicKey);
    expect(begun.ok).toBe(false);
    expect(begun.ok === false && begun.reason).toMatch(/challenge|sign/i);
  });
});

describe("HostChannelHandshake.finish", () => {
  /** Everything a genuine Node computes, so a single field can be spoiled. */
  const exchange = (nodeEphemeralPublicKey: string) => {
    const nodeKeys = createIdentityKeyPair();
    const session = handshake();
    const opening = hello({ nodeEphemeralPublicKey });
    const begun = session.begin(opening, nodeKeys.publicKey);
    if (!begun.ok) throw new Error(`begin refused: ${begun.reason}`);
    const transcript: HandshakeTranscriptInput = {
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId: identity.hostId,
      nodeId: opening.nodeId,
      connectionId: begun.challenge.connectionId,
      hostNonce: begun.challenge.hostNonce,
      nodeNonce: opening.nodeNonce,
      hostPublicKey: identity.publicKey,
      nodePublicKey: nodeKeys.publicKey,
      hostEphemeralPublicKey: begun.challenge.hostEphemeralPublicKey,
      nodeEphemeralPublicKey,
      dialedHostUrl: opening.dialedHostUrl,
    };
    return {
      session,
      signature: signWithIdentity(
        nodeKeys.privateKey,
        handshakeTranscript(NODE_PROOF_LABEL, transcript),
      ),
    };
  };

  it("derives a channel from a real ephemeral key", () => {
    const { session, signature } = exchange(createEphemeralKeyPair().publicKey);
    expect(session.finish(signature).ok).toBe(true);
  });

  /*
   * The three shapes a schema-valid ephemeral key can take and still not be
   * one: base64 of something that is not DER, DER of a key that is not
   * X25519, and a truncated point. Each of them reaches `createPublicKey` or
   * `diffieHellman`, and each of them used to throw straight out of the
   * socket's `message` listener.
   */
  it.each([
    ["base64 that is not a key at all", Buffer.from("not-a-key").toString("base64")],
    ["an Ed25519 key where an X25519 one belongs", createIdentityKeyPair().publicKey],
    ["a truncated point", createEphemeralKeyPair().publicKey.slice(0, 8)],
  ])("refuses %s instead of throwing", (_case, ephemeral) => {
    const { session, signature } = exchange(ephemeral);
    const finished = session.finish(signature);
    expect(finished.ok).toBe(false);
    expect(finished.ok === false && finished.reason).toBeTruthy();
  });

  it("refuses a proof when no challenge was ever issued", () => {
    const finished = handshake().finish("anything");
    expect(finished.ok).toBe(false);
  });
});
