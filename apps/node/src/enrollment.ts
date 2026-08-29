import { randomBytes } from "node:crypto";
import {
  HostChallengeSchema,
  MUTUAL_AUTH_PROTOCOL,
  NodeEnrollmentChallengeResponseSchema,
  NodeEnrollmentReceiptSchema,
  parseEnrollmentGrant,
  type HostChallenge,
  type NodeClientHello,
  type NodeRegistrationPayload,
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
  identityFingerprint,
  registrationHash,
  sameDigest,
  signWithIdentity,
  verifyIdentitySignature,
  type EnrollmentTranscriptInput,
  type HandshakeTranscriptInput,
} from "@fleet/protocol/node-auth";
import type { Credentials, KeyedCredentials } from "./config.js";
import { isConfidentialHostUrl } from "./host-endpoints.js";
import type { Settings } from "./settings.js";

/**
 * What to do with the credentials found on disk.
 *
 * The host URL is deliberately not part of the identity: tunnel providers hand
 * out a fresh URL constantly, and re-registering under the same name collides
 * with the Host's unique name index.
 *
 * Neither is the name, any more. A rename used to mean registering again, which
 * quietly abandoned this machine's placements and sessions on a node row that
 * would never come back online. The `nodeId` is the identity; the name travels
 * as a proposal in the inventory frame and the Host answers with the one it
 * recorded.
 *
 * The pinned Host identity is not part of it either, and for the opposite
 * reason: the URL is where the Host is, and the fingerprint is who it is. A
 * Host that moved is still the same Host, and a Host at the expected address
 * with a different key is not one this Node will speak to.
 */
export type CredentialPlan =
  | { action: "register"; reason: string }
  | { action: "move"; credentials: Credentials }
  | { action: "reuse"; credentials: Credentials };

export function planCredentials(
  stored: Credentials | undefined,
  settings: Pick<Settings, "hostUrl" | "nodeName">,
): CredentialPlan {
  if (!stored) {
    return { action: "register", reason: "No stored credentials, registering" };
  }
  if (stored.hostUrl !== settings.hostUrl) {
    return { action: "move", credentials: { ...stored, hostUrl: settings.hostUrl } };
  }
  return { action: "reuse", credentials: stored };
}

/**
 * The Host answered, but it is not the Host this command named.
 *
 * Its own class because it is the one enrolment failure an operator can act on:
 * every other error means "try again", and this one means "whatever is at that
 * address is not your Fleet".
 */
export class HostFingerprintMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(
      `That Host's fingerprint is ${received}, not the ${expected} on the Connect command. Nothing was sent to it.`,
    );
    this.name = "HostFingerprintMismatchError";
  }
}

