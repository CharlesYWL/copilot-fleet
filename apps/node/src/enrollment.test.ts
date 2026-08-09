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

  it("registers again after a rename, because the name is the identity", () => {
    const plan = planCredentials({ ...stored, name: "old-name" }, settings);
    expect(plan.action).toBe("register");
    // A rename strands the old node's placements and sessions, so the reason
    // has to name both sides and the way back.
    expect(plan).toMatchObject({
      reason: expect.stringContaining('"old-name" -> "WEILI-PC"') as unknown as string,
    });
    if (plan.action === "register") {
      expect(plan.reason).toContain("switch back");
    }
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
