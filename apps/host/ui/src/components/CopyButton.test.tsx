import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { CopyButton } from "./CopyButton";
import { fleetDarkTheme } from "../theme";

const show = (showText: boolean) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <CopyButton text="the complete command" label="Copy sample" showText={showText} />
    </FluentProvider>,
  );

describe("CopyButton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { showText: false, delay: 1_600 },
    { showText: true, delay: 2_000 },
  ])("preserves copy feedback with showText=$showText", async ({ showText, delay }) => {
    show(showText);
    const button = screen.getByRole("button", { name: "Copy sample" });
    expect(button.textContent).toBe(showText ? "Copy" : "");
    await act(async () => fireEvent.click(button));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("the complete command");
    expect(button.getAttribute("aria-label")).toBe(showText ? "Copy sample" : "Copied");
    expect(button.textContent).toBe(showText ? "Copied" : "");
    act(() => vi.advanceTimersByTime(delay - 1));
    expect(button.getAttribute("aria-label")).toBe(showText ? "Copy sample" : "Copied");
    expect(button.textContent).toBe(showText ? "Copied" : "");
    act(() => vi.advanceTimersByTime(1));
    expect(button.getAttribute("aria-label")).toBe("Copy sample");
    expect(button.textContent).toBe(showText ? "Copy" : "");
  });

  it.each([false, true])(
    "does not claim success when the clipboard refuses, showText=%s",
    async (showText) => {
      vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error("blocked"));
      show(showText);
      const button = screen.getByRole("button", { name: "Copy sample" });
      await act(async () => fireEvent.click(button));
      expect(button.getAttribute("aria-label")).toBe("Copy sample");
      expect(button.textContent).toBe(showText ? "Copy" : "");
    },
  );
});
