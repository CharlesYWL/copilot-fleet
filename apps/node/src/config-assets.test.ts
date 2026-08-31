import { describe, expect, it } from "vitest";
import { configAsset } from "./config-assets.js";

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
      "/sessions.js",
      "/ui.js",
    ]) {
      const asset = configAsset(path);
      expect(asset?.contentType).toBe("text/javascript; charset=utf-8");
      expect(asset?.body.length).toBeGreaterThan(0);
    }
  });

  it("ships the responsive session-management shell", () => {
    const html = configAsset("/")?.body ?? "";
    const css = configAsset("/config.css")?.body ?? "";

    expect(html).toContain('id="sessionSearch"');
    expect(html).toContain('id="sessionList"');
    expect(html).toContain('id="resumeSession"');
    expect(html).toContain('id="newSessionDialog"');
    expect(css).toContain("@media (max-width: 900px)");
  });

  it("has no path but its own", () => {
    expect(configAsset("/../package.json")).toBeUndefined();
    expect(configAsset("/index.html")).toBeUndefined();
  });
});
