import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { TunnelProvider } from "@fleet/protocol";

const execFileAsync = promisify(execFile);

const runDevTunnel = (args: string[]): Promise<unknown> =>
  execFileAsync("devtunnel", args, { windowsHide: true, timeout: 30_000 });

/**
 * Registering a tunnel or a port that already exists is the steady state, not a
 * failure: the Host re-runs setup on every start so a half-configured tunnel
 * repairs itself. Only a conflict is swallowed — a missing binary or a signed-out
 * CLI still has to surface, or the operator gets a silent no-op.
 */
async function tolerateConflict(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    const text = error instanceof Error ? `${error.message}` : String(error);
    if (/conflict/i.test(text)) return;
    throw error;
  }
}

export type ProviderSpec = {
  id: TunnelProvider;
  label: string;
  /** Binary that must exist on PATH. */
  binary: string;
  /** Arguments used to probe whether the binary is installed. */
  versionArgs: string[];
  /** Builds the argv that starts the tunnel for a loopback target. */
  args: (target: LocalTarget, tunnelId?: string) => string[];
  /**
   * Registers whatever the provider needs before `args` can be spawned, and
   * returns the id to host. Providers that need no setup omit this and get a
   * fresh anonymous tunnel each start.
   */
  prepare?: (target: LocalTarget, tunnelId: string) => Promise<void>;
  /** A stable id this provider can reuse so its URL survives restarts. */
  newTunnelId?: () => string;
  /** Extracts the public URL from a line of CLI output. */
  extractUrl: (text: string) => string | undefined;
  /**
   * Extracts a secondary URL for inspecting traffic, when the provider offers
   * one. Deliberately separate from `extractUrl`, which must reject it.
   */
  extractInspectUrl?: (text: string) => string | undefined;
  /**
   * Extracts the provider's own tunnel identifier, for providers whose public
   * URL does not encode it. Only Dev Tunnels needs this today.
   */
  extractId?: (text: string) => string | undefined;
  /** Shown in the UI when the binary is missing. */
  installHint: string;
  /** Ordered setup steps shown in the provider's help dialog. */
  setupSteps: string[];
  /** Upstream documentation for this provider. */
  docsUrl: string;
  /** Warning surfaced while the tunnel is online, if any. */
  caveat?: string;
  /**
   * Whether a node can dial this provider's URL directly.
   *
   * False for tunnels that demand an interactive login: a running node told to
   * move to one cannot authenticate, cannot reach the Host to be told anything
   * else, and has to be repointed by hand. Such a URL is still worth showing —
   * enrollment has a command for it — but must never be pushed to live nodes.
   */
  nodeDialable?: boolean;
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
/**
 * `devtunnel host` prints two devtunnels.ms URLs: the forwarding one, then an
 * `-inspect` sibling for its traffic inspector. The lookbehind rejects the
 * inspector, because the first URL parsed is latched for the life of the
 * process — a single mis-parse would point every enrollment at a debugging UI.
 */
export const DEVTUNNEL_URL_RE =
  /https:\/\/[a-z0-9-]+(?<!-inspect)\.[a-z0-9]+\.devtunnels\.ms/i;
/** The sibling host that serves the traffic inspector for the same tunnel. */
export const DEVTUNNEL_INSPECT_URL_RE =
  /https:\/\/[a-z0-9-]+-inspect\.[a-z0-9]+\.devtunnels\.ms/i;
/** `Ready to accept connections for tunnel: neat-lake-7x8gj9s.usw2` */
export const DEVTUNNEL_ID_RE = /(?<=for tunnel:\s)[a-z0-9-]+\.[a-z0-9]+/i;

export const providerSpecs: Record<TunnelProvider, ProviderSpec> = {
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare",
    binary: "cloudflared",
    versionArgs: ["--version"],
    args: (target) => ["tunnel", "--url", target.url, "--no-autoupdate"],
    extractUrl: matcher(TRYCLOUDFLARE_URL_RE),
    installHint: "brew install cloudflared",
    setupSteps: [
      "Install the CLI: `brew install cloudflared` (or `winget install Cloudflare.cloudflared`).",
      "No account or login is needed — quick tunnels are anonymous.",
      "Switch this on; the Host runs `cloudflared` and reads the URL it prints.",
      "Anyone with the URL can reach this Host, so treat it as a secret.",
    ],
    docsUrl:
      "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/",
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
    setupSteps: [
      "Install Tailscale and run `tailscale up` to join your tailnet.",
      "Enable Funnel for this machine in the admin console — it is off by default.",
      "Switch this on; the Host runs `tailscale funnel` against its own port.",
      "The URL is a stable name on your tailnet, so it survives restarts.",
    ],
    docsUrl: "https://tailscale.com/kb/1223/funnel",
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
    setupSteps: [
      "Install the CLI: `brew install ngrok` (or `winget install ngrok.ngrok`).",
      "Create a free ngrok account and run `ngrok config add-authtoken <token>` once.",
      "Switch this on; the Host runs `ngrok http` against its own port.",
      "A free domain is public and rotates — a paid reserved domain keeps it fixed.",
    ],
    docsUrl: "https://ngrok.com/docs/getting-started/",
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
    setupSteps: [
      "Install the CLI: `brew install bore-cli` (or `cargo install bore-cli`).",
      "No account or login is needed.",
      "Switch this on; the Host runs `bore local` against its own port.",
      "The public endpoint is plain HTTP over a TCP relay — there is no TLS, so anything sent through it is readable in transit. Prefer another provider for real traffic.",
    ],
    docsUrl: "https://github.com/ekzhang/bore",
    caveat: "bore relays plain TCP, so traffic is not encrypted in transit.",
  },
  devtunnel: {
    id: "devtunnel",
    label: "Dev Tunnels",
    binary: "devtunnel",
    versionArgs: ["--version"],
    // Hosting a named tunnel keeps the URL stable across restarts, which is
    // what lets a node keep one `devtunnel connect <id>` command forever.
    // Without an id the service mints a throwaway tunnel and a new URL.
    args: (target, tunnelId) =>
      tunnelId
        ? ["host", tunnelId]
        : ["host", "-p", String(target.port), "--protocol", "http"],
    // The port cannot be passed to `host` alongside an existing id — the
    // service rejects that as a batch port update — so both the tunnel and its
    // port are registered first. Each call conflicts once the entity exists,
    // which is the normal steady state and not an error.
    prepare: async (target, tunnelId) => {
      await tolerateConflict(runDevTunnel(["create", tunnelId]));
      await tolerateConflict(
        runDevTunnel([
          "port",
          "create",
          tunnelId,
          "-p",
          String(target.port),
          "--protocol",
          "http",
        ]),
      );
    },
    newTunnelId: () => `fleet-${randomBytes(4).toString("hex")}`,
    extractUrl: matcher(DEVTUNNEL_URL_RE),
    extractInspectUrl: matcher(DEVTUNNEL_INSPECT_URL_RE),
    extractId: matcher(DEVTUNNEL_ID_RE),
    installHint: "winget install Microsoft.devtunnel, then run `devtunnel user login`.",
    setupSteps: [
      "Install the CLI: `winget install Microsoft.devtunnel` (or `brew install --cask devtunnel`).",
      "Run `devtunnel user login` once on this machine — hosting requires a signed-in account.",
      "Switch this on; the Host reuses a named tunnel, so the URL survives restarts.",
      "Opening the URL in a browser prompts for a Microsoft login — that is the point, and it is why the URL alone grants nobody access.",
      "Nodes cannot answer that login, so they use `--devtunnel <id>` instead: the node opens the tunnel itself and dials a forwarded local port. The Connect card generates the command.",
    ],
    docsUrl: "https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started",
    caveat:
      "Private by default: the URL prompts for a Microsoft login, so nodes cannot dial it directly. Nodes reach it through `devtunnel connect`.",
    // A node handed this URL would be redirected to a login it cannot answer,
    // and would then be unreachable for a correction.
    nodeDialable: false,
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
