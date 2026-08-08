import { describe, expect, it } from "vitest";
import { nativePickerCommand, parsePickerResult } from "./pick-folder.js";

describe("nativePickerCommand", () => {
  it("uses AppleScript on macOS", () => {
    const command = nativePickerCommand("darwin", "/Users/me");
    expect(command?.file).toBe("osascript");
  });

  it("uses PowerShell on Windows", () => {
    const command = nativePickerCommand("win32", "C:\\Users\\me");
    expect(command?.file).toMatch(/powershell/i);
  });

  it("reports no picker on a platform without a standard one", () => {
    // A headless server has no dialog to show. Saying so lets the page keep
    // its typed-path fallback instead of hanging on a command that cannot run.
    expect(nativePickerCommand("linux", "/home/me")).toBeUndefined();
  });

  it("passes the starting folder as an argument, never as script text", () => {
    // The whole point: a folder named `"; rm -rf ~` must arrive as data. If it
    // were interpolated into the script source it would be executed instead,
    // so the script text is what has to stay clean.
    const hostile = '/tmp/"; do shell script "rm -rf ~"; --';
    const command = nativePickerCommand("darwin", hostile);
    const script = command!.args[command!.args.indexOf("-e") + 1]!;
    expect(script).not.toContain("rm -rf");
    expect(command!.args).toContain(hostile);
  });

  it("hands Windows the starting folder out of band, not inside the script", () => {
    const hostile = 'C:\\tmp"; Remove-Item C:\\ -Recurse; #';
    const command = nativePickerCommand("win32", hostile);
    const script = command!.args[command!.args.indexOf("-Command") + 1]!;
    expect(script).not.toContain("Remove-Item");
    expect(command!.env?.FLEET_PICKER_START).toBe(hostile);
  });
});

describe("parsePickerResult", () => {
  it("reads the chosen folder", () => {
    expect(parsePickerResult(0, "/Users/me/project\n")).toEqual({
      ok: true,
      path: "/Users/me/project",
    });
  });

  it("treats an empty selection as a cancel, not a failure", () => {
    // Windows reports a dismissed dialog with empty output and a zero exit.
    // Surfacing that as an error would show a scary message for the ordinary
    // act of changing your mind.
    expect(parsePickerResult(0, "  \n")).toEqual({ ok: false, canceled: true });
  });

  it("treats the macOS cancel exit code as a cancel", () => {
    expect(parsePickerResult(1, "")).toEqual({ ok: false, canceled: true });
  });

  it("reports a real failure with its exit code", () => {
    const result = parsePickerResult(127, "");
    expect(result.ok).toBe(false);
    if (result.ok || result.canceled) throw new Error("expected a failure");
    expect(result.reason).toContain("127");
  });
});
