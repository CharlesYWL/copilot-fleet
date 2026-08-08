import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Process and filesystem helpers shared by the two services.
 *
 * Kept behind its own entry point because the browser bundle imports the
 * protocol root, and nothing in there may touch `process` or `node:fs`.
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

function moduleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function hasPackageJson(directory: string): boolean {
  return existsSync(resolve(directory, "package.json"));
}

function declaresWorkspaces(directory: string): boolean {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(resolve(directory, "package.json"), "utf8"),
    );
    return typeof manifest === "object" && manifest !== null && "workspaces" in manifest;
  } catch {
    return false;
  }
}

/**
 * Nearest ancestor that owns a package.json.
 *
 * Counting `../` from `import.meta.url` cannot work for both entry points: the
 * sources live one directory below their package while the build output lives
 * two (`dist/server/`), so the same literal resolved to two different places and
 * the production Host silently loaded no `.env` at all. Walking up to a
 * package.json gives source and build the same answer.
 */
export function packageRoot(startDirectory: string): string {
  let directory = startDirectory;
  while (!hasPackageJson(directory)) {
    const parent = dirname(directory);
    if (parent === directory) return startDirectory;
    directory = parent;
  }
  return directory;
}

/**
 * The checkout root, where the shared `.env` lives.
 *
 * Identified by the workspace manifest rather than by "topmost package.json",
 * because a checkout placed inside another Node project would otherwise climb
 * straight past its own root.
 */
export function repoRoot(startDirectory = moduleDirectory()): string {
  let directory = startDirectory;
  let outermost: string | undefined;
  for (;;) {
    if (hasPackageJson(directory)) {
      if (declaresWorkspaces(directory)) return directory;
      outermost = directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return outermost ?? startDirectory;
}

/** Absolute path of the repo-root `.env` both services read on startup. */
export function envFilePath(startDirectory = moduleDirectory()): string {
  return resolve(repoRoot(startDirectory), ".env");
}
