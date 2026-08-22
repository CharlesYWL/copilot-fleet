import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envFilePath as sharedEnvFilePath,
  packageRoot as sharedPackageRoot,
  packageVersion as sharedPackageVersion,
} from "@fleet/protocol/runtime";

function moduleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** The `@fleet/node` package root, where shipped assets like `agents/` live. */
export function packageRoot(startDirectory = moduleDirectory()): string {
  return sharedPackageRoot(startDirectory);
}

/**
 * Absolute path of the repo-root `.env`.
 *
 * Anchored on a package.json walk rather than a fixed number of `../` so the
 * sources and the build output, which sit at different depths, agree.
 */
export function envFilePath(startDirectory = moduleDirectory()): string {
  return sharedEnvFilePath(startDirectory);
}

/** This package's semver, as `package.json` declares it. */
export function packageVersion(startDirectory = moduleDirectory()): string {
  return sharedPackageVersion(startDirectory);
}
