import { describe, expect, it } from "vitest";
import {
  AuthenticatedEnvelopeSchema,
  ConnectCommandSchema,
  EnrollNodeSchema,
  HostBackupNodeSchema,
  HostChallengeSchema,
  HostToNodeMessageSchema,
  MAX_AUTHENTICATED_CIPHERTEXT_LENGTH,
  MUTUAL_AUTH_PROTOCOL,
  NodeClientHelloSchema,
  NodeEnrollmentChallengeResponseSchema,
  NodeEnrollmentChallengeSchema,
  NodeEnrollmentReceiptSchema,
  NodeFirstFrameSchema,
  NodeProofSchema,
  RegisterNodeSchema,
  SecurityBackupNodeAuthSchema,
  formatEnrollmentGrant,
  parseEnrollmentGrant,
} from "./index.js";

const base64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
const digest = "a".repeat(64);

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

/**
 * The Connect card is the only place a grant, a Host id and a fingerprint ever
 * travel together, and a Node pins the fingerprint before it says anything. A
 * field missing here is a Node that cannot tell the Host from a relay.
 */
describe("connect command contract", () => {
  it("carries the Host identity a Node has to pin, plus a one-time grant", () => {
    const parsed = ConnectCommandSchema.parse({
      hostUrl: "https://fleet.example.com",
      hostId: "host-1",
      hostFingerprint: digest,
      enrollmentGrant: "grant-1.secret-value",
      tunnelId: "quiet-tunnel",
    });
    expect(parsed.hostId).toBe("host-1");
    expect(parsed.hostFingerprint).toBe(digest);
    expect(parsed.enrollmentGrant).toBe("grant-1.secret-value");
    expect(parsed.tunnelId).toBe("quiet-tunnel");
  });

  it("has nowhere to put a fleet-wide enrollment token", () => {
    const parsed = ConnectCommandSchema.parse({
      hostUrl: "https://fleet.example.com",
      hostId: "host-1",
      hostFingerprint: digest,
      enrollmentGrant: "grant-1.secret-value",
      enrollmentToken: "legacy-fleet-token",
    });
    expect("enrollmentToken" in parsed).toBe(false);
  });

  it("refuses a fingerprint that is not a SHA-256 digest", () => {
    expect(
      ConnectCommandSchema.safeParse({
        hostUrl: "https://fleet.example.com",
        hostId: "host-1",
        hostFingerprint: "short",
        enrollmentGrant: "grant-1.secret-value",
      }).success,
    ).toBe(false);
  });

  it("splits a grant into its id and its secret, and refuses the malformed", () => {
    expect(formatEnrollmentGrant("grant-1", "secret-value")).toBe("grant-1.secret-value");
    expect(parseEnrollmentGrant("grant-1.secret-value")).toEqual({
      id: "grant-1",
      secret: "secret-value",
    });
    expect(parseEnrollmentGrant("no-separator")).toBeUndefined();
    expect(parseEnrollmentGrant(".secret")).toBeUndefined();
    expect(parseEnrollmentGrant("grant-1.")).toBeUndefined();
    expect(parseEnrollmentGrant("")).toBeUndefined();
  });
});

