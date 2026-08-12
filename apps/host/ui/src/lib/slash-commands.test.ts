import { describe, expect, it } from "vitest";
import type { SessionCommand } from "@fleet/protocol";
import { applyCommand, matchCommands, moveHighlight, slashQuery } from "./slash-commands";

const commands: SessionCommand[] = [
  { name: "model", description: "Select AI model to use", hint: "model" },
  { name: "modern-web-design", description: "Design sites", hint: "instructions" },
  { name: "usage", description: "Display session usage metrics" },
  { name: "compact", description: "Compact the thread", hint: "focus instructions" },
];

describe("slashQuery", () => {
  it("opens on a bare slash and narrows as the name is typed", () => {
    expect(slashQuery("/")).toEqual({ open: true, term: "" });
    expect(slashQuery("/mod")).toEqual({ open: true, term: "mod" });
  });

  it("closes once an argument is being typed", () => {
    // `/model claude-haiku-4.5` is a command with an argument; the operator has
    // stopped choosing a command and a menu over the box is in the way.
    expect(slashQuery("/model claude").open).toBe(false);
    expect(slashQuery("/model ").open).toBe(false);
  });

  it("ignores text that only mentions a slash", () => {
    expect(slashQuery("fix /model handling").open).toBe(false);
    expect(slashQuery(" /model").open).toBe(false);
    expect(slashQuery("").open).toBe(false);
  });
});

describe("matchCommands", () => {
  it("puts prefix matches ahead of substring matches", () => {
    // "compact" contains "pac"; "modern-web-design" does not contain "model",
    // so the pair that proves the ordering has to actually overlap.
    expect(matchCommands(commands, "mod").map((c) => c.name)).toEqual([
      "model",
      "modern-web-design",
    ]);
    expect(matchCommands(commands, "a").map((c) => c.name)).toEqual(["usage", "compact"]);
  });

  it("returns everything for an empty term, in the agent's own order", () => {
    expect(matchCommands(commands, "").map((c) => c.name)).toEqual([
      "model",
      "modern-web-design",
      "usage",
      "compact",
    ]);
  });

  it("matches case-insensitively and honours the limit", () => {
    expect(matchCommands(commands, "USA").map((c) => c.name)).toEqual(["usage"]);
    expect(matchCommands(commands, "", 2)).toHaveLength(2);
  });

  it("finds nothing for a term no command contains", () => {
    expect(matchCommands(commands, "zzz")).toEqual([]);
  });
});

describe("applyCommand", () => {
  it("waits for an argument when the command takes one", () => {
    expect(applyCommand(commands[0]!)).toEqual({ text: "/model ", submit: false });
  });

  it("runs immediately when the command takes none", () => {
    expect(applyCommand(commands[2]!)).toEqual({ text: "/usage", submit: true });
  });

  it("treats an empty hint as still wanting input", () => {
    // Copilot sends `hint: ""` for commands like /init, which do take text it
    // has no words for. Submitting those on selection would send them bare.
    expect(applyCommand({ name: "init", description: "", hint: "" })).toEqual({
      text: "/init ",
      submit: false,
    });
  });
});

describe("moveHighlight", () => {
  it("wraps around both ends", () => {
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, 1, 3)).toBe(1);
  });

  it("stays put when there is nothing to highlight", () => {
    expect(moveHighlight(0, 1, 0)).toBe(0);
  });
});
