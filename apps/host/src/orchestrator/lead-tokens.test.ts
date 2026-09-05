import { createHmac } from "node:crypto";
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

/**
 * A token this Host really did sign, carrying claims it would never mint.
 *
 * The signature is the cheap half of the check; these exist to prove the
 * claims themselves are still read strictly once the signature passes.
 */
function signed(
  store: { getSetting(key: string): string | undefined },
  claims: Record<string, unknown>,
): string {
  const key = Buffer.from(store.getSetting(LEAD_TOKEN_KEY_SETTING) ?? "", "base64");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `flt_${payload}.${signature}`;
}

/** What a lead is, as far as a token is concerned. */
const lead = { sessionId: "sess-1", runId: "run-1", nodeId: "node-1" };

describe("LeadTokens", () => {
  it("resolves a token back to the claims it was minted for", () => {
    const tokens = new LeadTokens(settingsStore());

    const claims = tokens.resolve(tokens.mint(lead));

    expect(claims).toMatchObject({ version: 1, ...lead });
    expect(Date.parse(claims?.issuedAt ?? "")).toBeGreaterThan(0);
  });

  it("still recognises a token after the Host restarts", () => {
    // The bug this replaced: an orchestrator kept alive by its Node never
    // settles, so nothing resumes it and nothing mints it a new token. It
    // carried on with one the restarted Host had forgotten, and every tool
    // call came back 401 — on every file save, under `tsx watch`.
    const store = settingsStore();
    const token = new LeadTokens(store).mint(lead);

    const afterRestart = new LeadTokens(store);

    expect(afterRestart.resolve(token)).toMatchObject(lead);
  });

  it("leaves the token a running lead holds working after a re-mint", () => {
    // A resume mints again. The older token is signed by the same key and
    // names the same claims, so minting a replacement supersedes nothing the
    // agent is already carrying.
    const tokens = new LeadTokens(settingsStore());
    const first = tokens.mint(lead);

    tokens.mint(lead);

    expect(tokens.resolve(first)).toMatchObject(lead);
  });

  it("keeps one Host's tokens from opening another's", () => {
    const token = new LeadTokens(settingsStore()).mint(lead);
    expect(new LeadTokens(settingsStore()).resolve(token)).toBeUndefined();
  });

  it("refuses claims edited under a signature made for other claims", () => {
    const tokens = new LeadTokens(settingsStore());
    const [, signature] = tokens.mint(lead).slice(4).split(".");
    const swapped = Buffer.from(
      JSON.stringify({ ...lead, version: 1, sessionId: "sess-2", issuedAt: "" }),
      "utf8",
    ).toString("base64url");

    expect(tokens.resolve(`flt_${swapped}.${signature ?? ""}`)).toBeUndefined();
  });

  it("refuses claims this Host signed that are not a lead token's claims", () => {
    // Signed here, and still not something to authorise anything on: a payload
    // with no run and no node cannot be re-checked once the run has moved on.
    const store = settingsStore();
    const tokens = new LeadTokens(store);

    expect(
      tokens.resolve(signed(store, { version: 1, sessionId: "sess-1" })),
    ).toBeUndefined();
  });

  it("refuses claims in a format this Host does not issue", () => {
    const store = settingsStore();
    const tokens = new LeadTokens(store);

    expect(
      tokens.resolve(
        signed(store, { ...lead, version: 2, issuedAt: new Date().toISOString() }),
      ),
    ).toBeUndefined();
  });

  it("refuses a token far longer than the claims it signs", () => {
    // A bound rather than a parse: an unbounded bearer is an unbounded HMAC
    // and an unbounded JSON parse on a path nobody has authenticated yet.
    const tokens = new LeadTokens(settingsStore());
    expect(tokens.resolve(`flt_${"a".repeat(9_000)}.signature`)).toBeUndefined();
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

  it("adopts a restored Host key without waiting for a process restart", () => {
    const originalStore = settingsStore();
    const restoredStore = settingsStore();
    const restored = new LeadTokens(restoredStore);
    const restoredToken = restored.mint(lead);
    const live = new LeadTokens(originalStore);

    expect(live.resolve(restoredToken)).toBeUndefined();
    live.adoptKey(restoredStore.getSetting(LEAD_TOKEN_KEY_SETTING)!);

    expect(live.resolve(restoredToken)).toMatchObject(lead);
  });
});