/** Narrowed so a caller can inject a stub without pulling in the DOM types. */
type FetchLike = (
  url: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export type EnrollWithGrantInput = {
  hostUrl: string;
  hostId: string;
  hostFingerprint: string;
  /** `<grant-id>.<grant-secret>` from the Connect card. */
  grant: string;
  registration: NodeRegistrationPayload;
  fetch?: FetchLike;
};

export type EnrollmentResult = {
  credentials: KeyedCredentials;
  /** Kept for the caller's log and for tests; the transcript is otherwise internal. */
  hostNonce: string;
  /** The Host's signature over the receipt, kept so a test can check the binding. */
  receiptSignature: string;
};

/**
 * Joins a fleet, having proved the Host first.
 *
 * The order is the security property. The Node generates a key pair, hashes the
 * registration it intends to send, and asks for a challenge with neither the
 * grant secret nor anything reusable in it. Only once the Host has signed a
 * transcript that covers this Node's key, this payload hash and the address
 * actually dialed — and only once that signature verifies against a fingerprint
 * that came from the operator rather than from the connection — does the Node
 * send anything that authorises an enrolment.
 *
 * A relay in the middle can carry every byte of this and gain nothing: it never
 * sees a private key, never sees the grant secret, and cannot alter a field
 * without breaking a signature it cannot recompute.
 */
export async function enrollWithGrant(
  input: EnrollWithGrantInput,
): Promise<EnrollmentResult> {
  /*
   * Refused before a byte is sent, and for a reason the exchange itself cannot
   * fix. The signatures below stop a relay from *altering* the enrolment, but
   * a relay on plain HTTP does not need to: it reads it, and then it reads
   * everything the connection carries afterwards — the lead tokens the Host
   * sends, the prompts and transcripts the agents produce. The Connect card can
   * print an HTTPS address or a loopback forward, so the cost of refusing here
   * is a corrected URL.
   */
  if (!isConfidentialHostUrl(input.hostUrl)) {
    throw new Error(
      `Refusing to enrol against ${input.hostUrl}: everything this Host sends afterwards would cross that address in clear text. Use an HTTPS address, or a loopback forward such as \`devtunnel connect\`.`,
    );
  }
  const parts = parseEnrollmentGrant(input.grant);
  if (!parts) {
    throw new Error(
      "That enrollment grant is not in the `<id>.<secret>` form the Connect command prints.",
    );
  }
  const call = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const keys = createIdentityKeyPair();
  const nodeNonce = randomBytes(32).toString("base64");
  const hash = registrationHash(input.registration);

  const challenged = await call(
    new URL("/api/nodes/enrollment/challenge", input.hostUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantId: parts.id,
        nodeNonce,
        nodePublicKey: keys.publicKey,
        registrationHash: hash,
        dialedHostUrl: input.hostUrl,
      }),
    },
  );
  if (!challenged.ok) {
    throw new Error(
      `Enrollment challenge failed (${challenged.status}): ${await challenged.text()}`,
    );
  }
  const challenge = NodeEnrollmentChallengeResponseSchema.parse(await challenged.json());

  if (
    !sameDigest(challenge.hostFingerprint, input.hostFingerprint) ||
    !sameDigest(identityFingerprint(challenge.hostPublicKey), input.hostFingerprint)
  ) {
    // Thrown before anything else is sent. Both comparisons matter: the first
    // catches a Host that names another fingerprint, the second a Host that
    // names the right one over a key that is not it.
    throw new HostFingerprintMismatchError(
      input.hostFingerprint,
      challenge.hostFingerprint,
    );
  }
  if (challenge.hostId !== input.hostId) {
    throw new HostFingerprintMismatchError(
      input.hostFingerprint,
      challenge.hostFingerprint,
    );
  }
  const fields: EnrollmentTranscriptInput = {
    challengeId: challenge.challengeId,
    hostId: challenge.hostId,
    hostNonce: challenge.hostNonce,
    nodeNonce,
    nodePublicKey: keys.publicKey,
    registrationHash: hash,
    dialedHostUrl: input.hostUrl,
  };
  if (
    !verifyIdentitySignature(
      challenge.hostPublicKey,
      enrollmentTranscript(ENROLLMENT_CHALLENGE_LABEL, fields),
      challenge.signature,
    )
  ) {
    throw new Error(
      "That Host's enrollment signature did not verify, so nothing was sent to it.",
    );
  }

  const completed = await call(new URL("/api/nodes/register", input.hostUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      registration: input.registration,
      nodeSignature: signWithIdentity(
        keys.privateKey,
        enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, fields),
      ),
      // Keyed with the digest of the secret rather than the secret itself, so
      // the Host can check a proof it could not have produced.
      grantProof: grantProof(
        grantSecretDigest(parts.secret),
        enrollmentTranscript(ENROLLMENT_GRANT_LABEL, fields),
      ),
    }),
  });
  if (!completed.ok) {
    throw new Error(
      `Node registration failed (${completed.status}): ${await completed.text()}`,
    );
  }
  const receipt = NodeEnrollmentReceiptSchema.parse(await completed.json());
  /*
   * The last frame is checked against the exchange rather than believed.
   *
   * Everything before this is bound to a transcript the Node verified against a
   * fingerprint from the operator. The receipt is what it persists — the Host
   * identity it pins for the rest of its life and the id it answers to — so a
   * receipt that is merely well-formed would hand a relay the one field it
   * could still choose, at the end of an exchange it could not otherwise touch.
   *
   * The identity is compared to the challenge that was authenticated, not to
   * the Connect card, because the card only names a fingerprint: a receipt
   * naming the right fingerprint over a different key would otherwise pass.
   */
  if (
    receipt.challengeId !== challenge.challengeId ||
    receipt.hostId !== challenge.hostId ||
    !sameDigest(receipt.hostPublicKey, challenge.hostPublicKey) ||
    !sameDigest(receipt.hostFingerprint, challenge.hostFingerprint)
  ) {
    throw new Error(
      "That enrollment receipt describes a different Host or a different enrollment, so nothing was stored.",
    );
  }
  if (
    !verifyIdentitySignature(
      challenge.hostPublicKey,
      enrollmentReceiptTranscript({ ...fields, nodeId: receipt.nodeId }),
      receipt.signature,
    )
  ) {
    throw new Error(
      "That enrollment receipt was not signed by the Host that answered the challenge, so nothing was stored.",
    );
  }
  return {
    hostNonce: challenge.hostNonce,
    receiptSignature: receipt.signature,
    credentials: {
      hostUrl: input.hostUrl,
      nodeId: receipt.nodeId,
      name: input.registration.name,
      authProtocol: MUTUAL_AUTH_PROTOCOL,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      host: {
        hostId: receipt.hostId,
        publicKey: receipt.hostPublicKey,
        fingerprint: receipt.hostFingerprint,
      },
    },
  };
}

