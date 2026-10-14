import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  applyStartupConfig,
  resolveConfigValue,
  rolloverStartupConfig,
} from "./agents.js";

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

  function configurationHarness() {
    let options: acp.SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "native",
        options: ["native", "default", "routed"].map((value) => ({ value, name: value })),
      },
      {
        id: "reasoning_effort",
        name: "Reasoning",
        type: "select",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
        ],
      },
    ];
    const order: string[] = [];
    const handle = {
      options: () => options,
      notice: vi.fn(),
      assertActive: () => {},
      setConfigOption: vi.fn(async (id: string, value: string) => {
        order.push(`${id}:${value}`);
        options = options.map((option) =>
          option.id === id && option.type === "select"
            ? { ...option, currentValue: value }
            : option,
        );
        if (id === "model") {
          options = options.filter((option) => option.id !== "reasoning_effort");
          options.push({
            id: "reasoning_effort",
            name: "Reasoning",
            type: "select",
            currentValue: "low",
            options:
              value === "routed"
                ? [
                    { value: "low", name: "Low" },
                    { value: "high", name: "High" },
                  ]
                : [
                    { value: "low", name: "Low" },
                    { value: "medium", name: "Medium" },
                  ],
          });
        }
      }),
    };
    return { handle, order };
  }

  describe("profile startup and ordinary-default fallback", () => {
    it("sets model before effort using the refreshed model-specific catalog", async () => {
      const { handle, order } = configurationHarness();
      expect(
        await applyStartupConfig(handle, [
          { id: "model", value: "routed", fallback: "default" },
          { id: "reasoning_effort", value: "high", fallback: "medium" },
        ]),
      ).toBe(false);
      order.push("prompt");
      expect(order).toEqual(["model:routed", "reasoning_effort:high", "prompt"]);
      expect(
        handle.options().find((option) => option.id === "reasoning_effort")?.currentValue,
      ).toBe("high");
    });

    it("falls back as a pair when the model is missing, never applying routed effort", async () => {
      const { handle, order } = configurationHarness();
      expect(
        await applyStartupConfig(handle, [
          { id: "model", value: "missing", fallback: "default" },
          { id: "reasoning_effort", value: "high", fallback: "medium" },
        ]),
      ).toBe(true);
      order.push("prompt");
      expect(order).toEqual(["model:default", "reasoning_effort:medium", "prompt"]);
      expect(handle.notice).toHaveBeenCalledWith(
        expect.stringContaining("Using Fleet worker defaults"),
      );
    });

    it("uses the native default when Fleet has not chosen a default model", async () => {
      const { handle, order } = configurationHarness();
      expect(
        await applyStartupConfig(handle, [
          { id: "model", value: "missing", fallback: "" },
          { id: "reasoning_effort", value: "high", fallback: "medium" },
        ]),
      ).toBe(true);
      expect(order).toEqual(["reasoning_effort:medium"]);
      expect(handle.options().find((option) => option.id === "model")?.currentValue).toBe(
        "native",
      );
    });

    it("restores the native default when the configured default is also unavailable", async () => {
      const { handle, order } = configurationHarness();
      expect(
        await applyStartupConfig(handle, [
          { id: "model", value: "routed", fallback: "missing-default" },
          { id: "reasoning_effort", value: "unsupported-effort", fallback: "medium" },
        ]),
      ).toBe(true);
      expect(order).toEqual(["model:routed", "model:native", "reasoning_effort:medium"]);
    });

    it("falls back on a rejected model change and on an unsupported effort", async () => {
      const rejected = configurationHarness();
      rejected.handle.setConfigOption.mockRejectedValueOnce(
        new Error("ACP refused this model"),
      );
      expect(
        await applyStartupConfig(rejected.handle, [
          { id: "model", value: "routed", fallback: "default" },
          { id: "reasoning_effort", value: "high", fallback: "medium" },
        ]),
      ).toBe(true);
      expect(rejected.order).toEqual(["model:default", "reasoning_effort:medium"]);
      const unsupported = configurationHarness();
      expect(
        await applyStartupConfig(unsupported.handle, [
          { id: "model", value: "routed", fallback: "default" },
          { id: "reasoning_effort", value: "High", fallback: "medium" },
        ]),
      ).toBe(true);
      expect(unsupported.order).toEqual([
        "model:routed",
        "model:default",
        "reasoning_effort:medium",
      ]);
    });

    it("captures no-effort-override profiles without inheriting Fleet's global effort", async () => {
      const { handle, order } = configurationHarness();
      expect(
        await applyStartupConfig(handle, [
          { id: "model", value: "routed", fallback: "default" },
          { id: "reasoning_effort", value: "", fallback: "medium" },
        ]),
      ).toBe(false);
      expect(order).toEqual(["model:routed"]);
    });

    it("keeps legacy startup best-effort without trying another model", async () => {
      const { handle, order } = configurationHarness();
      expect(
        await applyStartupConfig(handle, [
          { id: "model", value: "missing" },
          { id: "reasoning_effort", value: "medium" },
        ]),
      ).toBe(false);
      expect(order).toEqual(["reasoning_effort:medium"]);
      expect(handle.notice).toHaveBeenCalled();
    });

    it("uses the current pair rather than launch-time settings on context rollover", () => {
      const { handle } = configurationHarness();
      expect(
        rolloverStartupConfig(
          [
            { id: "mode", value: "agent" },
            { id: "model", value: "routed", fallback: "default" },
            { id: "reasoning_effort", value: "high", fallback: "medium" },
          ],
          handle.options(),
        ),
      ).toEqual([
        { id: "mode", value: "agent" },
        { id: "model", value: "native" },
        { id: "reasoning_effort", value: "low" },
      ]);
      expect(
        rolloverStartupConfig(
          [
            { id: "model", value: "routed" },
            { id: "reasoning_effort", value: "high" },
          ],
          [handle.options()[0]!],
        ),
      ).toEqual([{ id: "model", value: "native" }]);
    });
  });

  it("takes an exact value, which is how models arrive", () => {
    expect(resolveConfigValue(modelOption(), "claude-opus-5")).toBe("claude-opus-5");
  });

  it.each(["Claude Opus 5", "CLAUDE-OPUS-5", " claude-opus-5 "])(
    "does not reinterpret a backend model ID as a name or normalized alias: %s",
    (value) => {
      expect(resolveConfigValue(modelOption(), value)).toBeUndefined();
    },
  );

  it("keeps provider-prefixed IDs even when names and URL fragments match", () => {
    const option: acp.SessionConfigOption = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "provider-a#claude-opus-5",
      options: [
        { value: "provider-a#claude-opus-5", name: "Claude Opus 5" },
        { value: "provider-b/claude-opus-5", name: "Claude Opus 5" },
      ],
    };
    expect(resolveConfigValue(option, "claude-opus-5")).toBeUndefined();
    expect(resolveConfigValue(option, "Claude Opus 5")).toBeUndefined();
    expect(resolveConfigValue(option, "provider-b/claude-opus-5")).toBe(
      "provider-b/claude-opus-5",
    );
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
