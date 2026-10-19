import { describe, expect, it } from "vitest";
import {
  CorpDirectConfigSchema,
  CorpDirectConnectionSchema,
  isPrivateIpv4,
} from "./corp-direct.js";

describe("Corp direct private network configuration", () => {
  it("accepts only canonical RFC1918 IPv4 addresses", () => {
    for (const ip of ["10.0.5.136", "172.16.0.1", "172.31.255.254", "192.168.1.2"])
      expect(isPrivateIpv4(ip)).toBe(true);
    for (const ip of [
      "8.8.8.8",
      "127.0.0.1",
      "0.0.0.0",
      "169.254.1.1",
      "172.32.0.1",
      "10.00.0.1",
      "10.0.0.256",
      "::1",
      "10.0.0.1;whoami",
    ])
      expect(isPrivateIpv4(ip)).toBe(false);
  });

  it("defaults to port 8787 without requiring worker source addresses", () => {
    expect(CorpDirectConfigSchema.parse({ hostIp: "10.0.5.136" })).toEqual({
      hostIp: "10.0.5.136",
      port: 8787,
    });
    expect(CorpDirectConfigSchema.safeParse({ hostIp: "8.8.8.8" }).success).toBe(false);
    for (const port of [0, 65536, 1.5]) {
      expect(
        CorpDirectConfigSchema.safeParse({ hostIp: "10.0.5.136", port }).success,
      ).toBe(false);
    }
  });

  it("discards legacy source allowlists rather than retaining a hidden restriction", () => {
    for (const allowedSources of [["10.0.18.236"], [], ["0.0.0.0/0"]]) {
      expect(
        CorpDirectConfigSchema.parse({
          hostIp: "10.0.5.136",
          port: 8787,
          allowedSources,
        }),
      ).toEqual({ hostIp: "10.0.5.136", port: 8787 });
    }
  });

  it("accepts only an HTTPS private-IP origin and public certificate PEM", () => {
    const caCertificate =
      "-----BEGIN CERTIFICATE-----\nYWJjZA==\n-----END CERTIFICATE-----";
    expect(
      CorpDirectConnectionSchema.safeParse({
        hostUrl: "https://10.0.5.136:8787",
        caCertificate,
      }).success,
    ).toBe(true);
    for (const hostUrl of [
      "http://10.0.5.136:8787",
      "https://example.com",
      "https://127.0.0.1",
      "https://10.0.5.136/mcp",
      "https://user:secret@10.0.5.136",
      "https://10.0.5.136?token=x",
      "https://10.0.5.136#x",
      "https://10.0.5.136\\",
      "https://10.0.5.136\n",
      "https://010.0.5.136",
      "https://10.0.5.136:0",
    ]) {
      expect(
        CorpDirectConnectionSchema.safeParse({ hostUrl, caCertificate }).success,
      ).toBe(false);
    }
    expect(
      CorpDirectConnectionSchema.safeParse({
        hostUrl: "https://10.0.5.136",
        caCertificate: "-----BEGIN PRIVATE KEY-----\na\n-----END PRIVATE KEY-----",
      }).success,
    ).toBe(false);
  });
});
