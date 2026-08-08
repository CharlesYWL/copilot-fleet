import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type PathCheck = { ok: true; kind: "directory" } | { ok: false; reason: string };

/**
 * Checks a placement path against this machine's filesystem.
 *
 * The browser cannot offer a real folder picker — a sandboxed page never learns
 * an absolute path — so the node validates what was typed instead. This turns a
 * typo into an answer here, rather than into a session that starts and then
 * fails somewhere less obvious.
 */
export function inspectPath(input: string): PathCheck {
  const path = input.trim();
  if (!path || !isAbsolute(path)) {
    return { ok: false, reason: "Enter an absolute path" };
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false, reason: "That path does not exist on this machine" };
  }
  if (!stats.isDirectory()) {
    return { ok: false, reason: "That path is a file, not a folder" };
  }
  return { ok: true, kind: "directory" };
}
