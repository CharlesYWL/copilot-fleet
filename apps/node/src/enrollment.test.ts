import { describe, expect, it, vi } from "vitest";
import {
  MUTUAL_AUTH_PROTOCOL,
  formatEnrollmentGrant,
  type HostChallenge,
  type NodeEnrollmentChallengeResponse,
} from "@fleet/protocol";
import {
  AuthenticatedChannel,
  CHANNEL_KEY_LABEL,
  ENROLLMENT_CHALLENGE_LABEL,
  ENROLLMENT_COMPLETION_LABEL,
  ENROLLMENT_GRANT_LABEL,
  HOST_CHALLENGE_LABEL,
  NODE_PROOF_LABEL,
  createEphemeralKeyPair,
  createIdentityKeyPair,
  deriveChannelKeys,
  enrollmentReceiptTranscript,
  enrollmentTranscript,
  grantProof,
  grantSecretDigest,
  handshakeTranscript,
  registrationHash,
  signWithIdentity,
  verifyIdentitySignature,
  type EnrollmentTranscriptInput,
} from "@fleet/protocol/node-auth";
import { randomBytes } from "node:crypto";
import {
  HostFingerprintMismatchError,
  ensureNodeCredentials,
  enrollWithGrant,
  keyEnrollmentTuple,
  openNodeChannel,
  planCredentials,
  registerWithToken,
} from "./enrollment.js";

const host = createIdentityKeyPair();
const HOST_ID = "host-1";
const HOST_URL = "https://fleet.example.com";

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

/** Every challenge this stub has issued, so a receipt can be signed over one. */
const challenges = new Map<string, EnrollmentTranscriptInput>();

/**
 * A Host that answers the way a real one does, so the Node's half can be
 * exercised without a server — including the ways a relay would answer.
 */
function hostFetch(
  options: {
    hostKeys?: typeof host;
    /** The id the Host says it recorded, which a reclaim keeps. */
    nodeId?: string;
    /** Overrides applied to the receipt after it has been signed honestly. */
    receipt?: (receipt: Record<string, unknown>) => Record<string, unknown>;
    /** Signs the receipt with this key instead, as a relay would have to. */
    receiptSigner?: typeof host;
  } = {},
) {
  const keys = options.hostKeys ?? host;
  const nodeId = options.nodeId ?? "node-1";
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ url: String(url), body });
    if (String(url).endsWith("/api/nodes/enrollment/challenge")) {
      const fields = {
        challengeId: "challenge-1",
        hostId: HOST_ID,
        hostNonce: randomBytes(32).toString("base64"),
        nodeNonce: String(body.nodeNonce),
        nodePublicKey: String(body.nodePublicKey),
        registrationHash: String(body.registrationHash),
        dialedHostUrl: String(body.dialedHostUrl),
      };
      challenges.set(fields.challengeId, fields);
      const response: NodeEnrollmentChallengeResponse = {
        challengeId: fields.challengeId,
        hostId: HOST_ID,
        hostPublicKey: keys.publicKey,
        hostFingerprint: keys.fingerprint,
        hostNonce: fields.hostNonce,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        signature: signWithIdentity(
          keys.privateKey,
          enrollmentTranscript(ENROLLMENT_CHALLENGE_LABEL, fields),
        ),
      };
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      };
    }
    const fields = challenges.get(String(body.challengeId));
    if (!fields) throw new Error("completion for a challenge that was never issued");
    const signer = options.receiptSigner ?? keys;
    const receipt: Record<string, unknown> = {
      nodeId,
      challengeId: fields.challengeId,
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      hostId: HOST_ID,
      hostPublicKey: keys.publicKey,
      hostFingerprint: keys.fingerprint,
      signature: signWithIdentity(
        signer.privateKey,
        enrollmentReceiptTranscript({ ...fields, nodeId }),
      ),
    };
    const answered = options.receipt ? options.receipt(receipt) : receipt;
    return {
      ok: true,
      status: 201,
      json: async () => answered,
      text: async () => JSON.stringify(answered),
    };
  });
  return { fetcher, seen };
}

/**
 * The Node's half of enrolment.
 *
 * The whole reason this exists is that the old path sent a reusable credential
 * to whatever answered the URL. These assert the reversal: the Node commits to
 * a key it generated, checks the Host against a fingerprint it was given out of
 * band, and proves the grant only over a transcript the Host has already signed.
 */
