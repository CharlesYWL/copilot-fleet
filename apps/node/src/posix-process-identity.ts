import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * A process's start time as a decimal string, used with its PID as identity.
 *
 * A PID alone is reused; the pair is not. On Linux this is field 22 of
 * `/proc/<pid>/stat` (clock ticks since boot). Elsewhere (macOS) it is the
 * `ps` start time reduced to its digits, which is stable for one process.
 * Returns undefined when the process no longer exists.
 */
export function posixProcessStartTime(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
    // The command name (field 2) is parenthesised and may contain spaces or
    // parentheses, so split after its last closing parenthesis.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    return start && /^\d+$/.test(start) ? start : undefined;
  }
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Date.parse(started);
    return Number.isFinite(parsed) ? String(parsed) : undefined;
  } catch {
    return undefined;
  }
}
