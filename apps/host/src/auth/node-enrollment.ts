import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  MUTUAL_AUTH_PROTOCOL,
  type EnrollNode,
  type FleetNode,
  type NodeEnrollmentChallenge,
  type NodeEnrollmentChallengeResponse,
  type NodeEnrollmentReceipt,
} from "@fleet/protocol";
import {
  ENROLLMENT_CHALLENGE_LABEL,
  ENROLLMENT_COMPLETION_LABEL,
  ENROLLMENT_GRANT_LABEL,
  enrollmentReceiptTranscript,
  enrollmentTranscript,
  grantProof,
  registrationHash,
  verifyIdentitySignature,
  type EnrollmentTranscriptInput,
} from "@fleet/protocol/node-auth";
import type { FleetStore, SecurityAuditInput } from "../store.js";
import type { EnrollmentGrants } from "./enrollment-grants.js";
import type { HostIdentityService } from "./host-identity.js";

/** A challenge outlives one round trip and nothing more. */
export const ENROLLMENT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * A ceiling on in-flight challenges.
 *
 * The challenge endpoint is reachable without a session — it has to be, since
 * a machine that has not enrolled has no credential — so the memory it can
 * make the Host spend is bounded here rather than left to whoever finds the URL.
 */
export const MAX_PENDING_CHALLENGES = 100;

type PendingChallenge = EnrollmentTranscriptInput & {
  grantId: string;
  expiresAt: number;
};

export type EnrollmentFailure = { ok: false; status: number; error: string };

/**
 * One answer for every way an enrolment fails to prove itself.
 *
 * Which half failed — an unknown grant, a spent one, a signature over the wrong
 * key, an HMAC from somebody who never had the secret — is precisely what an
 * attacker holding one of the three pieces wants to be told.
 */
const REFUSED = "That enrollment could not be authorised.";

export type NodeEnrollmentOptions = {
  store: FleetStore;
  identity: HostIdentityService;
  grants: EnrollmentGrants;
  now?: (() => number) | undefined;
  audit?: ((entry: SecurityAuditInput) => void) | undefined;
};

/**
 * The bound enrolment exchange, from the Host's side.
 *
 * The old registration endpoint took a fleet-wide token from a caller that had
 * no way to know it was talking to the Host, and handed back a reusable secret.
 * Every part of that is replaced here: the Node commits to its key and its
 * registration before the Host answers, the Host signs a transcript the Node
 * checks against a pinned fingerprint, and the completion proves possession of
 * both the Node private key and the grant secret over the *same* transcript.
 *
 * A relay can carry all of it and gain nothing: there is no reusable secret to
 * steal, no field it can change without invalidating a signature, and no way to
 * present the grant against a challenge it did not originate.
 */
export class NodeEnrollment {
  private readonly pending = new Map<string, PendingChallenge>();
  private readonly store: FleetStore;
  private readonly identity: HostIdentityService;
  private readonly grants: EnrollmentGrants;
  private readonly now: () => number;
  private readonly audit: (entry: SecurityAuditInput) => void;

  constructor(options: NodeEnrollmentOptions) {
    this.store = options.store;
    this.identity = options.identity;
    this.grants = options.grants;
    this.now = options.now ?? Date.now;
    this.audit = options.audit ?? (() => {});
  }

