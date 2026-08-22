import type { McpHttpServer } from "@fleet/protocol";

/**
 * Rebases the Host's MCP address onto the one this node actually reaches it on.
 *
 * The Host has to put *some* address in the command, but it cannot know which
 * one works from here: it may be behind a tunnel, on a LAN address, or on
 * loopback, and the answer differs per node. This node does know — it is
 * connected on `hostUrl`, and has been since it enrolled.
 *
 * So only the path is taken from the Host. Guessing was worth avoiding: the
 * Host's best guess prefers a public tunnel URL, which would send an agent
 * running on the same machine out to the internet and back to reach a port it
 * is already talking to.
 */
export function resolveMcpServers(
  servers: readonly McpHttpServer[] | undefined,
  hostUrl: string,
): McpHttpServer[] {
  // Tolerates absence: a Host older than this field sends a command without
  // one, and an ordinary session is meant to have no servers at all.
  return (servers ?? []).map((server) => ({
    ...server,
    url: rebase(server.url, hostUrl),
  }));
}

function rebase(url: string, hostUrl: string): string {
  try {
    const declared = new URL(url);
    return new URL(`${declared.pathname}${declared.search}`, hostUrl).toString();
  } catch {
    // Not a URL the Host could form; treat it as a path, which is all we use.
    return new URL(url, hostUrl).toString();
  }
}
