import { useEffect, useState } from "react";
import { api } from "./useFleet";

export type Enrollment = {
  hostUrl: string;
  hostId: string;
  hostFingerprint: string;
  hostPublicKey: string;
  /** How far the fleet is through the move from shared secrets to Node keys. */
  nodeAuthentication: { total: number; mutualAuth: number; legacy: number };
  mutualAuthenticationRequired: boolean;
  /**
   * The fleet-wide credential that predates Node keys, when this Host still has
   * one.
   *
   * Absent on a fresh Host, which never had one, and on a fleet that has
   * enforced mutual Node authentication, which retired the one it had. Never
   * used to build a Connect command in any case: a new machine has no use for a
   * reusable secret, and pasting one is how it reaches a stranger's relay.
   */
  enrollmentToken?: string;
  /** Present for providers whose public URL does not encode the tunnel id. */
  tunnelId?: string;
};

/**
 * The current enrollment command inputs, re-read on a timer.
 *
 * A tunnel URL rotates while the card is open, and the token can be reissued,
 * so the card would otherwise hand out an address that stopped working. Polling
 * (rather than a socket message) keeps this out of the broadcast path: only the
 * one screen that shows it pays for it, and only while it is on screen.
 */
export function useEnrollment(intervalMs = 3_000): Enrollment | undefined {
  const [enrollment, setEnrollment] = useState<Enrollment>();

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      void api<Enrollment>("/api/enrollment")
        .then((result) => {
          if (!cancelled) setEnrollment(result);
        })
        // A failed poll keeps the last good answer; the next one retries.
        .catch(() => undefined);
    };
    pull();
    const timer = setInterval(pull, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return enrollment;
}
