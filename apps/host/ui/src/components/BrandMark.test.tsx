import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../theme";
import markUrl from "../assets/copilot-fleet-mark.svg";
import { BrandMark } from "./BrandMark";

const show = (node: ReactNode) =>
  render(<FluentProvider theme={fleetDarkTheme}>{node}</FluentProvider>);

const mark = () => document.querySelector("img")!;

describe("BrandMark", () => {
  it("draws the brand asset rather than a shape of its own", () => {
    /*
     * The point of the component is that one file holds the artwork. A second
     * copy of the paths — inlined here, retraced, or pasted into a sibling
     * component — is a copy that can drift from the brand.
     *
     * Whether the bundler emits that file as a URL or folds it into the
     * document is its business and changes with the file's size, so this asks
     * for the asset the component imports, not for a particular spelling of it.
     */
    show(<BrandMark />);
    expect(mark().getAttribute("src")).toBe(markUrl);
    expect(markUrl).toMatch(/^data:image\/svg\+xml|\.svg(\?|$)/);
    expect(document.querySelectorAll("svg")).toHaveLength(0);
  });

  it("is the size it was asked for, in both dimensions", () => {
    show(<BrandMark size={36} />);
    expect(mark().getAttribute("width")).toBe("36");
    // The artwork is square; a mark that is 36 wide and something else tall is
    // a stretched mark.
    expect(mark().getAttribute("height")).toBe("36");
  });

  it("says nothing beside the word it sits next to", () => {
    /*
     * The mark only ever appears alongside "Copilot Fleet". Naming it would
     * make a screen reader read the brand twice for one piece of branding.
     */
    show(
      <div>
        <BrandMark size={30} />
        <span>Copilot Fleet</span>
      </div>,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(mark().getAttribute("alt")).toBe("");
    expect(mark().getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByText("Copilot Fleet")).toHaveLength(1);
  });
});
