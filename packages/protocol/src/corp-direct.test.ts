import { describe, expect, it } from "vitest";
import {
  CorpDirectConfigSchema,
  CorpDirectConnectionSchema,
  isPrivateIpv4,
  isPrivateSource,
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

  it("requires each allowed source range to remain entirely private", () => {
    for (const source of [
      "10.0.18.236",
      "10.0.0.0/17",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "10.0.5.136/32",
    ])
      expect(isPrivateSource(source)).toBe(true);
    for (const source of [
      "Any",
      "LocalSubnet",
      "0.0.0.0/0",
      "10.0.0.0/7",
      "172.16.0.0/11",
      "192.168.0.0/15",
      "10.0.0.0/33",
      "10.0.0.0/01",
      "10.0.0.0/",
    ])
      expect(isPrivateSource(source)).toBe(false);
  });

  it("defaults to port 8787 and requires an explicit nonempty source scope", () => {
    expect(
      CorpDirectConfigSchema.parse({
        hostIp: "10.0.5.136",
        allowedSources: ["10.0.18.236"],
      }).port,
    ).toBe(8787);
    expect(
      CorpDirectConfigSchema.safeParse({
        hostIp: "8.8.8.8",
        allowedSources: ["10.0.18.236"],
      }).success,
    ).toBe(false);
    expect(
      CorpDirectConfigSchema.safeParse({ hostIp: "10.0.5.136", allowedSources: [] })
        .success,
    ).toBe(false);
    expect(
      CorpDirectConfigSchema.safeParse({
        hostIp: "10.0.5.136",
        port: 0,
        allowedSources: ["10.0.18.236"],
      }).success,
    ).toBe(false);
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
