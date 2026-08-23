import { useCallback, useState } from "react";

const PREFIX = "fleet.ui.";

/**
 * Reads a remembered on/off choice, treating a missing or unreadable store as
 * "never chosen" rather than as an error.
 *
 * `localStorage` throws rather than returning null when a browser has storage
 * blocked, so every read has to survive that: a panel that will not render
 * because a privacy setting is on is a worse outcome than a panel that forgets
 * where it was.
 */
export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(PREFIX + key);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

/**
 * A boolean that outlives a reload.
 *
 * Panels an operator has deliberately folded away should stay folded — being
 * given back a sidebar you closed on every refresh is the kind of thing that
 * makes the control feel broken. Kept out of React state alone for that reason,
 * and out of the Host because it is a preference of this browser, not of the
 * fleet.
 */
export function useStickyFlag(
  key: string,
  fallback: boolean,
): [boolean, (next?: boolean) => void] {
  const [value, setValue] = useState(() => readFlag(key, fallback));

  const set = useCallback(
    (next?: boolean) => {
      setValue((current) => {
        const resolved = next ?? !current;
        try {
          localStorage.setItem(PREFIX + key, resolved ? "1" : "0");
        } catch {
          // A browser with storage blocked still gets the toggle, just not the
          // memory of it.
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}
