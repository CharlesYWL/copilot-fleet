import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envFilePath, packageRoot, packageVersion, repoRoot } from "./runtime.js";

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
    expect(envFilePath(join(checkout, "apps", "host", "dist", "server"))).toBe(expected);
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

  it("reads a version from the package a module belongs to", () => {
    const host = join(checkout, "apps", "host");
    writeFileSync(
      join(host, "package.json"),
      JSON.stringify({ name: "@fleet/host", version: "1.2.3" }),
    );
    // Sources and build output sit at different depths and must still agree,
    // which is the whole reason this walks up rather than counting `../`.
    expect(packageVersion(join(host, "src"))).toBe("1.2.3");
    expect(packageVersion(join(host, "dist", "server"))).toBe("1.2.3");
  });

  it("answers with the workspace version, not a parent project's", () => {
    // The checkout manifest has no version; climbing past the package would
    // report whatever project the checkout happens to sit inside.
    expect(packageVersion(join(checkout, "apps", "host", "src"))).toBe("0.0.0");
  });

  it("still starts when the manifest cannot be read", () => {
    // An unknown version is a packaging problem, not a reason to refuse to run.
    expect(packageVersion(join(checkout, "nowhere"), "unknown")).toBe("unknown");
  });
});

describe("declared versions", () => {
  it("reports the version its own package.json declares", async () => {
    /*
     * The Host and the Node each used to carry `const VERSION = "0.1.0"`, so a
     * release meant editing five files and the two constants were the ones
     * nobody looked at. They then disagree in silence — `/api/health` says one
     * number, `package.json` says another, and nothing fails.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const declared: { version?: string } = JSON.parse(
      readFileSync(join(packageRoot(here), "package.json"), "utf8"),
    );
    expect(packageVersion(here)).toBe(declared.version);
  });
});
