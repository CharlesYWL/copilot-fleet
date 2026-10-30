import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../theme";
import type { SettingsSearchEntry } from "../lib/settings-search";
import { SettingsSearch } from "./SettingsSearch";

const entries: SettingsSearchEntry[] = [
  { id: "general", kind: "section", tab: "general", title: "General", keywords: [] },
  {
    id: "general.yolo",
    kind: "setting",
    tab: "general",
    title: "YOLO mode",
    keywords: ["--allow-all"],
  },
  {
    id: "general.long-context",
    kind: "setting",
    tab: "general",
    title: "Long context by default",
    keywords: [],
  },
  {
    id: "general.model",
    kind: "setting",
    tab: "general",
    title: "Default Copilot model",
    keywords: [],
  },
  {
    id: "orchestrator.agent",
    kind: "setting",
    tab: "orchestrator",
    title: "Preferred agent",
    keywords: [],
  },
  { id: "node:n1", kind: "node", tab: "nodes", title: "WEILI-PC", keywords: [] },
];

const show = (
  overrides: Partial<Parameters<typeof SettingsSearch>[0]> = {},
  onSelect = vi.fn(),
) => {
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <SettingsSearch entries={entries} onSelect={onSelect} {...overrides} />
    </FluentProvider>,
  );
  return onSelect;
};

const box = () =>
  screen.getByRole<HTMLInputElement>("combobox", { name: "Search settings" });
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const key = (name: string) => fireEvent.keyDown(box(), { key: name });
const list = () => screen.queryByRole("listbox", { name: "Settings search results" });
const options = () => within(list()!).getAllByRole("option");
const active = () =>
  screen.getByRole("option", { selected: true }).textContent?.replace(/\s+/g, " ");

afterEach(() => vi.restoreAllMocks());

describe("SettingsSearch", () => {
  it("shows no list until something is typed", () => {
    show();
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(list()).toBeNull();
  });

  it("lists each match as its section and setting, with the match marked", () => {
    show();
    type("def");

    expect(box().getAttribute("aria-expanded")).toBe("true");
    const rows = options();
    expect(rows.map((row) => row.textContent)).toEqual([
      "GeneralDefault Copilot model",
      "GeneralLong context by default",
    ]);
    expect(
      [...rows[0]!.querySelectorAll("mark")].map((mark) => mark.textContent),
    ).toEqual(["Def"]);
    expect(rows[0]!.getAttribute("aria-label")).toBe("Default Copilot model, General");
  });

  it("names a section result as the page itself", () => {
    show();
    type("general");
    expect(options()[0]!.getAttribute("aria-label")).toBe("General settings page");
  });

  it("names a node or a workspace by what it is", () => {
    show();
    type("weili");
    expect(options()[0]!.getAttribute("aria-label")).toBe("WEILI-PC, node in Nodes");
  });

  it("highlights the first result and moves with the arrow keys, wrapping at the ends", () => {
    show();
    type("def");
    expect(active()).toBe("GeneralDefault Copilot model");
    expect(box().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);

    key("ArrowDown");
    expect(active()).toBe("GeneralLong context by default");
    key("ArrowDown");
    expect(active()).toBe("GeneralDefault Copilot model");
    key("ArrowUp");
    expect(active()).toBe("GeneralLong context by default");
    expect(box().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
  });

  it("opens the highlighted result with Enter, then clears and closes", () => {
    const onSelect = show();
    type("def");
    key("ArrowDown");
    key("Enter");

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(entries[2]);
    expect(box().value).toBe("");
    expect(list()).toBeNull();
  });

  it("opens a result with the mouse", () => {
    const onSelect = show();
    type("yolo");
    fireEvent.click(screen.getByRole("option", { name: "YOLO mode, General" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(entries[1]);
  });

  it("follows the pointer without moving focus out of the box", () => {
    show();
    type("def");
    fireEvent.mouseMove(options()[1]!);
    expect(active()).toBe("GeneralLong context by default");
  });

  it("keeps focus in the box when a result is pressed", () => {
    show();
    type("def");
    const pressed = fireEvent.mouseDown(options()[0]!);
    expect(pressed).toBe(false);
  });

  it("closes on the first Escape and clears on the second", () => {
    show();
    type("def");
    key("Escape");
    expect(list()).toBeNull();
    expect(box().value).toBe("def");

    key("ArrowDown");
    expect(list()).toBeTruthy();
    key("Escape");
    key("Escape");
    expect(box().value).toBe("");
  });

  it("says when nothing matches, and that is not an option to pick", () => {
    const onSelect = show();
    type("zzz");
    expect(screen.getByText("No settings match “zzz”.")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    key("Enter");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("announces how many results there are", () => {
    show();
    type("def");
    expect(screen.getByRole("status").textContent).toBe("2 results");
    type("yolo");
    expect(screen.getByRole("status").textContent).toBe("1 result");
    type("zzz");
    expect(screen.getByRole("status").textContent).toBe("No results");
  });

  it("closes when focus leaves the search, and reopens on the way back", () => {
    show();
    type("def");
    fireEvent.blur(box(), { relatedTarget: document.body });
    expect(list()).toBeNull();
    fireEvent.focus(box());
    expect(list()).toBeTruthy();
  });

  it("leaves out results the page says are not available here", () => {
    show({ isAvailable: (entry) => entry.id !== "general.model" });
    type("def");
    expect(options().map((row) => row.textContent)).toEqual([
      "GeneralLong context by default",
    ]);
  });
});
