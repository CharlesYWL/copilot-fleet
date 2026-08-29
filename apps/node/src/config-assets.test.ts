import { describe, expect, it } from "vitest";
import { configAsset } from "./config-assets.js";

describe("config assets", () => {
  it("serves the page entry point and its browser modules", () => {
    // They live under public/ now, found by walking up to the package root so
    // that tsx and the built dist/ agree on where they are.
    expect(configAsset("/")?.body).toContain("<!doctype html>");
    expect(configAsset("/config.css")?.contentType).toBe("text/css; charset=utf-8");
    expect(configAsset("/config.js")?.body).toContain("initSessions");
    expect(configAsset("/sessions.js")?.body).toContain("selectedSessionId");
    expect(configAsset("/node-settings.js")?.body).toContain("savedSettings");
    expect(configAsset("/ui.js")?.contentType).toBe("text/javascript; charset=utf-8");
  });

  it("ships the responsive session-management shell", () => {
    const html = configAsset("/")?.body ?? "";
    const css = configAsset("/config.css")?.body ?? "";
    const script = configAsset("/sessions.js")?.body ?? "";

    expect(html).toContain('id="sessionSearch"');
    expect(html).toContain('id="sessionList"');
    expect(html).toContain('id="resumeSession"');
    expect(html).toContain('id="newSessionDialog"');
    expect(css).toContain("@media (max-width: 900px)");
    expect(script).toContain("selectedSessionId");
    expect(script).toContain("previewRequest?.abort()");
    expect(script).toContain("resumedSessionIds");
  });

  it("has no path but its own", () => {
    expect(configAsset("/../package.json")).toBeUndefined();
    expect(configAsset("/index.html")).toBeUndefined();
  });
});
