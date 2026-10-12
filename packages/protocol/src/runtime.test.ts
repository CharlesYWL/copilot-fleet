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
      JSON.stringify({
        name: "copilot-fleet",
        version: "1.2.3",
        workspaces: ["apps/*", "packages/*"],
      }),
    );
    mkdirSync(join(checkout, "apps", "host", "src"), { recursive: true });
    mkdirSync(join(checkout, "apps", "host", "dist", "server"), { recursive: true });
    writeFileSync(
      join(checkout, "apps", "host", "package.json"),
      JSON.stringify({ name: "@fleet/host" }),
    );
    for (const [folder, name] of [
      [join("apps", "node"), "@fleet/node"],
      [join("packages", "protocol"), "@fleet/protocol"],
    ] as const) {
      mkdirSync(join(checkout, folder, "src"), { recursive: true });
      mkdirSync(join(checkout, folder, "dist"), { recursive: true });
      writeFileSync(join(checkout, folder, "package.json"), JSON.stringify({ name }));
    }
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
      writeFileSync(
        join(outer, "package.json"),
        JSON.stringify({ name: "unrelated", version: "9.9.9" }),
      );
      const nested = join(outer, "copilot-fleet");
      mkdirSync(join(nested, "apps", "host", "src"), { recursive: true });
      writeFileSync(
        join(nested, "package.json"),
        JSON.stringify({
          name: "copilot-fleet",
          version: "4.5.6",
          workspaces: ["apps/*"],
        }),
      );
      writeFileSync(
        join(nested, "apps", "host", "package.json"),
        JSON.stringify({ name: "@fleet/host" }),
      );
      expect(repoRoot(join(nested, "apps", "host", "src"))).toBe(nested);
      expect(packageVersion(join(nested, "apps", "host", "src"))).toBe("4.5.6");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("reads the root version even if a workspace still declares an old version", () => {
    const host = join(checkout, "apps", "host");
    writeFileSync(
      join(host, "package.json"),
      JSON.stringify({ name: "@fleet/host", version: "0.8.1" }),
    );
    // Sources and build output sit at different depths and must still agree,
    // which is the whole reason this walks up rather than counting `../`.
    expect(packageVersion(join(host, "src"))).toBe("1.2.3");
    expect(packageVersion(join(host, "dist", "server"))).toBe("1.2.3");
  });

  it.each([
    join("apps", "host", "src"),
    join("apps", "host", "dist", "server"),
    join("apps", "node", "src"),
    join("apps", "node", "dist"),
    join("packages", "protocol", "src"),
    join("packages", "protocol", "dist"),
  ])("reports the same root version from %s", (folder) => {
    expect(packageVersion(join(checkout, folder))).toBe("1.2.3");
  });

  it.each([undefined, "", 123])(
    "returns unknown when the root version is %s",
    (version) => {
      writeFileSync(
        join(checkout, "package.json"),
        JSON.stringify({ name: "copilot-fleet", version, workspaces: ["apps/*"] }),
      );
      expect(packageVersion(join(checkout, "apps", "host", "src"), "unknown")).toBe(
        "unknown",
      );
    },
  );

  it("still starts when the manifest cannot be read", () => {
    // An unknown version is a packaging problem, not a reason to refuse to run.
    writeFileSync(join(checkout, "package.json"), "{");
    expect(packageVersion(join(checkout, "nowhere"), "unknown")).toBe("unknown");
  });
});

describe("declared versions", () => {
  it("declares the release version only at the root and reports it in every workspace", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = repoRoot(here);
    const declared: { version?: string } = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    expect(declared.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageVersion(here)).toBe(declared.version);
    for (const folder of [
      join("apps", "host"),
      join("apps", "node"),
      join("packages", "protocol"),
    ]) {
      const workspace: {
        version?: string;
        private?: boolean;
        dependencies?: Record<string, string>;
      } = JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8"));
      expect(workspace.version).toBeUndefined();
      expect(workspace.private).toBe(true);
      expect(packageVersion(join(root, folder, "src"))).toBe(declared.version);
      if (folder !== join("packages", "protocol")) {
        expect(workspace.dependencies?.["@fleet/protocol"]).toBe("*");
      }
    }
  });
});
