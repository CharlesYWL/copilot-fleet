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

/**
 * The one-time step that authenticates this machine against the tunnel.
 *
 * Kept separate from the start command because it is interactive — it opens a
 * browser — and because it only has to be done once per machine, while the
 * command below is what gets re-run.
 */
export function devTunnelLoginCommand(): string {
  return "devtunnel user login";
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
  // The node opens the tunnel itself and discovers the forwarded port, so a
  // dev tunnel needs no second terminal and no transcribed port number.
  const target = isDevTunnelUrl(hostUrl)
    ? `--devtunnel="${tunnelId ?? "<tunnel-id>"}"`
    : `--url="${hostUrl}"`;
  return [
    "npm install",
    "npm run build:node",
    `npm run start:node -- ${target} --token="${enrollmentToken}"`,
  ].join("\n");
}
