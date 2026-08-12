import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  configValueFor,
  toSessionCommands,
  toSessionConfigOptions,
} from "./acp-config.js";

/**
 * The fixtures below are trimmed from what `copilot --acp` actually answers, so
 * a change in its shape shows up here rather than as an empty model chooser.
 */

describe("toSessionCommands", () => {
  it("keeps the argument hint, including an empty one", () => {
    const commands = toSessionCommands([
      { name: "model", description: "Select AI model to use", input: { hint: "model" } },
      { name: "usage", description: "Display session usage metrics" },
      // Copilot sends this for /init: it takes text, it just has no word for it.
      { name: "init", description: "Set up", input: { hint: "" } },
    ] as acp.AvailableCommand[]);

    expect(commands).toEqual([
      { name: "model", description: "Select AI model to use", hint: "model" },
      { name: "usage", description: "Display session usage metrics" },
      { name: "init", description: "Set up", hint: "" },
    ]);
  });

  it("survives a command with no description", () => {
    const [command] = toSessionCommands([{ name: "bare" }] as acp.AvailableCommand[]);
    expect(command).toEqual({ name: "bare", description: "" });
  });
});

describe("toSessionConfigOptions", () => {
  it("flattens a select, keeping the current value and the category", () => {
    const options = toSessionConfigOptions([
      {
        type: "select",
        id: "model",
        name: "Model",
        description: "Which model answers",
        category: "model",
        currentValue: "claude-sonnet-5",
        options: [
          { value: "auto", name: "Auto", description: "Let Copilot pick" },
          { value: "claude-sonnet-5", name: "Claude Sonnet 5" },
        ],
      },
    ] as acp.SessionConfigOption[]);

    expect(options).toEqual([
      {
        id: "model",
        name: "Model",
        description: "Which model answers",
        category: "model",
        currentValue: "claude-sonnet-5",
        choices: [
          { value: "auto", name: "Auto", description: "Let Copilot pick" },
          { value: "claude-sonnet-5", name: "Claude Sonnet 5", description: "" },
        ],
      },
    ]);
  });

  it("folds grouped options into one addressable list", () => {
    // ACP allows either a flat list or groups; a client that only handled the
    // flat form would show an empty picker against an agent that groups.
    const [option] = toSessionConfigOptions([
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "fast-1",
        options: [
          {
            group: "fast",
            name: "Fast",
            options: [{ value: "fast-1", name: "Fast One" }],
          },
          {
            group: "deep",
            name: "Deep",
            options: [{ value: "deep-1", name: "Deep One" }],
          },
        ],
      },
    ] as acp.SessionConfigOption[]);

    expect(option?.choices.map((choice) => choice.value)).toEqual(["fast-1", "deep-1"]);
  });

  it("gives a boolean the two choices it has and stringifies its value", () => {
    const [option] = toSessionConfigOptions([
      { type: "boolean", id: "allow_all", name: "Allow All", currentValue: true },
    ] as acp.SessionConfigOption[]);

    expect(option?.currentValue).toBe("true");
    expect(option?.choices.map((choice) => choice.value)).toEqual(["true", "false"]);
  });
});

describe("configValueFor", () => {
  const options = [
    { type: "boolean", id: "allow_all", name: "Allow All", currentValue: false },
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "auto",
      options: [{ value: "auto", name: "Auto" }],
    },
  ] as acp.SessionConfigOption[];

  it("sends a real boolean for a boolean option", () => {
    // The agent rejects the string "true" here, and the client only has strings.
    expect(configValueFor(options, "allow_all", "true")).toBe(true);
    expect(configValueFor(options, "allow_all", "false")).toBe(false);
  });

  it("leaves a select value as text", () => {
    expect(configValueFor(options, "model", "auto")).toBe("auto");
  });

  it("passes an unknown option through for the agent to reject", () => {
    expect(configValueFor(options, "mystery", "true")).toBe("true");
  });
});
