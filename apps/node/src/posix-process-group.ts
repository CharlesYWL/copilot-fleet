import {
  spawn,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

/**
 * Process-group ownership for Linux and macOS.
 *
 * Windows Job Objects can prove that a whole process tree is gone. POSIX has
 * no exact equivalent without cgroups, so ownership here is the process group
 * a detached child leads: every descendant joins it unless it deliberately
 * calls setsid() or setpgid(), and the kernel answers "is anything in this
 * group still alive?" with `kill(-pgid, 0)`. That answer is the proof, the
 * same role the Job Object's active-process count plays on Windows.
 */

/**
 * Referenced on purpose: stopping and verifying a group is required work. An
 * unreferenced timer lets Node exit mid-cleanup once the leader and its pipes
 * are gone, before SIGKILL reaches a member that ignored SIGTERM.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Signal = (pid: number, signal: NodeJS.Signals | 0) => boolean;

/** Whether any process in the group still exists. Never infers from the leader. */
export function processGroupAlive(pgid: number, kill: Signal = process.kill): boolean {
  try {
    kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means a member exists but belongs to someone else; that is still a
    // member, and claiming quiescence over it would be wrong.
    if (code === "EPERM") return true;
    throw error;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals, kill: Signal): void {
  try {
    kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Polls until the group is empty; true only when the kernel says so. */
export async function waitForGroupExit(
  pgid: number,
  timeoutMs: number,
  kill: Signal = process.kill,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!processGroupAlive(pgid, kill)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

export type StopGroupOptions = {
  /** How long well-behaved members get to exit after SIGTERM. */
  graceMs?: number;
  /** How long to wait for the group to empty after SIGKILL. */
  verifyMs?: number;
  kill?: Signal;
};

/**
 * Terminates every member of a group and verifies it is empty.
 *
 * SIGTERM first, so an agent can flush its own state; SIGKILL after the grace
 * period for anything that ignored it. Returns false when emptiness could not
 * be verified (an unkillable process in uninterruptible sleep, for example) so
 * the caller keeps its lease rather than releasing a checkout something still
 * writes to.
 */
export async function stopProcessGroup(
  pgid: number,
  { graceMs = 2_000, verifyMs = 10_000, kill = process.kill }: StopGroupOptions = {},
): Promise<boolean> {
  if (!processGroupAlive(pgid, kill)) return true;
  signalGroup(pgid, "SIGTERM", kill);
  if (await waitForGroupExit(pgid, graceMs, kill)) return true;
  signalGroup(pgid, "SIGKILL", kill);
  return waitForGroupExit(pgid, verifyMs, kill);
}

/** Spawns `command` as the leader of a new process group. */
export function spawnPosixGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcess {
  return spawn(command, args, { ...options, detached: true });
}
