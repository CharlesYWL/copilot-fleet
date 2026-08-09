import type { Credentials } from "./config.js";
import type { Settings } from "./settings.js";

/**
 * What to do with the credentials found on disk.
 *
 * The host URL is deliberately not part of the identity: tunnel providers hand
 * out a fresh URL constantly, and re-registering under the same name collides
 * with the Host's unique name index.
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
  if (stored.name !== settings.nodeName) {
    // Worth spelling out: the Host keys a node by name, so a rename is a new
    // identity unless it already knows the new one. The placements and
    // sessions of the old name stay where they are, and the way back is to
    // start again under the old name — which is hard to guess from
    // "registering again" alone.
    return {
      action: "register",
      reason: `Node renamed "${stored.name}" -> "${settings.nodeName}"; registering. Placements and sessions stay with the old name until you switch back.`,
    };
  }
  if (stored.hostUrl !== settings.hostUrl) {
    return { action: "move", credentials: { ...stored, hostUrl: settings.hostUrl } };
  }
  return { action: "reuse", credentials: stored };
}
