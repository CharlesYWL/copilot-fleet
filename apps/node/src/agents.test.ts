import { describe, expect, it } from "vitest";
import { copilotLaunchArgs } from "./agents.js";

describe("copilotLaunchArgs", () => {
  it("starts ACP over stdio", () => {
    expect(copilotLaunchArgs(false)).toEqual(["--acp", "--stdio"]);
  });

  it("adds Copilot's yolo flag when the Host asks for it", () => {
    expect(copilotLaunchArgs(true)).toEqual(["--acp", "--stdio", "--allow-all"]);
  });
});
