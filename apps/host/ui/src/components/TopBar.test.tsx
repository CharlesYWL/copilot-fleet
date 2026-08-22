import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../theme";
import { TopBar } from "./TopBar";

const show = (overrides: Partial<Parameters<typeof TopBar>[0]> = {}) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <TopBar
        nodesOnline={2}
        liveSessions={3}
        waitingPermissions={0}
        connected
        context={{ kind: "session", mode: "tree", onChange: vi.fn() }}
        soundEnabled
        onToggleSound={vi.fn()}
        onSignOut={vi.fn()}
        {...overrides}
      />
    </FluentProvider>,
  );

describe("TopBar counts", () => {
  it("still says what each number counts, now that the words are icons", () => {
    /*
     * The labels moved into the icons to stop three strings pushing the mode
     * switch off centre. They moved visually, not out of the page: without a
     * name of its own each count reached assistive tech as a bare digit.
     */
    show();
    expect(screen.getByRole("img", { name: "2 nodes online" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "3 live sessions" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "0 waiting for you" })).toBeTruthy();
  });

  it("counts one thing in the singular", () => {
    show({ nodesOnline: 1, liveSessions: 1 });
    expect(screen.getByRole("img", { name: "1 node online" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "1 live session" })).toBeTruthy();
  });

  it("keeps the number visible, because that is the information", () => {
    show({ nodesOnline: 7 });
    const stat = screen.getByRole("img", { name: "7 nodes online" });
    expect(stat.textContent).toContain("7");
  });

  it("becomes a way in once something is waiting", () => {
    const onShowAttention = vi.fn();
    show({ waitingPermissions: 4, onShowAttention });

    const button = screen.getByRole("button", { name: "4 waiting for you" });
    button.click();

    expect(onShowAttention).toHaveBeenCalled();
  });

  it("does not offer a way in when nothing is waiting", () => {
    show({ waitingPermissions: 0, onShowAttention: vi.fn() });
    expect(screen.queryByRole("button", { name: /waiting for you/ })).toBeNull();
  });

  it("says whether the Host is reachable without spending a word on it", () => {
    const { rerender } = show({ connected: true });
    expect(screen.getByRole("img", { name: "Connected to the Host" })).toBeTruthy();

    rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <TopBar
          nodesOnline={2}
          liveSessions={3}
          waitingPermissions={0}
          connected={false}
          context={{ kind: "none" }}
          soundEnabled
          onToggleSound={vi.fn()}
          onSignOut={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(screen.getByRole("img", { name: /Reconnecting/ })).toBeTruthy();
  });
});

describe("TopBar layout", () => {
  it("puts the mode switch in a column of its own, not between two auto margins", () => {
    /*
     * Auto margins only centre within whatever the sides leave, so the switch
     * drifted as the brand or the counts changed width. A three-column grid is
     * what makes "centre" mean the centre of the window.
     */
    show();
    const bar = screen.getByRole("banner");
    const group = within(bar).getByRole("group", { name: "Session layout" });

    expect(bar.childElementCount).toBe(3);
    // The switch is alone in the middle column, so nothing beside it can move it.
    const middle = bar.children[1]!;
    expect(middle.contains(group)).toBe(true);
    expect(middle.childElementCount).toBe(1);
  });

  it("offers no mode column where there is no mode to choose", () => {
    show({ context: { kind: "none" } });
    const bar = screen.getByRole("banner");
    expect(within(bar).queryByRole("group")).toBeNull();
    // The column stays, so the sides do not reflow when the switch goes away.
    expect(bar.childElementCount).toBe(3);
  });
});
