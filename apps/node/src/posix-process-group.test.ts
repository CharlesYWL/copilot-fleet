import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

  it("treats a zombie-only group's EPERM as nothing to signal only on macOS", async () => {
    // Real signals answer EPERM for a group of zombies on macOS; the zombies
    // are then reaped and the probe reports the group gone.
    let reaped = false;
    const zombies = (_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (reaped) throw error("ESRCH");
        return true;
      }
      reaped = true;
      throw error("EPERM");
    };
    const stopping = stopProcessGroup(7, { graceMs: 200, kill: zombies });
    if (process.platform === "darwin") await expect(stopping).resolves.toBe(true);
    else await expect(stopping).rejects.toThrow("EPERM");
  });
});

describe.skipIf(process.platform === "win32")("POSIX process-group ownership", () => {
  it("keeps Node alive until a SIGTERM-ignoring member is killed and verified", async () => {
    // A group whose only member ignores SIGTERM, as a stubborn agent child would.
    const victim = spawn("/bin/sh", ["-c", 'trap "" TERM; exec sleep 30'], {
      detached: true,
      stdio: "ignore",
    });
    const pgid = victim.pid!;
    const directory = mkdtempSync(join(tmpdir(), "fleet-stop-group-"));
    const script = join(directory, "stop.mjs");
    // Nothing else holds this Node open: stopping the group is its only work,
    // as it is during shutdown once listeners and sockets have closed.
    writeFileSync(
      script,
      `import { stopProcessGroup } from ${JSON.stringify(
        pathToFileURL(fileURLToPath(new URL("./posix-process-group.ts", import.meta.url)))
          .href,
      )};\nstopProcessGroup(Number(process.argv[2]), { graceMs: 300 }).then((ok) => console.log(String(ok)));\n`,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const output = await new Promise<string>((resolve, reject) => {
        const worker = spawn(
          process.execPath,
          ["--import", "tsx", script, String(pgid)],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let text = "";
        worker.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
        worker.once("error", reject);
        worker.once("close", () => resolve(text.trim()));
      });
      expect(output).toBe("true");
      expect(processGroupAlive(pgid)).toBe(false);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

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
