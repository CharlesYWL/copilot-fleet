export type NodeShell = "bash" | "powershell";

/** Loopback and wildcard addresses resolve to the wrong box on a remote node. */
export function isLocalOnlyHostUrl(hostUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/.test(
    hostUrl,
  );
}

export const nodeShells: { key: NodeShell; label: string }[] = [
  { key: "bash", label: "macOS / Linux" },
  { key: "powershell", label: "Windows" },
];

/**
 * A first-run command for a machine that already has a Fleet checkout, Node.js
 * and an authenticated Copilot CLI. The node name defaults to the machine
 * hostname; rename it later from the Host's Nodes tab.
 */
export function enrollCommand(
  shell: NodeShell,
  hostUrl: string,
  enrollmentToken: string,
): string {
  if (shell === "powershell") {
    return [
      "npm install",
      "npm run build:node",
      `$env:FLEET_HOST_URL="${hostUrl}"`,
      `$env:FLEET_ENROLLMENT_TOKEN="${enrollmentToken}"`,
      "npm run start:node",
    ].join("\n");
  }
  return [
    "npm install",
    "npm run build:node",
    `FLEET_HOST_URL="${hostUrl}" \\`,
    `  FLEET_ENROLLMENT_TOKEN="${enrollmentToken}" \\`,
    "  npm run start:node",
  ].join("\n");
}
