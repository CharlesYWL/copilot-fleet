import { describe, expect, it } from "vitest";
import { COMMAND_LIMITS, type CommandOutputEvent } from "@fleet/protocol";
import {
  decodeCommandOutput,
  mergeCommandOutput,
  visibleCommandText,
} from "./command-output";

const event = (
  sequence: number,
  bytes: number[] | string,
  stream: "stdout" | "stderr" = "stdout",
): CommandOutputEvent => ({
  executionId: "d00c5b6e-1c21-4b5d-8f2e-c2dc1ebdbf65",
  attemptId: "e00c5b6e-1c21-4b5d-8f2e-c2dc1ebdbf65",
  sequence,
  stream,
  data: typeof bytes === "string" ? btoa(bytes) : btoa(String.fromCharCode(...bytes)),
  at: "2026-09-16T14:00:00.000Z",
});

describe("command output", () => {
  it("deduplicates replay and bounds the global live buffer independently of retention", () => {
    const first = event(1, "first");
    const second = event(2, "second");
    expect(mergeCommandOutput([first], [first, second])).toEqual([first, second]);
    expect(mergeCommandOutput([first], [second], 270)).toEqual([second]);
    expect(mergeCommandOutput([], [event(1, "a".repeat(500))], 270)).toEqual([]);
  });

  it("reassembles UTF-8 separately for stdout and stderr", () => {
    expect(
      decodeCommandOutput(
        [event(1, [0xe7]), event(2, "warning\n", "stderr"), event(3, [0x95, 0x8c])],
        true,
      ),
    ).toEqual({ text: "warning\n界", lossy: false, gap: false, truncated: false });
  });

  it("reports gaps and invalid native encoding instead of declaring a complete transcript", () => {
    const decoded = decodeCommandOutput([event(3, [0xe9])], true);
    expect(decoded.gap).toBe(true);
    expect(decoded.lossy).toBe(true);
    expect(decoded.text).toContain("[Output gap: 1-2]");
  });

  it("does not report a live incomplete UTF-8 tail as lost until the stream settles", () => {
    expect(decodeCommandOutput([event(1, [0xe7])], false).lossy).toBe(false);
    expect(decodeCommandOutput([event(1, [0xe7])], true).lossy).toBe(true);
  });

  it("makes terminal and directional controls visible without interpreting them", () => {
    expect(visibleCommandText("\x1b[31mhello\u202e\nnext")).toBe(
      "\\u001b[31mhello\\u202e\nnext",
    );
    expect(visibleCommandText("npm run build\r\nexit 7")).toBe("npm run build\r\nexit 7");
  });

  it("bounds rendered text as well as transport bytes", () => {
    const decoded = decodeCommandOutput(
      [event(1, "a".repeat(COMMAND_LIMITS.pageBytes + 10))],
      true,
    );
    expect(decoded.truncated).toBe(true);
    expect(decoded.text).toContain("omitted from display");
    expect(decoded.text.length).toBeLessThan(COMMAND_LIMITS.pageBytes + 100);
  });
});
