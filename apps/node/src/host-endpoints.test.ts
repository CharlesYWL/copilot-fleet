import { describe, expect, it } from "vitest";
import {
  adoptHostUrl,
  dialableInMode,
  endpointsAfterOperatorEdit,
  endpointsBehindLocalForward,
  firstDialUrl,
  hostUrlCandidates,
  isConfidentialHostUrl,
  nextHostUrl,
  promoteHostUrl,
  recordHostUrl,
  type HostEndpoints,
} from "./host-endpoints.js";

const lan = "https://192.168.1.20:8787";
/** The same machine over a wire anyone on the path can read. */
const plainLan = "http://192.168.1.20:8787";
const tunnel = "https://one.trycloudflare.com";
const rotated = "https://two.trycloudflare.com";
const forward = "http://127.0.0.1:8790";
const publicDevTunnel = "https://hqn74pr4-8790.usw2.devtunnels.ms";

describe("adoptHostUrl", () => {
  it("takes the announced address and keeps the working one as a fallback", () => {
    // The announcement arrived over the LAN connection, which proves the LAN
    // address works and proves nothing about the tunnel.
    const moved = adoptHostUrl({ hostUrl: lan, knownHostUrls: [] }, tunnel);
    expect(moved).toEqual({ hostUrl: tunnel, knownHostUrls: [lan] });
  });

  it("ignores an announcement of the address already in use", () => {
    const endpoints: HostEndpoints = { hostUrl: tunnel, knownHostUrls: [lan] };
    expect(adoptHostUrl(endpoints, tunnel)).toBe(endpoints);
    expect(adoptHostUrl(endpoints, `${tunnel}/`)).toBe(endpoints);
    expect(adoptHostUrl(endpoints, "  ")).toBe(endpoints);
  });

  it("does not keep the same address in both slots after a rotation back", () => {
    const first = adoptHostUrl({ hostUrl: lan, knownHostUrls: [] }, tunnel);
    const second = adoptHostUrl(first, rotated);
    const back = adoptHostUrl(second, tunnel);
    expect(back).toEqual({ hostUrl: tunnel, knownHostUrls: [rotated, lan] });
  });

  it("stops the fallback list growing without bound", () => {
    let endpoints: HostEndpoints = { hostUrl: lan, knownHostUrls: [] };
    for (let index = 0; index < 8; index += 1) {
      endpoints = adoptHostUrl(endpoints, `https://tunnel-${index}.example.com`);
    }
    expect(endpoints.knownHostUrls.length).toBeLessThanOrEqual(4);
    expect(endpoints.hostUrl).toBe("https://tunnel-7.example.com");
  });
});

describe("hostUrlCandidates", () => {
  it("leads with the primary and drops duplicate spellings", () => {
    expect(
      hostUrlCandidates({ hostUrl: tunnel, knownHostUrls: [`${tunnel}/`, lan, ""] }),
    ).toEqual([tunnel, lan]);
  });
});

describe("tunnel mode exclusivity", () => {
  /**
   * The list DevBox2 was stranded on: three tunnels the Host no longer hosts,
   * the forward that actually worked, and a named tunnel that had been deleted.
   */
  const stranded: HostEndpoints = {
    hostUrl: publicDevTunnel,
    knownHostUrls: [
      "https://k1ptp301-8790.usw2.devtunnels.ms",
      "https://p75f5584-8790.usw2.devtunnels.ms",
      forward,
      "https://cf.example.com",
    ],
  };

  it("dials only the local forward when the node opened the tunnel itself", () => {
    // The three public URLs are refused in about 60ms each, which is what let
    // the reconnect loop drive the tunnel recycler faster than the tunnel could
    // come up. A node in this mode has exactly one address worth dialing.
    expect(hostUrlCandidates(stranded, "devtunnel")).toEqual([forward]);
  });

  it("never rotates away from the forward, so the dial cannot fail fast", () => {
    expect(nextHostUrl(stranded, forward, "devtunnel")).toBe(forward);
  });

  it("opens on the forward even when the stored primary is a dead tunnel", () => {
    expect(firstDialUrl(stranded, publicDevTunnel, "devtunnel")).toBe(forward);
  });

  it("refuses a Dev Tunnels address for a node that dials the Host directly", () => {
    // It answers a browser and only a browser: a node has no cookie and no
    // tunnel header, so this can only ever be a fast failure.
    expect(dialableInMode(publicDevTunnel, "direct")).toBe(false);
    expect(hostUrlCandidates(stranded, "direct")).toEqual([
      forward,
      "https://cf.example.com",
    ]);
  });

  it("keeps the remembered address when it suits the mode", () => {
    expect(firstDialUrl(stranded, forward, "devtunnel")).toBe(forward);
    expect(firstDialUrl({ hostUrl: tunnel, knownHostUrls: [lan] }, lan, "direct")).toBe(
      lan,
    );
  });

  it("offers the primary rather than nothing when no address fits the mode", () => {
    // A node with no address at all cannot even report that it is stuck.
    const noForward: HostEndpoints = { hostUrl: publicDevTunnel, knownHostUrls: [] };
    expect(hostUrlCandidates(noForward, "devtunnel")).toEqual([publicDevTunnel]);
  });

  it("ignores the ports a rebuilt forward used to bind", () => {
    // The CLI takes another port when its first choice is busy, so a node
    // accumulates loopback addresses that are as dead as any other — and refuse
    // a dial just as fast, which is what put the recycler on the clock.
    const moved: HostEndpoints = {
      hostUrl: "http://127.0.0.1:9001",
      knownHostUrls: [forward, publicDevTunnel],
    };
    expect(hostUrlCandidates(moved, "devtunnel")).toEqual(["http://127.0.0.1:9001"]);
    expect(nextHostUrl(moved, "http://127.0.0.1:9001", "devtunnel")).toBe(
      "http://127.0.0.1:9001",
    );
  });

  it("treats a direct node's ordinary addresses as dialable", () => {
    expect(dialableInMode(lan, "direct")).toBe(true);
    expect(dialableInMode(tunnel, "direct")).toBe(true);
    // A forward is still fine to dial directly; it is the mode that is fixed,
    // not the shape of the URL.
    expect(dialableInMode(forward, "direct")).toBe(true);
  });

  it("rejects addresses that are not addresses", () => {
    expect(dialableInMode("", "direct")).toBe(false);
    expect(dialableInMode("   ", "devtunnel")).toBe(false);
  });
});

