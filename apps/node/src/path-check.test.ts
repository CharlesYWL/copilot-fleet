import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPath } from "./path-check.js";

describe("inspectPath", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleet-path-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("accepts a directory that exists", () => {
    expect(inspectPath(directory)).toEqual({ ok: true, kind: "directory" });
  });

  it("reports a path that is not there rather than failing at session start", () => {
    // Catching the typo here is the whole point: the same mistake surfaces much
    // later, and far less legibly, as an agent that cannot open the workspace.
    const missing = join(directory, "no-such-folder");
    expect(inspectPath(missing)).toEqual({
      ok: false,
      reason: "That path does not exist on this machine",
    });
  });

  it("rejects a file, since a workspace has to be a directory", () => {
    const file = join(directory, "a-file.txt");
    writeFileSync(file, "x");
    expect(inspectPath(file)).toEqual({
      ok: false,
      reason: "That path is a file, not a folder",
    });
  });

  it("rejects a relative path", () => {
    // The Host stores these verbatim and the agent resolves them against an
    // unrelated working directory, so a relative path is never what was meant.
    expect(inspectPath("./project")).toEqual({
      ok: false,
      reason: "Enter an absolute path",
    });
  });

  it("rejects an empty path without touching the filesystem", () => {
    expect(inspectPath("   ")).toEqual({
      ok: false,
      reason: "Enter an absolute path",
    });
  });
});
