import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@fleet/protocol";
import { visibleConfigOptions } from "./session-config";

const option = (values: Partial<SessionConfigOption>): SessionConfigOption => ({
  id: "model",
  name: "Model",
  description: "",
  category: "model",
  currentValue: "a",
  choices: [
    { value: "a", name: "A", description: "" },
    { value: "b", name: "B", description: "" },
  ],
  ...values,
});

describe("visibleConfigOptions", () => {
  it("hides the permission picker the fleet already owns", () => {
    // The session was launched with or without --allow-all and wears a YOLO
    // badge saying so; a second control for the same fact can only disagree.
    const options = [
      option({}),
      option({ id: "allow_all", name: "Allow All", category: "permissions" }),
    ];
    expect(visibleConfigOptions(options).map((entry) => entry.id)).toEqual(["model"]);
  });

  it("hides a permission picker whose id this build has not seen", () => {
    expect(
      visibleConfigOptions([
        option({ id: "future_permission", category: "permissions" }),
      ]),
    ).toEqual([]);
  });

  it("hides allow_all even if it arrives without a category", () => {
    expect(visibleConfigOptions([option({ id: "allow_all", category: "" })])).toEqual([]);
  });

  it("keeps mode, which yolo does not decide", () => {
    // A session started with --allow-all still reports mode "agent", so this is
    // the only way to reach Plan or Autopilot and is not redundant with YOLO.
    const options = [option({ id: "mode", name: "Mode", category: "mode" })];
    expect(visibleConfigOptions(options).map((entry) => entry.id)).toEqual(["mode"]);
  });

  it("drops an option with nothing to choose between", () => {
    expect(visibleConfigOptions([option({ choices: [] })])).toEqual([]);
    expect(
      visibleConfigOptions([
        option({ choices: [{ value: "only", name: "Only", description: "" }] }),
      ]),
    ).toEqual([]);
  });

  it("keeps the agent's own order for what remains", () => {
    const options = [
      option({ id: "mode", category: "mode" }),
      option({ id: "allow_all", category: "permissions" }),
      option({ id: "model", category: "model" }),
      option({ id: "reasoning_effort", category: "thought_level" }),
    ];
    expect(visibleConfigOptions(options).map((entry) => entry.id)).toEqual([
      "mode",
      "model",
      "reasoning_effort",
    ]);
  });
});
