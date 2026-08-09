/** Loopback and wildcard addresses resolve to the wrong box on a remote node. */
export function isLocalOnlyHostUrl(hostUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/.test(
    hostUrl,
  );
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
export function enrollCommand(hostUrl: string, enrollmentToken: string): string {
  return [
    "npm install",
    "npm run build:node",
    `npm run start:node -- --url="${hostUrl}" --token="${enrollmentToken}"`,
  ].join("\n");
}
