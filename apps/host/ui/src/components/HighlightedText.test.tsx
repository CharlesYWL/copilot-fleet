import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../theme";
import { HighlightedText } from "./HighlightedText";

const show = (text: string, terms: string[]) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <span data-testid="host">
        <HighlightedText text={text} terms={terms} />
      </span>
    </FluentProvider>,
  );

describe("HighlightedText", () => {
  it("wraps each matching run in a mark and keeps the full text readable", () => {
    const { getByTestId } = show("Default save defaults", ["def"]);
    const host = getByTestId("host");
    expect(host.textContent).toBe("Default save defaults");
    expect([...host.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "Def",
      "def",
    ]);
  });

  it("renders plain text with no marks when nothing matches", () => {
    const { getByTestId } = show("YOLO mode", ["tunnel"]);
    expect(getByTestId("host").querySelector("mark")).toBeNull();
    expect(getByTestId("host").textContent).toBe("YOLO mode");
  });

  it("keeps the spaces around a match in the accessible name", () => {
    const { getByRole } = render(
      <FluentProvider theme={fleetDarkTheme}>
        <button type="button">
          <HighlightedText text="Fix the lint step" terms={["lint"]} />
        </button>
      </FluentProvider>,
    );
    expect(getByRole("button", { name: "Fix the lint step" })).toBeTruthy();
  });
});
