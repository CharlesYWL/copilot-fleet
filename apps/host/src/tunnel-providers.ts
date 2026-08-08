import type { TunnelProvider } from "@fleet/protocol";

export type ProviderSpec = {
  id: TunnelProvider;
  label: string;
  /** Binary that must exist on PATH. */
  binary: string;
  /** Arguments used to probe whether the binary is installed. */
  versionArgs: string[];
  /** Builds the argv that starts the tunnel for a loopback target. */
  args: (target: LocalTarget) => string[];
  /** Extracts the public URL from a line of CLI output. */
  extractUrl: (text: string) => string | undefined;
  /** Shown in the UI when the binary is missing. */
  installHint: string;
  /** Warning surfaced while the tunnel is online, if any. */
  caveat?: string;
};

export type LocalTarget = {
  /** Full loopback URL, e.g. http://127.0.0.1:8787 */
  url: string;
  host: string;
  port: number;
};

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

const matcher =
  (pattern: RegExp) =>
  (text: string): string | undefined => {
    const match = text.match(pattern);
    return match ? stripTrailingSlash(match[0]) : undefined;
  };

/** Matches the URL cloudflared prints for account-less quick tunnels. */
export const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const NGROK_URL_RE = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io|dev)/i;
const TAILSCALE_URL_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?::\d+)?/i;
/** bore reports `listening at bore.pub:45871` and forwards plain TCP. */
const BORE_HOSTPORT_RE = /listening at ([a-z0-9.-]+:\d+)/i;

export const providerSpecs: Record<TunnelProvider, ProviderSpec> = {
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare",
    binary: "cloudflared",
    versionArgs: ["--version"],
    args: (target) => ["tunnel", "--url", target.url, "--no-autoupdate"],
    extractUrl: matcher(TRYCLOUDFLARE_URL_RE),
    installHint: "brew install cloudflared",
    caveat: "Quick tunnel URLs change on every restart.",
  },
  tailscale: {
    id: "tailscale",
    label: "Tailscale Funnel",
    binary: "tailscale",
    versionArgs: ["version"],
    args: (target) => ["funnel", String(target.port)],
    extractUrl: matcher(TAILSCALE_URL_RE),
    installHint:
      "brew install tailscale, then run `tailscale up` and enable Funnel for this machine.",
  },
  ngrok: {
    id: "ngrok",
    label: "ngrok",
    binary: "ngrok",
    versionArgs: ["version"],
    // `--log stdout` keeps the URL in a pipe-friendly stream instead of the TUI.
    args: (target) => ["http", target.url, "--log", "stdout", "--log-format", "logfmt"],
    extractUrl: matcher(NGROK_URL_RE),
    installHint: "brew install ngrok, then run `ngrok config add-authtoken <token>`.",
    caveat: "Free ngrok domains change on every restart.",
  },
  bore: {
    id: "bore",
    label: "bore",
    binary: "bore",
    versionArgs: ["--version"],
    args: (target) => [
      "local",
      String(target.port),
      "--local-host",
      target.host,
      "--to",
      "bore.pub",
    ],
    // bore is a raw TCP relay, so the public endpoint has no TLS.
    extractUrl: (text) => {
      const match = text.match(BORE_HOSTPORT_RE);
      return match ? `http://${match[1]}` : undefined;
    },
    installHint: "brew install bore-cli",
    caveat: "bore relays plain TCP, so traffic is not encrypted in transit.",
  },
};

export const providerList: ProviderSpec[] = Object.values(providerSpecs);

export function extractTunnelUrl(
  text: string,
  provider: TunnelProvider = "cloudflare",
): string | undefined {
  return providerSpecs[provider].extractUrl(text);
}

export function parseLocalTarget(url: string): LocalTarget {
  const parsed = new URL(url);
  return {
    url: stripTrailingSlash(url),
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
  };
}
