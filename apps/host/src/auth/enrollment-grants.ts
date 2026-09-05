import { randomBytes } from "node:crypto";
import { formatEnrollmentGrant } from "@fleet/protocol";
import { grantSecretDigest } from "@fleet/protocol/node-auth";
import type { EnrollmentGrantRow, FleetStore } from "../store.js";

/** Fifteen minutes: long enough to walk to the other machine, short enough to matter. */
export const ENROLLMENT_GRANT_TTL_MS = 15 * 60 * 1000;

/** 256 bits, because this is the only thing standing between a stranger and the fleet. */
const GRANT_SECRET_BYTES = 32;

export type IssuedGrant = {
  id: string;
  /** `<id>.<secret>` — printed once, on the Connect card, and never stored. */
  grant: string;
  expiresAt: string;
};

/**
 * One-time authorisations for a new machine to join.
 *
 * The fleet-wide enrollment token it replaces was a reusable credential that a
 * Node sent to whatever answered the URL, before it had any way to tell that
 * from the Host. A grant is different in three ways that matter: it is spent by
 * the first machine to use it, it expires, and the Host stores only its digest
 * — which is also the HMAC key the completion is proved with, so the Host can
 * check a proof it could not have produced itself.
 */
export class EnrollmentGrants {
  private readonly store: FleetStore;
  private readonly now: () => number;

  constructor(options: { store: FleetStore; now?: () => number }) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  create(createdByAdminId: string): IssuedGrant {
    const secret = randomBytes(GRANT_SECRET_BYTES).toString("base64url");
    const expiresAt = new Date(this.now() + ENROLLMENT_GRANT_TTL_MS).toISOString();
    const row = this.store.createEnrollmentGrant({
      tokenHash: grantSecretDigest(secret),
      createdByAdminId,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt,
    });
    return { id: row.id, grant: formatEnrollmentGrant(row.id, secret), expiresAt };
  }

  /**
   * The grant behind this id, if it is still one.
   *
   * Returns the row rather than a boolean because the digest it holds is the
   * key the challenge's proof is checked with — the id alone authorises the
   * challenge, and only the HMAC authorises the enrolment.
   */
  live(id: string): EnrollmentGrantRow | undefined {
    const row = this.store.getEnrollmentGrant(id);
    if (!row) return undefined;
    if (row.consumedAt) return undefined;
    if (Date.parse(row.expiresAt) <= this.now()) return undefined;
    return row;
  }

  /** Spends it. False when somebody else already did, which is the race that matters. */
  consume(id: string, nodeId: string): boolean {
    if (!this.live(id)) return false;
    return this.store.consumeEnrollmentGrant(
      id,
      nodeId,
      new Date(this.now()).toISOString(),
    );
  }
}
