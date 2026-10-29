import {
  execFile,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { promisify } from "node:util";
import { Transform } from "node:stream";
import { jobScript, spawnWindowsJob } from "./windows-process-job.js";
import {
  processGroupAlive,
  spawnPosixGroup,
  stopProcessGroup,
  waitForGroupExit,
} from "./posix-process-group.js";

const execute = promisify(execFile);

/**
 * How a managed child's whole tree is stopped and proven gone.
 *
 * `stop` asks the tree to end; `verified` reports whether emptiness was proven.
 * On Windows the proof is the supervisor's stderr line after the Job Object
 * drains; on POSIX it is the kernel reporting the process group empty.
 */
type ManagedOwnership = {
  closed: Promise<void>;
  verified: () => boolean;
  stop: () => Promise<void>;
};
const jobs = new WeakMap<ChildProcess, ManagedOwnership>();

/**
 * How long a managed POSIX tree may take to empty once its leader exits.
 *
 * Mirrors the Windows supervisor, which terminates the job when the root
 * exits and then waits for it to drain. Background work an agent leaves
 * behind does not outlive the agent's session.
 */
const POSIX_LEADER_EXIT_DRAIN_MS = 1_000;

export function killPosixProcessGroup(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals) => boolean = process.kill,
): void {
  try {
    kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    // macOS: EPERM for a group of zombies only; there is nothing left to kill.
    if (code === "EPERM" && process.platform === "darwin") return;
    throw error;
  }
}

/**
 * Whether a child should lead its own process group.
 *
 * On Linux and macOS the tree is stopped by signalling the group, which only
 * exists if the child was spawned detached. Otherwise the child shares this
 * process's group, the group kill finds nothing, and the agent and everything
 * it started survive the stop. Windows uses taskkill or a Job Object instead.
 */
export const OWN_PROCESS_GROUP = process.platform !== "win32";

const liveProcessGroups = new Set<number>();
let exitCleanupInstalled = false;

/** Kills every tracked group; for this process's own exit, so it never throws. */
export function killTrackedProcessGroups(): void {
  for (const pid of liveProcessGroups) {
    try {
      killPosixProcessGroup(pid);
    } catch {
      // Exiting anyway; a group that cannot be signalled cannot be helped here.
    }
  }
  liveProcessGroups.clear();
}

/**
 * Remembers a detached child's group until the group is empty.
 *
 * A detached group no longer receives the terminal's Ctrl-C and is not taken
 * down with this process, so an exit without a clean shutdown (a crash, or
 * `process.exit` on a fatal error) would otherwise leave agents running with
 * nobody to stop them. That includes descendants still running after their
 * leader exits, while asynchronous cleanup is underway, so the group is kept
 * until the kernel reports it empty, not merely until the leader exits. The
 * kernel does not reuse a PID while it still names a process group, so a group
 * kept this way is never someone else's.
 */
export function trackProcessGroup(child: ChildProcess): void {
  if (!OWN_PROCESS_GROUP || !child.pid) return;
  const pid = child.pid;
  liveProcessGroups.add(pid);
  child.once("exit", () => forgetWhenEmpty(pid));
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", killTrackedProcessGroups);
}

/** How often a tracked group whose leader has exited is checked for emptiness. */
const EMPTY_GROUP_POLL_MS = 250;

function forgetWhenEmpty(pgid: number): void {
  if (!liveProcessGroups.has(pgid)) return;
  let alive: boolean;
  try {
    alive = processGroupAlive(pgid);
  } catch {
    // An answer the kernel would not give proves nothing; keep the group.
    alive = true;
  }
  if (!alive) {
    liveProcessGroups.delete(pgid);
    return;
  }
  // Bookkeeping only: this must not keep the Node alive, and the exit handler
  // kills whatever is still tracked if it exits first.
  setTimeout(() => forgetWhenEmpty(pgid), EMPTY_GROUP_POLL_MS).unref();
}

/** Whether a group is still remembered for exit cleanup; for tests. */
export function processGroupTracked(pgid: number): boolean {
  return liveProcessGroups.has(pgid);
}

function quiescenceStderr(proof: string, verified: () => void): Transform {
  const expected = Buffer.from(proof);
  const expectedCR = Buffer.from(`${proof}\r`);
  let pending = Buffer.alloc(0);
  let passthrough = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        if (!passthrough) {
          // Only a possible proof prefix is buffered, never an unbounded
          // diagnostic line. Keep bytes intact across UTF-8/chunk boundaries.
          const length = pending.length + part.length;
          const candidate =
            length <= expectedCR.length ? Buffer.concat([pending, part]) : undefined;
          if (candidate && expectedCR.subarray(0, length).equals(candidate)) {
            pending = candidate;
          } else {
            this.push(pending);
            pending = Buffer.alloc(0);
            passthrough = true;
          }
        }
        if (passthrough) this.push(part);
        if (newline !== -1) {
          if (!passthrough && (pending.equals(expected) || pending.equals(expectedCR))) {
            verified();
          } else {
            this.push(pending);
            this.push(Buffer.from("\n"));
          }
          pending = Buffer.alloc(0);
          passthrough = false;
        }
        start = end + 1;
      }
      done();
    },
    flush(done) {
      // EOF without a line terminator is diagnostic text, not proof.
      this.push(pending);
      done();
    },
  });
}

