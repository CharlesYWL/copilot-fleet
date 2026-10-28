/**
 * POSIX command supervisor: the Linux/macOS counterpart of the C# supervisor
 * that `command-supervisor-native.ts` compiles on Windows.
 *
 * Started detached by the Node with the attempt directory as its only argument,
 * so it outlives a Node crash and can still prove what happened. It honours the
 * same on-disk contract, which is what lets the Node's receipt reader, the
 * command journal and the Host treat both platforms identically:
 *
 *   manifest.json   written by the Node: identity, cwd, limits, control id
 *   ready.json      root spawned and gated, identity with root/supervisor
 *   release.json    written by the Node once the Host's approval is durable
 *   cancel.json     written by the Node to stop the attempt
 *   started.json    the gate opened; user code may now run
 *   stdout.bin / stderr.bin   retained output (10 MiB total)
 *   quiescent.json  the process group was verified empty
 *   terminal.json   outcome and ownership
 *
 * Ownership is the process group the root leads. The root is `/bin/sh` running
 * `invoke.sh`, which first blocks reading one byte from fd 3. Only this process
 * holds the write end, and it writes that byte after `release.json`; until
 * then no user code runs, which is the role CREATE_SUSPENDED plays on Windows.
 *
 * Dependency-free on purpose (Node built-ins and two small sibling modules that
 * use only built-ins): it is spawned as a plain script and must start even if
 * the Node's own module graph cannot load.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { posixProcessStartTime } from "./posix-process-identity.js";
import { posixShellEnvironment } from "./posix-shell-environment.js";

const OUTPUT_LIMIT = 10 * 1024 * 1024;
const ERROR_LIMIT = 2048;
/** A descendant still leaving at root exit within this window was not forced. */
const ROOT_EXIT_DRAIN_MS = 1_000;
const VERIFY_EMPTY_MS = 10_000;
const POLL_MS = 10;

type ProcessIdentity = { pid: number; creationTime: string };
type Manifest = {
  version: 1;
  executionId: string;
  attemptId: string;
  controlId: string;
  jobId: string;
  commandSha256: string;
  cwd: string;
  shellPath: string;
  timeoutMs: number;
  startExpiresAt: string;
  parent: ProcessIdentity;
};
type StreamSummary = { bytes: number; retainedBytes: number; droppedBytes: number };
type Reason =
  | "exited"
  | "descendant_cleanup"
  | "parent_lost"
  | "start_expired"
  | "timed_out"
  | "cancelled"
  | "supervisor_error";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function bound(message: string, limit = ERROR_LIMIT): string {
  const suffix = "...[truncated]";
  return message.length <= limit
    ? message
    : message.slice(0, limit - suffix.length) + suffix;
}

function durable(directory: string, file: string, value: unknown): void {
  const path = join(directory, file);
  const stage = `${path}.writing`;
  const descriptor = openSync(stage, "w", 0o600);
  try {
    writeSync(descriptor, JSON.stringify(value));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(stage, path);
  // Make the rename itself durable: sync the directory entry.
  const directoryHandle = openSync(directory, "r");
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    // macOS answers EPERM for a group whose remaining members are all zombies
    // (the shell that just exited, not yet reaped). Emptiness is still decided
    // by polling, so a member that really belongs to someone else keeps the
    // group alive and leaves ownership unverified.
    if (code === "EPERM" && process.platform === "darwin") return;
    throw error;
  }
}