  challenge(
    input: NodeEnrollmentChallenge,
  ): { ok: true; response: NodeEnrollmentChallengeResponse } | EnrollmentFailure {
    this.sweep();
    const grant = this.grants.live(input.grantId);
    if (!grant) {
      this.audit({
        eventType: "enrollment_grant_rejected",
        actorKind: "enrollment",
        outcome: "denied",
        detail: "no live grant for that id",
      });
      return { ok: false, status: 401, error: REFUSED };
    }
    if (this.pending.size >= MAX_PENDING_CHALLENGES) {
      return {
        ok: false,
        status: 503,
        error: "This Host is already handling as many enrollments as it will hold.",
      };
    }
    const identity = this.identity.identity();
    const fields: EnrollmentTranscriptInput = {
      challengeId: randomUUID(),
      hostId: identity.hostId,
      hostNonce: randomBytes(32).toString("base64"),
      nodeNonce: input.nodeNonce,
      nodePublicKey: input.nodePublicKey,
      registrationHash: input.registrationHash,
      dialedHostUrl: input.dialedHostUrl,
    };
    const expiresAt = this.now() + ENROLLMENT_CHALLENGE_TTL_MS;
    this.pending.set(fields.challengeId, { ...fields, grantId: grant.id, expiresAt });
    return {
      ok: true,
      response: {
        challengeId: fields.challengeId,
        hostId: identity.hostId,
        hostPublicKey: identity.publicKey,
        hostFingerprint: identity.fingerprint,
        hostNonce: fields.hostNonce,
        expiresAt: new Date(expiresAt).toISOString(),
        signature: this.identity.sign(
          enrollmentTranscript(ENROLLMENT_CHALLENGE_LABEL, fields),
        ),
      },
    };
  }

  complete(
    input: EnrollNode,
  ): { ok: true; node: FleetNode; receipt: NodeEnrollmentReceipt } | EnrollmentFailure {
    this.sweep();
    // Taken rather than read: a challenge answers exactly once, so a completion
    // replayed against it finds nothing to complete.
    const challenge = this.pending.get(input.challengeId);
    this.pending.delete(input.challengeId);
    if (!challenge) return { ok: false, status: 401, error: REFUSED };

    if (registrationHash(input.registration) !== challenge.registrationHash) {
      // The one failure worth naming: the Node committed to a payload and then
      // sent a different one, which is a bug on its side rather than an attack.
      return {
        ok: false,
        status: 400,
        error: "The registration does not match the one this enrollment committed to.",
      };
    }
    if (
      !verifyIdentitySignature(
        challenge.nodePublicKey,
        enrollmentTranscript(ENROLLMENT_COMPLETION_LABEL, challenge),
        input.nodeSignature,
      )
    ) {
      this.audit({
        eventType: "enrollment_node_proof_failed",
        actorKind: "enrollment",
        outcome: "denied",
        detail: "node signature did not verify",
      });
      return { ok: false, status: 401, error: REFUSED };
    }
    const grant = this.grants.live(challenge.grantId);
    if (!grant) return { ok: false, status: 401, error: REFUSED };
    const expected = grantProof(
      grant.tokenHash,
      enrollmentTranscript(ENROLLMENT_GRANT_LABEL, challenge),
    );
    if (!sameProof(expected, input.grantProof)) {
      this.audit({
        eventType: "enrollment_grant_rejected",
        actorKind: "enrollment",
        outcome: "denied",
        detail: "grant proof did not verify",
      });
      return { ok: false, status: 401, error: REFUSED };
    }

    const node = this.store.registerNodeWithKey({
      ...input.registration,
      publicKey: challenge.nodePublicKey,
    });
    // Spent after the row exists, so the grant records the Node it produced —
    // and if two completions race, the loser enrolls nothing.
    if (!this.grants.consume(challenge.grantId, node.id)) {
      return { ok: false, status: 401, error: REFUSED };
    }
    const identity = this.identity.identity();
    this.audit({
      eventType: "enrollment_grant_consumed",
      actorKind: "enrollment",
      outcome: "allowed",
      targetId: node.id,
    });
    return {
      ok: true,
      node,
      receipt: {
        nodeId: node.id,
        challengeId: challenge.challengeId,
        authProtocol: MUTUAL_AUTH_PROTOCOL,
        hostId: identity.hostId,
        hostPublicKey: identity.publicKey,
        hostFingerprint: identity.fingerprint,
        // Signed over the transcript the Node already checked, plus the id it
        // is being given. Everything earlier in this exchange is bound to that
        // transcript; without this the receipt was the one frame a relay could
        // still compose — and it names the Host key the Node pins for life.
        signature: this.identity.sign(
          enrollmentReceiptTranscript({ ...challenge, nodeId: node.id }),
        ),
      },
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, challenge] of this.pending) {
      if (challenge.expiresAt <= now) this.pending.delete(id);
    }
  }
}

/** Constant time: the proof is a MAC, and a comparison that leaks is a forgery oracle. */
function sameProof(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(presented, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
