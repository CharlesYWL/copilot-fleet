import type { TunnelPolicy, TunnelPolicyKind, TunnelProvider } from "@fleet/protocol";
import { providerList, providerSpecs } from "./tunnel-providers.js";

/*
 * Extension point for corpnet-direct connectivity between Dev Boxes.
 *
 * That route needs no tunnel: the Host listens on its corpnet address and Nodes
 * dial it directly (today's `FLEET_PUBLIC_URL` / `--url`, which this policy
 * leaves alone). When the panel offers it, it should be one more catalog entry
 * with `microsoftCorpApproved: true`: the corp policy, the route's refusal and
 * the panel all read the published allow-list, so none of them needs a special
 * case. What it will need of its own is a scheme decision in
 * `auth/external-scheme.ts`, because a corpnet name is neither loopback nor a
 * published HTTPS tunnel, and so today grants no session.
 */

/** What the Host knows that decides which providers it may run. */
export type TunnelPolicyContext = {
  /** Fleet sign-in was skipped: anyone who reaches the Host can operate it. */
  noAuth: boolean;
  /** A verified Microsoft corporate account administers this Host. */
  microsoftCorp: boolean;
};

/**
 * The rule in force, from the Host's own state rather than from whoever asks.
 *
 * Host-wide on purpose: a tunnel runs for the machine, is restored at boot with
 * nobody signed in, and serves whoever opens it next, so a per-browser answer
 * would be a rule the boot path and the auto-restart walk around.
 *
 * No-auth wins over corp because it is the stricter of the two: it demands a
 * provider with its own login, whereas a corp-approved route (such as a future
 * corpnet-direct connection) need not have one, and without Fleet sign-in that
 * would leave the Host open to anybody on the network.
 */
export function resolveTunnelPolicyKind(context: TunnelPolicyContext): TunnelPolicyKind {
  if (context.noAuth) return "private-only";
  if (context.microsoftCorp) return "microsoft-corp";
  return "open";
}

/** Whether the Host may run this provider under the given policy. */
export function tunnelProviderAllowed(
  kind: TunnelPolicyKind,
  provider: TunnelProvider,
): boolean {
  const spec = providerSpecs[provider];
  // A provider with no TLS is refused under every policy.
  if (!spec.controlPlaneEligible) return false;
  switch (kind) {
    case "open":
      return true;
    case "private-only":
      return spec.access === "creator-private";
    case "microsoft-corp":
      return spec.microsoftCorpApproved === true;
  }
}

export function describeTunnelPolicy(kind: TunnelPolicyKind): TunnelPolicy {
  return {
    kind,
    allowedProviders: providerList
      .filter((spec) => tunnelProviderAllowed(kind, spec.id))
      .map((spec) => spec.id),
  };
}

/**
 * Why a provider is refused, in the words the panel and the API both use.
 *
 * One sentence in one place: this is raised from the manager, returned in the
 * state of an external tunnel nobody may adopt, and matched by the route that
 * refuses the request — three readings of the same rule that only have to
 * disagree once to become two rules.
 */
export function ineligibleProviderMessage(
  provider: TunnelProvider,
  kind: TunnelPolicyKind = "open",
): string {
  const spec = providerSpecs[provider];
  if (spec.controlPlaneEligible && kind === "private-only") {
    return `${spec.label} is public. Without Microsoft sign-in, use private Dev Tunnels or keep the Host local.`;
  }
  if (spec.controlPlaneEligible && kind === "microsoft-corp") {
    const allowed = describeTunnelPolicy(kind)
      .allowedProviders.map((id) => providerSpecs[id].label)
      .join(" or ");
    return `${spec.label} is not approved for Microsoft corporate use. This Host is administered by an @microsoft.com account, so Fleet only runs ${allowed} here.`;
  }
  return `${spec.label} publishes plain HTTP, so Fleet will not expose the operator console, node credentials or lead tokens through it. Use an HTTPS provider such as Dev Tunnels.`;
}
