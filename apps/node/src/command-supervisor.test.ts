import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  commandSupervisorReadiness,
  prepareCommandProcess,
  readCommandProcessReceipt,
  type CommandProcessInput,
  type PreparedCommandProcess,
} from "./command-supervisor.js";
import { commandSupervisorScript } from "./command-supervisor-native.js";

const windows = describe.skipIf(process.platform !== "win32");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const fixtureLauncher = fileURLToPath(
  new URL("./command-supervisor-fixture.mjs", import.meta.url),
);
const roots: string[] = [];
const commands: PreparedCommandProcess[] = [];
const parents: ChildProcess[] = [];
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function fixture(
  base = process.cwd(),
  name = `.command-supervisor-test-${randomUUID()}`,
) {
  const root = resolve(base, name);
  roots.push(root);
  await mkdir(root);
  const cwd = join(root, "work space Ω's");
  await mkdir(cwd);
  return { root, cwd };
}

function input(
  root: string,
  cwd: string,
  command: string,
  timeoutMs = 20_000,
): CommandProcessInput {
  return {
    executionId: randomUUID(),
    attemptId: randomUUID(),
    directory: join(root, `attempt-${randomUUID()}`),
    cwd,
    command,
    timeoutMs,
    startExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function start(value: CommandProcessInput) {
  const prepared = await prepareCommandProcess(value);
  commands.push(prepared);
  return prepared;
}

async function waitFor<T>(read: () => Promise<T | null>, timeout = 20_000): Promise<T> {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (value !== null) return value;
    await delay(30);
  }
  throw new Error("Disposable fixture did not reach its expected state.");
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function parentFixture(
  root: string,
  command: CommandProcessInput,
  mode: string,
  env?: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const path = join(root, "parent-input.json");
  await writeFile(path, JSON.stringify({ root, command, mode }));
  const child = spawn(process.execPath, ["--import", "tsx", fixtureLauncher, path], {
    cwd: root,
    env: env ?? process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  parents.push(child);
  let errors = "";
  child.stderr?.on("data", (bytes: Buffer) => {
    if (errors.length < 64 * 1024) errors += bytes.toString();
  });
  child.stdout?.resume();
  child.on("error", () => undefined);
  // Error output is fixture-only and bounded; include it if startup fails early.
  await delay(100);
  if (child.exitCode !== null) throw new Error(`Fixture parent exited: ${errors}`);
  return child;
}

async function killParent(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  child.kill(); // Exactly this disposable Node PID, never name-based taskkill.
  await closed;
}

async function workload(root: string, mode: "silent" | "orphan", exitCode = 7) {
  const path = join(root, "workload.cjs");
  await writeFile(
    path,
    `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const mode = process.argv[2];
if (mode === "grandchild") {
  setInterval(() => {}, 1000);
} else if (mode === "middle") {
  const grandchild = spawn(process.execPath, [__filename, "grandchild"], { stdio: "ignore", windowsHide: true, detached: true });
  fs.writeFileSync(path.join(__dirname, "grandchild.json"), JSON.stringify({ pid: grandchild.pid }));
  grandchild.unref();
} else {
  const middle = spawn(process.execPath, [__filename, "middle"], { stdio: "ignore", windowsHide: true });
  middle.once("exit", () => {
    fs.writeFileSync(path.join(__dirname, "workload-ready.json"), JSON.stringify({ pid: process.pid }));
    if (mode === "orphan") process.exit(${exitCode});
    setInterval(() => {}, 1000);
  });
}
`,
  );
  return `& ${quote(process.execPath)} ${quote(path)} ${quote(mode)}`;
}

async function publishControl(
  root: string,
  value: CommandProcessInput,
  control: "release" | "cancel",
  shared: boolean,
  holdMs = 10_000,
) {
  const manifest = (await readJson(join(value.directory, "manifest.json")))!;
  const content = JSON.stringify({
    executionId: value.executionId,
    attemptId: value.attemptId,
    controlId: manifest.controlId,
  });
  const close = join(root, "close-publisher");
  const published = join(root, "control-published");
  const script = join(root, "publish-control.ps1");
  const stage = join(value.directory, "control-publisher.writing");
  await writeFile(
    script,
    "\ufeff" +
      [
        "$ErrorActionPreference='Stop'",
        `$bytes=[Text.Encoding]::UTF8.GetBytes(${quote(content)})`,
        `$share=[IO.FileShare]::Delete${shared ? " -bor [IO.FileShare]::ReadWrite" : ""}`,
        `$file=[IO.FileStream]::new(${quote(stage)},[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,$share)`,
        "try {",
        "  $file.Write($bytes,0,$bytes.Length); $file.Flush($true)",
        `  [IO.File]::Move(${quote(stage)},${quote(join(value.directory, `${control}.json`))})`,
        `  [IO.File]::WriteAllText(${quote(published)},'published')`,
        "  $timer=[Diagnostics.Stopwatch]::StartNew()",
        `  while (-not [IO.File]::Exists(${quote(close)}) -and $timer.ElapsedMilliseconds -lt ${holdMs}) { [Threading.Thread]::Sleep(10) }`,
        "} finally { $file.Dispose() }",
      ].join("\r\n"),
  );
  const shell = (await commandSupervisorReadiness()).shellPath!;
  let failure: unknown;
  const running = promisify(execFile)(
    shell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script],
    { windowsHide: true, timeout: 15_000 },
  );
  void running.catch((error: unknown) => {
    failure = error;
  });
  await waitFor(async () => {
    if (failure) throw failure;
    return await stat(published).then(
      () => true,
      () => null,
    );
  });
  return {
    close: async () => {
      await writeFile(close, "close");
      await running;
    },
  };
}

afterEach(async () => {
  for (const child of parents.splice(0)) await killParent(child);
  for (const prepared of commands.splice(0))
    await prepared.cancel().catch(() => undefined);
  for (const root of roots.splice(0)) {
    // Only exact UUID fixture roots. No shared TEMP and no process-name cleanup.
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter(
      (item) => item.isDirectory() && item.name.startsWith("attempt-"),
    )) {
      const directory = join(root, entry.name);
      await waitFor(async () => {
        const receipt = await readCommandProcessReceipt(directory);
        if (!receipt.identity) return true;
        // A deliberately killed supervisor cannot prove ownership. Its recorded
        // fixture root PID must at least be gone before removing test evidence.
        if (
          receipt.result ||
          (receipt.identity.root && !alive(receipt.identity.root.pid))
        )
          return true;
        return null;
      }).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 40_000);

windows("Windows command supervisor: real disposable processes", () => {
  beforeAll(async () => {
    const ready = await commandSupervisorReadiness();
    expect(ready.supported, ready.reason).toBe(true);
  }, 60_000);

  it("proves the actual trusted Windows PowerShell supervisor, not a PATH substitute", async () => {
    const ready = await commandSupervisorReadiness();
    expect(ready.shellPath).toMatch(
      /^[A-Z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
    );
    const { root, cwd } = await fixture();
    await writeFile(join(cwd, "powershell.cmd"), "@exit /b 99\r\n");
    const prepared = await start(input(root, cwd, "exit 0"));
    expect(prepared.identity.supervisor?.creationTime).toMatch(/^\d+$/);
    expect(prepared.identity.root?.creationTime).toMatch(/^\d+$/);
    expect(prepared.identity.parent.pid).toBe(process.pid);
    expect(await readJson(join(prepared.identity.directory, "ready.json"))).toEqual(
      prepared.identity,
    );
    await prepared.release();
    expect(await prepared.result).toMatchObject({
      exitCode: 0,
      ownership: "quiescent",
      reason: "exited",
    });
  }, 40_000);

  it("prepares through an 8.3 directory alias and recovers legacy alias receipts", async () => {
    const { root, cwd } = await fixture(tmpdir());
    const canonicalRoot = await realpath(root);
    const shell = (await commandSupervisorReadiness()).shellPath!;
    const shortPath = await promisify(execFile)(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class FixtureShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder result, uint length); }'; $path=New-Object Text.StringBuilder 32768; if ([FixtureShortPath]::GetShortPathName(${quote(canonicalRoot)},$path,32768) -eq 0) { throw 'Could not get fixture short path' }; [Console]::Write($path.ToString())`,
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    const aliasRoot = shortPath.stdout;
    expect(aliasRoot.toLowerCase()).not.toBe(canonicalRoot.toLowerCase());
    const value = input(aliasRoot, await realpath(cwd), "exit 0");
    const prepared = await start(value);
    expect(prepared.identity.directory).toBe(await realpath(value.directory));
    await prepared.release();
    const completed = await prepared.result;
    expect(completed).toMatchObject({ exitCode: 0, ownership: "quiescent" });
    const canonicalDirectory = await realpath(value.directory);
    const manifestPath = join(value.directory, "manifest.json");
    const manifest = (await readJson(manifestPath))!;
    // Older attempts wrote the caller's 8.3 alias while the native receipt used
    // the long path. Recovery must validate both names against the same directory.
    manifest.directory = value.directory;
    await writeFile(manifestPath, JSON.stringify(manifest));
    for (const directory of [value.directory, canonicalDirectory]) {
      expect(await readCommandProcessReceipt(directory)).toEqual({
        identity: prepared.identity,
        result: completed,
      });
    }
    await rm(join(value.directory, "terminal.json"));
    expect((await readCommandProcessReceipt(value.directory)).result).toMatchObject({
      ownership: "quiescent",
      outcomeKnown: false,
      exitCode: null,
    });
  }, 40_000);

  it.each([1, 2, 3, 4, 5])(
    "runs actual Git through a deep Windows temporary journal directory (%i)",
    async () => {
      const { root, cwd } = await fixture(
        tmpdir(),
        `.cs-e2e-${randomUUID().slice(0, 16)}`,
      );
      await promisify(execFile)(
        "git",
        ["init", "--quiet", "--initial-branch=supervisor-fixture"],
        { cwd, windowsHide: true },
      );
      const executionId = randomUUID();
      const parentDirectory = join(root, "node-journal", randomUUID(), executionId);
      await mkdir(parentDirectory, { recursive: true });
      const value = input(
        parentDirectory,
        await realpath(cwd),
        "git branch --show-current",
      );
      value.executionId = executionId;
      value.directory = join(parentDirectory, value.attemptId);
      const prepared = await start(value);
      await prepared.release();
      const result = await prepared.result;
      const evidence = JSON.stringify({
        result,
        terminal: await readJson(join(value.directory, "terminal.json")),
        stderr: await readFile(join(value.directory, "stderr.bin"), "utf8"),
      });
      expect(result, evidence).toMatchObject({
        exitCode: 0,
        reason: "exited",
        ownership: "quiescent",
        outcomeKnown: true,
      });
      expect(await readFile(join(value.directory, "stdout.bin"), "utf8")).toMatch(
        /^supervisor-fixture\r?\n$/,
      );
    },
    40_000,
  );

  it("rejects receipt paths pointing at a different physical directory", async () => {
    const { root, cwd } = await fixture();
    const value = input(root, cwd, "exit 0");
    const prepared = await start(value);
    await prepared.cancel();
    const terminalPath = join(value.directory, "terminal.json");
    const terminal = (await readJson(terminalPath))!;
    (terminal.identity as Record<string, unknown>).directory = cwd;
    await writeFile(terminalPath, JSON.stringify(terminal));
    await expect(readCommandProcessReceipt(value.directory)).rejects.toThrow(
      /quarantine/,
    );
  }, 40_000);

  it("persists bounded native exception detail without releasing user code", async () => {
    const { root, cwd } = await fixture();
    const marker = join(root, "must-not-exist");
    const value = input(
      root,
      cwd,
      `[IO.File]::WriteAllText(${quote(marker)},'executed')`,
    );
    const prepared = await start(value);
    const stagedControl = join(value.directory, "malformed-control.writing");
    await writeFile(stagedControl, "invalidControl".repeat(1000));
    await rename(stagedControl, join(value.directory, "release.json"));
    const result = await prepared.result;
    expect(result).toMatchObject({
      reason: "supervisor_error",
      started: false,
      ownership: "quiescent",
      outcomeKnown: false,
      exitCode: null,
    });
    expect(result.error).toMatch(
      /^read_release\.json: System\.\w+Exception \(HRESULT=0x[0-9A-F]{8}\):/,
    );
    expect(result.error).toHaveLength(2048);
    expect(result.error).toMatch(/\.\.\.\[truncated\]$/);
    expect(await stat(marker).catch(() => null)).toBeNull();
    const terminalPath = join(value.directory, "terminal.json");
    const terminal = (await readJson(terminalPath))!;
    expect((terminal.result as Record<string, unknown>).error).toBe(result.error);

    const shell = (await commandSupervisorReadiness()).shellPath!;
    const diagnostic = await promisify(execFile)(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$type=[Reflection.Assembly]::LoadFile(${quote(join(value.directory, "supervisor.exe"))}).GetType('FleetCommandSupervisor'); $flags=[Reflection.BindingFlags]'NonPublic,Static'; $type.GetField('Phase',$flags).SetValue($null,'fixture_win32'); $format=$type.GetMethod('ErrorDetail',$flags).CreateDelegate([Func[Exception,string]]); $exception=New-Object ComponentModel.Win32Exception 5; [Console]::Write($format.Invoke($exception))`,
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    expect(diagnostic.stdout).toMatch(
      /^fixture_win32: System\.ComponentModel\.Win32Exception \(HRESULT=0x[0-9A-F]{8}, Win32=5\):/,
    );

    (terminal.result as Record<string, unknown>).error = "legacy exception ".repeat(400);
    await writeFile(terminalPath, JSON.stringify(terminal));
    const recovered = await readCommandProcessReceipt(value.directory);
    expect(recovered.result?.error).toHaveLength(2048);
    expect(recovered.result?.error).toMatch(/\.\.\.\[truncated\]$/);
  }, 40_000);

  it.each(["release", "cancel"] as const)(
    "reads atomically published %s while the publisher still holds write access",
    async (control) => {
      const { root, cwd } = await fixture();
      const value = input(root, cwd, "[Console]::Write('released'); exit 0");
      const prepared = await start(value);
      const publisher = await publishControl(root, value, control, true);
      try {
        const result = await prepared.result;
        expect(result, JSON.stringify(result)).toMatchObject({
          reason: control === "release" ? "exited" : "cancelled",
          ownership: "quiescent",
          started: control === "release",
        });
      } finally {
        await publisher.close();
      }
    },
    40_000,
  );

  it.each([350, 10_000])(
    "never releases past an unreadable cancellation (%i ms lock)",
    async (holdMs) => {
      const { root, cwd } = await fixture();
      const marker = join(root, "must-not-exist");
      const value = input(
        root,
        cwd,
        `[IO.File]::WriteAllText(${quote(marker)},'executed')`,
      );
      const prepared = await start(value);
      const publisher = await publishControl(root, value, "cancel", false, holdMs);
      try {
        await prepared.release();
        const result = await prepared.result;
        expect(result, JSON.stringify(result)).toMatchObject({
          reason: holdMs === 350 ? "cancelled" : "supervisor_error",
          started: false,
          ownership: "quiescent",
        });
        if (holdMs === 10_000) {
          expect(result.error).toMatch(/^read_cancel\.json: System\.IO\.IOException/);
          expect(result.error).toContain("HRESULT=0x80070020");
        }
        expect(await stat(marker).catch(() => null)).toBeNull();
      } finally {
        await publisher.close();
      }
    },
    40_000,
  );

  it("still detects parent loss while cancellation is exclusively locked", async () => {
    const { root, cwd } = await fixture();
    const value = input(root, cwd, "throw 'must not execute'");
    const parent = await parentFixture(root, value, "before_ack");
    await waitFor(() => readJson(join(value.directory, "ready.json")));
    const publisher = await publishControl(root, value, "cancel", false);
    try {
      await killParent(parent);
      const receipt = await waitFor(async () => {
        const current = await readCommandProcessReceipt(value.directory);
        return current.result?.reason === "parent_lost" ? current : null;
      });
      expect(receipt.result).toMatchObject({ started: false, ownership: "quiescent" });
    } finally {
      await publisher.close();
    }
  }, 40_000);

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "stress publishes release and duplicate cancellation without sharing failures (%i)",
    async () => {
      const { root, cwd } = await fixture();
      const prepared = await start(input(root, cwd, "Start-Sleep -Seconds 30"));
      await Promise.all([prepared.release(), prepared.cancel(), prepared.cancel()]);
      expect(await prepared.result).toMatchObject({
        reason: "cancelled",
        ownership: "quiescent",
        error: null,
      });
    },
    40_000,
  );

  it("never executes before durable release and cancelling first cannot be undone", async () => {
    const { root, cwd } = await fixture();
    const marker = join(root, "must-not-exist");
    const value = input(
      root,
      cwd,
      `[IO.File]::WriteAllText(${quote(marker)}, 'executed')`,
    );
    const prepared = await start(value);
    await delay(200);
    expect(await stat(marker).catch(() => null)).toBeNull();
    const cancelling = prepared.cancel();
    const lateRelease = expect(prepared.release()).rejects.toThrow(/settled|cancelled/);
    await Promise.all([cancelling, lateRelease]);
    expect(await prepared.result).toMatchObject({
      started: false,
      cancelled: true,
      exitCode: null,
      ownership: "quiescent",
    });
    expect(await stat(marker).catch(() => null)).toBeNull();
    await expect(prepareCommandProcess(value)).rejects.toThrow();
  }, 40_000);

  it.each([
    ["explicit script exit", "exit 29", 29],
    ["final native failure", `& ${quote(process.execPath)} -e 'process.exit(37)'`, 37],
    [
      "unsigned Windows native exit",
      `& ${quote(process.execPath)} -e 'process.exit(-1)'`,
      0xffffffff,
    ],
    ["PowerShell terminating error", "throw 'fixture failure'", 1],
    ["PowerShell nonterminating error", "Write-Error 'fixture failure'", 1],
    ["git exit", "git rev-parse --verify refs/heads/fleet-nonexistent-fixture", 128],
  ])(
    "preserves %s",
    async (_name, command, exitCode) => {
      const { root, cwd } = await fixture();
      const prepared = await start(input(root, cwd, command));
      await prepared.release();
      expect(await prepared.result).toMatchObject({
        exitCode,
        ownership: "quiescent",
        outcomeKnown: true,
        reason: "exited",
      });
    },
    40_000,
  );

  it("preserves exact npm.cmd script failure without modifying dependencies", async () => {
    const { root, cwd } = await fixture();
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { fail: 'node -e "process.exit(23)"' },
      }),
    );
    const prepared = await start(input(root, cwd, "npm.cmd run fail --silent"));
    await prepared.release();
    expect(await prepared.result).toMatchObject({
      exitCode: 23,
      ownership: "quiescent",
      reason: "exited",
    });
  }, 40_000);

  it("transports exact UTF-8/BOM bytes and a 16 KiB script independently of cwd", async () => {
    const { root, cwd } = await fixture();
    const prefix =
      "[Console]::Write('雪 café Ω'); [Console]::Error.Write((Get-Location).Path)\r\n#";
    const command = prefix + "x".repeat(16 * 1024 - Buffer.byteLength(prefix));
    const value = input(root, cwd, command);
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    value.onOutput = (stream, bytes) => output[stream].push(bytes);
    const prepared = await start(value);
    const script = await readFile(join(value.directory, "command.ps1"));
    expect(script.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(script.subarray(3)).toEqual(Buffer.from(command));
    expect(prepared.identity.commandSha256).toBe(
      createHash("sha256").update(command).digest("hex"),
    );
    await prepared.release();
    expect(await prepared.result).toMatchObject({ exitCode: 0, ownership: "quiescent" });
    expect(Buffer.concat(output.stdout).toString("utf8")).toBe("雪 café Ω");
    expect(Buffer.concat(output.stderr).toString("utf8")).toBe(cwd);
  }, 40_000);

  it("rejects oversized multibyte and NUL scripts before creating an attempt", async () => {
    const { root, cwd } = await fixture();
    for (const command of ["雪".repeat(5500), "x\0y"]) {
      const value = input(root, cwd, command);
      await expect(prepareCommandProcess(value)).rejects.toThrow(/16 KiB/);
      expect(await stat(value.directory).catch(() => null)).toBeNull();
    }
  });

  it("keeps invalid UTF-8, NUL and independent native stdout/stderr as raw bytes", async () => {
    const { root, cwd } = await fixture();
    const bytes = Buffer.from([0, 255, 128, 13, 10, 226, 130, 172]);
    const js = `process.stdout.write(Buffer.from([${[...bytes]}]));process.stderr.write(Buffer.from([${[...bytes]}]))`;
    const value = input(root, cwd, `& ${quote(process.execPath)} -e ${quote(js)}`);
    const prepared = await start(value);
    await prepared.release();
    expect(await prepared.result).toMatchObject({ exitCode: 0, outputComplete: true });
    expect(await readFile(join(value.directory, "stdout.bin"))).toEqual(bytes);
    expect(await readFile(join(value.directory, "stderr.bin"))).toEqual(bytes);
  }, 40_000);

  it("starts native stdin at EOF, not an interactive input channel", async () => {
    const { root, cwd } = await fixture();
    const js =
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('closed'))";
    const value = input(root, cwd, `& ${quote(process.execPath)} -e ${quote(js)}`);
    const prepared = await start(value);
    await prepared.release();
    expect(await prepared.result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await readFile(join(value.directory, "stdout.bin"), "utf8")).toBe("closed");
  }, 40_000);

  it("caps disk and callback chunks while continuing to drain both full pipes", async () => {
    const { root, cwd } = await fixture();
    const path = join(root, "flood.cjs");
    await writeFile(
      path,
      "const fs=require('node:fs');const b=Buffer.alloc(65536,255);for(let i=0;i<96;i++){fs.writeSync(1,b);fs.writeSync(2,b)}",
    );
    const value = input(root, cwd, `& ${quote(process.execPath)} ${quote(path)}`);
    let delivered = 0;
    let largestChunk = 0;
    value.onOutput = (_stream, bytes) => {
      largestChunk = Math.max(largestChunk, bytes.length);
      delivered += bytes.length;
    };
    const prepared = await start(value);
    await prepared.release();
    const result = await prepared.result;
    expect(result).toMatchObject({
      exitCode: 0,
      ownership: "quiescent",
      outputComplete: true,
    });
    expect(result.stdout.bytes + result.stderr.bytes).toBe(12 * 1024 * 1024);
    expect(result.stdout.retainedBytes + result.stderr.retainedBytes).toBe(
      10 * 1024 * 1024,
    );
    expect(result.stdout.droppedBytes + result.stderr.droppedBytes).toBe(2 * 1024 * 1024);
    expect(delivered).toBe(10 * 1024 * 1024);
    expect(largestChunk).toBeLessThanOrEqual(64 * 1024);
    const sizes = await Promise.all(
      ["stdout", "stderr"].map(
        async (stream) => (await stat(join(value.directory, `${stream}.bin`))).size,
      ),
    );
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(10 * 1024 * 1024);
  }, 40_000);

  it.each([0, 7])(
    "kills surviving orphaned grandchildren on natural root exit %i and reports interruption",
    async (exitCode) => {
      const { root, cwd } = await fixture();
      const prepared = await start(
        input(root, cwd, await workload(root, "orphan", exitCode)),
      );
      await prepared.release();
      const result = await prepared.result;
      expect(result).toMatchObject({
        exitCode,
        reason: "descendant_cleanup",
        descendantCleanupForced: true,
        interrupted: true,
        ownership: "quiescent",
      });
      const grandchild = await readJson(join(root, "grandchild.json"));
      expect(alive(grandchild!.pid as number)).toBe(false);
    },
    40_000,
  );

  it.each(["timeout", "cancel"])(
    "enforces %s for a silent job with surviving grandchildren",
    async (mode) => {
      const { root, cwd } = await fixture();
      const prepared = await start(
        input(
          root,
          cwd,
          await workload(root, "silent"),
          mode === "timeout" ? 2_000 : 20_000,
        ),
      );
      await prepared.release();
      await waitFor(() => readJson(join(root, "workload-ready.json")));
      if (mode === "cancel") await prepared.cancel();
      expect(await prepared.result).toMatchObject({
        exitCode: null,
        ownership: "quiescent",
        timedOut: mode === "timeout",
        cancelled: mode === "cancel",
      });
      const grandchild = await readJson(join(root, "grandchild.json"));
      expect(alive(grandchild!.pid as number)).toBe(false);
    },
    40_000,
  );

  it("rechecks start expiry inside the supervisor while suspended", async () => {
    const { root, cwd } = await fixture();
    const value = input(root, cwd, "throw 'must never run'");
    value.startExpiresAt = new Date(Date.now() + 4_000).toISOString();
    const prepared = await start(value);
    expect(await prepared.result).toMatchObject({
      started: false,
      reason: "start_expired",
      ownership: "quiescent",
    });
    await expect(prepared.release()).rejects.toThrow(/settled|expired/);
  }, 40_000);

  it.each(["before_ack", "silent"])(
    "persists cleanup after the Node parent dies %s",
    async (mode) => {
      const { root, cwd } = await fixture();
      const marker = join(root, "must-not-exist");
      const command =
        mode === "before_ack"
          ? `[IO.File]::WriteAllText(${quote(marker)},'executed')`
          : await workload(root, "silent");
      const value = input(root, cwd, command);
      const parent = await parentFixture(root, value, mode);
      await waitFor(() => readJson(join(value.directory, "ready.json")));
      if (mode === "silent")
        await waitFor(() => readJson(join(root, "workload-ready.json")));
      await killParent(parent);
      const receipt = await waitFor(async () => {
        const valueRead = await readCommandProcessReceipt(value.directory);
        return valueRead.result?.reason !== "receipt_missing" && valueRead.result
          ? valueRead
          : null;
      });
      expect(receipt.result).toMatchObject({
        reason: "parent_lost",
        interrupted: true,
        started: mode === "silent",
        ownership: "quiescent",
        exitCode: null,
      });
      expect(receipt.identity?.parent.pid).toBe(parent.pid);
      expect(await readJson(join(value.directory, "quiescent.json"))).not.toBeNull();
      if (mode === "before_ack") {
        expect(await stat(marker).catch(() => null)).toBeNull();
        expect(await stat(join(root, "released.json")).catch(() => null)).toBeNull();
      } else {
        const grandchild = await readJson(join(root, "grandchild.json"));
        expect(alive(grandchild!.pid as number)).toBe(false);
      }
    },
    60_000,
  );

  it("enforces a monotonic deadline even when the Node event loop is blocked", async () => {
    const { root, cwd } = await fixture();
    const value = input(root, cwd, await workload(root, "silent"), 2_000);
    const parent = await parentFixture(root, value, "blocked");
    const receipt = await waitFor(async () => {
      const read = await readCommandProcessReceipt(value.directory);
      return read.result?.reason === "timed_out" ? read : null;
    });
    expect(alive(parent.pid!)).toBe(true);
    expect(receipt.result).toMatchObject({ timedOut: true, ownership: "quiescent" });
    expect(alive((await readJson(join(root, "grandchild.json")))!.pid as number)).toBe(
      false,
    );
  }, 60_000);

  it("separates lost outcome from unknown ownership, without relaunching recovery", async () => {
    const { root, cwd } = await fixture();
    const value = input(root, cwd, "exit 0");
    const prepared = await start(value);
    await prepared.release();
    await prepared.result;
    await rm(join(value.directory, "terminal.json"));
    const recovered = await readCommandProcessReceipt(value.directory);
    expect(recovered.result).toMatchObject({
      exitCode: null,
      outcomeKnown: false,
      ownership: "quiescent",
      interrupted: true,
    });
    await rm(join(value.directory, "quiescent.json"));
    expect(await readCommandProcessReceipt(value.directory)).toMatchObject({
      identity: prepared.identity,
      result: null,
    });
    await expect(prepareCommandProcess(value)).rejects.toThrow();
    expect(
      await stat(join(value.directory, "terminal.json")).catch(() => null),
    ).toBeNull();
  }, 40_000);

  it("never treats supervisor death as a durable ownership proof", async () => {
    const { root, cwd } = await fixture();
    const prepared = await start(input(root, cwd, await workload(root, "silent")));
    await prepared.release();
    await waitFor(() => readJson(join(root, "workload-ready.json")));
    process.kill(prepared.identity.supervisor!.pid);
    expect(await prepared.result).toMatchObject({
      exitCode: null,
      ownership: "unknown",
      outcomeKnown: false,
    });
    const grandchild = await readJson(join(root, "grandchild.json"));
    await waitFor(async () => (!alive(grandchild!.pid as number) ? true : null));
    await expect(prepared.cancel()).rejects.toThrow(/ownership is unknown/);
  }, 40_000);

  it.each(["missing", "restricted"])(
    "fails readiness before user code when supervisor is %s",
    async (mode) => {
      const { root, cwd } = await fixture();
      const marker = join(root, "must-not-exist");
      const value = input(
        root,
        cwd,
        `[IO.File]::WriteAllText(${quote(marker)},'executed')`,
      );
      const env = { ...process.env };
      // These tighten only this disposable child's policy. Never bypass or change host policy.
      if (mode === "restricted") env.PSExecutionPolicyPreference = "Restricted";
      const parent = await parentFixture(
        root,
        value,
        mode === "missing" ? "missing" : "readiness",
        env,
      );
      const result = await waitFor(() => readJson(join(root, "fixture-result.json")));
      expect(result.prepareFailed).toBe(true);
      expect(result.ready).toMatchObject({ supported: false });
      expect(await stat(marker).catch(() => null)).toBeNull();
      expect(await stat(value.directory).catch(() => null)).toBeNull();
      await killParent(parent);
    },
    60_000,
  );

  it("cannot compile the real supervisor under ConstrainedLanguage policy", async () => {
    const { root } = await fixture();
    const shell = (await commandSupervisorReadiness()).shellPath!;
    const path = join(root, "supervisor.ps1");
    await writeFile(path, `\ufeff${commandSupervisorScript}`);
    const result = promisify(execFile)(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; & ${quote(path)}`,
      ],
      { windowsHide: true, env: { ...process.env, TEMP: root, TMP: root } },
    );
    await expect(result).rejects.toThrow(
      /ConstrainedLanguage|language mode|Cannot add type/i,
    );
    expect(await stat(join(root, "supervisor.exe")).catch(() => null)).toBeNull();
    expect(await stat(join(root, "ready.json")).catch(() => null)).toBeNull();
  }, 40_000);

  it("rejects a mismatched durable receipt instead of trusting unrelated PID evidence", async () => {
    const { root, cwd } = await fixture();
    const value = input(root, cwd, "exit 0");
    const prepared = await start(value);
    await prepared.cancel();
    const terminalPath = join(value.directory, "terminal.json");
    const terminal = (await readJson(terminalPath))!;
    (terminal.identity as Record<string, unknown>).attemptId = randomUUID();
    await writeFile(terminalPath, JSON.stringify(terminal));
    await expect(readCommandProcessReceipt(value.directory)).rejects.toThrow(
      /quarantine/,
    );
  }, 40_000);
});
