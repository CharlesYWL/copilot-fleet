import type { TunnelPolicy, TunnelProviderInfo, TunnelState } from "@fleet/protocol";

/**
 * Whether the operator has asked this provider to be up, or it still is.
 *
 * Covers a tunnel still starting or one that failed while enabled — those are
 * the rows most likely to need attention, so they must neither drop below an
 * idle provider that merely happens to be installed nor be hidden by a policy.
 */
const isLive = (state: TunnelState | undefined): boolean =>
  state?.status === "on" ||
  state?.status === "starting" ||
  state?.status === "stopping" ||
  Boolean(state?.enabled);

/**
 * Providers the tunnel settings page should render at all.
 *
 * Under a Microsoft corporate policy, a provider the Host will not run is not
 * offered: a greyed-out Cloudflare switch on a corp machine is still an
 * invitation to go and find a way around it. One that is somehow still up — a
 * tunnel from before the policy applied, or one started in another terminal —
 * stays visible, so the operator can see it and switch it off.
 *
 * Every other policy keeps the full catalog, with refused providers greyed out
 * and explained, exactly as before.
 */
export function visibleTunnelProviders(
  providers: readonly TunnelProviderInfo[],
  policy: TunnelPolicy | undefined,
  stateFor: (provider: TunnelProviderInfo["id"]) => TunnelState | undefined,
): TunnelProviderInfo[] {
  if (policy?.kind !== "microsoft-corp") return [...providers];
  return providers.filter((spec) => {
    if (policy.allowedProviders.includes(spec.id)) return true;
    const state = stateFor(spec.id);
    return isLive(state) || Boolean(state?.external);
  });
}

/**
 * Card order for the tunnel settings page: active, then installed, then the rest.
 *
 * What an operator came to see is what is currently running; what they might
 * switch on comes next; a provider whose CLI is missing is not actionable
 * without leaving the page and sinks to the bottom.
 *
 * Ties keep the caller's original order rather than falling back to something
 * like alphabetical, because the list is re-rendered on every poll and a
 * comparator that can reorder equal items makes cards jump under the cursor.
 */
export function orderTunnelProviders(
  providers: readonly TunnelProviderInfo[],
  stateFor: (provider: TunnelProviderInfo["id"]) => TunnelState | undefined,
): TunnelProviderInfo[] {
  const rank = (spec: TunnelProviderInfo): number => {
    if (isLive(stateFor(spec.id))) return 0;
    return spec.binaryPresent ? 1 : 2;
  };

  return providers
    .map((spec, index) => ({ spec, index }))
    .sort((a, b) => rank(a.spec) - rank(b.spec) || a.index - b.index)
    .map((entry) => entry.spec);
}
