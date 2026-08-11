import type { Credentials } from "./config.js";
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
 * as a proposal in the `hello` frame and the Host answers with the one it
 * recorded.
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
