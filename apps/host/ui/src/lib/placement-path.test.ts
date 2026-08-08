import { describe, expect, it } from "vitest";
import { nextPlacementPath } from "./placement-path.js";

describe("nextPlacementPath", () => {
  it("seeds the path from the newly selected node", () => {
    expect(nextPlacementPath("", undefined, "/Users/me")).toBe("/Users/me");
  });

  it("retargets a path left over from the previously selected node", () => {
    // The reported bug: picking a Windows node then a macOS one kept showing
    // C:\Users\..., which is not a path the new machine could ever open.
    expect(nextPlacementPath("C:\\Users\\me", "C:\\Users\\me", "/Users/me")).toBe(
      "/Users/me",
    );
  });

  it("keeps a path the operator typed themselves", () => {
    // Only a value we know we wrote is ours to replace; anything else is the
    // operator's intent, and silently discarding it loses their work.
    expect(nextPlacementPath("/srv/project", "C:\\Users\\me", "/Users/me")).toBe(
      "/srv/project",
    );
  });

  it("leaves an operator's path alone even when no node was selected before", () => {
    expect(nextPlacementPath("/srv/project", undefined, "/Users/me")).toBe(
      "/srv/project",
    );
  });

  it("clears a stale prefill when the new node reports no home directory", () => {
    // Keeping the old node's home would be worse than an empty required field:
    // it looks valid and points somewhere that does not exist on this machine.
    expect(nextPlacementPath("C:\\Users\\me", "C:\\Users\\me", "")).toBe("");
  });

  it("does not blank a typed path when the new node reports no home directory", () => {
    expect(nextPlacementPath("/srv/project", "C:\\Users\\me", "")).toBe("/srv/project");
  });
});
