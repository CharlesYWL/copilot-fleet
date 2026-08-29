import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  BOOTSTRAP_GRANT_TTL_MS,
  CLAIM_CODE_TTL_MS,
  ClaimCodeService,
  MAX_CLAIM_ATTEMPTS_PER_BINDING,
  CLAIM_ATTEMPT_WINDOW_MS,
} from "./claim.js";

/**
 * The claim code is the only proof a network attacker cannot obtain: it is
 * printed on the Host console and nowhere else. Everything here exists so that
 * possession of the URL, of a forged header, or of a lucky guess is not enough.
 */
function setup(start = 1_000_000) {
  let now = start;
  const announced: string[] = [];
  const service = new ClaimCodeService({
    now: () => now,
    announce: (code) => announced.push(code),
  });
  return {
    service,
    announced,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

describe("ClaimCodeService", () => {
  it("prints a code with at least 128 bits of entropy, and keeps only its hash", () => {
    const { service, announced } = setup();
    service.issue();
    expect(announced).toHaveLength(1);
    const code = announced[0] ?? "";
    // base64url of 16 bytes is 22 characters; anything shorter is not 128 bits.
    expect(code.length).toBeGreaterThanOrEqual(22);
    expect(service.codeFingerprint()).toBe(
      createHash("sha256").update(code).digest("hex"),
    );
    // Nothing on the service hands the plaintext back out.
    expect(JSON.stringify(service.status())).not.toContain(code);
  });

  it("issues a different code every time it is regenerated", () => {
    const { service, announced } = setup();
    service.issue();
    service.regenerate();
    expect(announced).toHaveLength(2);
    expect(announced[0]).not.toBe(announced[1]);
    // The old one stops working the moment a new one is printed.
    expect(service.redeem(announced[0] ?? "", "binding-a").ok).toBe(false);
    expect(service.redeem(announced[1] ?? "", "binding-a").ok).toBe(true);
  });

  it("exchanges the printed code for a bootstrap grant", () => {
    const { service, announced } = setup();
    service.issue();
    const outcome = service.redeem(announced[0] ?? "", "binding-a");
    if (!outcome.ok) throw new Error("expected the printed code to be accepted");
    expect(outcome.token.length).toBeGreaterThanOrEqual(32);
    expect(service.verifyBootstrap(outcome.token)).toMatchObject({
      binding: "binding-a",
    });
  });

  it("will not let another browser use a grant it did not earn", () => {
    const { service, announced } = setup();
    service.issue();
    const outcome = service.redeem(announced[0] ?? "", "binding-a");
    if (!outcome.ok) throw new Error("expected a grant");
    expect(service.verifyBootstrap(outcome.token, "binding-b")).toBeUndefined();
    expect(service.verifyBootstrap(outcome.token, "binding-a")).toBeDefined();
  });

  it("expires the claim code, and says nothing about why", () => {
    const { service, announced, advance } = setup();
    service.issue();
    advance(CLAIM_CODE_TTL_MS + 1);
    const outcome = service.redeem(announced[0] ?? "", "binding-a");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.status).toBe(401);
    // A distinct "expired" answer tells a guesser the code they tried was real.
    expect(outcome.error).toBe("Invalid claim code");
  });

  it("expires a bootstrap grant", () => {
    const { service, announced, advance } = setup();
    service.issue();
    const outcome = service.redeem(announced[0] ?? "", "binding-a");
    if (!outcome.ok) throw new Error("expected a grant");
    advance(BOOTSTRAP_GRANT_TTL_MS + 1);
    expect(service.verifyBootstrap(outcome.token)).toBeUndefined();
  });

  it("keeps one live grant per binding, so a flood cannot accumulate them", () => {
    const { service, announced } = setup();
    service.issue();
    const first = service.redeem(announced[0] ?? "", "binding-a");
    const second = service.redeem(announced[0] ?? "", "binding-a");
    if (!first.ok || !second.ok) throw new Error("expected both to be accepted");
    expect(service.verifyBootstrap(first.token)).toBeUndefined();
    expect(service.verifyBootstrap(second.token)).toBeDefined();
  });

  it("stops answering guesses from one binding, without burning the code", () => {
    const { service, announced, advance } = setup();
    service.issue();
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS_PER_BINDING; attempt += 1) {
      expect(service.redeem("wrong", "guesser")).toMatchObject({
        ok: false,
        status: 401,
      });
    }
    expect(service.redeem("wrong", "guesser")).toMatchObject({ ok: false, status: 429 });
    // Locked out means locked out; the right code does not reopen the window,
    // or a guesser could use it to learn they had found it.
    expect(service.redeem(announced[0] ?? "", "guesser")).toMatchObject({
      ok: false,
      status: 429,
    });
    // The real code is untouched: another browser can still claim the Host.
    expect(service.redeem(announced[0] ?? "", "operator").ok).toBe(true);

    advance(CLAIM_ATTEMPT_WINDOW_MS + 1);
    service.regenerate();
    expect(service.redeem(announced[1] ?? "", "guesser").ok).toBe(true);
  });

  it("throttles globally without ever invalidating the real code", () => {
    const { service, announced } = setup();
    service.issue();
    let throttled = false;
    for (let attempt = 0; attempt < 500 && !throttled; attempt += 1) {
      const outcome = service.redeem("wrong", `binding-${attempt}`);
      if (!outcome.ok && outcome.status === 429) throttled = true;
    }
    expect(throttled).toBe(true);
    // Still the same code, still printed on the same console.
    expect(service.codeFingerprint()).toBe(
      createHash("sha256")
        .update(announced[0] ?? "")
        .digest("hex"),
    );
  });

  it("consumes a grant exactly once, which is what makes the claim atomic", () => {
    const { service, announced } = setup();
    service.issue();
    const outcome = service.redeem(announced[0] ?? "", "binding-a");
    if (!outcome.ok) throw new Error("expected a grant");
    expect(service.consumeBootstrap(outcome.token)).toBe(true);
    expect(service.consumeBootstrap(outcome.token)).toBe(false);
    expect(service.verifyBootstrap(outcome.token)).toBeUndefined();
  });

  it("goes quiet once the Host is claimed", () => {
    const { service, announced } = setup();
    service.issue();
    const code = announced[0] ?? "";
    service.clear();
    expect(service.status().active).toBe(false);
    expect(service.codeFingerprint()).toBeUndefined();
    expect(service.redeem(code, "binding-a").ok).toBe(false);
  });

  /**
   * The grant a caller who has already proved themselves another way is owed.
   *
   * An upgraded Host's operator proves the existing password before this is
   * reached, which is the same authority the console code stands for — so the
   * code is neither required nor revealed. What the grant keeps is every other
   * property: the same TTL, the same browser binding, the same single use.
   */
  describe("a trusted grant", () => {
    it("issues the same short browser-bound grant with no code at all", () => {
      const { service } = setup();
      const grant = service.grantTrusted("binding-a");
      expect(grant.token.length).toBeGreaterThanOrEqual(32);
      expect(service.verifyBootstrap(grant.token, "binding-a")).toMatchObject({
        binding: "binding-a",
      });
      expect(service.verifyBootstrap(grant.token, "binding-b")).toBeUndefined();
    });

    it("neither reveals nor consumes the console code", () => {
      const { service, announced } = setup();
      service.issue();
      const before = service.codeFingerprint();
      const grant = service.grantTrusted("binding-a");
      expect(JSON.stringify(grant)).not.toContain(announced[0] ?? "never");
      // The printed code is untouched: a console operator can still use it.
      expect(service.codeFingerprint()).toBe(before);
      expect(service.redeem(announced[0] ?? "", "binding-b").ok).toBe(true);
    });

    it("works when no code was ever printed, or the printed one expired", () => {
      const { service, advance } = setup();
      service.issue();
      advance(CLAIM_CODE_TTL_MS + 1);
      expect(service.status().active).toBe(false);
      const grant = service.grantTrusted("binding-a");
      expect(service.verifyBootstrap(grant.token, "binding-a")).toBeDefined();
    });

    it("expires and is spent exactly once, like any other grant", () => {
      const { service, advance } = setup();
      const grant = service.grantTrusted("binding-a");
      expect(service.consumeBootstrap(grant.token)).toBe(true);
      expect(service.consumeBootstrap(grant.token)).toBe(false);

      const second = service.grantTrusted("binding-a");
      advance(BOOTSTRAP_GRANT_TTL_MS + 1);
      expect(service.verifyBootstrap(second.token, "binding-a")).toBeUndefined();
    });

    it("keeps one live grant per binding", () => {
      const { service } = setup();
      const first = service.grantTrusted("binding-a");
      const second = service.grantTrusted("binding-a");
      expect(service.verifyBootstrap(first.token)).toBeUndefined();
      expect(service.verifyBootstrap(second.token)).toBeDefined();
    });
  });

  it("bounds the bindings it remembers, so a public URL cannot grow the map", () => {
    const { service } = setup();
    service.issue();
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      service.redeem("wrong", `binding-${attempt}`);
    }
    expect(service.bindingCount()).toBeLessThanOrEqual(1_000);
  });
});
