import { describe, expect, it } from "vitest";
import type { FleetSession } from "@fleet/protocol";
import { isDerivedLabel, sessionLabel } from "./session-label";

const session = (values: Partial<FleetSession>): FleetSession => ({
  id: "s1",
  workspaceId: "w1",
  workspaceName: "repo",
  placementId: "p1",
  nodeId: "n1",
  nodeName: "node",
  state: "idle",
  name: "",
  initialPrompt: "prompt",
  currentActivity: "",
  lastText: "",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  agentSessionId: "",
  yolo: false,
  commands: [],
  configOptions: [],
  ...values,
});

describe("sessionLabel", () => {
  it("prefers the name an operator gave it", () => {
    expect(sessionLabel(session({ name: "Router cleanup" }))).toBe("Router cleanup");
  });

  it("falls back to the prompt while the session has no name", () => {
    expect(sessionLabel(session({ initialPrompt: "Fix the flaky test" }))).toBe(
      "Fix the flaky test",
    );
    // A whitespace-only name is not a name; it would render as a blank row.
    expect(sessionLabel(session({ name: "   ", initialPrompt: "Fix it" }))).toBe(
      "Fix it",
    );
  });

  it("shows only the first line of a multi-line prompt", () => {
    expect(
      sessionLabel(session({ initialPrompt: "Migrate the store\n\nDetails follow" })),
    ).toBe("Migrate the store");
  });

  it("clips a long prompt on a word boundary", () => {
    const label = sessionLabel(
      session({
        initialPrompt:
          "Refactor the session store so every write goes through one transaction helper",
      }),
    );
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(73);
    expect(label).not.toContain("  ");
    expect(label.startsWith("Refactor the session store")).toBe(true);
  });

  it("clips mid-word rather than throwing most of the label away", () => {
    // One very long token has no word boundary to cut on; returning "…" would
    // be worse than a truncated identifier.
    const label = sessionLabel(session({ initialPrompt: "x".repeat(200) }));
    expect(label).toBe(`${"x".repeat(72)}…`);
  });

  it("never renders an empty row", () => {
    expect(sessionLabel(session({ initialPrompt: "   " }))).toBe("Untitled session");
  });
});

describe("isDerivedLabel", () => {
  it("reports whether the label is standing in for a missing name", () => {
    expect(isDerivedLabel(session({}))).toBe(true);
    expect(isDerivedLabel(session({ name: "Named" }))).toBe(false);
  });
});
