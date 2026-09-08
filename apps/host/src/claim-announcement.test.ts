import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceClaimCode, copyClaimCode } from "./claim-announcement.js";

const clipboard = vi.hoisted(() => ({
  execFile: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: clipboard.execFile }));
vi.unmock("./claim-announcement.js");

describe("claim announcement", () => {
  it.each([
    [true, "http://localhost:5173"],
    [false, "https://fleet.example"],
  ])("uses the browser URL (development=%s)", async (development, expectedUrl) => {
    const write = vi.fn();
    const copy = vi.fn().mockResolvedValue(true);
    await announceClaimCode("test-claim-code", {
      development,
      publicUrl: "https://fleet.example",
      write,
      copy,
    });
    expect(write.mock.calls[0]?.[0]).toContain(`Claim it at ${expectedUrl}`);
    expect(write.mock.calls[0]?.[0]).toContain("test-claim-code");
    expect(write.mock.calls[0]?.[0]).toContain("expires in 30 minutes");
    expect(copy).toHaveBeenCalledWith("test-claim-code");
    expect(write.mock.calls[1]?.[0]).toContain("copied to clipboard");
    expect(write.mock.calls[0]?.[0]).not.toContain(`${expectedUrl}?`);
  });

  it.each(["unavailable", "throws"])(
    "offers manual copying when clipboard %s",
    async (failure) => {
      const write = vi.fn();
      const copy = vi.fn().mockImplementation(async () => {
        if (failure === "throws") throw new Error("clipboard failed");
        return false;
      });
      await announceClaimCode("test-claim-code", {
        development: false,
        publicUrl: "http://127.0.0.1:8787",
        write,
        copy,
      });
      expect(write.mock.calls[0]?.[0]).toContain("http://127.0.0.1:8787");
      expect(write.mock.calls[1]?.[0]).toContain("Copy the claim code above manually");
      expect(write.mock.calls.flat().join("")).not.toContain("copied to clipboard");
    },
  );

  it("prints the code without waiting for the clipboard", async () => {
    const write = vi.fn();
    let finish!: (copied: boolean) => void;
    const announcement = announceClaimCode("test-claim-code", {
      development: true,
      publicUrl: "http://127.0.0.1:8787",
      write,
      copy: () => new Promise((resolve) => (finish = resolve)),
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toContain("test-claim-code");
    finish(false);
    await announcement;
  });
});

describe("local clipboard", () => {
  let stdin: PassThrough;
  let complete: (error: Error | null) => void;

  beforeEach(() => {
    clipboard.execFile.mockImplementation(
      (_command, _args, _options, callback: typeof complete) => {
        stdin = new PassThrough();
        complete = callback;
        return { stdin };
      },
    );
  });

  afterEach(() => vi.clearAllMocks());

  it.each([
    ["win32", {}, "clip.exe", []],
    ["darwin", {}, "pbcopy", []],
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, "wl-copy", []],
    ["linux", { DISPLAY: ":0" }, "xclip", ["-selection", "clipboard"]],
  ] as const)("copies on %s using %s", async (platform, env, command, args) => {
    const result = copyClaimCode("test-claim-code", platform, env);
    expect(clipboard.execFile).toHaveBeenCalledWith(
      command,
      args,
      { timeout: 2_000, windowsHide: true },
      expect.any(Function),
    );
    expect(stdin.read().toString()).toBe("test-claim-code");
    complete(null);
    await expect(result).resolves.toBe(true);
  });

  it.each(["linux", "freebsd"] as const)(
    "skips headless or unsupported %s",
    async (platform) => {
      await expect(copyClaimCode("test-claim-code", platform, {})).resolves.toBe(false);
      expect(clipboard.execFile).not.toHaveBeenCalled();
    },
  );

  it.each(["ENOENT", "nonzero exit", "timeout"])(
    "falls back to X11 when Wayland fails with %s",
    async (message) => {
      const result = copyClaimCode("test-claim-code", "linux", {
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
      });
      expect(clipboard.execFile.mock.calls[0]?.[0]).toBe("wl-copy");
      complete(new Error(message));
      await vi.waitFor(() => expect(clipboard.execFile).toHaveBeenCalledTimes(2));
      expect(clipboard.execFile.mock.calls[1]?.slice(0, 3)).toEqual([
        "xclip",
        ["-selection", "clipboard"],
        { timeout: 2_000, windowsHide: true },
      ]);
      expect(stdin.read().toString()).toBe("test-claim-code");
      complete(null);
      await expect(result).resolves.toBe(true);
    },
  );

  it("stops after a successful Wayland copy", async () => {
    const result = copyClaimCode("test-claim-code", "linux", {
      WAYLAND_DISPLAY: "wayland-0",
      DISPLAY: ":0",
    });
    complete(null);
    await expect(result).resolves.toBe(true);
    expect(clipboard.execFile).toHaveBeenCalledOnce();
  });

  it("returns false after all eligible backends fail", async () => {
    const result = copyClaimCode("test-claim-code", "linux", {
      WAYLAND_DISPLAY: "wayland-0",
      DISPLAY: ":0",
    });
    complete(new Error("ENOENT"));
    await vi.waitFor(() => expect(clipboard.execFile).toHaveBeenCalledTimes(2));
    complete(new Error("ENOENT"));
    await expect(result).resolves.toBe(false);
  });

  it.each(["ENOENT", "timeout", "nonzero exit"])(
    "handles %s without failing startup",
    async (message) => {
      const result = copyClaimCode("test-claim-code", "win32", {});
      complete(new Error(message));
      await expect(result).resolves.toBe(false);
    },
  );

  it("handles a clipboard process closing stdin early", async () => {
    const result = copyClaimCode("test-claim-code", "win32", {});
    stdin.emit("error", new Error("EPIPE"));
    complete(null);
    await expect(result).resolves.toBe(false);
  });
});
