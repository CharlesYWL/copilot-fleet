import { describe, expect, it } from "vitest";
import { extractTunnelUrl } from "./tunnel.js";

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
});
