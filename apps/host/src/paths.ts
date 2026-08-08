import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Filesystem anchors shared by everything that has to find a file relative to
 * the checkout rather than to the working directory.
 *
 * Counting `../` from `import.meta.url` cannot work for both entry points: the
 * sources live one directory below the package while the build output lives two
 * (`dist/server/`), so the same literal resolved to two different places and the
 * production Host silently loaded no `.env` at all. Walking up to a package.json
 * gives source and build the same answer.
 */

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
    return (
      typeof manifest === "object" && manifest !== null && "workspaces" in manifest
    );
  } catch {
    return false;
  }
}

/** Nearest ancestor that owns a package.json, i.e. the `@fleet/host` package. */
export function packageRoot(startDirectory = moduleDirectory()): string {
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

/** Absolute path of the repo-root `.env` both apps read on startup. */
export function envFilePath(startDirectory = moduleDirectory()): string {
  return resolve(repoRoot(startDirectory), ".env");
}
