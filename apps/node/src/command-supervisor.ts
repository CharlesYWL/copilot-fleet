import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  COMMAND_SUPERVISOR_ERROR_LIMIT,
  commandSupervisorScript,
} from "./command-supervisor-native.js";

const execute = promisify(execFile);
const MAX_SCRIPT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const PREPARE_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function boundedError(message: string): string {
  const suffix = "...[truncated]";
  return message.length <= COMMAND_SUPERVISOR_ERROR_LIMIT
    ? message
    : message.slice(0, COMMAND_SUPERVISOR_ERROR_LIMIT - suffix.length) + suffix;
}

export interface CommandProcessIdentity {
  version: 1;
  executionId: string;
  attemptId: string;
  directory: string;
  jobId: string;
  commandSha256: string;
  parent: { pid: number; creationTime: string };
  supervisor: { pid: number; creationTime: string } | null;
  root: { pid: number; creationTime: string } | null;
}

export interface CommandProcessResult {
  exitCode: number | null;
  reason: string;
  descendantCleanupForced: boolean;
  ownership: "quiescent" | "unknown";
  outcomeKnown: boolean;
  interrupted: boolean;
  timedOut: boolean;
  cancelled: boolean;
  started: boolean | null;
  outputComplete: boolean;
  completedAt: string | null;
  /** At most 2048 characters, including native phase, exception type and error codes. */
  error: string | null;
  stdout: { bytes: number; retainedBytes: number; droppedBytes: number };
  stderr: { bytes: number; retainedBytes: number; droppedBytes: number };
}

export interface PreparedCommandProcess {
  identity: CommandProcessIdentity;
  /** Call only after the manager durably records acceptance and release intent. */
  release(): Promise<void>;
  /** Resolves only after a durable quiescent receipt; rejects on unknown ownership. */
  cancel(): Promise<void>;
  result: Promise<CommandProcessResult>;
}

export interface CommandProcessInput {
  executionId: string;
  attemptId: string;
  /** Absolute, fresh attempt directory inside the manager's secured journal. Never reused. */
  directory: string;
  cwd: string;
  /** Exact UTF-8 source. PowerShell errors stop by default; the script may override that policy. */
  command: string;
  timeoutMs: number;
  startExpiresAt: string;
  /** Raw retained bytes. Delivery is best effort; durable .bin files are authoritative. */
  onOutput?: (stream: "stdout" | "stderr", bytes: Buffer) => void;
}

interface Manifest extends Omit<CommandProcessInput, "onOutput"> {
  version: 1;
  controlId: string;
  jobId: string;
  shellPath: string;
  commandSha256: string;
  parent: CommandProcessIdentity["parent"];
}

export interface CommandProcessReceipt {
  identity: CommandProcessIdentity | null;
  /** Null is absent evidence, not proof that the process never started or exited. */
  result: CommandProcessResult | null;
}

