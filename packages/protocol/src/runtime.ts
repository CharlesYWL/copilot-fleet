import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Process and filesystem helpers shared by the two services.
 *
 * Kept behind its own entry point because the browser bundle imports the
 * protocol root, and nothing in there may touch `process` or `node:fs`.
 */

/**
 * What the launcher (`scripts/launcher.mjs`) tells the processes it starts.
 *
 * `npm run dev`, `npm run dev:tunnel` and `npm start` run the Host and its Node
 * under a launcher that can restart them after the Host updates itself; these
 * say where to reach it and prove the request came from inside. The launcher is
 * plain JavaScript and keeps its own copy of the names, which a test holds equal.
 */
export const LAUNCHER_ENDPOINT_ENV = "FLEET_LAUNCHER_ENDPOINT";
export const LAUNCHER_TOKEN_ENV = "FLEET_LAUNCHER_TOKEN";
export const LAUNCHER_SCRIPT_ENV = "FLEET_LAUNCHER_SCRIPT";

/**
 * Removes the launcher's variables from an environment about to be inherited.
 *
 * Only the Host has any use for them. Everything else the launcher starts —
 * the Node, and through it every agent and every command an agent runs — would
 * otherwise carry a token that restarts the Host.
 */
export function forgetLauncherEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  delete env[LAUNCHER_ENDPOINT_ENV];
  delete env[LAUNCHER_TOKEN_ENV];
  delete env[LAUNCHER_SCRIPT_ENV];
}

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

/**
 * Where a Node keeps its identity and settings on this machine.
 *
 * Here rather than in the Node because the Host needs the same answer: updating
 * the Host restarts the Node started beside it, and the identity in this
 * directory is how the Host tells which of its Nodes that is.
 */
export function nodeConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLEET_NODE_CONFIG_DIR !== undefined) {
    if (!isAbsolute(env.FLEET_NODE_CONFIG_DIR)) {
      throw new Error("FLEET_NODE_CONFIG_DIR must be an absolute directory.");
    }
    return env.FLEET_NODE_CONFIG_DIR;
  }
  if (process.platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "CopilotFleet");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "copilot-fleet");
}

/**
 * The semver of the package a module belongs to.
 *
 * Read rather than repeated. Both services used to carry their own
 * `const VERSION = "0.1.0"`, which meant a release had to remember five files
 * — three manifests and two constants — and the constants are the two nobody
 * looks at. They disagree silently: the Host reports one number over `/api/health`
 * while `package.json` says another, and nothing fails.
 *
 * Takes the caller's directory because `import.meta.url` only means anything in
 * the module it is written in; resolving from here would always answer with the
 * protocol package's own version.
 */
export function packageVersion(startDirectory: string, fallback = "0.0.0"): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(resolve(packageRoot(startDirectory), "package.json"), "utf8"),
    );
    if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
      const version = (manifest as { version: unknown }).version;
      if (typeof version === "string" && version) return version;
    }
    return fallback;
  } catch {
    // A missing or unreadable manifest is a packaging problem, not a reason to
    // refuse to start: an unknown version still runs sessions.
    return fallback;
  }
}

/**
 * The commit this checkout is built from, or `""` when that cannot be known.
 *
 * The package version is a constant nobody bumps between deploys, so comparing
 * it across machines reports every Node as current no matter how far behind it
 * is. The commit is what actually differs after a `git pull`, which makes it
 * the only honest answer to "is this machine running my latest code".
 *
 * An empty string is returned rather than a thrown error for the checkout that
 * is not a git repository — a tarball deploy is still a working Node, and it
 * should show up as "unknown", not take the caller down with it.
 */
export function gitRevision(directory = repoRoot()): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