describe("enrolling with a grant", () => {
  it("generates a key pair and never sends the private half", async () => {
    const grantSecret = randomBytes(32).toString("base64url");
    const { fetcher, seen } = hostFetch();

    const result = await enrollWithGrant({
      hostUrl: HOST_URL,
      hostId: HOST_ID,
      hostFingerprint: host.fingerprint,
      grant: formatEnrollmentGrant("grant-1", grantSecret),
      registration,
      fetch: fetcher,
    });

    expect(result.credentials.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    if (result.credentials.authProtocol !== MUTUAL_AUTH_PROTOCOL) {
      throw new Error("wrong protocol");
    }
    expect(result.credentials.nodeId).toBe("node-1");
    expect(result.credentials.host.fingerprint).toBe(host.fingerprint);
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain(result.credentials.privateKey);
    // The grant secret is an HMAC key, not a field.
    expect(sent).not.toContain(grantSecret);
  });

  it("commits to the registration payload before the Host answers", async () => {
    const grantSecret = randomBytes(32).toString("base64url");
    const { fetcher, seen } = hostFetch();

    await enrollWithGrant({
      hostUrl: HOST_URL,
      hostId: HOST_ID,
      hostFingerprint: host.fingerprint,
      grant: formatEnrollmentGrant("grant-1", grantSecret),
      registration,
      fetch: fetcher,
    });

    expect(seen[0]?.body.registrationHash).toBe(registrationHash(registration));
    expect(seen[1]?.body.registration).toEqual(registration);
    expect(seen[1]?.body.challengeId).toBe("challenge-1");
  });

  it("proves the grant and its own key over the Host's transcript", async () => {
    const grantSecret = randomBytes(32).toString("base64url");
    const { fetcher, seen } = hostFetch();

    const result = await enrollWithGrant({
      hostUrl: HOST_URL,
      hostId: HOST_ID,
      hostFingerprint: host.fingerprint,
      grant: formatEnrollmentGrant("grant-1", grantSecret),
      registration,
      fetch: fetcher,
    });
    if (result.credentials.authProtocol !== MUTUAL_AUTH_PROTOCOL) {
      throw new Error("wrong protocol");
    }

    const fields = {
      challengeId: "challenge-1",
      hostId: HOST_ID,
      hostNonce: result.hostNonce,
      nodeNonce: String(seen[0]?.body.nodeNonce),
      nodePublicKey: result.credentials.publicKey,
      registrationHash: registrationHash(registration),
      dialedHostUrl: HOST_URL,
    };
    expect(
      verifyIdentitySignature(
        result.credentials.publicKey,
        enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, fields),
        String(seen[1]?.body.nodeSignature),
      ),
    ).toBe(true);
    expect(seen[1]?.body.grantProof).toBe(
      grantProof(
        grantSecretDigest(grantSecret),
        enrollmentTranscript(ENROLLMENT_GRANT_LABEL, fields),
      ),
    );
  });

  it("sends no completion to a Host whose fingerprint is not the pinned one", async () => {
    const grantSecret = randomBytes(32).toString("base64url");
    const { fetcher, seen } = hostFetch({ hostKeys: createIdentityKeyPair() });

    await expect(
      enrollWithGrant({
        hostUrl: HOST_URL,
        hostId: HOST_ID,
        hostFingerprint: host.fingerprint,
        grant: formatEnrollmentGrant("grant-1", grantSecret),
        registration,
        fetch: fetcher,
      }),
    ).rejects.toBeInstanceOf(HostFingerprintMismatchError);

    // One call: the challenge. The completion was never sent.
    expect(seen).toHaveLength(1);
  });

  it("refuses a challenge whose signature does not verify", async () => {
    const grantSecret = randomBytes(32).toString("base64url");
    const { fetcher } = hostFetch();
    fetcher.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        challengeId: "challenge-1",
        hostId: HOST_ID,
        hostPublicKey: host.publicKey,
        hostFingerprint: host.fingerprint,
        hostNonce: randomBytes(32).toString("base64"),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        // Right shape, wrong signature: a relay that kept the key it was
        // forwarding and changed the transcript underneath it.
        signature: randomBytes(64).toString("base64"),
      }),
      text: async () => "",
    }));

    await expect(
      enrollWithGrant({
        hostUrl: HOST_URL,
        hostId: HOST_ID,
        hostFingerprint: host.fingerprint,
        grant: formatEnrollmentGrant("grant-1", grantSecret),
        registration,
        fetch: fetcher,
      }),
    ).rejects.toThrow(/signature/i);
  });

  it("refuses a grant that is not `<id>.<secret>`", async () => {
    const { fetcher } = hostFetch();
    await expect(
      enrollWithGrant({
        hostUrl: HOST_URL,
        hostId: HOST_ID,
        hostFingerprint: host.fingerprint,
        grant: "not-a-grant",
        registration,
        fetch: fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  /**
   * Enrolment is where a machine's identity is decided, and its first byte is
   * a grant id that authorises exactly one Node key.
   *
   * On plain HTTP to anything but this machine, a relay sitting in the path
   * does not have to break a signature to win: it reads the exchange, and
   * afterwards it reads everything the connection carries — the lead tokens the
   * Host sends, the transcripts the agents produce. The Connect card can print
   * an https address or a loopback forward, so refusing before anything is sent
   * costs an operator a corrected URL and nothing else.
   */
  it("sends nothing to a Host addressed over plain HTTP off this machine", async () => {
    const { fetcher } = hostFetch();
    for (const hostUrl of ["http://192.168.1.20:8787", "http://bore.pub:45871"]) {
      await expect(
        enrollWithGrant({
          hostUrl,
          hostId: HOST_ID,
          hostFingerprint: host.fingerprint,
          grant: formatEnrollmentGrant("grant-1", randomBytes(32).toString("base64url")),
          registration,
          fetch: fetcher,
        }),
      ).rejects.toThrow(/HTTPS|plain HTTP|loopback/i);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enrols over a loopback forward, which never leaves the machine", async () => {
    const { fetcher } = hostFetch();
    const result = await enrollWithGrant({
      hostUrl: "http://127.0.0.1:8790",
      hostId: HOST_ID,
      hostFingerprint: host.fingerprint,
      grant: formatEnrollmentGrant("grant-1", randomBytes(32).toString("base64url")),
      registration,
      fetch: fetcher,
    });
    expect(result.credentials.nodeId).toBe("node-1");
  });
});

/**
 * The receipt is the only frame the Node persists, and it names the Host this
 * machine will pin and the id it will answer to forever after. Everything
 * before it is bound to a transcript both ends signed; if the receipt is not,
 * then a relay that forwarded an honest exchange still gets to choose the last
 * word — which is the whole exchange, undone at the end.
 */
describe("pinning the enrollment receipt", () => {
  const enroll = (fetcher: ReturnType<typeof hostFetch>["fetcher"]) =>
    enrollWithGrant({
      hostUrl: HOST_URL,
      hostId: HOST_ID,
      hostFingerprint: host.fingerprint,
      grant: formatEnrollmentGrant("grant-1", randomBytes(32).toString("base64url")),
      registration,
      fetch: fetcher,
    });

  it("accepts a receipt the Host signed over this enrollment", async () => {
    const { fetcher, seen } = hostFetch();
    const result = await enroll(fetcher);

    expect(result.credentials.nodeId).toBe("node-1");
    expect(result.credentials.host.publicKey).toBe(host.publicKey);
    // Signed over the transcript that named this Node's key, not merely over
    // whatever the last response happened to contain.
    const challenged = seen[0]?.body ?? {};
    expect(
      verifyIdentitySignature(
        host.publicKey,
        enrollmentReceiptTranscript({
          challengeId: "challenge-1",
          hostId: HOST_ID,
          hostNonce: result.hostNonce,
          nodeNonce: String(challenged.nodeNonce),
          nodePublicKey: String(challenged.nodePublicKey),
          registrationHash: registrationHash(registration),
          dialedHostUrl: HOST_URL,
          nodeId: "node-1",
        }),
        result.receiptSignature,
      ),
    ).toBe(true);
  });

  it("refuses a receipt signed by anything but the Host it authenticated", async () => {
    const relay = createIdentityKeyPair();
    const { fetcher } = hostFetch({ receiptSigner: relay });
    await expect(enroll(fetcher)).rejects.toThrow(/receipt/i);
  });

  it("refuses a receipt that names a different Host identity", async () => {
    const relay = createIdentityKeyPair();
    // The signature is genuine and so is the challenge; only the identity the
    // Node would pin has been swapped for the relay's.
    await expect(
      enroll(
        hostFetch({
          receipt: (receipt) => ({ ...receipt, hostPublicKey: relay.publicKey }),
        }).fetcher,
      ),
    ).rejects.toThrow(/receipt/i);
    await expect(
      enroll(
        hostFetch({
          receipt: (receipt) => ({ ...receipt, hostFingerprint: relay.fingerprint }),
        }).fetcher,
      ),
    ).rejects.toThrow(/receipt/i);
    await expect(
      enroll(
        hostFetch({ receipt: (receipt) => ({ ...receipt, hostId: "host-2" }) }).fetcher,
      ),
    ).rejects.toThrow(/receipt/i);
  });

  it("refuses a receipt for a challenge this Node did not run", async () => {
    await expect(
      enroll(
        hostFetch({ receipt: (receipt) => ({ ...receipt, challengeId: "challenge-2" }) })
          .fetcher,
      ),
    ).rejects.toThrow(/receipt/i);
  });

  it("refuses a receipt whose nodeId is not the one that was signed for", async () => {
    // The substitution that matters: a valid signature over node-1's
    // enrollment, presented alongside another machine's id.
    await expect(
      enroll(
        hostFetch({ receipt: (receipt) => ({ ...receipt, nodeId: "node-2" }) }).fetcher,
      ),
    ).rejects.toThrow(/receipt/i);
  });

  it("refuses a receipt with no signature at all", async () => {
    await expect(
      enroll(
        hostFetch({
          receipt: ({ signature: _dropped, ...rest }) => rest,
        }).fetcher,
      ),
    ).rejects.toThrow();
  });
});

/**
 * The Node's side of the connection handshake, driven by a fake Host that can
 * be made to answer wrongly in the specific ways a relay would.
 */
describe("opening an authenticated channel", () => {
  const nodeKeys = createIdentityKeyPair();
  const credentials = {
    hostUrl: HOST_URL,
    nodeId: "node-1",
    name: "alpha",
    authProtocol: MUTUAL_AUTH_PROTOCOL,
    privateKey: nodeKeys.privateKey,
    publicKey: nodeKeys.publicKey,
    host: {
      hostId: HOST_ID,
      publicKey: host.publicKey,
      fingerprint: host.fingerprint,
    },
  } as const;

  /** Answers a `client_hello` the way the Host does, or the way a relay would. */
  const answer = (
    hello: {
      nodeId: string;
      nodeNonce: string;
      nodeEphemeralPublicKey: string;
      dialedHostUrl: string;
    },
    options: { keys?: typeof host; connectionId?: string } = {},
  ) => {
    const keys = options.keys ?? host;
    const ephemeral = createEphemeralKeyPair();
    const connectionId = options.connectionId ?? "connection-1";
    const hostNonce = randomBytes(32).toString("base64");
    const transcript = {
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId: HOST_ID,
      nodeId: hello.nodeId,
      connectionId,
      hostNonce,
      nodeNonce: hello.nodeNonce,
      hostPublicKey: keys.publicKey,
      nodePublicKey: nodeKeys.publicKey,
      hostEphemeralPublicKey: ephemeral.publicKey,
      nodeEphemeralPublicKey: hello.nodeEphemeralPublicKey,
      dialedHostUrl: hello.dialedHostUrl,
    };
    const challenge: HostChallenge = {
      type: "host_challenge",
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId: HOST_ID,
      hostPublicKey: keys.publicKey,
      hostFingerprint: keys.fingerprint,
      hostNonce,
      connectionId,
      hostEphemeralPublicKey: ephemeral.publicKey,
      signature: signWithIdentity(
        keys.privateKey,
        handshakeTranscript(HOST_CHALLENGE_LABEL, transcript),
      ),
    };
    return { challenge, ephemeral, transcript };
  };

  it("proves itself only after the Host has proved its pinned identity", () => {
    const session = openNodeChannel({ credentials, dialedHostUrl: HOST_URL });
    const { challenge, ephemeral, transcript } = answer(session.clientHello);

    const opened = session.accept(challenge);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.reason);
    expect(
      verifyIdentitySignature(
        nodeKeys.publicKey,
        handshakeTranscript(NODE_PROOF_LABEL, transcript),
        opened.proof.signature,
      ),
    ).toBe(true);

    // Both ends derive one channel, which is what makes it a channel.
    const hostChannel = new AuthenticatedChannel({
      keys: deriveChannelKeys({
        privateKey: ephemeral.privateKey,
        peerPublicKey: session.clientHello.nodeEphemeralPublicKey,
        transcript: handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
      }),
      binding: {
        protocol: MUTUAL_AUTH_PROTOCOL,
        hostId: HOST_ID,
        nodeId: "node-1",
        connectionId: challenge.connectionId,
      },
      seals: "host-to-node",
    });
    const received = opened.channel.open(
      hostChannel.seal(JSON.stringify({ type: "welcome", nodeId: "node-1" })),
    );
    expect(received.ok && JSON.parse(received.plaintext)).toEqual({
      type: "welcome",
      nodeId: "node-1",
    });
  });

  it("refuses a challenge from a Host with another fingerprint", () => {
    const session = openNodeChannel({ credentials, dialedHostUrl: HOST_URL });
    const { challenge } = answer(session.clientHello, {
      keys: createIdentityKeyPair(),
    });

    const opened = session.accept(challenge);
    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.reason).toMatch(/fingerprint/i);
  });

  it("refuses a challenge whose signature is not over this handshake", () => {
    const session = openNodeChannel({ credentials, dialedHostUrl: HOST_URL });
    const { challenge } = answer(session.clientHello);

    // A relay forwarding a genuine challenge, with one field changed.
    const opened = session.accept({ ...challenge, connectionId: "connection-2" });
    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.reason).toMatch(/signature/i);
  });

  it("refuses a challenge that names a different Host", () => {
    const session = openNodeChannel({ credentials, dialedHostUrl: HOST_URL });
    const { challenge } = answer(session.clientHello);

    expect(session.accept({ ...challenge, hostId: "host-2" }).ok).toBe(false);
  });

  it("sends the Node's identity and nothing that authenticates it", () => {
    const session = openNodeChannel({ credentials, dialedHostUrl: HOST_URL });
    const hello = JSON.stringify(session.clientHello);

    expect(session.clientHello.type).toBe("client_hello");
    expect(session.clientHello.nodeId).toBe("node-1");
    expect(hello).not.toContain(nodeKeys.privateKey);
    expect(hello).not.toContain("secret");
  });

  /**
   * The mirror of the Host's containment, and for the same reason.
   *
   * `hostEphemeralPublicKey` is checked as base64 of a plausible length, which
   * says nothing about whether it decodes to an X25519 point. Signing it into
   * the transcript gets it past the identity check, and then the key exchange
   * is handed a string it cannot use. This runs inside the Node's socket
   * listener, so a throw is an unhandled rejection and a process that restarts
   * into the same frame — a crash loop driven by whatever is answering that
   * address. A refusal drops the connection and reconnects.
   */
  it("refuses a signed challenge whose ephemeral key is unusable", () => {
    for (const ephemeral of [
      Buffer.from("not-a-key").toString("base64"),
      createIdentityKeyPair().publicKey,
      createEphemeralKeyPair().publicKey.slice(0, 8),
    ]) {
      const session = openNodeChannel({ credentials, dialedHostUrl: HOST_URL });
      const { challenge, transcript } = answer(session.clientHello);
      const spoiled = { ...transcript, hostEphemeralPublicKey: ephemeral };
      const opened = session.accept({
        ...challenge,
        hostEphemeralPublicKey: ephemeral,
        signature: signWithIdentity(
          host.privateKey,
          handshakeTranscript(HOST_CHALLENGE_LABEL, spoiled),
        ),
      });
      expect(opened.ok).toBe(false);
      expect(!opened.ok && opened.reason).toBeTruthy();
    }
  });
});

describe("planCredentials", () => {
  const settings = { hostUrl: "http://127.0.0.1:8787", nodeName: "WEILI-PC" };
  const stored = {
    hostUrl: settings.hostUrl,
    nodeId: "node-1",
    name: settings.nodeName,
    authProtocol: "legacy-secret",
    secret: "s3cret",
  } as const;
  /** What an operator pasted from the Connect card, already parsed. */
  const tuple = () => ({
    grant: formatEnrollmentGrant("grant-1", "secret"),
    hostId: HOST_ID,
    hostFingerprint: host.fingerprint,
  });

  it("registers when nothing is stored", () => {
    expect(planCredentials(undefined, settings).action).toBe("register");
  });

  it("keeps the node id through a rename, so placements and sessions survive", () => {
    // The name is a label the inventory proposes, not the identity:
    // re-registering here used to abandon this machine's history on a node row
    // that would never come back online.
    const plan = planCredentials({ ...stored, name: "old-name" }, settings);
    expect(plan).toEqual({
      action: "reuse",
      credentials: { ...stored, name: "old-name" },
    });
  });

  it("keeps the node id when only the host url rotated", () => {
    const plan = planCredentials({ ...stored, hostUrl: "https://old.example" }, settings);
    expect(plan).toEqual({
      action: "move",
      credentials: { ...stored, hostUrl: settings.hostUrl },
    });
  });

  it("reuses an unchanged identity", () => {
    expect(planCredentials(stored, settings)).toEqual({
      action: "reuse",
      credentials: stored,
    });
  });

  it("moves a key-based identity without disturbing its pinned Host", () => {
    const keyed = {
      hostUrl: "https://old.example",
      nodeId: "node-1",
      name: settings.nodeName,
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      privateKey: "private",
      publicKey: "public",
      host: { hostId: HOST_ID, publicKey: host.publicKey, fingerprint: host.fingerprint },
    } as const;

    const plan = planCredentials(keyed, settings);
    // The URL is where the Host is; the fingerprint is who it is. Only one of
    // them moves.
    expect(plan).toEqual({
      action: "move",
      credentials: { ...keyed, hostUrl: settings.hostUrl },
    });
  });

  /**
   * The manual migration, which is the only one there is.
   *
   * A legacy Node cannot be upgraded over its own connection, so the Host tells
   * the operator to run a fresh Connect command instead. Reusing the stored
   * secret because it still parses makes that command a no-op that reports
   * success — the machine reconnects happily on the credential the operator was
   * trying to retire, and nothing anywhere says why.
   */
  it("re-enrols a stored legacy identity when a Connect command is supplied", () => {
    const plan = planCredentials(stored, settings, { keyEnrollment: tuple() });
    expect(plan).toEqual({
      action: "register",
      reason: expect.stringContaining("re-enrolling"),
      reclaims: stored,
    });
  });

  /** Whatever the address on the command says; a move is not a migration. */
  it("re-enrols rather than moving when both would apply", () => {
    const plan = planCredentials(
      { ...stored, hostUrl: "https://old.example" },
      settings,
      {
        keyEnrollment: tuple(),
      },
    );
    expect(plan.action).toBe("register");
  });

  /**
   * The same command, run again on a machine that already obeyed it.
   *
   * A grant is one-time, so a service unit that bakes the Connect flags in
   * would spend a consumed grant on every boot and fail to start — while
   * already being exactly what the command asks for.
   */
  it("keeps a machine already enrolled against that Host identity", () => {
    const keyed = {
      ...stored,
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      privateKey: "private",
      publicKey: "public",
      host: { hostId: HOST_ID, publicKey: host.publicKey, fingerprint: host.fingerprint },
    } as const;
    const { secret: _secret, ...rest } = keyed;

    expect(planCredentials(rest, settings, { keyEnrollment: tuple() })).toEqual({
      action: "reuse",
      credentials: rest,
    });
  });

  it("re-enrols a keyed identity pinned to a different Host", () => {
    const keyed = {
      hostUrl: settings.hostUrl,
      nodeId: "node-1",
      name: settings.nodeName,
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      privateKey: "private",
      publicKey: "public",
      host: {
        hostId: "some-other-host",
        publicKey: host.publicKey,
        fingerprint: host.fingerprint,
      },
    } as const;

    expect(planCredentials(keyed, settings, { keyEnrollment: tuple() }).action).toBe(
      "register",
    );
  });

  /** The Host has already refused this credential, so reusing it loops. */
  it("enrols again under the stored name when told to", () => {
    expect(planCredentials(stored, settings, { forced: true })).toEqual({
      action: "register",
      reason: expect.stringContaining(settings.nodeName),
      reclaims: stored,
    });
  });
});

/**
 * The three flags a Connect command carries, and what two of them mean.
 *
 * Partial is the interesting case. An operator who pasted two thirds of the
 * command has said what they want, and both ways of guessing are wrong: with
 * nothing stored the Node fails later complaining about a missing token, and
 * with credentials on disk it silently keeps them — which is a machine that
 * carries on presenting a shared secret while its operator believes it was
 * migrated.
 */
describe("keyEnrollmentTuple", () => {
  const whole = {
    FLEET_ENROLLMENT_GRANT: "grant-1.secret",
    FLEET_HOST_ID: HOST_ID,
    FLEET_HOST_FINGERPRINT: host.fingerprint,
  };

  it("is absent when the run was not given one", () => {
    expect(keyEnrollmentTuple({})).toBeUndefined();
    expect(keyEnrollmentTuple({ FLEET_ENROLLMENT_TOKEN: "legacy" })).toBeUndefined();
  });

  it("reads a whole command, whitespace and all", () => {
    expect(
      keyEnrollmentTuple({
        FLEET_ENROLLMENT_GRANT: " grant-1.secret ",
        FLEET_HOST_ID: `${HOST_ID}\n`,
        FLEET_HOST_FINGERPRINT: ` ${host.fingerprint}`,
      }),
    ).toEqual({
      grant: "grant-1.secret",
      hostId: HOST_ID,
      hostFingerprint: host.fingerprint,
    });
  });

  it("refuses two thirds of a command rather than ignoring it", () => {
    for (const missing of [
      "FLEET_ENROLLMENT_GRANT",
      "FLEET_HOST_ID",
      "FLEET_HOST_FINGERPRINT",
    ] as const) {
      const partial: Record<string, string | undefined> = { ...whole };
      delete partial[missing];
      expect(() => keyEnrollmentTuple(partial), missing).toThrow(/all three/i);
      // A flag given an empty value is the same mistake, not a third state.
      expect(() => keyEnrollmentTuple({ ...whole, [missing]: "  " }), missing).toThrow(
        /all three/i,
      );
    }
  });
});

/**
 * Registering the old way: a fleet-wide token out, a reusable secret back.
 *
 * Both halves are bearer credentials in the clear, which is why the address
 * they may be spoken over is checked before either of them moves. The key-based
 * exchange refuses the same addresses for a weaker reason — it at least signs
 * its transcripts — so a legacy Node that did not check was the one path where
 * a relay could simply take the credential and use it.
 */
describe("registering with the fleet-wide token", () => {
  /** A Host that mints a secret, and remembers what it was asked. */
  function tokenHost(status = 201) {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: { body?: string }) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      const answer = { nodeId: "node-7", secret: "shared-secret" };
      return {
        ok: status < 400,
        status,
        json: async () => answer,
        text: async () => JSON.stringify(answer),
      };
    });
    return { fetcher, seen };
  }

  it("sends nothing to a Host addressed over plain HTTP off this machine", async () => {
    const { fetcher } = tokenHost();
    for (const hostUrl of ["http://192.168.1.20:8787", "http://bore.pub:45871"]) {
      await expect(
        registerWithToken({
          hostUrl,
          enrollmentToken: "fleet-wide-token",
          registration,
          fetch: fetcher,
        }),
      ).rejects.toThrow(/HTTPS|clear text|loopback/i);
    }
    // The token is the credential; it never reached the wire.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("registers over HTTPS and keeps the secret the Host minted", async () => {
    const { fetcher, seen } = tokenHost();

    const credentials = await registerWithToken({
      hostUrl: HOST_URL,
      enrollmentToken: "fleet-wide-token",
      registration,
      fetch: fetcher,
    });

    expect(credentials).toEqual({
      hostUrl: HOST_URL,
      nodeId: "node-7",
      name: registration.name,
      authProtocol: "legacy-secret",
      secret: "shared-secret",
    });
    expect(seen[0]?.url).toBe(`${HOST_URL}/api/nodes/register`);
    expect(seen[0]?.body).toMatchObject({
      enrollmentToken: "fleet-wide-token",
      name: registration.name,
    });
  });

  /** `http://127.0.0.1` never reaches a wire, which is the whole exception. */
  it("registers over a loopback forward", async () => {
    const { fetcher } = tokenHost();
    const credentials = await registerWithToken({
      hostUrl: "http://127.0.0.1:8790",
      enrollmentToken: "fleet-wide-token",
      registration,
      fetch: fetcher,
    });
    expect(credentials.nodeId).toBe("node-7");
  });

  it("reports a Host that refused the token", async () => {
    const { fetcher } = tokenHost(401);
    await expect(
      registerWithToken({
        hostUrl: HOST_URL,
        enrollmentToken: "wrong",
        registration,
        fetch: fetcher,
      }),
    ).rejects.toThrow(/401/);
  });
});

