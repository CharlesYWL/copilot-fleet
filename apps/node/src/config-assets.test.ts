import { describe, expect, it } from "vitest";
import { configAsset } from "./config-assets.js";

describe("config assets", () => {
  it("serves the three files the page is made of", () => {
    // They live under public/ now, found by walking up to the package root so
    // that tsx and the built dist/ agree on where they are.
    expect(configAsset("/")?.body).toContain("<!doctype html>");
    expect(configAsset("/config.css")?.contentType).toBe("text/css; charset=utf-8");
    expect(configAsset("/config.js")?.body).toContain("addEventListener");
  });

  it("has no path but its own", () => {
    expect(configAsset("/../package.json")).toBeUndefined();
    expect(configAsset("/index.html")).toBeUndefined();
  });
});
