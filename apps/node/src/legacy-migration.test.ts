import { describe, expect, it } from "vitest";
import {
  legacyKeyUpgradeRefusal,
  unsolicitedKeyAcknowledgement,
} from "./legacy-migration.js";

/**
 * Why this Node no longer migrates itself.
 *
 * A machine still on the shared secret has, by definition, already sent that
 * secret to whatever terminated its connection. So a Host that asks it to
 * generate a key — and proves the request with an HMAC keyed on the digest of
 * that same secret — proves only that the asker has seen the secret, which the
 * relay has. Answering would have this Node pin whichever Host key arrived,
 * permanently, on the strength of a credential it cannot keep to itself.
 *
 * There is no fix inside the exchange, so the exchange is gone. What is left is
 * an operator-visible instruction: run a fresh Connect command, which carries a
 * one-time grant and the Host's fingerprint out of band.
 */
describe("a Host that asks this Node to upgrade itself", () => {
  const request = {
    hostId: "host-1",
    hostFingerprint: "a".repeat(64),
  };

  it("is refused, and the operator is told what to do instead", () => {
    const message = legacyKeyUpgradeRefusal(request);
    expect(message).toMatch(/Connect command/i);
    // Naming the fingerprint is the point: it is what the operator compares
    // against the card, and it is the thing a relay would have substituted.
    expect(message).toContain(request.hostFingerprint.slice(0, 16));
  });

  it("never repeats a secret or a key back into the log", () => {
    expect(legacyKeyUpgradeRefusal(request)).not.toContain("secret");
  });

  it("says plainly that an acknowledgement nobody asked for changes nothing", () => {
    expect(unsolicitedKeyAcknowledgement()).toMatch(/ignored|no key|nothing/i);
  });
});