/**
 * The decision this Node actually makes at startup.
 *
 * Every case worth having is a refusal to act on what is on disk: a Connect
 * command re-enrolling a machine whose stored credentials read perfectly well,
 * a two-thirds command failing instead of quietly keeping them, and an address
 * that stops the exchange before a credential is sent to it.
 */
describe("ensureNodeCredentials", () => {
  const settings = { hostUrl: HOST_URL, nodeName: "WEILI-PC" };
  const machine = {
    os: "linux",
    arch: "x64",
    version: "0.3.0",
    revision: "abc1234",
    capabilities: ["copilot-acp"],
    agents: [],
    maxSessions: 2,
    homeDir: "/home/alpha",
  };
  const legacy = {
    hostUrl: HOST_URL,
    nodeId: "node-existing",
    name: "WEILI-PC",
    authProtocol: "legacy-secret",
    secret: "s3cret",
  } as const;
  const command = {
    FLEET_ENROLLMENT_GRANT: formatEnrollmentGrant(
      "grant-1",
      randomBytes(32).toString("base64url"),
    ),
    FLEET_HOST_ID: HOST_ID,
    FLEET_HOST_FINGERPRINT: host.fingerprint,
  };

  it("migrates a stored legacy machine when a Connect command is supplied", async () => {
    const { fetcher, seen } = hostFetch({ nodeId: legacy.nodeId });

    const outcome = await ensureNodeCredentials({
      stored: legacy,
      settings,
      env: command,
      machine,
      fetch: fetcher,
    });

    expect(outcome.persist).toBe(true);
    expect(outcome.credentials.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
    // The Host indexes machines by name, so enrolling under the stored one is
    // what reclaims the row — the same id, and with it every placement and
    // session this machine has.
    expect((seen[1]?.body.registration as { name: string } | undefined)?.name).toBe(
      legacy.name,
    );
    expect(outcome.credentials.nodeId).toBe(legacy.nodeId);
    expect(JSON.stringify(seen)).not.toContain(legacy.secret);
  });

  /** Even when the operator has since renamed this machine locally. */
  it("enrols under the name the Host knows, not the one settings hold", async () => {
    const { fetcher, seen } = hostFetch({ nodeId: legacy.nodeId });

    await ensureNodeCredentials({
      stored: legacy,
      settings: { ...settings, nodeName: "renamed-locally" },
      env: command,
      machine,
      fetch: fetcher,
    });

    expect((seen[1]?.body.registration as { name: string } | undefined)?.name).toBe(
      legacy.name,
    );
  });

  it("refuses two thirds of a Connect command instead of keeping the secret", async () => {
    const { fetcher } = hostFetch();
    const { FLEET_HOST_FINGERPRINT: _dropped, ...partial } = command;

    await expect(
      ensureNodeCredentials({
        stored: legacy,
        settings,
        env: partial,
        machine,
        fetch: fetcher,
      }),
    ).rejects.toThrow(/all three/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("spends no grant on a machine already enrolled against that Host", async () => {
    const { fetcher } = hostFetch();
    const keyed = {
      hostUrl: HOST_URL,
      nodeId: "node-existing",
      name: "WEILI-PC",
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      privateKey: "private",
      publicKey: "public",
      host: { hostId: HOST_ID, publicKey: host.publicKey, fingerprint: host.fingerprint },
    } as const;

    const outcome = await ensureNodeCredentials({
      stored: keyed,
      settings,
      env: command,
      machine,
      fetch: fetcher,
    });

    expect(outcome).toEqual({ credentials: keyed, persist: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends no enrollment token to a plain-HTTP Host off this machine", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      throw new Error("nothing should have been sent");
    });

    await expect(
      ensureNodeCredentials({
        stored: undefined,
        settings: { ...settings, hostUrl: "http://192.168.1.20:8787" },
        env: { FLEET_ENROLLMENT_TOKEN: "fleet-wide-token" },
        machine,
        fetch: fetcher as never,
      }),
    ).rejects.toThrow(/clear text|HTTPS|loopback/i);
    expect(seen).toEqual([]);
  });

  it("registers a new machine with the token it was given", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ nodeId: "node-7", secret: "shared-secret" }),
      text: async () => "",
    }));

    const outcome = await ensureNodeCredentials({
      stored: undefined,
      settings,
      env: { FLEET_ENROLLMENT_TOKEN: "fleet-wide-token" },
      machine,
      fetch: fetcher,
    });

    expect(outcome.persist).toBe(true);
    expect(outcome.credentials).toMatchObject({
      nodeId: "node-7",
      name: settings.nodeName,
      authProtocol: "legacy-secret",
    });
  });

  it("says what is missing when a first run has no authority at all", async () => {
    await expect(
      ensureNodeCredentials({ stored: undefined, settings, env: {}, machine }),
    ).rejects.toThrow(/enrollment token/i);
  });

  it("follows a rotated Host URL without re-registering", async () => {
    const { fetcher } = hostFetch();
    const outcome = await ensureNodeCredentials({
      stored: { ...legacy, hostUrl: "https://old.example" },
      settings,
      env: {},
      machine,
      fetch: fetcher,
    });

    expect(outcome).toEqual({
      credentials: { ...legacy, hostUrl: HOST_URL },
      persist: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("writes nothing when the stored identity is already right", async () => {
    const logs: string[] = [];
    const outcome = await ensureNodeCredentials({
      stored: legacy,
      settings,
      env: {},
      machine,
      log: (message) => logs.push(message),
    });

    expect(outcome).toEqual({ credentials: legacy, persist: false });
    expect(logs.join(" ")).toContain(legacy.nodeId);
  });

  /** The Host refused the stored credential, so retrying it would loop. */
  it("enrols again on demand, under the name that reclaims the row", async () => {
    const { fetcher, seen } = hostFetch({ nodeId: legacy.nodeId });

    const outcome = await ensureNodeCredentials({
      stored: legacy,
      settings: { ...settings, nodeName: "renamed-locally" },
      env: command,
      machine,
      forceEnrollment: true,
      fetch: fetcher,
    });

    expect(outcome.credentials.nodeId).toBe(legacy.nodeId);
    expect((seen[1]?.body.registration as { name: string } | undefined)?.name).toBe(
      legacy.name,
    );
  });
});