describe("enrollment messages", () => {
  it("asks for a challenge with the grant id and nothing that unlocks it", () => {
    const parsed = NodeEnrollmentChallengeSchema.parse({
      grantId: "grant-1",
      nodeNonce: base64(32),
      nodePublicKey: base64(44),
      registrationHash: digest,
      dialedHostUrl: "https://fleet.example.com",
      grantSecret: "leaked",
    });
    // The secret is a key, not a field: the challenge endpoint never sees it.
    expect("grantSecret" in parsed).toBe(false);
    expect(parsed.grantId).toBe("grant-1");
  });

  it("answers with the Host identity and a signature over the transcript", () => {
    const parsed = NodeEnrollmentChallengeResponseSchema.parse({
      challengeId: "challenge-1",
      hostId: "host-1",
      hostPublicKey: base64(44),
      hostFingerprint: digest,
      hostNonce: base64(32),
      expiresAt: "2026-08-28T12:15:00.000Z",
      signature: base64(64),
    });
    expect(parsed.hostFingerprint).toBe(digest);
    expect(parsed.signature).toBe(base64(64));
  });

  it("completes with the exact payload the hash promised, signed and proved", () => {
    const parsed = EnrollNodeSchema.parse({
      challengeId: "challenge-1",
      registration,
      nodeSignature: base64(64),
      grantProof: base64(32),
    });
    expect(parsed.registration.name).toBe("alpha");
    expect(parsed.grantProof).toBe(base64(32));
  });

  it("issues a receipt naming the protocol, and never a reusable secret", () => {
    const parsed = NodeEnrollmentReceiptSchema.parse({
      nodeId: "node-1",
      challengeId: "challenge-1",
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      hostId: "host-1",
      hostPublicKey: base64(44),
      hostFingerprint: digest,
      signature: base64(64),
      secret: "reusable",
    });
    expect(parsed.authProtocol).toBe("mutual-auth-v1");
    expect("secret" in parsed).toBe(false);
  });

  /**
   * A receipt is the last frame of enrolment and the first thing the Node
   * writes to disk. Unsigned, it is the one field a relay could still choose:
   * it names the Host the Node pins and the id it answers to from then on.
   */
  it("refuses a receipt with nothing tying it to the challenge it answers", () => {
    const receipt = {
      nodeId: "node-1",
      challengeId: "challenge-1",
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      hostId: "host-1",
      hostPublicKey: base64(44),
      hostFingerprint: digest,
      signature: base64(64),
    };
    expect(NodeEnrollmentReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const field of ["challengeId", "signature"] as const) {
      const { [field]: _removed, ...without } = receipt;
      expect(
        NodeEnrollmentReceiptSchema.safeParse(without).success,
        `${field} is optional`,
      ).toBe(false);
    }
  });

  it("keeps the legacy token registration for Nodes that still have one", () => {
    const parsed = RegisterNodeSchema.parse({ ...registration, enrollmentToken: "t" });
    expect(parsed.enrollmentToken).toBe("t");
    // And a key-based completion is not a token registration.
    expect(RegisterNodeSchema.safeParse({ ...registration }).success).toBe(false);
  });
});

