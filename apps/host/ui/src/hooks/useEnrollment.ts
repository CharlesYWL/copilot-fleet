import { useEffect, useState } from "react";
import { api } from "./useFleet";

export type Enrollment = { hostUrl: string; enrollmentToken: string };

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
