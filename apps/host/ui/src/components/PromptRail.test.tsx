import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { PromptRail } from "./PromptRail";
import { fleetDarkTheme } from "../theme";

const marks = [
  { key: "u1", label: "fix the retry helper", createdAt: "2026-08-18T20:39:00.000Z" },
  { key: "u2", label: "now ship it", createdAt: "2026-08-18T21:05:00.000Z" },
];

const show = (onSelect = vi.fn(), activeKey = "u2") => {
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <PromptRail marks={marks} activeKey={activeKey} onSelect={onSelect} />
    </FluentProvider>,
  );
  return onSelect;
};

describe("PromptRail", () => {
  it("draws one mark per prompt, each naming the prompt it jumps to", () => {
    // The rail stands in for the scrollbar, so the marks are the only handle a
    // keyboard or screen-reader user has on "take me back to that turn".
    show();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Jump to prompt: now ship it" }),
    ).toBeTruthy();
  });

  it("reports which prompt was picked", () => {
    const onSelect = show();
    screen.getByRole("button", { name: "Jump to prompt: fix the retry helper" }).click();
    expect(onSelect).toHaveBeenCalledWith("u1");
  });

  it("names the prompt and when it was sent while the pointer rests on a mark", () => {
    show();
    const mark = screen.getByRole("button", {
      name: "Jump to prompt: fix the retry helper",
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(mark);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("fix the retry helper");
    expect(tooltip.textContent).toMatch(/\d/);
  });

  it("keeps the marks reachable without a pointer at all", () => {
    // Focus is the keyboard's version of hovering; without this the label a
    // sighted user gets from the tooltip would have no equivalent.
    show();
    const mark = screen.getByRole("button", { name: "Jump to prompt: now ship it" });
    fireEvent.focus(mark);
    expect(screen.getByRole("tooltip").textContent).toContain("now ship it");
  });
});
