import { describe, expect, it, vi } from "vitest";
import { NodeAdmission } from "./node-admission.js";

describe("Node maintenance admission", () => {
  it("closes before the snapshot and refuses mutation while an asynchronous start owns a ticket", async () => {
    const gate = new NodeAdmission();
    const launch = gate.enter("session:starting");
    const updateCheckout = vi.fn(async () => {});
    await expect(gate.maintenance("update", updateCheckout)).rejects.toThrow("Active");
    expect(updateCheckout).not.toHaveBeenCalled();
    launch.release();
    await gate.maintenance("update", async () => {
      expect(() => gate.enter("racing command")).toThrow("update");
      await updateCheckout();
    });
    expect(updateCheckout).toHaveBeenCalledOnce();
    gate.enter("next").release();
  });

  it("does not reopen quarantined admission after maintenance failure", async () => {
    const gate = new NodeAdmission();
    gate.quarantine("Unknown old process ownership");
    await expect(gate.maintenance("restore", async () => {})).rejects.toThrow("Unknown");
    expect(() => gate.enter("start")).toThrow("Unknown");
  });
});