async function groupEmpty(pgid: number, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    if (!groupAlive(pgid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

function parentAlive(parent: ProcessIdentity): boolean {
  return posixProcessStartTime(parent.pid) === parent.creationTime;
}

/** Retains at most OUTPUT_LIMIT bytes across both streams, counting the rest. */
class Drain {
  bytes = 0;
  kept = 0;
  failed = false;
  readonly done: Promise<void>;
  private static retained = 0;
  private descriptor: number | undefined;

  constructor(stream: NodeJS.ReadableStream, path: string) {
    try {
      this.descriptor = openSync(path, "wx", 0o600);
    } catch {
      this.failed = true;
    }
    this.done = new Promise((resolve) => {
      stream.on("data", (chunk: Buffer) => {
        this.bytes += chunk.length;
        const keep = Math.min(chunk.length, OUTPUT_LIMIT - Drain.retained);
        if (keep <= 0 || this.descriptor === undefined) return;
        Drain.retained += keep;
        try {
          writeSync(this.descriptor, chunk, 0, keep);
          this.kept += keep;
        } catch {
          this.failed = true;
          this.close();
        }
      });
      stream.once("error", () => {
        this.failed = true;
      });
      stream.once("close", () => {
        this.close();
        resolve();
      });
    });
  }

  private close(): void {
    if (this.descriptor === undefined) return;
    try {
      fsyncSync(this.descriptor);
    } catch {
      this.failed = true;
    }
    closeSync(this.descriptor);
    this.descriptor = undefined;
  }

  summary(): StreamSummary {
    return {
      bytes: this.bytes,
      retainedBytes: this.kept,
      droppedBytes: this.bytes - this.kept,
    };
  }
}

function readControl(directory: string, file: string, manifest: Manifest): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(directory, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (raw.length > 65_536) throw new Error("Oversized control receipt.");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    value.controlId !== manifest.controlId ||
    value.attemptId !== manifest.attemptId ||
    value.executionId !== manifest.executionId
  )
    throw new Error("Control receipt identity mismatch.");
  return true;
}

export async function runSupervisor(directory: string): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  ) as Manifest;
  const supervisorStart = posixProcessStartTime(process.pid);
  const identity: Record<string, unknown> = {
    version: 1,
    executionId: manifest.executionId,
    attemptId: manifest.attemptId,
    directory,
    jobId: manifest.jobId,
    commandSha256: manifest.commandSha256,
    parent: manifest.parent,
    supervisor: supervisorStart
      ? { pid: process.pid, creationTime: supervisorStart }
      : null,
    root: null,
  };
  let phase = "initializing";
  let reason: Reason = "supervisor_error";
  let error: string | null = null;
  let exitCode: number | null = null;
  let started = false;
  let forced = false;
  // Assigned once the root exists; every exit path sets it before reading.
  let quiescent: boolean;
  let root: ChildProcess | undefined;
  let gate: 1 | undefined;
  let openGate: () => Promise<void>;
  let closeGate: () => void = () => undefined;
  let stdout: Drain | undefined;
  let stderr: Drain | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  try {
    phase = "inspect_parent";
    if (!parentAlive(manifest.parent)) {
      reason = "parent_lost";
      return;
    }
    phase = "create_root";
    // fd 3 is the gate: a socket the shell blocks on until this process writes
    // to it. Nothing else holds the other end.
    root = spawn(manifest.shellPath, [join(directory, "invoke.sh"), manifest.shellPath], {
      cwd: manifest.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: posixShellEnvironment(process.env),
    });
    const gateStream = root.stdio[3] as NodeJS.WritableStream & {
      destroy(): void;
    };
    gate = 1;
    closeGate = () => gateStream.destroy();
    openGate = () =>
      new Promise<void>((resolve, reject) =>
        gateStream.write("1\n", (failure) => (failure ? reject(failure) : resolve())),
      );
    quiescent = false;
    const rootPid = root.pid;
    if (!rootPid) throw new Error("The command shell did not start.");
    root.once("exit", (code, signal) => {
      rootExit = { code, signal };
    });
    phase = "inspect_root";
    const rootStart = posixProcessStartTime(rootPid);
    if (!rootStart) throw new Error("Command shell identity could not be read.");
    identity.root = { pid: rootPid, creationTime: rootStart };
    phase = "start_output_drains";
    stdout = new Drain(root.stdout!, join(directory, "stdout.bin"));
    stderr = new Drain(root.stderr!, join(directory, "stderr.bin"));
    durable(directory, "ready.json", identity);

    phase = "parse_limits";
    const expiry = Date.parse(manifest.startExpiresAt);
    let runtimeStart = 0;
    for (;;) {
      phase = "wait_root";
      if (started && rootExit) {
        exitCode =
          rootExit.code ?? (rootExit.signal ? 128 + signalNumber(rootExit.signal) : null);
        forced = !(await groupEmpty(rootPid, ROOT_EXIT_DRAIN_MS));
        reason = forced ? "descendant_cleanup" : "exited";
        break;
      }
      phase = "wait_parent";
      if (!parentAlive(manifest.parent)) {
        reason = "parent_lost";
        break;
      }
      if (!started && Date.now() >= expiry) {
        reason = "start_expired";
        break;
      }
      if (started && performance.now() - runtimeStart >= manifest.timeoutMs) {
        reason = "timed_out";
        break;
      }
      phase = "read_control";
      if (readControl(directory, "cancel.json", manifest)) {
        reason = "cancelled";
        break;
      }
      if (!started && readControl(directory, "release.json", manifest)) {
        if (readControl(directory, "cancel.json", manifest)) {
          reason = "cancelled";
          break;
        }
        if (!parentAlive(manifest.parent)) {
          reason = "parent_lost";
          break;
        }
        if (Date.now() >= expiry) {
          reason = "start_expired";
          break;
        }
        phase = "resume_root";
        runtimeStart = performance.now();
        await openGate();
        closeGate();
        gate = undefined;
        started = true;
        durable(directory, "started.json", {
          identity,
          startedAt: new Date().toISOString(),
        });
      }
      // A root that died before release (e.g. killed) never ran user code.
      if (!started && rootExit) {
        reason = "supervisor_error";
        error = "The command shell exited before release.";
        break;
      }
      await sleep(POLL_MS);
    }
  } catch (caught) {
    error = bound(
      `${phase}: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
    reason = "supervisor_error";
  } finally {
    // Closing an unopened gate gives the shell EOF, and invoke.sh then exits
    // without running user code.
    if (gate !== undefined) closeGate();
    try {
      const pgid = root?.pid;
      // A group that still has members keeps its id, so it cannot have been
      // reused by an unrelated process while we were deciding to signal it.
      if (pgid && groupAlive(pgid)) {
        phase = "terminate_group";
        killGroup(pgid);
        quiescent = await groupEmpty(pgid, VERIFY_EMPTY_MS);
      } else quiescent = true;
    } catch (caught) {
      quiescent = false;
      error = bound(
        `${error ?? ""}\n${phase}: ${caught instanceof Error ? caught.message : String(caught)}`.trim(),
      );
    }
    let outputComplete = true;
    for (const drain of [stdout, stderr]) {
      if (!drain) continue;
      const finished = await Promise.race([
        drain.done.then(() => true),
        sleep(VERIFY_EMPTY_MS).then(() => false),
      ]);
      if (!finished || drain.failed) outputComplete = false;
    }
    const empty = { bytes: 0, retainedBytes: 0, droppedBytes: 0 };
    const result = {
      exitCode,
      reason,
      descendantCleanupForced: forced,
      ownership: quiescent ? "quiescent" : "unknown",
      outcomeKnown:
        reason !== "supervisor_error" && (reason !== "parent_lost" || !started),
      interrupted:
        !quiescent || reason === "supervisor_error" || reason === "parent_lost" || forced,
      timedOut: reason === "timed_out",
      cancelled: reason === "cancelled",
      started,
      outputComplete,
      error,
      completedAt: new Date().toISOString(),
      stdout: stdout?.summary() ?? empty,
      stderr: stderr?.summary() ?? empty,
    };
    try {
      if (quiescent)
        durable(directory, "quiescent.json", {
          identity,
          quiescentAt: new Date().toISOString(),
        });
      durable(directory, "terminal.json", { identity, result });
    } catch (caught) {
      process.stderr.write(
        bound(
          `write_terminal: ${caught instanceof Error ? caught.message : String(caught)}`,
        ),
      );
    }
  }
}

/**
 * The platform's own number for a signal, so `128 + n` matches what a shell
 * reports for the same death (SIGUSR1 is 10 on Linux, 30 on macOS). Exported
 * for tests.
 */
export function signalNumber(signal: NodeJS.Signals): number {
  return (osConstants.signals as Partial<Record<NodeJS.Signals, number>>)[signal] ?? 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && process.argv[2]) {
  // Ignore terminal signals aimed at the Node's group; this process leads its own.
  for (const signal of ["SIGINT", "SIGHUP", "SIGPIPE"] as const)
    process.on(signal, () => undefined);
  await runSupervisor(process.argv[2]);
}
