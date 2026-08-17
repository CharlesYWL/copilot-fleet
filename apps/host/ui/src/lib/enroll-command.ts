/** Loopback and wildcard addresses resolve to the wrong box on a remote node. */
export function isLocalOnlyHostUrl(hostUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/.test(
    hostUrl,
  );
}

/**
 * Dev Tunnels URLs are private by default: opening one prompts for a Microsoft
 * login, and a node has no way to satisfy that. It sends neither a browser
 * cookie nor an `X-Tunnel-Authorization` header, so dialing this URL directly
 * fails with 401 on register and 302 on the WebSocket upgrade.
 */
export function isDevTunnelUrl(hostUrl: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.[a-z0-9]+\.devtunnels\.ms(:|\/|$)/i.test(hostUrl);
}

/** Port the node should dial once `devtunnel connect` is forwarding locally. */
function forwardedPortFrom(hostUrl: string): string {
  // The port is the trailing segment of the URL's first label, e.g.
  // https://7m667npm-8790.usw2.devtunnels.ms -> 8790.
  const match = hostUrl.match(/^https:\/\/[a-z0-9-]*?-(\d+)\./i);
  return match?.[1] ?? "8787";
}

/**
 * Enrollment for a private Dev Tunnel, where the public URL is unusable to a
 * node. The node reaches the Host through a locally forwarded port instead, so
 * the CLI's own login does the authenticating and the node needs no token.
 *
 * The forwarded port is only usually the same number as the Host's: the CLI
 * picks the next free one when it is taken, which is why the operator is told
 * to read it back rather than being handed a guess.
 */
function devTunnelEnrollCommand(
  hostUrl: string,
  enrollmentToken: string,
  tunnelId: string | undefined,
): string {
  const port = forwardedPortFrom(hostUrl);
  return [
    "devtunnel user login",
    `devtunnel connect ${tunnelId ?? "<tunnel-id>"}`,
    "",
    `# Use the port from the CLI's "Forwarding from 127.0.0.1:<port>" line below.`,
    "npm install",
    "npm run build:node",
    `npm run start:node -- --url="http://127.0.0.1:${port}" --token="${enrollmentToken}"`,
  ].join("\n");
}

/**
 * A first-run command for a machine that already has a Fleet checkout, Node.js
 * and an authenticated Copilot CLI. The node name defaults to the machine
 * hostname; rename it later from the Host's Nodes tab.
 *
 * Flags rather than environment variables, so the same three lines can be
 * pasted into any shell: the previous form needed a `$env:` rewrite for
 * PowerShell, and a copy of the bash version there silently started a node
 * pointed at localhost.
 */
export function enrollCommand(
  hostUrl: string,
  enrollmentToken: string,
  tunnelId?: string,
): string {
  if (isDevTunnelUrl(hostUrl)) {
    return devTunnelEnrollCommand(hostUrl, enrollmentToken, tunnelId);
  }
  return [
    "npm install",
    "npm run build:node",
    `npm run start:node -- --url="${hostUrl}" --token="${enrollmentToken}"`,
  ].join("\n");
}
