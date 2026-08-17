import type { TunnelProviderInfo, TunnelState } from "@fleet/protocol";

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
    const state = stateFor(spec.id);
    // "Active" covers anything the operator has asked to be up, including a
    // tunnel still starting or one that failed while enabled — those are the
    // rows most likely to need attention, so they must not drop below an idle
    // provider that merely happens to be installed.
    const live =
      state?.status === "on" ||
      state?.status === "starting" ||
      state?.status === "stopping" ||
      Boolean(state?.enabled);
    if (live) return 0;
    return spec.binaryPresent ? 1 : 2;
  };

  return providers
    .map((spec, index) => ({ spec, index }))
    .sort((a, b) => rank(a.spec) - rank(b.spec) || a.index - b.index)
    .map((entry) => entry.spec);
}
