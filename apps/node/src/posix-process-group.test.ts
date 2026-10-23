import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  processGroupAlive,
  stopProcessGroup,
  waitForGroupExit,
} from "./posix-process-group.js";

const error = (code: string) => Object.assign(new Error(code), { code });

describe("POSIX process-group ownership (unit)", () => {
  it("treats ESRCH as empty and EPERM as a live member", () => {
    expect(
      processGroupAlive(5, () => {
        throw error("ESRCH");
      }),
    ).toBe(false);
    expect(
      processGroupAlive(5, () => {
        throw error("EPERM");
      }),
    ).toBe(true);
    expect(processGroupAlive(5, () => true)).toBe(true);
  });

  it("probes the group, never the leader alone", () => {
    const calls: Array<[number, NodeJS.Signals | 0]> = [];
    processGroupAlive(42, (pid, signal) => {
      calls.push([pid, signal]);
      return true;
    });
    expect(calls).toEqual([[-42, 0]]);
  });

  it("sends SIGTERM, then SIGKILL, and reports unverifiable groups", async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    const stubborn = (_pid: number, signal: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    };
    await expect(
      stopProcessGroup(7, { graceMs: 30, verifyMs: 30, kill: stubborn }),
    ).resolves.toBe(false);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(signals.indexOf("SIGTERM")).toBeLessThan(signals.indexOf("SIGKILL"));
  });

  it("stops at SIGTERM when the group leaves during the grace period", async () => {
    let alive = true;
    const signals: Array<NodeJS.Signals | 0> = [];
    const polite = (_pid: number, signal: NodeJS.Signals | 0) => {
      signals.push(signal);
      if (signal === "SIGTERM") alive = false;
      if (!alive && signal === 0) throw error("ESRCH");
      return true;
    };
    await expect(stopProcessGroup(7, { graceMs: 500, kill: polite })).resolves.toBe(true);
    expect(signals).not.toContain("SIGKILL");
  });
});

describe.skipIf(process.platform === "win32")("POSIX process-group ownership", () => {
  it("waits for a real group, including a grandchild, to empty", async () => {
    const leader = spawn(
      process.execPath,
      [
        "-e",
        'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},400)"],{stdio:"ignore"});setTimeout(()=>{},200)',
      ],
      { detached: true, stdio: "ignore" },
    );
    const pgid = leader.pid!;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processGroupAlive(pgid)).toBe(true);
    expect(await waitForGroupExit(pgid, 5_000)).toBe(true);
    expect(processGroupAlive(pgid)).toBe(false);
  });
});
