import { describe, expect, it } from "vitest";
import { LEAD_TOKEN_KEY_SETTING, LeadTokens } from "./lead-tokens.js";

function settingsStore(): {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
} {
  const values = new Map<string, string>();
  return {
    getSetting: (key) => values.get(key),
    setSetting: (key, value) => void values.set(key, value),
  };
}

describe("LeadTokens", () => {
  it("resolves a token back to the session that was given it", () => {
    const tokens = new LeadTokens(settingsStore());
    expect(tokens.resolve(tokens.mint("sess-1"))).toBe("sess-1");
  });

  it("still recognises a token after the Host restarts", () => {
    // The bug this replaced: an orchestrator kept alive by its Node never
    // settles, so nothing resumes it and nothing mints it a new token. It
    // carried on with one the restarted Host had forgotten, and every tool
    // call came back 401 — on every file save, under `tsx watch`.
    const store = settingsStore();
    const token = new LeadTokens(store).mint("sess-1");

    const afterRestart = new LeadTokens(store);

    expect(afterRestart.resolve(token)).toBe("sess-1");
  });

  it("gives the same session the same token twice", () => {
    // So a resume cannot leave the running agent holding a superseded token.
    const tokens = new LeadTokens(settingsStore());
    expect(tokens.mint("sess-1")).toBe(tokens.mint("sess-1"));
  });

  it("keeps one Host's tokens from opening another's", () => {
    const token = new LeadTokens(settingsStore()).mint("sess-1");
    expect(new LeadTokens(settingsStore()).resolve(token)).toBeUndefined();
  });

  it("refuses a token whose session was swapped for another", () => {
    const tokens = new LeadTokens(settingsStore());
    const [, signature] = tokens.mint("sess-1").slice(4).split(".");
    const forged = `flt_${Buffer.from("sess-2").toString("base64url")}.${signature}`;
    expect(tokens.resolve(forged)).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["unsigned", "flt_c2Vzcy0x"],
    ["not ours", "Bearer abc"],
    ["signature only", "flt_.abc"],
  ])("refuses a %s token", (_label, token) => {
    expect(new LeadTokens(settingsStore()).resolve(token)).toBeUndefined();
  });

  it("persists its key so it is generated once", () => {
    const store = settingsStore();
    new LeadTokens(store);
    const key = store.getSetting(LEAD_TOKEN_KEY_SETTING);

    new LeadTokens(store);

    expect(store.getSetting(LEAD_TOKEN_KEY_SETTING)).toBe(key);
    expect(key).toBeTruthy();
  });
});
