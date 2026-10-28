import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  killPosixProcessGroup,
  killTrackedProcessGroups,
  processGroupTracked,
  spawnManagedProcess,
  stopProcessTree,
  trackProcessGroup,
} from "./process-quiescence.js";

describe("managed process quiescence", () => {
  // Windows-only: the agent launcher uses a shell only for npm .cmd shims there.
  it.skipIf(process.platform !== "win32")(
    "preserves shell-launch argument boundaries inside the managed job",
    async () => {
      const child = spawnManagedProcess(
        "node",
        ["-e", "process.stdout.write(process.argv[1])", "argument with spaces"],
        { windowsHide: true, shell: true },
      );
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      try {
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
        expect(Buffer.concat(output).toString()).toBe("argument with spaces");
        expect(child.exitCode).toBe(0);
      } finally {
        await stopProcessTree(child, true);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "escalates to SIGKILL for a managed descendant that ignores SIGTERM",
    async () => {
      const child = spawnManagedProcess(
        process.execPath,
        [
          "-e",
          'const c=require("node:child_process").spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(String(c.pid));setInterval(()=>{},1000)',
        ],
        {},
      );
      const descendant = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (chunk: Buffer) =>
          resolve(Number(chunk.toString().trim())),
        );
        child.once("exit", () => reject(new Error("Exited before readiness")));
      });
      await stopProcessTree(child, true);
      expect(() => process.kill(descendant, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "never treats supervisor death as proof that orphaned descendants are quiescent",
    async () => {
      const child = spawnManagedProcess(
        process.execPath,
        [
          "-e",
          'const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});console.log(String(c.pid));setTimeout(()=>{},30000)',
        ],
        { windowsHide: true },
      );
      const descendant = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (chunk: Buffer) =>
          resolve(Number(chunk.toString().trim())),
        );
        child.once("exit", () => reject(new Error("Supervisor exited before readiness")));
      });

      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill();
      await closed;
      await expect(stopProcessTree(child, true)).rejects.toThrow(
        "reconciliation is required",
      );
      await expect(stopProcessTree(child, true)).rejects.toThrow(
        "reconciliation is required",
      );
      await expect
        .poll(() => {
          try {
            process.kill(descendant, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    },
    30_000,
  );

  it("preserves stdin bytes sent during managed startup", async () => {
    const child = spawnManagedProcess(
      process.execPath,
      [
        "-e",
        'process.stdin.once("data",(data)=>{process.stdout.write(data);process.exit(0)})',
      ],
      { windowsHide: true },
    );
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stdin.write('{"request":"early ACP initialize"}\n');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Managed stdin did not arrive")),
          10_000,
        );
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(Buffer.concat(output).toString()).toBe(
        '{"request":"early ACP initialize"}\n',
      );
    } finally {
      await stopProcessTree(child, true);
    }
  }, 30_000);

  it.each([0, 7])(
    "verifies a naturally exited managed process (%i) and its orphaned grandchild",
    async (code) => {
      const child = spawnManagedProcess(
        process.execPath,
        [
          "-e",
          `
          const {spawn}=require("node:child_process");
          const middle=spawn(process.execPath,["-e",
            'const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});console.log(String(c.pid));c.unref()'
          ],{stdio:["ignore","pipe","ignore"]});
          middle.stdout.pipe(process.stdout);
          middle.once("exit",()=>process.exit(${code}));
          `,
        ],
        { windowsHide: true },
      );
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      expect(child.exitCode, errors).toBe(code);
      await expect(stopProcessTree(child, true)).resolves.toBeUndefined();
      expect(Buffer.concat(output).toString()).toMatch(/^\d+\s*$/);
      const descendant = Number(Buffer.concat(output).toString().trim());
      expect(descendant).toBeGreaterThan(0);
      expect(() => process.kill(descendant, 0)).toThrow();
    },
    30_000,
  );

  it("stops a live managed job and verifies every process before returning", async () => {
    const child = spawnManagedProcess(
      process.execPath,
      ["-e", 'console.log("ready");setTimeout(()=>{},30000)'],
      { windowsHide: true },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("exit", () => reject(new Error("Job exited before readiness")));
      });
      await stopProcessTree(child, true);
      // A job exits with a code; a POSIX group member ends on a signal.
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await stopProcessTree(child, true);
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")(
    "waits for the ACP-shaped process and its shell descendant to exit",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
      const {spawn}=require("node:child_process");
      const child=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});
      process.stdout.write(String(child.pid)+"\\n");
      setTimeout(()=>{},30000);
    `,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      try {
        const descendant = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.stdout.once("data", (chunk: Buffer) =>
            resolve(Number(chunk.toString("utf8").trim())),
          );
        });
        expect(descendant).toBeGreaterThan(0);
        await stopProcessTree(child);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        expect(() => process.kill(descendant, 0)).toThrow();
      } finally {
        await stopProcessTree(child);
      }
    },
    30_000,
  );
});

describe("POSIX process quiescence", () => {
  it("signals the detached process group by negative PID", () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    killPosixProcessGroup(42, (pid, signal) => {
      calls.push([pid, signal]);
      return true;
    });
    expect(calls).toEqual([[-42, "SIGKILL"]]);
  });

  it("ignores a process group that exited concurrently", () => {
    expect(() =>
      killPosixProcessGroup(42, () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }),
    ).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "terminates the detached process group rather than only the direct child",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});console.log(c.pid);setTimeout(()=>{},30000)',
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const descendant = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (chunk: Buffer) =>
          resolve(Number(chunk.toString().trim())),
        );
        child.once("error", reject);
      });

      await stopProcessTree(child);
      // SIGKILL is immediate, but the orphan is reaped by init asynchronously,
      // and kill(pid, 0) still finds a zombie; under load that takes a moment.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          process.kill(descendant, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(() => process.kill(descendant, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "ends a managed descendant that holds the leader's pipes open after the leader exits",
    async () => {
      // The shell exits at once; `sleep` inherits stdout and stderr, so the
      // child's `close` event would not fire until it ends by itself.
      const child = spawnManagedProcess(
        "/bin/sh",
        ["-c", 'sleep 60 & echo "$!"; exit 0'],
        {},
      );
      const descendant = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (chunk: Buffer) =>
          resolve(Number(chunk.toString().trim())),
        );
        child.once("error", reject);
      });
      try {
        expect(descendant).toBeGreaterThan(0);
        // The reported scenario: the leader is gone, its descendant is not.
        if (child.exitCode === null && child.signalCode === null)
          await new Promise((resolve) => child.once("exit", resolve));
        expect(() => process.kill(descendant, 0)).not.toThrow();
        const started = Date.now();
        await stopProcessTree(child, true);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(() => process.kill(descendant, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {
          // Already gone, which is the expected outcome.
        }
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps ownership unverified, without an unhandled rejection, when the group cannot be signalled",
    async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const realKill = process.kill.bind(process);
      const child = spawnManagedProcess(
        "/bin/sh",
        ["-c", 'sleep 60 & echo "$!"; exit 0'],
        {},
      );
      const descendant = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (chunk: Buffer) =>
          resolve(Number(chunk.toString().trim())),
        );
        child.once("error", reject);
      });
      const pgid = child.pid!;
      // Probing the group still works; delivering a real signal to it fails.
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((pid: number, signal?: string | number) => {
          if (pid === -pgid && signal !== 0)
            throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
          return realKill(pid, signal);
        });
      try {
        // The leader has exited by itself, so only the exit-time cleanup acts.
        if (child.exitCode === null && child.signalCode === null)
          await new Promise((resolve) => child.once("exit", resolve));
        await expect(stopProcessTree(child, true)).rejects.toThrow(
          "reconciliation is required",
        );
        // Give any stray rejection a chance to surface before checking.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(unhandled).toEqual([]);
      } finally {
        kill.mockRestore();
        process.off("unhandledRejection", onUnhandled);
        try {
          realKill(-pgid, "SIGKILL");
        } catch {
          // Already gone.
        }
        try {
          realKill(descendant, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills tracked groups on exit, and forgets a group once it is empty",
    async () => {
      const spawnGroup = () =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
          detached: true,
          stdio: "ignore",
        });
      const exited = spawnGroup();
      const running = spawnGroup();
      try {
        trackProcessGroup(exited);
        trackProcessGroup(running);
        const exitedPid = exited.pid!;
        await new Promise<void>((resolve) => {
          exited.once("exit", () => resolve());
          process.kill(exitedPid, "SIGKILL");
        });
        expect(processGroupTracked(exitedPid)).toBe(false);

        const closed = new Promise<void>((resolve) =>
          running.once("exit", () => resolve()),
        );
        killTrackedProcessGroups();
        await closed;
        expect(running.signalCode).toBe("SIGKILL");
      } finally {
        for (const child of [exited, running]) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps a group whose leader exited while a descendant still runs, and kills it on exit",
    async () => {
      const leader = spawn(
        process.execPath,
        [
          "-e",
          'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});c.unref();console.log(c.pid)',
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const pgid = leader.pid!;
      let descendant = 0;
      try {
        trackProcessGroup(leader);
        descendant = await new Promise<number>((resolve, reject) => {
          leader.stdout!.once("data", (chunk: Buffer) =>
            resolve(Number(chunk.toString().trim())),
          );
          leader.once("error", reject);
        });
        await new Promise<void>((resolve) => {
          if (leader.exitCode !== null) resolve();
          else leader.once("exit", () => resolve());
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        // The leader is gone but the group is not, so exit cleanup still owns it.
        expect(processGroupTracked(pgid)).toBe(true);
        killTrackedProcessGroups();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(() => process.kill(descendant, 0)).toThrow();
      } finally {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
    30_000,
  );
});
