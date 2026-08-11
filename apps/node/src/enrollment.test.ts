import { describe, expect, it } from "vitest";
import { planCredentials } from "./enrollment.js";

describe("planCredentials", () => {
  const settings = { hostUrl: "http://127.0.0.1:8787", nodeName: "WEILI-PC" };
  const stored = {
    hostUrl: settings.hostUrl,
    nodeId: "node-1",
    secret: "s3cret",
    name: settings.nodeName,
  };

  it("registers when nothing is stored", () => {
    expect(planCredentials(undefined, settings).action).toBe("register");
  });

  it("keeps the node id through a rename, so placements and sessions survive", () => {
    // The name is a label the `hello` frame proposes, not the identity:
    // re-registering here used to abandon this machine's history on a node row
    // that would never come back online.
    const plan = planCredentials({ ...stored, name: "old-name" }, settings);
    expect(plan).toEqual({
      action: "reuse",
      credentials: { ...stored, name: "old-name" },
    });
  });

  it("keeps the node id when only the host url rotated", () => {
    const plan = planCredentials({ ...stored, hostUrl: "https://old.example" }, settings);
    expect(plan).toEqual({
      action: "move",
      credentials: { ...stored, hostUrl: settings.hostUrl },
    });
  });

  it("reuses an unchanged identity", () => {
    expect(planCredentials(stored, settings)).toEqual({
      action: "reuse",
      credentials: stored,
    });
  });
});
