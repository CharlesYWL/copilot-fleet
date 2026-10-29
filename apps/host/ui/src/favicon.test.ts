import { describe, expect, it } from "vitest";
import mark from "./assets/copilot-fleet-mark.svg?raw";
import favicon from "./assets/favicon.svg?raw";
import nodeFavicon from "../../../node/public/favicon.svg?raw";
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
