import { describe, expect, it } from "vitest";
import { extractTunnelUrl, restartDelay, RESTART_DELAYS_MS } from "./tunnel.js";
import { parseLocalTarget, providerSpecs } from "./tunnel-providers.js";

describe("extractTunnelUrl", () => {
  it("pulls the trycloudflare URL out of cloudflared banner text", () => {
    const log = `
INF |  Your quick Tunnel has been created! Visit it at:
INF |  https://include-prayers-ministers-logical.trycloudflare.com                               |
INF +--------------------------------------------------------------------------------------------+
`;
    expect(extractTunnelUrl(log)).toBe(
      "https://include-prayers-ministers-logical.trycloudflare.com",
    );
  });

  it("strips a trailing slash and ignores unrelated https links", () => {
    expect(
      extractTunnelUrl("see https://developers.cloudflare.com and https://abc-def.trycloudflare.com/"),
    ).toBe("https://abc-def.trycloudflare.com");
  });

  it("returns undefined when no quick tunnel URL is present", () => {
    expect(extractTunnelUrl("INF Starting metrics server")).toBeUndefined();
  });

  it("reads the forwarding URL out of ngrok logfmt output", () => {
    const log =
      't=2026-08-08T08:00:00-0700 lvl=info msg="started tunnel" url=https://1a2b-3c.ngrok-free.app';
    expect(extractTunnelUrl(log, "ngrok")).toBe("https://1a2b-3c.ngrok-free.app");
  });

  it("reads the funnel hostname out of tailscale output", () => {
    const log = "Available on the internet:\n\nhttps://my-box.tail1234.ts.net/\n";
    expect(extractTunnelUrl(log, "tailscale")).toBe("https://my-box.tail1234.ts.net");
  });

  it("turns the bore host:port line into an http URL", () => {
    const log =
      "2026-08-08T08:22:34.641798Z  INFO bore_cli::client: listening at bore.pub:45871";
    expect(extractTunnelUrl(log, "bore")).toBe("http://bore.pub:45871");
  });

  it("does not match another provider's banner", () => {
    const cloudflareLog = "https://abc-def.trycloudflare.com";
    expect(extractTunnelUrl(cloudflareLog, "ngrok")).toBeUndefined();
    expect(extractTunnelUrl(cloudflareLog, "bore")).toBeUndefined();
  });
});

describe("parseLocalTarget", () => {
  it("splits a loopback URL into host and port for port-only providers", () => {
    expect(parseLocalTarget("http://127.0.0.1:8787")).toEqual({
      url: "http://127.0.0.1:8787",
      host: "127.0.0.1",
      port: 8787,
    });
  });

  it("passes the port through to bore and tailscale argv", () => {
    const target = parseLocalTarget("http://127.0.0.1:8787");
    expect(providerSpecs.bore.args(target)).toContain("8787");
    expect(providerSpecs.tailscale.args(target)).toEqual(["funnel", "8787"]);
  });
});

describe("restartDelay", () => {
  it("backs off on repeated failures and caps at the last step", () => {
    expect(restartDelay(0)).toBe(RESTART_DELAYS_MS[0]);
    expect(restartDelay(2)).toBe(RESTART_DELAYS_MS[2]);
    expect(restartDelay(99)).toBe(RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1]);
  });
});
