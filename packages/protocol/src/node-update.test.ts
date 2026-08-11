import { describe, expect, it } from "vitest";
import { SELF_UPDATE_CAPABILITY, nodeUpdateState } from "./index.js";

const node = (revision: string, capabilities: string[] = [SELF_UPDATE_CAPABILITY]) => ({
  revision,
  capabilities,
});

describe("nodeUpdateState", () => {
  it("matches a node running the Host's commit", () => {
    expect(nodeUpdateState(node("abc123"), "abc123")).toBe("current");
  });

  it("flags a node running anything else", () => {
    expect(nodeUpdateState(node("abc123"), "def456")).toBe("stale");
  });

  it("refuses to guess when either side has no commit", () => {
    // A tarball deploy is still a working node; calling it stale would send an
    // operator chasing an update that cannot apply.
    expect(nodeUpdateState(node(""), "abc123")).toBe("unknown");
    expect(nodeUpdateState(node("abc123"), "")).toBe("unknown");
  });

  it("separates a node that cannot be updated remotely from one that is behind", () => {
    // Both need updating, but only one can be told to. Offering the button to
    // the other would hang up on the machine instead of updating it.
    expect(nodeUpdateState(node("abc123", ["copilot-acp"]), "def456")).toBe(
      "unsupported",
    );
  });
});