export type ChannelRefusal = { ok: false; reason: string };
export type ChannelOpened = {
  ok: true;
  proof: { type: "node_proof"; signature: string };
  channel: AuthenticatedChannel;
};

export type NodeChannelSession = {
  clientHello: NodeClientHello;
  accept(challenge: HostChallenge): ChannelOpened | ChannelRefusal;
};

/**
 * The Node's half of the connection handshake.
 *
 * Returned as an object with the frame to send and the answer to check, rather
 * than driving a socket, because the interesting part is the refusals — and a
 * refusal buried in a socket callback is one no test can reach.
 *
 * The Node proves nothing until the Host has proved itself against the pinned
 * fingerprint. That ordering is what makes an impostor a wasted round trip
 * instead of a captured signature.
 */
export function openNodeChannel(input: {
  credentials: KeyedCredentials;
  dialedHostUrl: string;
}): NodeChannelSession {
  const ephemeral = createEphemeralKeyPair();
  const nodeNonce = randomBytes(32).toString("base64");
  const clientHello: NodeClientHello = {
    type: "client_hello",
    protocol: MUTUAL_AUTH_PROTOCOL,
    nodeId: input.credentials.nodeId,
    hostId: input.credentials.host.hostId,
    nodeNonce,
    nodeEphemeralPublicKey: ephemeral.publicKey,
    dialedHostUrl: input.dialedHostUrl,
  };

  return {
    clientHello,
    accept(raw: HostChallenge): ChannelOpened | ChannelRefusal {
      const parsed = HostChallengeSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: "malformed host challenge" };
      const challenge = parsed.data;
      if (challenge.hostId !== input.credentials.host.hostId) {
        return { ok: false, reason: "that is a different Host" };
      }
      if (
        !sameDigest(challenge.hostPublicKey, input.credentials.host.publicKey) ||
        !sameDigest(challenge.hostFingerprint, input.credentials.host.fingerprint)
      ) {
        return {
          ok: false,
          reason: `host fingerprint ${challenge.hostFingerprint} is not the pinned ${input.credentials.host.fingerprint}`,
        };
      }
      const transcript: HandshakeTranscriptInput = {
        protocol: MUTUAL_AUTH_PROTOCOL,
        hostId: challenge.hostId,
        nodeId: input.credentials.nodeId,
        connectionId: challenge.connectionId,
        hostNonce: challenge.hostNonce,
        nodeNonce,
        hostPublicKey: challenge.hostPublicKey,
        nodePublicKey: input.credentials.publicKey,
        hostEphemeralPublicKey: challenge.hostEphemeralPublicKey,
        nodeEphemeralPublicKey: ephemeral.publicKey,
        dialedHostUrl: input.dialedHostUrl,
      };
      /*
       * Wrapped for the same reason the Host wraps its half: this runs inside
       * the socket's `message` listener, and the two calls below are the ones
       * that can be handed something schema-valid and still unusable. A
       * `hostEphemeralPublicKey` that is base64 of the right length but not an
       * X25519 point reaches the key exchange and throws — and a throw here is
       * an unhandled rejection, which is a Node process restarting into the
       * same frame for as long as whatever is at that address keeps sending it.
       * A refusal drops the connection, and the reconnect negotiates fresh
       * ephemeral keys.
       */
      try {
        if (
          !verifyIdentitySignature(
            challenge.hostPublicKey,
            handshakeTranscript(HOST_CHALLENGE_LABEL, transcript),
            challenge.signature,
          )
        ) {
          return { ok: false, reason: "host challenge signature did not verify" };
        }
        const keys = deriveChannelKeys({
          privateKey: ephemeral.privateKey,
          peerPublicKey: challenge.hostEphemeralPublicKey,
          transcript: handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
        });
        return {
          ok: true,
          proof: {
            type: "node_proof",
            signature: signWithIdentity(
              input.credentials.privateKey,
              handshakeTranscript(NODE_PROOF_LABEL, transcript),
            ),
          },
          channel: new AuthenticatedChannel({
            keys,
            binding: {
              protocol: MUTUAL_AUTH_PROTOCOL,
              hostId: challenge.hostId,
              nodeId: input.credentials.nodeId,
              connectionId: challenge.connectionId,
            },
            seals: "node-to-host",
          }),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `channel could not be derived: ${reason}` };
      }
    },
  };
}