function unknownResult(ownership: "quiescent" | "unknown"): CommandProcessResult {
  return {
    exitCode: null,
    reason: "receipt_missing",
    descendantCleanupForced: false,
    ownership,
    outcomeKnown: false,
    interrupted: true,
    timedOut: false,
    cancelled: false,
    started: null,
    outputComplete: false,
    completedAt: null,
    error: null,
    stdout: { bytes: 0, retainedBytes: 0, droppedBytes: 0 },
    stderr: { bytes: 0, retainedBytes: 0, droppedBytes: 0 },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validProcess(value: unknown): boolean {
  return (
    record(value) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.creationTime === "string" &&
    /^\d+$/.test(value.creationTime)
  );
}

function validIdentity(value: unknown): value is CommandProcessIdentity {
  return (
    record(value) &&
    value.version === 1 &&
    ["executionId", "attemptId", "directory", "jobId", "commandSha256"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.directory === "string" &&
    isAbsolute(value.directory) &&
    validProcess(value.parent) &&
    (value.supervisor === null || validProcess(value.supervisor)) &&
    (value.root === null || validProcess(value.root))
  );
}

async function sameIdentity(
  a: CommandProcessIdentity,
  b: CommandProcessIdentity,
): Promise<boolean> {
  return (
    a.executionId === b.executionId &&
    a.attemptId === b.attemptId &&
    a.jobId === b.jobId &&
    a.commandSha256 === b.commandSha256 &&
    a.parent.pid === b.parent.pid &&
    a.parent.creationTime === b.parent.creationTime &&
    (!a.supervisor ||
      (a.supervisor.pid === b.supervisor?.pid &&
        a.supervisor.creationTime === b.supervisor.creationTime)) &&
    (!a.root ||
      (a.root.pid === b.root?.pid && a.root.creationTime === b.root.creationTime)) &&
    // Windows 8.3 names, long names and junction aliases can identify the same
    // directory. Never relax process/attempt identity to compensate for spelling.
    (await realpath(a.directory)).toLowerCase() ===
      (await realpath(b.directory)).toLowerCase()
  );
}

function validResult(value: unknown): value is CommandProcessResult {
  if (
    !record(value) ||
    !["quiescent", "unknown"].includes(String(value.ownership)) ||
    typeof value.reason !== "string" ||
    !(
      value.exitCode === null ||
      (Number.isInteger(value.exitCode) &&
        (value.exitCode as number) >= 0 &&
        (value.exitCode as number) <= 0xffffffff)
    ) ||
    !(value.completedAt === null || typeof value.completedAt === "string") ||
    !(value.error === null || typeof value.error === "string") ||
    !(value.started === null || typeof value.started === "boolean") ||
    ![
      "outcomeKnown",
      "interrupted",
      "timedOut",
      "cancelled",
      "outputComplete",
      "descendantCleanupForced",
    ].every((key) => typeof value[key] === "boolean")
  )
    return false;
  let retained = 0;
  for (const stream of ["stdout", "stderr"]) {
    const counts = value[stream];
    if (
      !record(counts) ||
      !["bytes", "retainedBytes", "droppedBytes"].every(
        (key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0,
      )
    )
      return false;
    if (
      counts.bytes !==
      (counts.retainedBytes as number) + (counts.droppedBytes as number)
    )
      return false;
    retained += counts.retainedBytes as number;
  }
  return retained <= MAX_OUTPUT_BYTES;
}

async function json(path: string): Promise<unknown | null> {
  try {
    const file = await open(path, "r");
    try {
      if ((await file.stat()).size > 64 * 1024)
        throw new Error("Oversized command receipt.");
      return JSON.parse(await file.readFile("utf8")) as unknown;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function manifestIdentity(value: unknown): CommandProcessIdentity | null {
  if (!record(value)) return null;
  const identity = { ...value, supervisor: null, root: null };
  return validIdentity(identity) ? identity : null;
}

/**
 * Read-only reconciliation. Never spawns, signals PIDs, reuses directories, or
 * infers quiescence from missing/reused process IDs. Preserve uncertain attempts.
 * A quiescence-only receipt yields an interrupted, unknown outcome safely.
 */
export async function readCommandProcessReceipt(
  directory: string,
): Promise<CommandProcessReceipt> {
  if (!isAbsolute(directory)) throw new Error("Attempt directory must be absolute.");
  const manifest = await json(join(directory, "manifest.json"));
  const original = manifestIdentity(manifest);
  if (
    manifest !== null &&
    (!original || !(await sameIdentity({ ...original, directory }, original)))
  ) {
    throw new Error("Invalid command manifest identity; quarantine this attempt.");
  }
  const ready = await json(join(directory, "ready.json"));
  if (
    ready !== null &&
    (!validIdentity(ready) || !original || !(await sameIdentity(original, ready)))
  ) {
    throw new Error("Invalid command readiness identity; quarantine this attempt.");
  }
  const identity = validIdentity(ready) ? ready : original;
  const terminal = await json(join(directory, "terminal.json"));
  if (terminal !== null) {
    if (
      !record(terminal) ||
      !validIdentity(terminal.identity) ||
      !identity ||
      !(await sameIdentity(identity, terminal.identity)) ||
      !validResult(terminal.result)
    ) {
      throw new Error("Invalid command terminal receipt; quarantine this attempt.");
    }
    return {
      identity: terminal.identity,
      result: {
        ...terminal.result,
        error:
          terminal.result.error === null ? null : boundedError(terminal.result.error),
      },
    };
  }
  const proof = await json(join(directory, "quiescent.json"));
  if (proof !== null) {
    if (
      !record(proof) ||
      !validIdentity(proof.identity) ||
      !identity ||
      !(await sameIdentity(identity, proof.identity)) ||
      typeof proof.quiescentAt !== "string"
    ) {
      throw new Error("Invalid command quiescence receipt; quarantine this attempt.");
    }
    return { identity: proof.identity, result: unknownResult("quiescent") };
  }
  return { identity, result: null };
}

async function durableFile(path: string, bytes: string | Buffer): Promise<void> {
  const stage = `${path}.${randomUUID()}.writing`;
  const file = await open(stage, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(stage, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        attempt >= 10
      )
        throw error;
      await sleep(10 * (attempt + 1));
    }
  }
}

async function scriptFile(path: string, source: string): Promise<void> {
  await durableFile(
    path,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]),
  );
}

async function trustedShell(): Promise<string> {
  if (process.platform !== "win32")
    throw new Error("Command supervision requires Windows.");
  // This is OS installation metadata, never PATH, cwd, a request field, or pwsh.
  const root = process.env.SystemRoot ?? "C:\\Windows";
  if (!isAbsolute(root))
    throw new Error("SystemRoot must identify an absolute Windows installation.");
  const path = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile())
    throw new Error("Windows PowerShell is missing.");
  return canonical;
}

function checkArguments(shell: string, args: readonly string[]): void {
  // Conservatively below both Win32's 32767 and cmd's 8191 limits. User scripts
  // are files; dynamic cmd/npm expansion still has its own runtime limit.
  if ([shell, ...args].join(" ").length * 2 >= 8191) {
    throw new Error("Generated supervisor command line is too long.");
  }
}

async function secureDirectory(
  directory: string,
  shell: string,
): Promise<CommandProcessIdentity["parent"]> {
  await mkdir(directory, { mode: 0o700 }); // Nonrecursive and exclusive: never reuse an attempt.
  const fixedCode = [
    "$ErrorActionPreference='Stop'",
    "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'Windows PowerShell 5.1 required' }",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl=New-Object Security.AccessControl.DirectorySecurity",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
    "$acl.AddAccessRule($rule)",
    `[IO.Directory]::SetAccessControl(${literal(directory)},$acl)`,
    `[Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToFileTimeUtc().ToString()`,
  ].join("; ");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", fixedCode];
  checkArguments(shell, args);
  const result = await execute(shell, args, {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  const creationTime = result.stdout.trim();
  if (!/^\d+$/.test(creationTime))
    throw new Error("Could not establish Node parent creation identity.");
  return { pid: process.pid, creationTime };
}

function validate(input: CommandProcessInput): void {
  if (!isAbsolute(input.directory) || !isAbsolute(input.cwd)) {
    throw new Error("Attempt directory and cwd must be absolute.");
  }
  if (input.directory.includes("\0") || input.cwd.includes("\0"))
    throw new Error("Paths must be NUL-free.");
  if (
    !input.executionId ||
    !input.attemptId ||
    input.executionId.length > 256 ||
    input.attemptId.length > 256
  ) {
    throw new Error("Execution and attempt identities are required and bounded.");
  }
  if (
    !input.command ||
    input.command.includes("\0") ||
    Buffer.byteLength(input.command, "utf8") > MAX_SCRIPT_BYTES
  ) {
    throw new Error("Command must be nonempty, NUL-free, and at most 16 KiB UTF-8.");
  }
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 3_600_000
  ) {
    throw new Error("Runtime must be between 1 ms and 1 hour.");
  }
  if (
    !Number.isFinite(Date.parse(input.startExpiresAt)) ||
    Date.parse(input.startExpiresAt) <= Date.now()
  ) {
    throw new Error("Start authorization is invalid or expired.");
  }
}

async function tailOutput(
  input: CommandProcessInput,
  offsets: Record<"stdout" | "stderr", number>,
): Promise<boolean> {
  let progress = false;
  for (const stream of ["stdout", "stderr"] as const) {
    let file;
    try {
      file = await open(join(input.directory, `${stream}.bin`), "r");
      // A bounded batch, including if a callback is slow or throws. The native
      // supervisor drains independently and keeps no Node-owned output queue.
      for (let chunk = 0; chunk < 8; chunk++) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offsets[stream]);
        if (!bytesRead) break;
        offsets[stream] += bytesRead;
        progress = true;
        try {
          input.onOutput?.(stream, buffer.subarray(0, bytesRead));
        } catch {
          /* Recover from retained bytes. */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await file?.close();
    }
  }
  return progress;
}

async function prepare(
  input: CommandProcessInput,
  shellPath: string,
): Promise<PreparedCommandProcess> {
  validate(input);
  if (!(await stat(input.cwd)).isDirectory())
    throw new Error("Command cwd is not a directory.");
  const parent = await secureDirectory(input.directory, shellPath);
  input = { ...input, directory: await realpath(input.directory) };
  const manifest: Manifest = {
    ...input,
    version: 1,
    shellPath,
    parent,
    jobId: `Local\\fleet-command-${randomUUID()}`,
    controlId: randomUUID(),
    commandSha256: createHash("sha256").update(input.command, "utf8").digest("hex"),
  };
  await mkdir(join(input.directory, "compiler"), { mode: 0o700 });
  await scriptFile(join(input.directory, "command.ps1"), input.command);
  // Capture status immediately. In particular, Windows PowerShell -File alone
  // returns zero for a final failing native command without this wrapper.
  const wrapper = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$global:LASTEXITCODE = 0",
    "try {",
    `  & ${literal(join(input.directory, "command.ps1"))}`,
    "  $fleetSuccess = $?; $fleetNativeExit = $global:LASTEXITCODE",
    "} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
    "if (-not $fleetSuccess -and $fleetNativeExit -eq 0) { exit 1 }",
    "exit $fleetNativeExit",
  ].join("\r\n");
  await scriptFile(join(input.directory, "invoke.ps1"), wrapper);
  await scriptFile(join(input.directory, "supervisor.ps1"), commandSupervisorScript);
  await durableFile(join(input.directory, "manifest.json"), JSON.stringify(manifest));
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    join(input.directory, "supervisor.ps1"),
  ];
  checkArguments(shellPath, args);
  const supervisorEnv = {
    ...process.env,
    TEMP: join(input.directory, "compiler"),
    TMP: join(input.directory, "compiler"),
  };
  // PowerShell's policy gates the fixed compiler bootstrap as well as the user
  // script. The generated executable is private, absolute, and contains no user
  // code. No ExecutionPolicy override or PATH-based launcher is used.
  await execute(shellPath, args, {
    cwd: input.directory,
    windowsHide: true,
    timeout: PREPARE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    env: supervisorEnv,
  });
  const launcher = join(input.directory, "supervisor.exe");
  checkArguments(launcher, []);
  const child: ChildProcess = spawn(launcher, [], {
    cwd: input.directory,
    windowsHide: true,
    // Escape libuv's parent-lifetime job, NOT the command's no-breakaway job.
    // DETACHED_PROCESS works for this native launcher, unlike PowerShell 5.1.
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    // Add-Type's compiler scratch belongs to this exact attempt, not shared TEMP.
    env: supervisorEnv,
  });
  let closed = false;
  let diagnostic = Buffer.alloc(0);
  child.stderr?.on("data", (bytes: Buffer) => {
    const remaining = 64 * 1024 - diagnostic.length;
    if (remaining > 0)
      diagnostic = Buffer.concat([diagnostic, bytes.subarray(0, remaining)]);
  });
  child.once("error", (error) => {
    diagnostic = Buffer.from(error.message);
    closed = true;
  });
  child.once("close", () => {
    closed = true;
  });
  child.unref();
  const control = {
    executionId: input.executionId,
    attemptId: input.attemptId,
    controlId: manifest.controlId,
  };
  const writeControl = (file: string) =>
    durableFile(join(input.directory, file), JSON.stringify(control));
  const preparationStarted = performance.now();
  let identity: CommandProcessIdentity;
  for (;;) {
    const receipt = await readCommandProcessReceipt(input.directory);
    if (receipt.identity?.root && receipt.identity.supervisor && !receipt.result) {
      identity = receipt.identity;
      break;
    }
    if (receipt.result || closed) {
      throw new Error(
        `Command supervisor failed before release: ${receipt.result?.reason ?? diagnostic.toString("utf8").trim() ?? "no readiness receipt"}`,
      );
    }
    if (performance.now() - preparationStarted >= PREPARE_TIMEOUT_MS) {
      await writeControl("cancel.json");
      // Do not kill a still-initializing launcher and manufacture a safe result.
      // It will observe cancellation/expiry or parent loss; the directory stays quarantined.
      throw new Error(
        "Command supervisor readiness timed out; reconcile the attempt directory.",
      );
    }
    await sleep(20);
  }

  let terminal: CommandProcessResult | null = null;
  const offsets = { stdout: 0, stderr: 0 };
  const result = (async (): Promise<CommandProcessResult> => {
    try {
      for (;;) {
        await tailOutput(input, offsets);
        const receipt = await readCommandProcessReceipt(input.directory);
        // Quiescence can be persisted immediately before the terminal receipt.
        if (receipt.result && receipt.result.reason !== "receipt_missing") {
          while (await tailOutput(input, offsets)) {
            /* Drain bounded retained output. */
          }
          terminal = receipt.result;
          return terminal;
        }
        if (closed) {
          // Close can race the reads above. Observe disk once more after close
          // before describing a persisted terminal receipt as missing.
          const final = await readCommandProcessReceipt(input.directory);
          while (await tailOutput(input, offsets)) {
            /* Retained output only. */
          }
          terminal = final.result ?? unknownResult("unknown");
          if (terminal.reason === "receipt_missing")
            terminal.error = boundedError(
              diagnostic.toString("utf8").trim() ||
                "Supervisor exited without terminal evidence.",
            );
          return terminal;
        }
        await sleep(20);
      }
    } catch (error) {
      // A reader/callback problem must never detach control of a running command.
      await writeControl("cancel.json").catch(() => undefined);
      terminal = unknownResult("unknown");
      terminal.error = boundedError(
        error instanceof Error ? error.message : String(error),
      );
      return terminal;
    }
  })();
  let cancelled = false;
  let cancellationPublished = false;
  let released = false;
  let serial = Promise.resolve();
  const serialize = (operation: () => Promise<void>) => {
    const next = serial.then(operation);
    serial = next.catch(() => undefined);
    return next;
  };
  return {
    identity,
    result,
    release: () =>
      serialize(async () => {
        if (terminal) throw new Error("Command attempt has already settled.");
        if (cancelled) throw new Error("Command attempt was cancelled before release.");
        if (released) return;
        if (Date.parse(input.startExpiresAt) <= Date.now())
          throw new Error("Start authorization expired.");
        await writeControl("release.json");
        released = true;
      }),
    cancel: async () => {
      await serialize(async () => {
        if (terminal || cancellationPublished) return;
        cancelled = true;
        await writeControl("cancel.json");
        cancellationPublished = true;
      });
      const completed = await result;
      if (completed.ownership !== "quiescent") {
        throw new Error("Command ownership is unknown; retain the lease and reconcile.");
      }
    },
  };
}

let readiness:
  Promise<{ supported: boolean; reason: string; shellPath?: string }> | undefined;

/**
 * Fixed code, the actual supervisor, actual job assignment and verified emptiness.
 * Cached for this Node lifetime; every prepare still compiles under current policy.
 * This is process ownership, not a sandbox against code running as the same OS user.
 */
export function commandSupervisorReadiness(): Promise<{
  supported: boolean;
  reason: string;
  shellPath?: string;
}> {
  readiness ??= (async () => {
    const directory = resolve(`.command-supervisor-readiness-${randomUUID()}`);
    try {
      const shellPath = await trustedShell();
      const prepared = await prepare(
        {
          executionId: randomUUID(),
          attemptId: randomUUID(),
          directory,
          cwd: process.cwd(),
          command: "[Console]::Write('fleet-command-ready'); exit 0",
          timeoutMs: 10_000,
          startExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        shellPath,
      );
      await prepared.release();
      const result = await prepared.result;
      const output = await readFile(join(directory, "stdout.bin"), "utf8");
      if (
        result.exitCode !== 0 ||
        result.ownership !== "quiescent" ||
        result.descendantCleanupForced ||
        output !== "fleet-command-ready"
      ) {
        throw new Error(
          `Supervisor fixture failed: ${result.reason}; ${result.error ?? ""}`,
        );
      }
      return {
        supported: true,
        reason: "Windows PowerShell 5.1 suspended Job Object supervision verified.",
        shellPath,
      };
    } catch (error) {
      return { supported: false, reason: (error as Error).message };
    } finally {
      const receipt = await readCommandProcessReceipt(directory).catch(() => null);
      // A failed probe with uncertain ownership is deliberately left for inspection.
      if (receipt?.result?.ownership === "quiescent" || !receipt?.identity) {
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        }).catch(() => undefined);
      }
    }
  })();
  return readiness;
}

export async function prepareCommandProcess(
  input: CommandProcessInput,
): Promise<PreparedCommandProcess> {
  validate(input);
  const ready = await commandSupervisorReadiness();
  if (!ready.supported || !ready.shellPath)
    throw new Error(`Command execution is unsupported: ${ready.reason}`);
  return prepare(input, ready.shellPath);
}