/**
 * What a Node may put its credentials on.
 *
 * A Node's traffic is not merely a session cookie: the connection carries its
 * shared secret on the legacy protocol, its signed proofs on the new one, and
 * the lead token the Host hands an agent for `/mcp`. On plain HTTP to anything
 * that is not this machine — a LAN address, a `bore` relay — every one of those
 * is readable by whoever is on the path, and the sealed channel does not help:
 * the legacy hello is in the clear by construction, and the tokens the Host
 * sends afterwards ride the same wire.
 *
 * Loopback is the exception and the only one. `http://127.0.0.1` and
 * `http://localhost` never leave the machine, which is exactly what a
 * `devtunnel connect` forward gives this node.
 */
describe("plain HTTP to somewhere that is not this machine", () => {
  it("refuses a LAN address, however the node was started", () => {
    expect(isConfidentialHostUrl(plainLan)).toBe(false);
    expect(dialableInMode(plainLan, "direct")).toBe(false);
    expect(dialableInMode(plainLan, "devtunnel")).toBe(false);
  });

  it("refuses a plain-HTTP relay", () => {
    expect(isConfidentialHostUrl("http://bore.pub:45871")).toBe(false);
    expect(dialableInMode("http://bore.pub:45871", "direct")).toBe(false);
  });

  it("keeps loopback, which is what a local forward is", () => {
    expect(isConfidentialHostUrl(forward)).toBe(true);
    expect(isConfidentialHostUrl("http://localhost:8787")).toBe(true);
    expect(isConfidentialHostUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isConfidentialHostUrl("http://[::1]:8787")).toBe(true);
    expect(dialableInMode(forward, "devtunnel")).toBe(true);
  });

  it("keeps every https address, loopback or not", () => {
    expect(isConfidentialHostUrl(tunnel)).toBe(true);
    expect(isConfidentialHostUrl(lan)).toBe(true);
  });

  it("refuses what is not an address at all", () => {
    expect(isConfidentialHostUrl("")).toBe(false);
    expect(isConfidentialHostUrl("not-a-url")).toBe(false);
    expect(isConfidentialHostUrl("ftp://fleet.example.com")).toBe(false);
  });

  /*
   * The rotation must not quietly pick one either. A node whose only remaining
   * fallback is a LAN address is stranded, and saying so beats sending its
   * secret over the wire.
   */
  it("keeps one out of the candidate list even as a last resort", () => {
    const endpoints: HostEndpoints = { hostUrl: tunnel, knownHostUrls: [plainLan] };
    expect(hostUrlCandidates(endpoints, "direct")).toEqual([tunnel]);
  });
});

describe("recordHostUrl", () => {
  it("remembers an address this node cannot use without moving to it", () => {
    // The Host is authoritative about where it lives, not about how this node
    // gets there. Keeping the address is what lets the mode change later.
    const endpoints: HostEndpoints = { hostUrl: forward, knownHostUrls: [lan] };
    expect(recordHostUrl(endpoints, publicDevTunnel)).toEqual({
      hostUrl: forward,
      knownHostUrls: [publicDevTunnel, lan],
    });
  });

  it("does not file the address it is already on", () => {
    const endpoints: HostEndpoints = { hostUrl: forward, knownHostUrls: [lan] };
    expect(recordHostUrl(endpoints, `${forward}/`)).toBe(endpoints);
    expect(recordHostUrl(endpoints, "  ")).toBe(endpoints);
  });

  it("keeps one entry per address and stays bounded", () => {
    let endpoints: HostEndpoints = { hostUrl: forward, knownHostUrls: [] };
    for (let index = 0; index < 8; index += 1) {
      endpoints = recordHostUrl(endpoints, `https://tunnel-${index}.example.com`);
    }
    expect(endpoints.hostUrl).toBe(forward);
    expect(endpoints.knownHostUrls.length).toBeLessThanOrEqual(4);
    expect(endpoints.knownHostUrls[0]).toBe("https://tunnel-7.example.com");
  });
});

