import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { PromptRail } from "./PromptRail";
import type { PromptMark } from "../lib/prompt-marks";
import { fleetDarkTheme } from "../theme";

const marks = [
  { key: "u1", label: "fix the retry helper", createdAt: "2026-08-18T20:39:00.000Z" },
  { key: "u2", label: "now ship it", createdAt: "2026-08-18T21:05:00.000Z" },
];

const show = (onSelect = vi.fn(), activeKey = "u2", promptMarks = marks) => {
  const result = render(
    <FluentProvider theme={fleetDarkTheme}>
      <PromptRail marks={promptMarks} activeKey={activeKey} onSelect={onSelect} />
    </FluentProvider>,
  );
  return { ...result, onSelect };
};

const manyMarks = (count: number): PromptMark[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `prompt-${index}`,
    label: `Prompt ${index + 1}`,
    createdAt: marks[0]!.createdAt,
  }));

let railHeight = 600;

beforeEach(() => {
  railHeight = 600;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 34, railHeight),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    const { onSelect } = show();
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

  it.each([0, 1, 39, 40])("keeps every prompt when %i prompts fit", (count) => {
    show(vi.fn(), undefined, manyMarks(count));
    expect(screen.queryAllByRole("button")).toHaveLength(count);
  });

  it.each([41, 80, 1_000])(
    "samples %i prompts evenly, including the first and last",
    (count) => {
      const { onSelect } = show(vi.fn(), undefined, manyMarks(count));
      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(40);
      const indices = buttons.map((button, index) => {
        const originalIndex = Math.round((index * (count - 1)) / 39);
        expect(button.getAttribute("aria-label")).toBe(
          `Jump to prompt: Prompt ${originalIndex + 1}`,
        );
        fireEvent.click(button);
        expect(onSelect).toHaveBeenLastCalledWith(`prompt-${originalIndex}`);
        return originalIndex;
      });
      expect(new Set(indices).size).toBe(40);
      expect(indices[0]).toBe(0);
      expect(indices.at(-1)).toBe(count - 1);
    },
  );

  it("previews the sampled prompt, not its position in the displayed list", () => {
    show(vi.fn(), undefined, manyMarks(80));
    const last = screen.getByRole("button", { name: "Jump to prompt: Prompt 80" });
    fireEvent.focus(last);
    expect(screen.getByRole("tooltip").textContent).toContain("Prompt 80");
  });

  it("lights the preceding sampled mark when the current prompt was skipped", () => {
    show(vi.fn(), "prompt-3", manyMarks(80));
    const active = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-current") === "location");
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute("aria-label")).toBe("Jump to prompt: Prompt 3");
  });

  it.each([3, 10, 11, 35, 100, 250, 600])(
    "fits the available %ipx without overflowing",
    (height) => {
      railHeight = height;
      show(vi.fn(), undefined, manyMarks(100));
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeLessThanOrEqual(40);
      for (const [index, button] of buttons.entries()) {
        const top = Number.parseFloat(button.style.top);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top + 3).toBeLessThanOrEqual(height);
        if (index > 0) {
          expect(
            top - Number.parseFloat(buttons[index - 1]!.style.top),
          ).toBeGreaterThanOrEqual(8);
        }
      }
      if (height >= 11) {
        expect(buttons[0]?.getAttribute("aria-label")).toBe("Jump to prompt: Prompt 1");
        expect(buttons.at(-1)?.getAttribute("aria-label")).toBe(
          "Jump to prompt: Prompt 100",
        );
      }
    },
  );

  it("hides marks when not even one fits", () => {
    railHeight = 2;
    show(vi.fn(), undefined, manyMarks(100));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it.each([
    [338, 39],
    [339, 40],
  ])("fits exactly %i pixels with %i marks", (height, count) => {
    railHeight = height;
    show(vi.fn(), undefined, manyMarks(80));
    expect(screen.getAllByRole("button")).toHaveLength(count);
  });

  it("resamples on resize and removes a preview for a mark no longer shown", () => {
    let notifyResize: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect = disconnect;
      },
    );
    const { unmount } = show(vi.fn(), undefined, manyMarks(80));
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Jump to prompt: Prompt 3" }),
    );
    expect(screen.queryByRole("tooltip")).not.toBeNull();
    act(() => {
      railHeight = 100;
      notifyResize?.();
    });
    expect(screen.getAllByRole("button")).toHaveLength(10);
    expect(screen.queryByRole("tooltip")).toBeNull();
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("resamples after new prompts arrive without losing either endpoint", () => {
    const { rerender } = show(vi.fn(), undefined, manyMarks(40));
    rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <PromptRail marks={manyMarks(80)} onSelect={vi.fn()} />
      </FluentProvider>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(40);
    expect(screen.getByRole("button", { name: "Jump to prompt: Prompt 1" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Jump to prompt: Prompt 80" }),
    ).toBeTruthy();
  });
});
