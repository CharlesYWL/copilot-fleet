import { describe, expect, it } from "vitest";
import { resolveNodeName } from "./index.js";

describe("resolveNodeName", () => {
  it("does nothing when both ends agree", () => {
    expect(
      resolveNodeName({
        stored: "weili-pc",
        reported: "weili-pc",
        knownName: "weili-pc",
      }),
    ).toEqual({ name: "weili-pc", renameStored: false, tellNode: false });
  });

  it("adopts a rename made on the node", () => {
    // The node last synced "weili-pc" and the Host still has it, so the change
    // can only have come from the operator editing it locally.
    expect(
      resolveNodeName({
        stored: "weili-pc",
        reported: "build-01",
        knownName: "weili-pc",
      }),
    ).toEqual({ name: "build-01", renameStored: true, tellNode: true });
  });

  it("keeps the Host's rename when the node was offline for it", () => {
    // The Host no longer holds what the node last synced, so the node is not
    // proposing anything — it is behind, and gets told.
    expect(
      resolveNodeName({
        stored: "build-01",
        reported: "weili-pc",
        knownName: "weili-pc",
      }),
    ).toEqual({ name: "build-01", renameStored: false, tellNode: true });
  });

  it("lets the Host win when both ends were renamed", () => {
    // Only one name can be right and the Host is the end that enforces
    // uniqueness across the fleet.
    expect(
      resolveNodeName({ stored: "build-01", reported: "laptop", knownName: "weili-pc" }),
    ).toEqual({ name: "build-01", renameStored: false, tellNode: true });
  });

  it("does not let a node that never synced a name overrule the Host", () => {
    expect(
      resolveNodeName({ stored: "build-01", reported: "laptop", knownName: "" }),
    ).toEqual({ name: "build-01", renameStored: false, tellNode: true });
  });

  it("leaves a node too old to report a name alone", () => {
    // It would hang up on a `node_name` frame its message union does not have.
    expect(resolveNodeName({ stored: "build-01" })).toEqual({
      name: "build-01",
      renameStored: false,
      tellNode: false,
    });
  });

  it("tells a node whose record of the Host's name went stale", () => {
    // Its own name is right but `knownName` is not, which is what the next
    // reconnect uses to tell a local rename from a stale copy.
    expect(
      resolveNodeName({
        stored: "build-01",
        reported: "build-01",
        knownName: "weili-pc",
      }),
    ).toEqual({ name: "build-01", renameStored: false, tellNode: true });
  });

  it("ignores surrounding whitespace rather than renaming over it", () => {
    expect(
      resolveNodeName({
        stored: "build-01",
        reported: "  build-01  ",
        knownName: "  build-01  ",
      }),
    ).toEqual({ name: "build-01", renameStored: false, tellNode: false });
  });
});
