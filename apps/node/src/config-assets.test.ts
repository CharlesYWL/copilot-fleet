import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configAsset, validateSessionConsoleAssets } from "./config-assets.js";

describe("config assets", () => {
  it("serves the page entry point and its browser modules", () => {
    // They live under public/ now, found by walking up to the package root so
    // that tsx and the built dist/ agree on where they are.
    expect(configAsset("/")?.body).toContain("<!doctype html>");
    expect(configAsset("/config.css")?.contentType).toBe("text/css; charset=utf-8");
    for (const path of [
      "/config.js",
      "/diagnostics.js",
      "/fleet-workspaces.js",
      "/node-settings.js",
      "/command-permissions.js",
      "/sessions.js",
      "/fleet-sessions.js",
      "/ui.js",
    ]) {
      const asset = configAsset(path);
      expect(asset?.contentType).toBe("text/javascript; charset=utf-8");
      expect(asset?.body.length).toBeGreaterThan(0);
    }
  });

  describe("generated session console assets", () => {
    const directories: string[] = [];
    afterEach(() => {
      directories
        .splice(0)
        .forEach((directory) => rmSync(directory, { recursive: true, force: true }));
    });
    const fixture = (file = "assets/entry.js", revision?: string) => {
      const directory = resolve(`.node-console-assets-${randomUUID()}`);
      directories.push(directory);
      mkdirSync(join(directory, ".vite"), { recursive: true });
      mkdirSync(join(directory, "assets"), { recursive: true });
      writeFileSync(
        join(directory, "index.html"),
        '<!doctype html><script type="module" src="/session-console/assets/entry.js"></script>',
      );
      writeFileSync(join(directory, "assets", "entry.js"), "console.log('entry')");
      writeFileSync(join(directory, "assets", "not-in-manifest.js"), "private");
      writeFileSync(
        join(directory, ".vite", "manifest.json"),
        JSON.stringify({
          "index.html": {
            file,
            isEntry: true,
            css: ["assets/entry.css"],
            ...(revision === undefined ? {} : { revision }),
          },
        }),
      );
      writeFileSync(join(directory, "assets", "entry.css"), "body{}");
      return directory;
    };

    it("serves only exact manifest-bound URLs and validates a complete build", () => {
      const directory = fixture();
      expect(validateSessionConsoleAssets(directory)).toEqual({ ok: true });
      expect(
        configAsset("/session-console/index.html", directory)?.contentType,
      ).toContain("text/html");
      expect(configAsset("/session-console/assets/entry.js", directory)?.body).toContain(
        "entry",
      );
      expect(
        configAsset("/session-console/assets/entry.css", directory)?.contentType,
      ).toContain("text/css");
      for (const path of [
        "/session-console/assets/not-in-manifest.js",
        "/session-console/.vite/manifest.json",
        "/session-console/assets/../index.html",
        "/session-console/assets/%2e%2e/index.html",
        "/session-console/assets\\entry.js",
        "/session-console/assets/entry.js/extra",
      ])
        expect(configAsset(path, directory)).toBeUndefined();
    });

    it.each([
      "../secret.js",
      "assets/../../secret.js",
      "assets/%2e%2e/secret.js",
      "C:\\secret.js",
    ])("rejects unsafe manifest path %s", (path) => {
      const directory = fixture(path);
      expect(validateSessionConsoleAssets(directory).ok).toBe(false);
      expect(configAsset("/session-console/assets/entry.js", directory)).toBeUndefined();
    });

    it("rejects a missing asset and still serves native modules without a manifest", () => {
      const directory = fixture();
      rmSync(join(directory, "assets", "entry.css"));
      expect(validateSessionConsoleAssets(directory).ok).toBe(false);
      rmSync(join(directory, ".vite", "manifest.json"));
      expect(configAsset("/session-console/index.html", directory)?.body).toContain(
        "bundle unavailable",
      );
      expect(configAsset("/config.js", directory)?.body).toContain("initShell");
      expect(configAsset("/sessions.js", directory)?.body).toContain("initSessions");
    });

    it("rejects an entry HTML that points outside the manifest", () => {
      const directory = fixture();
      writeFileSync(join(directory, "index.html"), '<script src="/secret.js"></script>');
      expect(validateSessionConsoleAssets(directory).ok).toBe(false);
    });

    it("requires the running revision when supplied and rejects a stale complete bundle", () => {
      const directory = fixture("assets/entry.js", "0123456789ab");
      expect(validateSessionConsoleAssets(directory, "0123456789ab")).toEqual({
        ok: true,
      });
      // Serving/cache warm-up must not bypass the fresh startup/update revision check.
      expect(configAsset("/session-console/index.html", directory)).toBeDefined();
      expect(validateSessionConsoleAssets(directory, "abcdef012345")).toEqual({
        ok: false,
        error:
          "Session console build revision mismatch: expected abcdef012345, found 0123456789ab",
      });
    });

    it("rejects an unstamped manifest when a revision is required but preserves directory-only checks", () => {
      const directory = fixture();
      expect(validateSessionConsoleAssets(directory)).toEqual({ ok: true });
      expect(validateSessionConsoleAssets(directory, "0123456789ab")).toEqual({
        ok: false,
        error:
          "Session console build revision mismatch: expected 0123456789ab, found (missing)",
      });
    });
  });

  it("ships the responsive session-management shell", () => {
    const html = configAsset("/")?.body ?? "";
    const css = configAsset("/config.css")?.body ?? "";

    expect(html).toContain('id="sessionSearch"');
    expect(html).toContain('id="sessionList"');
    expect(html).toContain('id="resumeSession"');
    expect(html).toContain('id="newSessionDialog"');
    expect(html).toContain('id="folderPicker"');
    expect(html).toContain('aria-labelledby="folderPickerTitle"');
    expect(css).toContain(".folder-list");
    expect(html).toContain('id="commandPermissions"');
    expect(html).toContain('id="commandPermissionForm"');
    expect(css).toContain("@media (max-width: 900px)");
  });

  it("has no path but its own", () => {
    expect(configAsset("/../package.json")).toBeUndefined();
    expect(configAsset("/index.html")).toBeUndefined();
  });

  it("serves the brand mark as the tab icon the page links", () => {
    const icon = configAsset("/favicon.svg");
    expect(icon?.contentType).toBe("image/svg+xml");
    expect(icon?.body).toContain("<svg");
    expect(configAsset("/")?.body).toContain(
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    );
  });
});
