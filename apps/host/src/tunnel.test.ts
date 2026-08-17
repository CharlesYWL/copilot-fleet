import { describe, expect, it, vi } from "vitest";
import { BinaryProbe, restartDelay, RESTART_DELAYS_MS, TunnelManager } from "./tunnel.js";
import { extractTunnelUrl, parseLocalTarget, providerSpecs } from "./tunnel-providers.js";

/** Never spawns anything, so tests do not depend on what the box has installed. */
const fakeProbe = (present = true) => new BinaryProbe(async () => present);

describe("external tunnel handover", () => {
  const managerWithExternal = (url: string | undefined) =>
    new TunnelManager({
      localTarget: "http://127.0.0.1:8787",
      readExternal: () => ({ provider: "bore" as const, url }),
      probe: fakeProbe(),
    });

  it("reports the external url and flags that the Host does not own it", async () => {
    const info = await managerWithExternal("http://bore.pub:1234").info(
      "http://127.0.0.1:8787",
    );
    expect(info.external).toBe(true);
    expect(info.publicUrl).toBe("http://bore.pub:1234");
    expect(info.status).toBe("on");
    expect(info.provider).toBe("bore");
  });

  it("shows a tunnel that has not published its url yet as starting", async () => {
    const info = await managerWithExternal(undefined).info("http://127.0.0.1:8787");
    expect(info.status).toBe("starting");
    expect(info.publicUrl).toBe("http://127.0.0.1:8787");
  });

  it("refuses to start or stop a process it never spawned", async () => {
    const manager = managerWithExternal("http://bore.pub:1234");
    // Both calls must be inert: stopping would kill a tunnel owned by another
    // terminal, and starting would race a second binary onto the same port.
    await manager.setEnabled(false);
    await manager.stop();
    expect(manager.activeTunnelUrl()).toBe("http://bore.pub:1234");
  });

  it("falls back to its own lifecycle when no external tunnel is running", async () => {
    const manager = new TunnelManager({
      localTarget: "http://127.0.0.1:8787",
      readExternal: () => undefined,
      probe: fakeProbe(false),
    });
    const info = await manager.info("http://127.0.0.1:8787");
    expect(info.external).toBe(false);
    expect(info.status).toBe("off");
    expect(info.binaryPresent).toBe(false);
  });
});

describe("BinaryProbe", () => {
  const spec = providerSpecs.cloudflare;

  it("probes once and serves the rest of the poll storm from cache", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const cache = new BinaryProbe(probe, 1_000, () => 0);
    // The Settings page polls /api/tunnel every 2s and each response describes
    // every provider, which used to mean five process spawns per poll.
    await Promise.all([cache.present(spec), cache.present(spec)]);
    await cache.present(spec);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the entry expires", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    let now = 0;
    const cache = new BinaryProbe(probe, 1_000, () => now);
    await cache.present(spec);
    now = 1_001;
    await cache.present(spec);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("re-probes after an explicit invalidation, so a fresh install is seen", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const cache = new BinaryProbe(probe, 60_000, () => 0);
    await cache.present(spec);
    cache.invalidate();
    await cache.present(spec);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("tunnel manager binary guard", () => {
  it("refuses to start when the provider CLI is missing and clears enabled", async () => {
    let cleared = false;
    const manager = new TunnelManager({
      localTarget: "http://127.0.0.1:8787",
      readExternal: () => undefined,
      probe: fakeProbe(false),
      onEnabledCleared: () => {
        cleared = true;
      },
    });
    await expect(manager.setEnabled(true)).rejects.toThrow(/not installed/);
    expect(cleared).toBe(true);
    const info = await manager.info("http://127.0.0.1:8787");
    expect(info.status).toBe("error");
    expect(info.enabled).toBe(false);
  });
});

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
      extractTunnelUrl(
        "see https://developers.cloudflare.com and https://abc-def.trycloudflare.com/",
      ),
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

/** Captured from a real `devtunnel host -p 8790` run. */
const DEVTUNNEL_LOG = [
  "Connection to host tunnel relay restored.",
  "Hosting port: 8790",
  "Connect via browser: https://7m667npm-8790.usw2.devtunnels.ms",
  "Inspect network activity: https://7m667npm-8790-inspect.usw2.devtunnels.ms",
  "",
  "Ready to accept connections for tunnel: neat-lake-7x8gj9s.usw2",
].join("\n");

describe("devtunnel output parsing", () => {
  it("takes the forwarding URL from a full session banner", () => {
    expect(extractTunnelUrl(DEVTUNNEL_LOG, "devtunnel")).toBe(
      "https://7m667npm-8790.usw2.devtunnels.ms",
    );
  });

  /**
   * Checked in isolation on purpose. Both URLs end in devtunnels.ms and the
   * forwarding one merely happens to be printed first, so a test that only
   * looks at the full banner would still pass with a pattern that cannot tell
   * them apart — and the manager latches the first URL it parses for the life
   * of the process.
   */
  it("refuses the inspector URL rather than merely ranking it second", () => {
    const inspectOnly =
      "Inspect network activity: https://7m667npm-8790-inspect.usw2.devtunnels.ms";
    expect(extractTunnelUrl(inspectOnly, "devtunnel")).toBeUndefined();
  });

  it("reads back the tunnel id, which the URL does not encode", () => {
    expect(providerSpecs.devtunnel.extractId?.(DEVTUNNEL_LOG)).toBe(
      "neat-lake-7x8gj9s.usw2",
    );
  });

  it("has no id to report before the tunnel is ready", () => {
    expect(providerSpecs.devtunnel.extractId?.("Hosting port: 8790")).toBeUndefined();
  });

  it("forwards the loopback port as an explicit http origin", () => {
    const args = providerSpecs.devtunnel.args(parseLocalTarget("http://127.0.0.1:8790"));
    expect(args).toEqual(["host", "-p", "8790", "--protocol", "http"]);
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