describe("mutual authentication frames", () => {
  it("accepts either a legacy hello or a client_hello as the first frame", () => {
    const legacy = NodeFirstFrameSchema.safeParse({
      type: "hello",
      nodeId: "node-1",
      secret: "s",
      os: "linux",
      arch: "x64",
      version: "0.3.0",
      capabilities: [],
      maxSessions: 1,
    });
    expect(legacy.success).toBe(true);

    const modern = NodeFirstFrameSchema.safeParse({
      type: "client_hello",
      protocol: MUTUAL_AUTH_PROTOCOL,
      nodeId: "node-1",
      hostId: "host-1",
      nodeNonce: base64(32),
      nodeEphemeralPublicKey: base64(44),
      dialedHostUrl: "https://fleet.example.com",
    });
    expect(modern.success).toBe(true);
    expect(NodeFirstFrameSchema.safeParse({ type: "heartbeat" }).success).toBe(false);
  });

  it("refuses a client_hello that names another protocol version", () => {
    expect(
      NodeClientHelloSchema.safeParse({
        type: "client_hello",
        protocol: "mutual-auth-v0",
        nodeId: "node-1",
        hostId: "host-1",
        nodeNonce: base64(32),
        nodeEphemeralPublicKey: base64(44),
      }).success,
    ).toBe(false);
  });

  it("carries no Node secret in the new first frame", () => {
    const parsed = NodeClientHelloSchema.parse({
      type: "client_hello",
      protocol: MUTUAL_AUTH_PROTOCOL,
      nodeId: "node-1",
      hostId: "host-1",
      nodeNonce: base64(32),
      nodeEphemeralPublicKey: base64(44),
      secret: "reusable",
    });
    expect("secret" in parsed).toBe(false);
  });

  it("describes the Host challenge a Node checks before it proves anything", () => {
    const parsed = HostChallengeSchema.parse({
      type: "host_challenge",
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId: "host-1",
      hostPublicKey: base64(44),
      hostFingerprint: digest,
      hostNonce: base64(32),
      connectionId: "connection-1",
      hostEphemeralPublicKey: base64(44),
      signature: base64(64),
    });
    expect(parsed.connectionId).toBe("connection-1");
    expect(
      NodeProofSchema.parse({ type: "node_proof", signature: base64(64) }).type,
    ).toBe("node_proof");
  });

  it("bounds an envelope and requires a whole, non-negative sequence", () => {
    const envelope = {
      type: "envelope",
      connectionId: "connection-1",
      sequence: 0,
      ciphertext: base64(32),
      authenticationTag: base64(16),
    };
    expect(AuthenticatedEnvelopeSchema.parse(envelope).sequence).toBe(0);
    expect(
      AuthenticatedEnvelopeSchema.safeParse({ ...envelope, sequence: -1 }).success,
    ).toBe(false);
    expect(
      AuthenticatedEnvelopeSchema.safeParse({ ...envelope, sequence: 1.5 }).success,
    ).toBe(false);
    expect(
      AuthenticatedEnvelopeSchema.safeParse({
        ...envelope,
        ciphertext: "A".repeat(MAX_AUTHENTICATED_CIPHERTEXT_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      AuthenticatedEnvelopeSchema.safeParse({ ...envelope, authenticationTag: "" })
        .success,
    ).toBe(false);
  });
});

describe("node authentication records in a portable backup", () => {
  it("carries a key-based Node's protocol and public key", () => {
    const parsed = SecurityBackupNodeAuthSchema.parse({
      nodeId: "node-1",
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      publicKey: base64(44),
    });
    expect(parsed.authProtocol).toBe("mutual-auth-v1");
    expect(parsed.publicKey).toBe(base64(44));
    // The legacy hash still has a home: migration is not finished until every
    // Node has upgraded, and until then the old proof is the only one there is.
    expect(parsed.secretHash).toBe("");
  });

  it("still reads a record written before Node keys existed", () => {
    expect(
      SecurityBackupNodeAuthSchema.parse({ nodeId: "node-1", secretHash: digest }),
    ).toEqual({
      nodeId: "node-1",
      authProtocol: "legacy-secret",
      secretHash: digest,
      publicKey: "",
    });
  });

  /**
   * An empty hash means "this machine proves itself with a key". On a legacy
   * row it means the archive would restore a Node nothing can authenticate,
   * which is a machine the operator has to re-enrol without being told why.
   */
  it("lets a hash be empty only for a Node that has a key instead", () => {
    expect(
      SecurityBackupNodeAuthSchema.safeParse({
        nodeId: "node-1",
        authProtocol: "legacy-secret",
        secretHash: "",
      }).success,
    ).toBe(false);
    expect(
      SecurityBackupNodeAuthSchema.safeParse({
        nodeId: "node-1",
        authProtocol: "legacy-secret",
        secretHash: "not-a-digest",
      }).success,
    ).toBe(false);
    // A machine mid-migration keeps both until enforcement deletes the hash.
    expect(
      SecurityBackupNodeAuthSchema.safeParse({
        nodeId: "node-1",
        authProtocol: MUTUAL_AUTH_PROTOCOL,
        secretHash: digest,
        publicKey: base64(44),
      }).success,
    ).toBe(true);
  });

  it("holds a version 1 archive to the same rule", () => {
    const node = {
      id: "node-1",
      name: "alpha",
      os: "linux",
      arch: "x64",
      version: "0.3.0",
      capabilities: [],
      maxSessions: 2,
      activeSessions: 0,
      lastHeartbeat: "2026-08-28T12:00:00.000Z",
      online: false,
      position: 0,
    };
    expect(HostBackupNodeSchema.safeParse({ ...node, secretHash: digest }).success).toBe(
      true,
    );
    expect(HostBackupNodeSchema.safeParse({ ...node, secretHash: "" }).success).toBe(
      false,
    );
    expect(
      HostBackupNodeSchema.safeParse({
        ...node,
        authProtocol: MUTUAL_AUTH_PROTOCOL,
        secretHash: "",
      }).success,
    ).toBe(true);
  });

  it("refuses a protocol nobody implements", () => {
    expect(
      SecurityBackupNodeAuthSchema.safeParse({
        nodeId: "node-1",
        authProtocol: "trust-me",
      }).success,
    ).toBe(false);
  });
});

/**
 * The Host's half of the two-phase key migration.
 *
 * A Node that discarded its shared secret the moment it generated a key pair
 * would be locked out of its own fleet by one dropped frame, so the Host has to
 * say which key it recorded — and say it in a frame that names that exact key.
 */
describe("node key acknowledgement", () => {
  it("names the public key the Host recorded", () => {
    const parsed = HostToNodeMessageSchema.parse({
      type: "node_key_accepted",
      publicKey: base64(44),
    });
    expect(parsed).toEqual({ type: "node_key_accepted", publicKey: base64(44) });
  });

  it("is not an acknowledgement without one", () => {
    expect(HostToNodeMessageSchema.safeParse({ type: "node_key_accepted" }).success).toBe(
      false,
    );
    expect(
      HostToNodeMessageSchema.safeParse({ type: "node_key_accepted", publicKey: "" })
        .success,
    ).toBe(false);
  });
});