describe("nextHostUrl", () => {
  const endpoints: HostEndpoints = { hostUrl: tunnel, knownHostUrls: [lan] };

  it("falls back to the previously working address when a dial fails", () => {
    expect(nextHostUrl(endpoints, tunnel)).toBe(lan);
  });

  it("cycles, so a Host that comes back is found on either address", () => {
    expect(nextHostUrl(endpoints, lan)).toBe(tunnel);
  });

  it("restarts the rotation from an address it does not know", () => {
    expect(nextHostUrl(endpoints, "https://edited-mid-dial.example.com")).toBe(tunnel);
  });

  it("stays put when there is nowhere else to go", () => {
    expect(nextHostUrl({ hostUrl: tunnel, knownHostUrls: [] }, tunnel)).toBe(tunnel);
  });
});

describe("promoteHostUrl", () => {
  it("makes the address that connected the primary one", () => {
    expect(promoteHostUrl({ hostUrl: tunnel, knownHostUrls: [lan] }, lan)).toEqual({
      hostUrl: lan,
      knownHostUrls: [tunnel],
    });
  });

  it("reports no change when the primary is what connected", () => {
    // The caller writes settings.json on a change, so "nothing moved" has to be
    // distinguishable from "moved to the same place".
    expect(
      promoteHostUrl({ hostUrl: tunnel, knownHostUrls: [lan] }, `${tunnel}/`),
    ).toBeUndefined();
  });
});

describe("endpointsBehindLocalForward", () => {
  const forwarded = "http://127.0.0.1:8790";

  it("keeps the public address when a tunnel forward takes over as primary", () => {
    // The failure this prevents: the node reaches the Host only through a
    // private tunnel's loopback port, the tunnel client dies, and every dial is
    // refused by a port on its own machine while the Host is still answering at
    // the address it used to know — which the forward had overwritten.
    expect(
      endpointsBehindLocalForward({ hostUrl: tunnel, knownHostUrls: [] }, forwarded),
    ).toEqual({ hostUrl: forwarded, knownHostUrls: [tunnel] });
  });

  it("keeps the other settings on the object it was handed", () => {
    const settings = { hostUrl: tunnel, knownHostUrls: [], maxSessions: 8 };
    expect(endpointsBehindLocalForward(settings, forwarded)).toEqual({
      hostUrl: forwarded,
      knownHostUrls: [tunnel],
      maxSessions: 8,
    });
  });

  it("does not stack a fallback per restart when the port is unchanged", () => {
    const once = endpointsBehindLocalForward(
      { hostUrl: tunnel, knownHostUrls: [] },
      forwarded,
    );
    expect(endpointsBehindLocalForward(once, forwarded)).toEqual(once);
  });

  it("moves the dead port to the fallbacks when the tunnel lands elsewhere", () => {
    const first = endpointsBehindLocalForward(
      { hostUrl: tunnel, knownHostUrls: [] },
      forwarded,
    );
    expect(endpointsBehindLocalForward(first, "http://127.0.0.1:9001")).toEqual({
      hostUrl: "http://127.0.0.1:9001",
      knownHostUrls: [forwarded, tunnel],
    });
  });

  it("changes nothing when the tunnel has not reported a port", () => {
    const endpoints: HostEndpoints = { hostUrl: tunnel, knownHostUrls: [lan] };
    expect(endpointsBehindLocalForward(endpoints, "")).toBe(endpoints);
  });
});

describe("endpointsAfterOperatorEdit", () => {
  const previous: HostEndpoints = { hostUrl: tunnel, knownHostUrls: [lan] };

  it("drops the old Host's fallbacks when an operator names a new Host", () => {
    // Otherwise a typo, or a new Host that is not serving yet, would fail and
    // send this node straight back to the Host it was just moved away from —
    // which is the one thing a deliberate retarget must never do.
    const edited = { ...previous, hostUrl: "https://elsewhere.example.com" };
    expect(endpointsAfterOperatorEdit(previous, edited)).toEqual({
      hostUrl: "https://elsewhere.example.com",
      knownHostUrls: [],
    });
  });

  it("keeps the fallbacks when the edit was about something else", () => {
    const edited = { ...previous, maxSessions: 8 };
    expect(endpointsAfterOperatorEdit(previous, edited)).toEqual(edited);
    expect(
      endpointsAfterOperatorEdit(previous, { ...previous, hostUrl: `${tunnel}/` })
        .knownHostUrls,
    ).toEqual([lan]);
  });
});
