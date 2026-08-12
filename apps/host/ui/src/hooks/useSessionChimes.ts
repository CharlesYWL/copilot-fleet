import { useEffect, useRef, useState } from "react";
import { eventPayload, type FleetSession, type SessionEvent } from "@fleet/protocol";
import { playChime } from "../lib/chime";
import { chimesFor, newPermissionIds, sessionStates } from "../lib/chime-decisions";

const STORAGE_KEY = "fleet.sound";

function storedPreference(): boolean {
  try {
    // Sound is on by default: the whole point of a fleet is that nobody is
    // watching it, so an alert nobody opted into is the useful default.
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export type SoundControls = { enabled: boolean; toggle: () => void };

/**
 * A short tone when an agent finishes, and a different one when it is blocked.
 *
 * The decision of *whether* a sound is owed lives in `chime-decisions`; what is
 * here is the bookkeeping that cannot: remembering the previous view of the
 * fleet, and which permission requests have already been announced.
 */
export function useSessionChimes(
  sessions: readonly FleetSession[],
  pendingPermissions: readonly SessionEvent[],
): SoundControls {
  const [enabled, setEnabled] = useState(storedPreference);
  const previousStates = useRef(new Map<string, string>());
  const announced = useRef(new Set<string>());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const next = sessionStates(sessions);
    // The map is updated even while muted, so unmuting does not immediately
    // replay every transition that happened in the meantime.
    const chimes = enabledRef.current ? chimesFor(previousStates.current, sessions) : [];
    previousStates.current = next;
    // One tone for a batch: five agents finishing together should sound like an
    // event, not like a dropped tray of cutlery.
    if (chimes.length > 0) playChime("done");
  }, [sessions]);

  useEffect(() => {
    const ids = pendingPermissions.map(
      (event) => eventPayload(event, "permission")?.requestId ?? "",
    );
    const fresh = newPermissionIds(announced.current, ids);
    // Resolved requests never return, so forgetting them keeps this bounded
    // without risking the same request chiming twice.
    announced.current = new Set(ids.filter(Boolean));
    if (fresh.length > 0 && enabledRef.current) playChime("permission");
  }, [pendingPermissions]);

  return {
    enabled,
    toggle: () =>
      setEnabled((current) => {
        const next = !current;
        try {
          window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
        } catch {
          // A browser that refuses storage still gets the toggle for this tab.
        }
        // Turning sound on is a click, which is the gesture browsers require
        // before audio may start; playing here also confirms it works.
        if (next) playChime("done");
        return next;
      }),
  };
}
