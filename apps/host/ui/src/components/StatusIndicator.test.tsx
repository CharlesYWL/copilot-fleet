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

  it("animates the icon wrapper, never the label or idle state", () => {
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
  });

  it.each([false, true])("only wraps status labels when requested (wrap: %s)", (wrap) => {
    const descriptor = {
      ...statusDescriptor("waiting-for-permission"),
      label: "Integration needs attention",
      shortLabel: "Integration needs attention",
    };
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <StatusIndicator descriptor={descriptor} wrap={wrap} />
      </FluentProvider>,
    );

    const indicator = screen.getByRole("img", { name: descriptor.label });
    expect(indicator.getAttribute("title")).toBe(descriptor.label);
    expect(getComputedStyle(indicator).flexShrink).toBe(wrap ? "1" : "0");
    expect(getComputedStyle(indicator.firstElementChild!).flexShrink).toBe("0");
    expect(getComputedStyle(screen.getByText(descriptor.label)).whiteSpace).toBe(
      wrap ? "normal" : "nowrap",
    );
  });

  it.each(["running", "stopping"] as const)(
    "keeps %s visibly rotating more slowly under reduced motion",
    (state) => {
      const descriptor = statusDescriptor(state);
      render(
        <FluentProvider theme={fleetDarkTheme}>
          <StatusIndicator descriptor={descriptor} />
        </FluentProvider>,
      );
      const icon = screen.getByRole("img", { name: descriptor.label }).firstElementChild!;
      const rules = reducedMotionRules(icon);
      expect(rules.some((rule) => rule.style.animationName === "none")).toBe(false);
      expect(rules.some((rule) => rule.style.animationDuration === "3s")).toBe(true);
    },
  );

  it("still disables decorative attention pulses under reduced motion", () => {
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <StatusIndicator descriptor={statusDescriptor("waiting-for-permission")} />
      </FluentProvider>,
    );
    const icon = screen.getByRole("img", { name: "Waiting for you" }).firstElementChild!;
    expect(
      reducedMotionRules(icon).some((rule) => rule.style.animationName === "none"),
    ).toBe(true);
  });
});

function reducedMotionRules(element: Element): CSSStyleRule[] {
  return [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules])
    .filter(
      (rule): rule is CSSMediaRule =>
        rule instanceof CSSMediaRule &&
        rule.conditionText.includes("prefers-reduced-motion: reduce"),
    )
    .flatMap((rule) => [...rule.cssRules])
    .filter(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && element.matches(rule.selectorText),
    );
}
