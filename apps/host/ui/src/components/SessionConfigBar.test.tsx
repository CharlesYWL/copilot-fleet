import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { CONTEXT_TIER_CONFIG_ID, type SessionConfigOption } from "@fleet/protocol";
import { SessionConfigBar, type SessionConfigBarProps } from "./SessionConfigBar";
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

const show = (
  options: SessionConfigOption[],
  disabled = false,
  session: SessionConfigBarProps["session"] = {},
) => {
  const onChange = vi.fn();
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <SessionConfigBar
        options={options}
        session={session}
        disabled={disabled}
        onChange={onChange}
      />
    </FluentProvider>,
  );
  return onChange;
};

const effort = () =>
  option({
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "reasoning",
    currentValue: "xhigh",
    choices: [
      { value: "", name: "Default", description: "" },
      { value: "xhigh", name: "Extra High", description: "" },
    ],
  });
const context = () =>
  option({
    id: CONTEXT_TIER_CONFIG_ID,
    name: "Context window",
    category: "context",
    currentValue: "long_context",
    description:
      "Switching restarts the session. Conversation history is kept. CLI may ignore the requested tier; the actual reported window is in Session usage.",
    choices: [
      { value: "default", name: "Default", description: "Standard window" },
      {
        value: "long_context",
        name: "Long",
        description: "Extended window; higher cost",
      },
    ],
  });
const openModel = () => {
  fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Model:/ }));
};

