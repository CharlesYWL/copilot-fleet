import { createSecureContext } from "node:tls";
import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueCorpDirectCertificates } from "./corp-direct-certificates.js";

describe.skipIf(process.platform !== "win32")(
  "native Corp direct certificate lifecycle",
  () => {
    it("creates a private CA and renews server certificates without changing public trust", async () => {
      const first = await issueCorpDirectCertificates(
        "corp-direct-native-test",
        "10.0.5.136",
      );
      const root = new X509Certificate(first.caCertificate);
      expect(root.ca).toBe(true);
      expect(root.verify(root.publicKey)).toBe(true);
      expect(() =>
        createSecureContext({
          pfx: Buffer.from(first.serverPfx, "base64"),
          passphrase: "",
        }),
      ).not.toThrow();
      const renewed = await issueCorpDirectCertificates(
        "corp-direct-native-test",
        "10.0.18.236",
        first,
      );
      expect(new X509Certificate(renewed.caCertificate).fingerprint256).toBe(
        root.fingerprint256,
      );
      expect(renewed.hostIp).toBe("10.0.18.236");
      expect(renewed.serverPfx).not.toBe(first.serverPfx);
      await expect(
        issueCorpDirectCertificates("other-host", "10.0.5.136", first),
      ).rejects.toThrow(/different Host/);
    }, 120000);
  },
);
