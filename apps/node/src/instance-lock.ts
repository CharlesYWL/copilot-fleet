import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_FAILED_CLOSE_CODE, SUPERSEDED_CLOSE_CODE } from "@fleet/protocol";
import { isProcessAlive } from "@fleet/protocol/runtime";

export { AUTH_FAILED_CLOSE_CODE, SUPERSEDED_CLOSE_CODE };

export function shouldReconnectAfterClose(
  code: number | undefined,
  shuttingDown: boolean,
): boolean {
  if (shuttingDown) return false;
  if (code === SUPERSEDED_CLOSE_CODE) return false;
  return true;
}

export type InstanceLock =
  { ok: true; release: () => void } | { ok: false; reason: string };

export function acquireInstanceLock(directory: string): InstanceLock {
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, "node.lock");
  if (existsSync(lockPath)) {
    const existing = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(existing) && existing > 0 && isProcessAlive(existing)) {
      return {
        ok: false,
        reason: `Another fleet node is already running (pid ${existing})`,
      };
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Best-effort stale lock cleanup.
    }
  }

  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    return {
      ok: false,
      reason: "Another fleet node is already running (lock busy)",
    };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = Number(readFileSync(lockPath, "utf8").trim());
      if (current === process.pid) unlinkSync(lockPath);
    } catch {
      // Lock already gone.
    }
  };
  return { ok: true, release };
}
