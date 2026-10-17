import http from "node:http";
import { describe, expect, it } from "vitest";
import { TEST_TLS_CERTIFICATE } from "../../../packages/protocol/dist/test-tls-fixture.js";
import { corpDirectFromEnv, startCorpDirectForward } from "./corp-direct.js";

const flags = {
  FLEET_CORP_DIRECT_URL: "https://10.0.5.136:8787",
  FLEET_HOST_CA: Buffer.from(TEST_TLS_CERTIFICATE).toString("base64"),
};

describe("Corp direct Node route", () => {
  it("decodes explicit public trust and rejects incomplete, unsafe or private-key input", () => {
    expect(corpDirectFromEnv(flags)).toEqual({
      hostUrl: flags.FLEET_CORP_DIRECT_URL,
      caCertificate: TEST_TLS_CERTIFICATE,
    });
    expect(corpDirectFromEnv({})).toBeUndefined();
    for (const env of [
      { FLEET_CORP_DIRECT_URL: flags.FLEET_CORP_DIRECT_URL },
      { FLEET_HOST_CA: flags.FLEET_HOST_CA },
      { ...flags, FLEET_CORP_DIRECT_URL: "http://10.0.5.136" },
      { ...flags, FLEET_HOST_CA: "not-base64" },
      {
        ...flags,
        FLEET_HOST_CA: Buffer.from(
          "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----",
        ).toString("base64"),
      },
    ]) {
      expect(() => corpDirectFromEnv(env)).toThrow();
    }
  });

  it("binds an ephemeral loopback helper and refuses rebinding/cross-origin requests", async () => {
    const forward = await startCorpDirectForward(corpDirectFromEnv(flags)!);
    try {
      expect(new URL(forward.url).hostname).toBe("127.0.0.1");
      expect(Number(new URL(forward.url).port)).toBeGreaterThan(0);
      // Native fetch intentionally ignores Host overrides; use a raw HTTP client.
      const evilHostStatus = await new Promise<number>((resolve, reject) => {
        const request = http.get(
          forward.url,
          { headers: { Host: "attacker.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        request.on("error", reject);
      });
      expect(evilHostStatus).toBe(403);
      const evilOrigin = await fetch(forward.url, {
        headers: { Origin: "https://attacker.example" },
      });
      expect(evilOrigin.status).toBe(403);
      const nullOrigin = await fetch(forward.url, { headers: { Origin: "null" } });
      expect(nullOrigin.status).toBe(403);
    } finally {
      await forward.stop();
    }
    await expect(fetch(forward.url)).rejects.toThrow();
  });
});
