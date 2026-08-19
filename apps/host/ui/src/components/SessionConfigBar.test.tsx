import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { SessionConfigOption } from "@fleet/protocol";
import { SessionConfigBar } from "./SessionConfigBar";
import { fleetDarkTheme } from "../theme";

const option = (values: Partial<SessionConfigOption>): SessionConfigOption => ({
  id: "model",
  name: "Model",
  description: "",
  category: "model",
  currentValue: "opus",
  choices: [
    { value: "opus", name: "Claude Opus 5", description: "" },
    { value: "haiku", name: "Claude Haiku 4.5", description: "" },
  ],
  ...values,
});

const show = (options: SessionConfigOption[], disabled = false) => {
  const onChange = vi.fn();
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <SessionConfigBar options={options} disabled={disabled} onChange={onChange} />
    </FluentProvider>,
  );
  return onChange;
};

describe("SessionConfigBar", () => {
  it("shows the current value, not the option's name", () => {
    // The label would cost width the composer needs; it lives in the menu.
    show([option({})]);
    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger.textContent).toContain("Claude Opus 5");
    expect(trigger.textContent).not.toContain("Model");
  });

  it("reports the chosen value", () => {
    const onChange = show([option({})]);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Claude Haiku 4.5" }));
    expect(onChange).toHaveBeenCalledWith("model", "haiku");
  });

  it("stays quiet when the current value is re-picked", () => {
    const onChange = show([option({})]);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Claude Opus 5" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a long list inside the window instead of running off the top", () => {
    // The strip sits at the bottom of the screen and opens upwards, so an agent
    // offering twenty models drew a list taller than the window: the choices at
    // the top could not be reached, scrolled to, or seen at all.
    show([
      option({
        choices: Array.from({ length: 21 }, (_, index) => ({
          value: `m${index}`,
          name: `Model ${index}`,
          description: "",
        })),
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    const list = screen.getByRole("menu");
    const style = getComputedStyle(list);
    // Not merely "set": an unset max-height computes to the string "none",
    // which is truthy and would let this pass over the bug it exists for.
    expect(style.maxHeight).not.toBe("none");
    expect(style.maxHeight).toBeTruthy();
    expect(style.overflowY).toBe("auto");
  });

  it("reaches a choice that only a scrolling list could show", () => {
    const onChange = show([
      option({
        choices: Array.from({ length: 21 }, (_, index) => ({
          value: `m${index}`,
          name: `Model ${index}`,
          description: "",
        })),
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Model 20" }));
    expect(onChange).toHaveBeenCalledWith("model", "m20");
  });

  it("leaves out the permission picker the fleet already owns", () => {
    show([
      option({}),
      option({ id: "allow_all", name: "Allow All", category: "permissions" }),
    ]);
    expect(screen.queryByRole("button", { name: "Allow All" })).toBeNull();
  });

  it("renders nothing at all when there is nothing to pick", () => {
    const { container } = render(
      <FluentProvider theme={fleetDarkTheme}>
        <SessionConfigBar options={[]} onChange={vi.fn()} />
      </FluentProvider>,
    );
    // An empty strip would still occupy a row under the composer.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("disables its triggers with the session", () => {
    show([option({})], true);
    expect(screen.getByRole("button", { name: "Model" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("falls back to the raw value when the choice list has not caught up", () => {
    show([option({ currentValue: "gpt-9-unlisted" })]);
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain(
      "gpt-9-unlisted",
    );
  });

  it("reports a pick of the empty-string choice", () => {
    // Copilot's `agent` picker names its default persona "". Guarding the
    // handler with a falsy test made that choice the one option in the menu
    // that could be clicked and do nothing.
    const onChange = show([
      option({
        id: "agent",
        name: "Agent",
        category: "_agent",
        currentValue: "feature-dev",
        choices: [
          { value: "", name: "Copilot", description: "" },
          { value: "feature-dev", name: "feature-dev", description: "" },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Copilot" }));
    expect(onChange).toHaveBeenCalledWith("agent", "");
  });
});
