import { describe, expect, it } from "vitest";
import mark from "./assets/copilot-fleet-mark.svg?raw";
import favicon from "./assets/favicon.svg?raw";
import nodeFavicon from "../../../node/public/favicon.svg?raw";
import appIcon from "../public/icon.svg?raw";
import manifestSource from "../public/manifest.webmanifest?raw";
import hostPage from "../index.html?raw";
import demoPage from "../demo/index.html?raw";

/** The `<path>` elements of an SVG, which is all there is of the brand's artwork. */
const paths = (svg: string) => svg.match(/<path\b[^>]*\/>/g) ?? [];

describe("tab icon", () => {
  it("draws the brand mark's own shapes", () => {
    /*
     * A browser draws a tab icon as an isolated image that cannot load another
     * file, so the icon carries a copy of the mark's paths instead of a
     * reference to them. This is what keeps that copy from drifting away from
     * the brand.
     */
    expect(paths(mark)).toHaveLength(3);
    expect(paths(favicon)).toEqual(paths(mark));
  });

  it("is the same file on the Node console", () => {
    // The Node serves its page from public/, outside this build, so it keeps its
    // own copy rather than importing this one.
    expect(nodeFavicon).toBe(favicon);
  });

  it("is linked from every page that loads the console", () => {
    expect(hostPage).toContain(
      '<link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg" />',
    );
    expect(demoPage).toContain(
      '<link rel="icon" type="image/svg+xml" href="../src/assets/favicon.svg" />',
    );
  });
});

type ManifestIcon = { src: string; type: string; sizes: string };
type WebAppManifest = {
  name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: ManifestIcon[];
};

describe("installable app", () => {
  const manifest = JSON.parse(manifestSource) as WebAppManifest;

  it("is offered from the console page", () => {
    expect(hostPage).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it("opens the console in its own window", () => {
    expect(manifest.name).toBe("Copilot Fleet");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("uses the tab icon as its app icon", () => {
    // Served from public/ because the manifest names fixed URLs that the
    // bundler does not rewrite; the copy is held to the tab icon here.
    expect(appIcon).toBe(favicon);
    expect(manifest.icons.map((icon) => icon.src)).toEqual([
      "/icon.svg",
      "/icon-192.png",
      "/icon-512.png",
    ]);
  });
});
