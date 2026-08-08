/**
 * Process helpers shared by the two services.
 *
 * Kept behind its own entry point because the browser bundle imports the
 * protocol root, and nothing in there may touch `process`.
 */

/** True while a pid still names a live process this user may signal. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