export function spawnManagedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return process.platform === "win32"
    ? spawnWindowsManaged(command, args, options)
    : spawnPosixManaged(command, args, options);
}

function spawnWindowsManaged(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  const { child, job, proof } = spawnWindowsJob(command, args, options);
  let verified = false;
  child.stderr = child.stderr.pipe(
    quiescenceStderr(proof, () => {
      verified = true;
    }),
  );
  child.stdio[2] = child.stderr;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  jobs.set(child, {
    closed,
    verified: () => verified,
    stop: async () => {
      await execute("powershell.exe", jobScript(`[FleetJob]::Stop('${job}')`), {
        windowsHide: true,
        timeout: 15_000,
      }).catch(() => {
        // A concurrent natural exit may destroy the job before OpenJobObject.
        // Only the supervisor's proof decides whether release is safe.
      });
    },
  });
  return child;
}

/**
 * The POSIX counterpart of a Job Object: the child leads a new process group.
 *
 * When the leader exits, whatever it left behind in its group is ended and the
 * group is checked empty, as the Windows supervisor terminates and drains its
 * job. `closed` resolves only once that check has run, so a lease is never
 * released while the leader's descendants could still write to the checkout.
 *
 * The check starts on `exit`, not `close`. `close` also waits for stdio to end,
 * and a surviving descendant holds those pipes open, so waiting for it would
 * wait on the very process the cleanup is meant to end.
 */
function spawnPosixManaged(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  const child = spawnPosixGroup(command, args, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const pgid = child.pid;
  let verified = false;
  const verify = async (): Promise<void> => {
    if (!pgid) return;
    try {
      verified =
        (await waitForGroupExit(pgid, POSIX_LEADER_EXIT_DRAIN_MS)) ||
        (await stopProcessGroup(pgid, { graceMs: 0 }));
    } catch {
      // A signal that cannot be delivered (EPERM, say) proves nothing about the
      // group. Ownership stays unverified, which keeps the checkout locked for
      // reconciliation, and nothing escapes as an unhandled rejection.
      verified = false;
    }
  };
  const closed = new Promise<void>((resolve) => {
    child.once("exit", () => void verify().then(resolve));
    // A spawn that failed never had a group, so there is nothing to own.
    child.once("error", () => {
      if (!pgid) {
        verified = true;
        resolve();
      }
    });
  });
  jobs.set(child, {
    closed,
    verified: () => verified,
    stop: async () => {
      if (pgid && processGroupAlive(pgid)) await stopProcessGroup(pgid);
    },
  });
  return child;
}

/** Waits for process-tree termination, not just for a signal to be sent. */
export async function stopProcessTree(
  child: ChildProcess,
  requireOwnership = false,
): Promise<void> {
  if (!child.pid) return;
  const job = jobs.get(child);
  if (job) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A natural exit also empties the job, including orphaned grandchildren.
      // Missing proof (e.g. a killed supervisor) is never inferred from a PID.
      if (child.exitCode === null && child.signalCode === null && !job.verified())
        await job.stop();
      await Promise.race([
        job.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Managed process supervisor did not close.")),
            15_000,
          );
        }),
      ]);
      if (!job.verified())
        throw new Error("Process-tree ownership is unknown; reconciliation is required.");
      return;
    } finally {
      clearTimeout(timer);
    }
  }
  const pid = child.pid;
  if (!pid) return;
  if (requireOwnership)
    throw new Error("Process-tree ownership is unknown; reconciliation is required.");
  if (child.exitCode !== null || child.signalCode !== null) return;
  let disposeWait: (() => void) | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("Process exit could not be verified; checkout remains locked.")),
      15_000,
    );
    timer.unref();
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    disposeWait = () => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
  const terminate = async () => {
    if (process.platform === "win32") {
      await execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000,
      }).catch((error: unknown) => {
        if (child.exitCode === null && child.signalCode === null) throw error;
      });
    } else {
      killPosixProcessGroup(pid);
    }
  };
  try {
    // Observe both promises before waiting: taskkill must not orphan the exit deadline.
    await Promise.all([closed, terminate()]);
  } finally {
    disposeWait?.();
  }
}
