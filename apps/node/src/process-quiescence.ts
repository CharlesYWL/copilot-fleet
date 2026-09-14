import {
  execFile,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { promisify } from "node:util";
import { Transform } from "node:stream";
import { jobScript, spawnWindowsJob } from "./windows-process-job.js";

const execute = promisify(execFile);
const jobs = new WeakMap<
  ChildProcess,
  { name: string; closed: Promise<void>; verified: () => boolean }
>();

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
) {
  if (process.platform !== "win32")
    throw new Error("Managed ACP requires verified Windows Job Object ownership.");
  const { child, job, proof } = spawnWindowsJob(command, args, options);
  let verified = false;
  child.stderr = child.stderr.pipe(
    quiescenceStderr(proof, () => {
      verified = true;
    }),
  );
  child.stdio[2] = child.stderr;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  jobs.set(child, { name: job, closed, verified: () => verified });
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
      if (child.exitCode === null && child.signalCode === null && !job.verified()) {
        await execute("powershell.exe", jobScript(`[FleetJob]::Stop('${job.name}')`), {
          windowsHide: true,
          timeout: 15_000,
        }).catch(() => {
          // A concurrent natural exit may destroy the job before OpenJobObject.
          // Only the supervisor's proof below decides whether release is safe.
        });
      }
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
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("Process exit could not be verified; checkout remains locked.")),
      15_000,
    );
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (process.platform === "win32") {
    await execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
    }).catch((error: unknown) => {
      if (child.exitCode === null && child.signalCode === null) throw error;
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await closed;
}
