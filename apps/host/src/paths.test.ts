import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envFilePath, packageRoot, repoRoot } from "./paths.js";

describe("filesystem anchors", () => {
  let checkout: string;

  beforeEach(() => {
    checkout = mkdtempSync(join(tmpdir(), "fleet-paths-"));
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({ name: "copilot-fleet", workspaces: ["apps/*"] }),
    );
    mkdirSync(join(checkout, "apps", "host", "src"), { recursive: true });
    mkdirSync(join(checkout, "apps", "host", "dist", "server"), { recursive: true });
    writeFileSync(
      join(checkout, "apps", "host", "package.json"),
      JSON.stringify({ name: "@fleet/host" }),
    );
  });

  afterEach(() => {
    rmSync(checkout, { recursive: true, force: true });
  });

  it("resolves the same .env from sources and from build output", () => {
    // The built Host lives one directory deeper than its sources, which is how
    // a hard-coded ../../../ pointed production at apps/.env and dropped
    // DATABASE_PATH onto an empty database.
    const expected = join(checkout, ".env");
    expect(envFilePath(join(checkout, "apps", "host", "src"))).toBe(expected);
    expect(envFilePath(join(checkout, "apps", "host", "dist", "server"))).toBe(
      expected,
    );
  });

  it("anchors package-scoped data to the package, not the checkout", () => {
    const host = join(checkout, "apps", "host");
    expect(packageRoot(join(host, "src"))).toBe(host);
    expect(packageRoot(join(host, "dist", "server"))).toBe(host);
  });

  it("stops at the workspace manifest instead of climbing into a parent project", () => {
    const outer = mkdtempSync(join(tmpdir(), "fleet-outer-"));
    try {
      writeFileSync(join(outer, "package.json"), JSON.stringify({ name: "unrelated" }));
      const nested = join(outer, "copilot-fleet");
      mkdirSync(join(nested, "apps", "host", "src"), { recursive: true });
      writeFileSync(
        join(nested, "package.json"),
        JSON.stringify({ name: "copilot-fleet", workspaces: ["apps/*"] }),
      );
      writeFileSync(
        join(nested, "apps", "host", "package.json"),
        JSON.stringify({ name: "@fleet/host" }),
      );
      expect(repoRoot(join(nested, "apps", "host", "src"))).toBe(nested);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
