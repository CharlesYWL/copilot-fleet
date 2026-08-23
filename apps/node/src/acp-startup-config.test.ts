import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { resolveConfigValue } from "./agents.js";

const modeOption = (): acp.SessionConfigOption =>
  ({
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "https://agentclientprotocol.com/protocol/session-modes#agent",
    options: [
      {
        value: "https://agentclientprotocol.com/protocol/session-modes#agent",
        name: "Agent",
      },
      {
        value: "https://agentclientprotocol.com/protocol/session-modes#plan",
        name: "Plan",
      },
    ],
  }) as unknown as acp.SessionConfigOption;

const modelOption = (): acp.SessionConfigOption =>
  ({
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "claude-sonnet-5",
    options: [
      { value: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { value: "claude-opus-5", name: "Claude Opus 5" },
    ],
  }) as unknown as acp.SessionConfigOption;

describe("resolving what the Host asked for", () => {
  it("finds a mode by the fragment of its URL", () => {
    /*
     * The reason this function exists. Copilot spells agent mode as an ACP URL,
     * and the Host cannot name it that way without pinning a fleet setting to a
     * protocol neither side owns.
     */
    expect(resolveConfigValue(modeOption(), "agent")).toBe(
      "https://agentclientprotocol.com/protocol/session-modes#agent",
    );
    expect(resolveConfigValue(modeOption(), "plan")).toBe(
      "https://agentclientprotocol.com/protocol/session-modes#plan",
    );
  });

  it("takes an exact value, which is how models arrive", () => {
    expect(resolveConfigValue(modelOption(), "claude-opus-5")).toBe("claude-opus-5");
  });

  it("takes the display name, since that is what a person copied", () => {
    expect(resolveConfigValue(modelOption(), "Claude Opus 5")).toBe("claude-opus-5");
  });

  it("ignores case, because these travel through a settings box", () => {
    expect(resolveConfigValue(modeOption(), "AGENT")).toBe(
      "https://agentclientprotocol.com/protocol/session-modes#agent",
    );
  });

  it("refuses to guess at a value it cannot find", () => {
    // A wrong setting applied silently is worse than a default left in place:
    // the session runs, and nothing says it is not what was asked for.
    expect(resolveConfigValue(modelOption(), "gpt-9")).toBeUndefined();
    expect(resolveConfigValue(modelOption(), "")).toBeUndefined();
  });

  it("handles a boolean option, which carries no list of its own", () => {
    const flag = {
      id: "verbose",
      name: "Verbose",
      type: "boolean",
      currentValue: false,
    } as unknown as acp.SessionConfigOption;

    expect(resolveConfigValue(flag, "true")).toBe("true");
    expect(resolveConfigValue(flag, "On")).toBe("true");
    expect(resolveConfigValue(flag, "maybe")).toBeUndefined();
  });
});
