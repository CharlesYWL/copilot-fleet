import { describe, expect, it } from "vitest";
import { copilotLaunchArgs, isYoloEnabled } from "./agents.js";

describe("isYoloEnabled", () => {
  it("is off by default", () => {
    expect(isYoloEnabled({})).toBe(false);
  });

  it("accepts FLEET_YOLO, FLEET_ALLOW_ALL, and the legacy tools flag", () => {
    expect(isYoloEnabled({ FLEET_YOLO: "1" })).toBe(true);
    expect(isYoloEnabled({ FLEET_ALLOW_ALL: "1" })).toBe(true);
    expect(isYoloEnabled({ FLEET_ALLOW_ALL_TOOLS: "1" })).toBe(true);
  });
});

describe("copilotLaunchArgs", () => {
  it("starts ACP over stdio", () => {
    expect(copilotLaunchArgs({})).toEqual(["--acp", "--stdio"]);
  });

  it("adds Copilot's yolo flag when enabled", () => {
    expect(copilotLaunchArgs({ FLEET_YOLO: "1" })).toEqual([
      "--acp",
      "--stdio",
      "--allow-all",
    ]);
  });
});
