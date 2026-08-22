import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../../theme";
import { ContextModeToggle, type ContextMode } from "./ContextModeToggle";

const wrap = (context: ContextMode) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <ContextModeToggle context={context} />
    </FluentProvider>,
  );

const labels = () =>
  within(screen.getByRole("group"))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

describe("ContextModeToggle", () => {
  it("offers session layouts while looking at sessions", () => {
    wrap({ kind: "session", mode: "tree", onChange: vi.fn() });
    expect(labels()).toEqual(["Tree", "Overview"]);
  });

  it("offers task views while looking at the orchestrator", () => {
    wrap({ kind: "orchestrator", mode: "stage", onChange: vi.fn() });
    expect(labels()).toEqual(["Stages", "List", "Dependency"]);
  });

  it("offers nothing where neither applies", () => {
    // Settings has no arrangement to choose, so the slot goes away rather than
    // showing a control that would change a page the operator is not on.
    wrap({ kind: "none" });
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("marks the mode in effect", () => {
    wrap({ kind: "orchestrator", mode: "list", onChange: vi.fn() });
    const pressed = within(screen.getByRole("group"))
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.getAttribute("aria-label"));
    expect(pressed).toEqual(["List"]);
  });

  it("reports the chosen mode, not a toggle", () => {
    const onChange = vi.fn();
    wrap({ kind: "orchestrator", mode: "stage", onChange });
    fireEvent.click(screen.getByRole("button", { name: "Dependency" }));
    expect(onChange).toHaveBeenCalledWith("dependency");
  });

  it("keeps every mode reachable by name when its label is hidden", () => {
    /*
     * Under 600px the words are hidden by CSS. If the accessible name came from
     * that same text, three of these buttons would become unnamed on a phone.
     */
    wrap({ kind: "orchestrator", mode: "stage", onChange: vi.fn() });
    for (const name of ["Stages", "List", "Dependency"]) {
      expect(screen.getByRole("button", { name }).getAttribute("title")).toBe(name);
    }
  });
});
