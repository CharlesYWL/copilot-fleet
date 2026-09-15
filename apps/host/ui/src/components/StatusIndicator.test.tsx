import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../theme";
import { statusDescriptor, type StatusState } from "../lib/status-visuals";
import { StatusIndicator } from "./StatusIndicator";

describe("StatusIndicator", () => {
  it.each([
    "running",
    "idle",
    "done",
    "offline",
    "failed",
    "queued",
    "stopping",
    "stopped",
    "skipped",
    "resumable",
    "waiting-for-permission",
    "online",
  ] satisfies StatusState[])(
    "renders a labelled SVG instead of a color-only dot for %s",
    (state) => {
      const descriptor = statusDescriptor(state);
      render(
        <FluentProvider theme={fleetDarkTheme}>
          <StatusIndicator descriptor={descriptor} variant="icon" />
        </FluentProvider>,
      );
      const indicator = screen.getByRole("img", { name: descriptor.label });
      expect(indicator.getAttribute("title")).toBe(descriptor.label);
      expect(indicator.querySelector("svg")).not.toBeNull();
      expect(indicator.textContent).toBe("");
      expect(indicator.style.color).not.toBe("");
    },
  );

  it("animates the icon wrapper, never the label, and supplies a reduced-motion rule", () => {
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <StatusIndicator descriptor={statusDescriptor("running")} />
        <StatusIndicator descriptor={statusDescriptor("idle")} />
      </FluentProvider>,
    );
    const running = screen.getByRole("img", { name: "Running" });
    const icon = running.firstElementChild!;
    expect(getComputedStyle(icon).animationIterationCount).toBe("infinite");
    expect(getComputedStyle(icon).animationTimingFunction).toBe("linear");
    expect(getComputedStyle(running).animationName).toBe("none");
    expect(getComputedStyle(screen.getByText("running")).animationName).toBe("none");
    expect(
      getComputedStyle(screen.getByRole("img", { name: /Idle/ }).firstElementChild!)
        .animationName,
    ).toBe("none");
    const css = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .map((rule) => rule.cssText)
      .join("\n");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("animation-name: none");
  });
});
