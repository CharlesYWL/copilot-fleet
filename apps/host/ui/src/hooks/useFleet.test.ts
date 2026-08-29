import { describe, expect, it } from "vitest";
import { sessionFailureMessage } from "./useFleet";

describe("sessionFailureMessage", () => {
  it("identifies the node that reported the failure", () => {
    expect(
      sessionFailureMessage({
        nodeName: "BUILD-PC",
        currentActivity:
          "Copilot ACP did not become ready within 60s. Run `copilot update` and `copilot login` on this node, then retry.",
      }),
    ).toBe(
      "BUILD-PC: Copilot ACP did not become ready within 60s. Run `copilot update` and `copilot login` on this node, then retry.",
    );
  });

  it("keeps the fallback useful when node metadata is unavailable", () => {
    expect(sessionFailureMessage({ nodeName: "", currentActivity: "" })).toBe(
      "Session failed",
    );
  });
});
