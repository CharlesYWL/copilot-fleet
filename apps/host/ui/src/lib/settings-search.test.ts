import { describe, expect, it } from "vitest";
import type { FleetNode, Workspace } from "@fleet/protocol";
import {
  buildSettingsIndex,
  isSettingAvailable,
  searchSettings,
  settingsSections,
  staticSettingEntries,
  type SettingsSearchEntry,
} from "./settings-search";

const node = (id: string, name: string): FleetNode => ({ id, name }) as FleetNode;
const workspace = (
  id: string,
  name: string,
  kind: Workspace["kind"] = "project",
  description = "",
) => ({ id, name, kind, description }) as Workspace;

const index = buildSettingsIndex({
  nodes: [node("n1", "WEILI-PC"), node("n2", "build-box")],
  workspaces: [
    workspace("chats", "Chats", "chats"),
    workspace("w1", "checkout-service", "project", "Payments API and its workers"),
  ],
});

const titles = (query: string, entries: readonly SettingsSearchEntry[] = index) =>
  searchSettings(entries, query).map((entry) => entry.title);
const ids = (query: string) => searchSettings(index, query).map((entry) => entry.id);

describe("buildSettingsIndex", () => {
  it("indexes every section page, so a tab can be found by its name", () => {
    for (const section of settingsSections) {
      expect(index).toContainEqual(
        expect.objectContaining({
          kind: "section",
          tab: section.value,
          title: section.label,
        }),
      );
    }
  });

  it("gives every entry a unique id, which is also its scroll target", () => {
    const all = index.map((entry) => entry.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("files every static setting under a real section", () => {
    const tabs = new Set(settingsSections.map((section) => section.value));
    for (const entry of staticSettingEntries) expect(tabs.has(entry.tab)).toBe(true);
  });

  it("lists each node by name, under Nodes", () => {
    expect(index).toContainEqual(
      expect.objectContaining({
        id: "node:n1",
        kind: "node",
        tab: "nodes",
        title: "WEILI-PC",
      }),
    );
  });

  it("lists each workspace by name, under Workspaces", () => {
    expect(index).toContainEqual(
      expect.objectContaining({
        id: "workspace:w1",
        kind: "workspace",
        tab: "workspaces",
        title: "checkout-service",
      }),
    );
    expect(index).toContainEqual(
      expect.objectContaining({ id: "workspace:chats", title: "Chats" }),
    );
  });

  it("lists each remote access provider under Tunnel", () => {
    expect(index).toContainEqual(
      expect.objectContaining({ id: "tunnel.provider.devtunnel", title: "Dev Tunnels" }),
    );
  });
});

describe("searchSettings", () => {
  it("returns nothing for an empty query", () => {
    expect(searchSettings(index, "")).toEqual([]);
    expect(searchSettings(index, "   ")).toEqual([]);
  });

  it("finds a setting by a word in its title", () => {
    expect(titles("yolo")).toContain("YOLO mode");
  });

  it("finds a setting by a keyword that is not in its title", () => {
    expect(titles("--allow-all")).toEqual(["YOLO mode"]);
    expect(titles("cron")).toContain("Orchestrator heartbeat");
  });

  it("puts a title that starts with the query ahead of one that only contains it", () => {
    const found = titles("default");
    expect(found.indexOf("Default Copilot model")).toBeLessThan(
      found.indexOf("Long context by default"),
    );
  });

  it("ranks title matches ahead of keyword-only matches", () => {
    const found = titles("tunnel");
    expect(found[0]).toBe("Tunnel");
    expect(found.indexOf("Dev Tunnels")).toBeLessThan(found.indexOf("Cloudflare"));
  });

  it("treats the start of any word in a title as a strong match", () => {
    expect(titles("private")[0]).toBe("Corp direct (private IP)");
  });

  it("needs every word, anywhere in the title, section or keywords", () => {
    expect(ids("orchestrator model")).toEqual(
      expect.arrayContaining(["orchestrator.model.copilot", "orchestrator.model.hermes"]),
    );
    expect(ids("orchestrator model")).not.toContain("general.model");
  });

  it("matches the section name, so a section narrows its own settings", () => {
    const found = searchSettings(index, "security password");
    expect(found[0]?.title).toBe("Password sign-in");
    expect(found.every((entry) => entry.tab === "security")).toBe(true);
  });

  it("finds live nodes and workspaces by name", () => {
    expect(titles("weili")).toEqual(["WEILI-PC"]);
    expect(titles("checkout")[0]).toBe("checkout-service");
  });

  it("finds a workspace by its description", () => {
    expect(ids("payments api")).toEqual(["workspace:w1"]);
  });

  it("keeps index order between results that rank the same", () => {
    const entries: SettingsSearchEntry[] = [
      { id: "a", kind: "setting", tab: "general", title: "Alpha lint", keywords: [] },
      { id: "b", kind: "setting", tab: "general", title: "Beta lint", keywords: [] },
      { id: "c", kind: "setting", tab: "general", title: "Gamma lint", keywords: [] },
    ];
    expect(titles("lint", entries)).toEqual(["Alpha lint", "Beta lint", "Gamma lint"]);
  });

  it("caps the list so a one-letter query stays readable", () => {
    expect(searchSettings(index, "e").length).toBeLessThanOrEqual(50);
  });
});

describe("isSettingAvailable", () => {
  const page = (tab: string, ...anchors: string[]) => {
    const root = document.createElement("div");
    const element = document.createElement("div");
    element.setAttribute("data-settings-page", tab);
    for (const id of anchors) {
      const anchor = document.createElement("section");
      anchor.setAttribute("data-setting-id", id);
      element.append(anchor);
    }
    root.append(element);
    return root;
  };
  const agency = staticSettingEntries.find((entry) => entry.id === "general.agency")!;
  const yolo = staticSettingEntries.find((entry) => entry.id === "general.yolo")!;

  it("offers a conditional setting until its page has loaded", () => {
    expect(isSettingAvailable(document.createElement("div"), agency)).toBe(true);
    expect(isSettingAvailable(page("general"), agency)).toBe(true);
  });

  it("withholds a conditional setting its loaded page does not show", () => {
    expect(isSettingAvailable(page("general", "general"), agency)).toBe(false);
    expect(isSettingAvailable(page("general", "general", "general.agency"), agency)).toBe(
      true,
    );
  });

  it("always offers a setting every Host shows", () => {
    expect(isSettingAvailable(page("general", "general"), yolo)).toBe(true);
  });
});