describe("SessionConfigBar", () => {
  it.each([
    { state: "idle" },
    { state: "running" },
    { state: "offline" },
    { state: "idle", stopRequested: true },
  ])("offers history-preserving context switching only while idle (%j)", (session) => {
    const onChange = show([option({}), effort(), context()], false, session);
    const locked = session.state !== "idle" || Boolean(session.stopRequested);
    fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
    const row = screen.getByRole("menuitem", { name: "Context window: Long" });
    expect(row.getAttribute("aria-disabled") === "true").toBe(locked);
    expect(row.title).toContain("CLI may ignore the requested tier");
    if (!locked) {
      fireEvent.click(row);
      expect(screen.getByText(/Conversation history is kept/)).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitemradio", { name: /Default/ }));
      expect(onChange).toHaveBeenCalledWith(CONTEXT_TIER_CONFIG_ID, "default");
    } else {
      expect(row.title).toContain("idle");
      fireEvent.click(row);
      expect(screen.queryByRole("menu", { name: "Context window" })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort:/ }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Default" }));
      expect(onChange).toHaveBeenCalledWith("reasoning_effort", "");
    }
  });

  it("shows the current value, not the option's name", () => {
    // The label would cost width the composer needs; it lives in the menu.
    show([option({})]);
    const trigger = screen.getByRole("button", { name: "Model settings" });
    expect(trigger.textContent).toContain("Claude Opus 5");
    expect(trigger.textContent).not.toContain("Model");
  });

  it("reports the chosen value", () => {
    const onChange = show([option({})]);
    openModel();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Claude Haiku 4.5" }));
    expect(onChange).toHaveBeenCalledWith("model", "haiku");
  });

  it("stays quiet when the current value is re-picked", () => {
    const onChange = show([option({})]);
    openModel();
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
    openModel();

    const list = screen
      .getByRole("menuitemradio", { name: "Model 0" })
      .closest('[role="menu"]')!;
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
    openModel();
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
    expect(
      screen.getByRole("button", { name: "Model settings" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("falls back to the raw value when the choice list has not caught up", () => {
    show([option({ currentValue: "gpt-9-unlisted" })]);
    expect(screen.getByRole("button", { name: "Model settings" }).textContent).toContain(
      "gpt-9-unlisted",
    );
  });

  it("reports a pick of the empty-string choice", () => {
    /*
     * Copilot's `agent` picker names its default persona "". Guarding the
     * handler with a falsy test made that choice the one option in the menu
     * that could be clicked and do nothing.
     *
     * The agent picker itself has moved next to the session's name — see
     * SessionAgentBadge, which guards the same case — but any picker may offer
     * an empty value, so the bar keeps its own guard.
     */
    const onChange = show([
      option({
        id: "persona",
        name: "Persona",
        category: "persona",
        currentValue: "feature-dev",
        choices: [
          { value: "", name: "Default", description: "" },
          { value: "feature-dev", name: "feature-dev", description: "" },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Persona" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Default" }));
    expect(onChange).toHaveBeenCalledWith("persona", "");
  });

  it("leaves the agent picker to the badge beside the session's name", () => {
    // Two controls in one strip both reading as "agent" — the mode picker's
    // value is literally the word — is why the real one could not be found.
    show([
      option({
        id: "agent",
        name: "Agent",
        category: "_agent",
        currentValue: "fleet-orchestrator",
        choices: [
          { value: "", name: "Copilot", description: "" },
          { value: "fleet-orchestrator", name: "fleet-orchestrator", description: "" },
        ],
      }),
    ]);

    expect(screen.queryByRole("button", { name: "Agent" })).toBeNull();
  });

  it("combines dynamic model and effort labels with three nested pickers", () => {
    show([context(), effort(), option({})], false, { state: "idle" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const trigger = screen.getByRole("button", { name: "Model settings" });
    expect(trigger.textContent).toBe("Claude Opus 5 · Extra High");
    fireEvent.click(trigger);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Model: Claude Opus 5", "Effort: Extra High", "Context window: Long"]);
    expect(screen.queryByRole("menuitem", { name: /Auto/ })).toBeNull();
    expect(screen.queryByText(/1M/)).toBeNull();
  });

  it.each(["running", "offline"])("keeps model changes usable while %s", (state) => {
    const onChange = show([option({}), effort(), context()], false, { state });
    openModel();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Claude Haiku 4.5" }));
    expect(onChange).toHaveBeenCalledWith("model", "haiku");
  });

  it("keeps Mode separate and unknown options usable, but hides fleet-owned Mode", () => {
    const mode = option({ id: "mode", name: "Mode", category: "mode" });
    const options = [
      option({}),
      mode,
      option({ id: "unknown", name: "Unknown", category: "future" }),
    ];
    const view = render(
      <FluentProvider theme={fleetDarkTheme}>
        <SessionConfigBar options={options} onChange={vi.fn()} />
      </FluentProvider>,
    );
    expect(screen.getByRole("button", { name: "Mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unknown" })).toBeTruthy();
    view.rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <SessionConfigBar
          options={options}
          session={{ runRole: "worker" }}
          onChange={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(screen.queryByRole("button", { name: "Mode" })).toBeNull();
    expect(screen.getByRole("button", { name: "Unknown" })).toBeTruthy();
  });

  it("works without a model and does not invent one", () => {
    show([effort(), context()], false, { state: "idle" });
    const trigger = screen.getByRole("button", { name: "Model settings" });
    expect(trigger.textContent).toBe("Extra High");
    fireEvent.click(trigger);
    expect(screen.queryByRole("menuitem", { name: /^Model:/ })).toBeNull();
  });

  it("includes a single-choice model in the summary without offering a dead picker", () => {
    show([
      option({ choices: [{ value: "opus", name: "Only model", description: "" }] }),
      effort(),
    ]);
    const trigger = screen.getByRole("button", { name: "Model settings" });
    expect(trigger.textContent).toBe("Only model · Extra High");
    fireEvent.click(trigger);
    expect(screen.queryByRole("menuitem", { name: /^Model:/ })).toBeNull();
  });

  it("constrains long labels and nested menus to the viewport", () => {
    const name = "A very long model name ".repeat(20);
    show([
      option({
        choices: [
          { value: "opus", name, description: "" },
          { value: "other", name: "Another", description: "" },
        ],
      }),
      effort(),
    ]);
    const trigger = screen.getByRole("button", { name: "Model settings" });
    expect(trigger.title).toBe(`${name} · Extra High`);
    expect(getComputedStyle(trigger).minWidth).toBe("0px");
    expect(getComputedStyle(trigger).maxWidth).toContain("100%");
    expect(getComputedStyle(trigger.firstElementChild!).textOverflow).toBe("ellipsis");
    openModel();
    const list = screen
      .getByRole("menuitemradio", { name: "Another" })
      .closest('[role="menu"]')!;
    expect(getComputedStyle(list.parentElement!).maxWidth).toContain("100vw");
    expect(
      getComputedStyle(
        screen
          .getByRole("menuitemradio", { name: name.trim() })
          .querySelector(".fui-MenuItemRadio__content")!,
      ).overflowWrap,
    ).toBe("anywhere");
  });

  it("supports keyboard entry, nested navigation, selection and Escape", async () => {
    const onChange = show([option({}), effort()]);
    const trigger = screen.getByRole("button", { name: "Model settings" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const row = await screen.findByRole("menuitem", { name: /^Model:/ });
    fireEvent.keyDown(row, { key: "ArrowRight" });
    const choice = await screen.findByRole("menuitemradio", { name: "Claude Haiku 4.5" });
    fireEvent.keyDown(choice, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("model", "haiku");
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).not.toBe("true"));
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /^Model:/ }), {
      key: "Escape",
    });
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).not.toBe("true"));
  });
});
