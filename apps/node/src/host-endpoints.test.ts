import { describe, expect, it } from "vitest";
import {
  adoptHostUrl,
  endpointsAfterOperatorEdit,
  hostUrlCandidates,
  nextHostUrl,
  promoteHostUrl,
  type HostEndpoints,
} from "./host-endpoints.js";

const lan = "http://192.168.1.20:8787";
const tunnel = "https://one.trycloudflare.com";
const rotated = "https://two.trycloudflare.com";

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
