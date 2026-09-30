import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { ComponentProps } from "react";
import type { SessionUsage } from "@fleet/protocol";
import { SessionUsageBar } from "./SessionUsageBar";
import { fleetDarkTheme } from "../theme";

const snapshot = (
  overrides: Partial<NonNullable<SessionUsage["context"]>> = {},
): NonNullable<SessionUsage["context"]> => ({
  model: "GPT-6 Astra",
  usedTokens: 125200,
  tokenLimit: 400000,
  percentage: 31,
  updatedAt: "2026-09-15T07:00:00.000Z",
  estimated: false,
  ...overrides,
});

const show = (props: Partial<ComponentProps<typeof SessionUsageBar>> = {}) => {
  const onCompact = vi.fn();
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <SessionUsageBar
        usage={{
          aiCredits: 27.4014,
          contextTokens: 50000,
          contextWindow: 272000,
          context: snapshot(),
        }}
        canCompact
        compactAvailable
        onCompact={onCompact}
        {...props}
      />
      <button type="button">Outside</button>
    </FluentProvider>,
  );
  return onCompact;
};

const ring = () =>
  screen.getByRole("button", { name: /Session (context usage|usage unavailable)/ });
const panel = () => screen.getByRole("group", { name: "Session usage" });

describe("SessionUsageBar", () => {
  it.each([
    { used: 50000, size: 200000, percentage: 25, offset: 75 },
    { used: 0, size: 200000, percentage: 0, offset: 100 },
    { used: 300000, size: 200000, percentage: 150, offset: 0 },
    { used: 125200, size: 400000, percentage: 31, offset: 69 },
    { used: 100000, size: 400000, percentage: 25.5, offset: 74.5 },
    { used: 125200, size: 1000000, percentage: 12.5, offset: 87.5 },
  ])(
    "draws the supplied usage, including real zero and over-capacity ($percentage%)",
    ({ used, size, percentage, offset }) => {
      show({
        usage: {
          context: snapshot({ usedTokens: used, tokenLimit: size, percentage }),
          contextTokens: 250000,
          contextWindow: 272000,
        },
      });
      const button = ring();
      expect(button.getAttribute("aria-label")).toBe(
        `Session context usage: ${percentage}% used`,
      );
      const progress = button.querySelector("circle[pathLength]");
      expect(progress?.getAttribute("stroke-dashoffset")).toBe(String(offset));
      expect(progress?.getAttribute("stroke-dasharray")).toBe("100");
      expect(button.textContent).toBe("");
      expect(screen.queryByText("AI credits")).toBeNull();
      expect(screen.queryByText(/tokens/)).toBeNull();
    },
  );

  it.each([
    undefined,
    {},
    { aiCredits: null, contextTokens: null, contextWindow: null, context: null },
    { contextTokens: 0 },
    { contextWindow: 200000 },
    { contextTokens: 1000, contextWindow: 0 },
    { contextTokens: -1, contextWindow: 200000 },
    { contextTokens: Number.NaN, contextWindow: 200000 },
    { contextTokens: 250000, contextWindow: 272000 },
    { context: null, contextTokens: 250000, contextWindow: 272000 },
    { context: snapshot({ percentage: Number.NaN }) },
    { context: snapshot({ percentage: -1 }) },
  ])(
    "keeps missing snapshots or invalid percentages neutral, even with ACP readings: %j",
    (usage) => {
      show({ usage });
      expect(ring().getAttribute("aria-label")).toBe("Session usage unavailable");
      expect(ring().querySelector("circle[pathLength]")).toBeNull();
      expect(ring().textContent).toBe("?");
      fireEvent.click(ring());
      expect(screen.getByText("? (Usage unavailable)")).toBeTruthy();
    },
  );

  it("shows exact session credits and full context details only in the popover", () => {
    show();
    fireEvent.mouseEnter(ring());
    expect(panel()).toBeTruthy();
    expect(screen.getByText("27.4")).toBeTruthy();
    expect(screen.getByText("27.4").title).toBe(
      "27.4014 AI credits used in this session.",
    );
    expect(screen.queryByText("27.4014 AI credits used in this session.")).toBeNull();
    expect(screen.getByText("125,200 / 400,000 tokens")).toBeTruthy();
    expect(screen.getByText("Model: GPT-6 Astra")).toBeTruthy();
    expect(screen.getByText(/CLI \/context · Updated \(local\):/)).toBeTruthy();
    const updatedAt = panel().querySelector("time");
    expect(updatedAt?.getAttribute("datetime")).toBe(snapshot().updatedAt);
    expect(updatedAt?.textContent).toBe(new Date(snapshot().updatedAt).toLocaleString());
    expect(screen.getByText("Last ACP input tokens / input budget")).toBeTruthy();
    expect(screen.getByText("50,000 / 272,000 tokens")).toBeTruthy();
    expect(
      screen.getByText(/Not the full context window.*timing may differ/),
    ).toBeTruthy();
    expect(
      screen.getByText("Last /context snapshot. Refreshed after turns."),
    ).toBeTruthy();
    expect(screen.queryByText(/account|quota/i)).toBeNull();
    expect(getComputedStyle(panel()).width).toContain("100vw");
    expect(getComputedStyle(panel()).overflowY).toBe("auto");
  });

  it("keeps core metrics and Compact outside the collapsed native reporting details", () => {
    show();
    fireEvent.click(ring());
    const reporting = panel().querySelector("details")!;
    expect(reporting.open).toBe(false);
    expect(reporting.querySelector("summary")?.textContent).toBe("Reporting details");
    for (const core of [
      screen.getByText("27.4"),
      screen.getByText("31% used"),
      screen.getByText("125,200 / 400,000 tokens"),
      screen.getByText("Model: GPT-6 Astra"),
      screen.getByText(/CLI \/context · Updated \(local\):/),
      screen.getByRole("button", { name: "Compact context" }),
    ]) {
      expect(reporting.contains(core)).toBe(false);
      expect(core.closest("[hidden]")).toBeNull();
    }
    expect(
      reporting.contains(screen.getByText("Last ACP input tokens / input budget")),
    ).toBe(true);
    expect(
      reporting.contains(
        screen.getByText("Last /context snapshot. Refreshed after turns."),
      ),
    ).toBe(true);
    const compact = screen.getByRole("button", { name: "Compact context" });
    expect(
      document.getElementById(compact.getAttribute("aria-describedby")!)?.hidden,
    ).toBe(true);
    expect(compact.title).toContain("saved transcript and draft are kept");
  });

  it("expands reporting details without dismissing the popover and keeps Compact outside the scroller", () => {
    const onCompact = show();
    fireEvent.mouseEnter(ring());
    fireEvent.mouseLeave(ring());
    fireEvent.mouseEnter(panel());
    const reporting = panel().querySelector("details")!;
    const summary = reporting.querySelector("summary")!;
    act(() => summary.focus());
    fireEvent.click(summary);
    expect(reporting.open).toBe(true);
    expect(ring().getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(reporting).overflowY).toBe("auto");
    expect(getComputedStyle(reporting).minHeight).toBe("0px");
    expect(getComputedStyle(panel()).maxHeight).toContain("420px");
    expect(getComputedStyle(panel()).maxHeight).toContain("100vh - 24px");
    const compact = screen.getByRole("button", { name: "Compact context" });
    expect(getComputedStyle(compact.parentElement!).flexShrink).toBe("0");
    expect(reporting.nextElementSibling).toBe(compact.parentElement);
    fireEvent.click(compact);
    expect(onCompact).toHaveBeenCalledTimes(1);
    fireEvent.click(summary);
    expect(reporting.open).toBe(false);
    fireEvent.keyDown(summary, { key: "Escape" });
    expect(ring().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(ring());
  });

  it.each([
    { aiCredits: undefined, label: "?" },
    { aiCredits: 0, label: "0" },
    { aiCredits: 0.00014, label: "<0.01" },
  ])("distinguishes missing, zero and small credits ($label)", ({ aiCredits, label }) => {
    show({ usage: aiCredits === undefined ? {} : { aiCredits } });
    fireEvent.click(ring());
    expect(within(panel()).getByText(label)).toBeTruthy();
  });

  it("labels Hermes ACP estimates without inventing credits or a Copilot context report", () => {
    show({
      agentKind: "hermes",
      usage: {
        context: {
          usedTokens: 8_000,
          tokenLimit: 32_000,
          percentage: 25,
          updatedAt: "2026-09-28T00:00:00.000Z",
          estimated: true,
          source: "acp",
        },
      },
    });
    expect(ring().getAttribute("aria-label")).toContain("approximately 25%");
    fireEvent.click(ring());
    expect(within(panel()).getByText("Hermes")).toBeTruthy();
    expect(within(panel()).getByText("?")).toBeTruthy();
    expect(screen.getByText(/Hermes ACP · Updated/)).toBeTruthy();
    expect(screen.getByText("~8,000 / ~32,000 tokens")).toBeTruthy();
    expect(screen.queryByText(/CLI \/context|Model:|input budget/)).toBeNull();
  });

  it("keeps partial ACP details explicitly separate from unknown full-window usage", () => {
    show({ usage: { contextTokens: 12345 } });
    fireEvent.click(ring());
    expect(screen.getByText("12,345 / ? tokens")).toBeTruthy();
    expect(screen.getByText("Last ACP input tokens / input budget")).toBeTruthy();
    expect(screen.getByText(/No \/context snapshot yet/)).toBeTruthy();
    expect(screen.queryByText(/1M|1,000,000/)).toBeNull();
  });

  it("marks rounded snapshot percentages and token counts as estimates", () => {
    show({ usage: { context: snapshot({ estimated: true }) } });
    expect(ring().getAttribute("aria-label")).toBe(
      "Session context usage: approximately 31% used",
    );
    fireEvent.click(ring());
    expect(screen.getByText("~31% used")).toBeTruthy();
    expect(screen.getByText("~125,200 / ~400,000 tokens")).toBeTruthy();
    expect(
      screen.getByText(
        "Estimated from CLI's rounded /context report. Refreshed after turns.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Last ACP input tokens / input budget")).toBeNull();
  });

  it("refreshes an open popover when a newer snapshot arrives and clears it on null", () => {
    const view = render(
      <FluentProvider theme={fleetDarkTheme}>
        <SessionUsageBar
          usage={{ context: snapshot() }}
          canCompact
          compactAvailable
          onCompact={vi.fn()}
        />
      </FluentProvider>,
    );
    fireEvent.click(ring());
    const next = snapshot({
      model: "Another model",
      usedTokens: 180000,
      percentage: 45,
      updatedAt: "2026-09-15T07:05:00.000Z",
    });
    view.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <SessionUsageBar
          usage={{ context: next }}
          canCompact
          compactAvailable
          onCompact={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(ring().getAttribute("aria-label")).toBe("Session context usage: 45% used");
    expect(screen.getByText("Model: Another model")).toBeTruthy();
    expect(panel().querySelector("time")?.getAttribute("datetime")).toBe(next.updatedAt);
    view.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <SessionUsageBar
          usage={{ context: null, contextTokens: 180000, contextWindow: 272000 }}
          canCompact
          compactAvailable
          onCompact={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(ring().getAttribute("aria-label")).toBe("Session usage unavailable");
    expect(panel().querySelector("time")).toBeNull();
    expect(screen.queryByText("Model: Another model")).toBeNull();
    expect(screen.getByText("180,000 / 272,000 tokens")).toBeTruthy();
  });

  it("keeps the hover popover interactive across pointer transfer without stealing focus", async () => {
    const onCompact = show();
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    fireEvent.mouseEnter(ring());
    expect(document.activeElement).toBe(outside);
    fireEvent.mouseLeave(ring());
    fireEvent.mouseEnter(panel());
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    fireEvent.click(screen.getByRole("button", { name: "Compact context" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
    fireEvent.mouseLeave(panel());
    await waitFor(() => expect(ring().getAttribute("aria-expanded")).toBe("false"));
  });

  it("opens on focus, reaches Compact by keyboard, and restores focus on Escape", async () => {
    show();
    const button = ring();
    act(() => button.focus());
    expect(panel()).toBeTruthy();
    fireEvent.keyDown(button, { key: "Tab" });
    const compact = screen.getByRole("button", { name: "Compact context" });
    expect(document.activeElement).toBe(compact);
    fireEvent.mouseLeave(panel());
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(compact, { key: "Escape" });
    await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe("false"));
    expect(document.activeElement).toBe(button);
  });

  it("dismisses keyboard previews when focus leaves", () => {
    show();
    act(() => ring().focus());
    expect(panel()).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    expect(ring().getAttribute("aria-expanded")).toBe("false");
  });

  it("pins on click/touch after focus or hover, toggles, and dismisses outside or with Escape", async () => {
    show();
    const button = ring();
    act(() => button.focus());
    fireEvent.click(button);
    fireEvent.mouseLeave(button);
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.touchStart(button);
    fireEvent.touchEnd(button);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(button, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    fireEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.mouseEnter(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it.each([
    {
      canCompact: false,
      compactAvailable: true,
      explanation: "Wait for the session to be idle before compacting.",
    },
    {
      canCompact: true,
      compactAvailable: false,
      explanation: "This agent has not offered /compact.",
    },
  ])("explains why Compact is disabled (%j)", ({ explanation, ...props }) => {
    const onCompact = show(props);
    act(() => ring().focus());
    fireEvent.keyDown(ring(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(panel());
    const compact = screen.getByRole<HTMLButtonElement>("button", {
      name: "Compact context",
    });
    expect(compact.disabled).toBe(true);
    expect(
      document.getElementById(compact.getAttribute("aria-describedby")!)?.textContent,
    ).toBe(explanation);
    expect(
      document.getElementById(compact.getAttribute("aria-describedby")!)?.hidden,
    ).toBe(false);
    fireEvent.click(compact);
    expect(onCompact).not.toHaveBeenCalled();
  });
});
