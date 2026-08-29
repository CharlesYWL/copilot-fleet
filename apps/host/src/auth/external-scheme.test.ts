import { describe, expect, it } from "vitest";
import {
  classifyRequestHost,
  cookieSecure,
  externalSchemeMap,
  sessionIssuanceAllowed,
} from "./external-scheme.js";

/**
 * Every tunnel provider relays into `http://127.0.0.1:<port>`, so the socket and
 * the forwarded headers say nothing true about what the browser saw. The only
 * witness the Host owns is the map it built itself from its own configuration,
 * which is what these assert.
 */
describe("externalSchemeMap", () => {
  it("records the scheme the Host itself published for each name", () => {
    const map = externalSchemeMap({
      publicUrl: () => "https://fleet.example.com:8443",
      tunnels: () => [
        { provider: "devtunnel", url: "https://abc-8787.usw2.devtunnels.ms" },
        { provider: "bore", url: "http://bore.pub:45871" },
      ],
    });
    expect(map.get("fleet.example.com")).toMatchObject({
      scheme: "https",
      provider: "public-url",
    });
    expect(map.get("abc-8787.usw2.devtunnels.ms")).toMatchObject({
      scheme: "https",
      provider: "devtunnel",
    });
    expect(map.get("bore.pub")).toMatchObject({ scheme: "http", provider: "bore" });
  });

  it("ignores a provider that has not published a URL yet", () => {
    const map = externalSchemeMap({
      publicUrl: () => undefined,
      tunnels: () => [{ provider: "ngrok", url: undefined }],
    });
    expect(map.size).toBe(0);
  });

  it("never maps a loopback name, which is decided by name and not by config", () => {
    const map = externalSchemeMap({
      publicUrl: () => "http://127.0.0.1:8787",
      tunnels: () => [],
    });
    expect(map.size).toBe(0);
  });
});

describe("classifyRequestHost", () => {
  const map = externalSchemeMap({
    publicUrl: () => "https://fleet.example.com",
    tunnels: () => [{ provider: "bore", url: "http://bore.pub:45871" }],
  });

  it("calls the loopback names loopback, whatever port they carry", () => {
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787", "127.9.9.9"]) {
      expect(classifyRequestHost(host, map), host).toMatchObject({ kind: "loopback" });
    }
  });

  it("calls a configured HTTPS name external and secure", () => {
    expect(classifyRequestHost("fleet.example.com", map)).toMatchObject({
      kind: "external-https",
      provider: "public-url",
    });
  });

  it("calls a plain HTTP relay external and insecure", () => {
    expect(classifyRequestHost("bore.pub:45871", map)).toMatchObject({
      kind: "external-http",
      provider: "bore",
    });
  });

  it("refuses to guess about a name it never published", () => {
    expect(classifyRequestHost("unknown.example.com", map)).toMatchObject({
      kind: "unknown",
    });
    expect(classifyRequestHost(undefined, map)).toMatchObject({ kind: "unknown" });
  });
});

describe("session issuance policy", () => {
  const map = externalSchemeMap({
    publicUrl: () => "https://fleet.example.com",
    tunnels: () => [{ provider: "bore", url: "http://bore.pub:45871" }],
  });

  it("issues on loopback HTTP and on a configured HTTPS endpoint", () => {
    expect(sessionIssuanceAllowed(classifyRequestHost("localhost:8787", map))).toBe(true);
    expect(sessionIssuanceAllowed(classifyRequestHost("fleet.example.com", map))).toBe(
      true,
    );
  });

  it("refuses to issue anything on a known plain-HTTP external endpoint", () => {
    expect(sessionIssuanceAllowed(classifyRequestHost("bore.pub:45871", map))).toBe(
      false,
    );
  });

  it("refuses a name the Host never published, rather than assuming HTTPS", () => {
    expect(sessionIssuanceAllowed(classifyRequestHost("who.example.com", map))).toBe(
      false,
    );
  });

  it("marks the cookie Secure only where the Host published HTTPS", () => {
    expect(cookieSecure(classifyRequestHost("fleet.example.com", map))).toBe(true);
    // Marking it Secure over loopback HTTP makes it undeliverable, which locks
    // the operator out of the only URL that always works.
    expect(cookieSecure(classifyRequestHost("localhost:8787", map))).toBe(false);
    expect(cookieSecure(classifyRequestHost("bore.pub:45871", map))).toBe(false);
  });
});
