import type { NodeConnection, TunnelProvider } from "@fleet/protocol";

type Endpoint = { provider: TunnelProvider; url: string | undefined };

/** These labels describe a connection; they never authorize it or adopt a Host URL. */
export const resolveNodeConnection = (
  reported: NodeConnection | undefined,
  requestHost: string | undefined,
  endpoints: readonly Endpoint[],
): NodeConnection | undefined => {
  if (reported?.provider === "devtunnel") return { provider: "devtunnel" };
  if (reported) {
    if (reported.provider !== "direct" || !reported.hostUrl) return reported;
    const matched = endpoints.find((endpoint) => {
      if (!endpoint.url) return false;
      try {
        return new URL(endpoint.url).origin === reported.hostUrl;
      } catch {
        return false;
      }
    });
    return matched ? { ...reported, provider: matched.provider } : reported;
  }
  if (!requestHost || /[\s/@?#]/.test(requestHost)) return undefined;
  for (const endpoint of endpoints) {
    if (!endpoint.url) continue;
    try {
      const url = new URL(endpoint.url);
      const observed = new URL(`${url.protocol}//${requestHost}`);
      if (observed.host.toLowerCase() === url.host.toLowerCase())
        return { provider: endpoint.provider, hostUrl: url.origin };
    } catch {
      /* An invalid or incomplete optional endpoint cannot identify a route. */
    }
  }
  return undefined;
};
