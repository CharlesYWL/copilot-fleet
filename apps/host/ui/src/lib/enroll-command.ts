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
  return [
    "npm install",
    "npm run build:node",
    `npm run start:node -- ${dialFlag(hostUrl, tunnelId)} --token="${enrollmentToken}"`,
  ].join("\n");
}

/**
 * How a node is told where to find the Host.
 *
 * The node opens a dev tunnel itself and discovers the forwarded port, so a
 * dev tunnel needs no second terminal and no transcribed port number — and it
 * must never be handed the private URL, which it cannot authenticate to.
 */
function dialFlag(hostUrl: string, tunnelId?: string): string {
  return isDevTunnelUrl(hostUrl)
    ? `--devtunnel="${tunnelId ?? "<tunnel-id>"}"`
    : `--url="${hostUrl}"`;
}

/** What the Connect card needs to print a key-based command. */
export type ConnectCommandFields = {
  hostUrl: string;
  hostId: string;
  hostFingerprint: string;
  enrollmentGrant: string;
  tunnelId?: string | undefined;
};

/**
 * The command that enrolls a machine against a Host it will pin.
 *
 * The fingerprint is the part that matters and the part a person can lose: it
 * travels here, in the same paste as everything else, because a fingerprint the
 * operator has to look up separately is one they will skip — and a node that
 * skips it sends its enrollment to whatever answers the URL.
 *
 * No fleet-wide token appears, because there is no longer one to send: the
 * grant is single-use, expires, and authorises exactly the key the node is
 * about to generate.
 */
export function keyEnrollCommand(fields: ConnectCommandFields): string {
  const flags = [
    dialFlag(fields.hostUrl, fields.tunnelId),
    `--host-id="${fields.hostId}"`,
    `--host-fingerprint="${fields.hostFingerprint}"`,
    `--enrollment-grant="${fields.enrollmentGrant}"`,
  ].join(" ");
  return ["npm install", "npm run build:node", `npm run start:node -- ${flags}`].join(
    "\n",
  );
}
