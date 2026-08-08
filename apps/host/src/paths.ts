import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envFilePath as sharedEnvFilePath,
  packageRoot as sharedPackageRoot,
} from "@fleet/protocol/runtime";

/**
 * Filesystem anchors for this package.
 *
 * The walking itself lives in the protocol package so the Host and the Node
 * agree on where the checkout is; these wrappers only supply the caller's own
 * directory, which is what distinguishes `apps/host` from `apps/node`.
 */
function moduleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** The `@fleet/host` package root, where `data/` and tunnel state live. */
export function packageRoot(startDirectory = moduleDirectory()): string {
  return sharedPackageRoot(startDirectory);
}

/** Absolute path of the repo-root `.env`. */
export function envFilePath(startDirectory = moduleDirectory()): string {
  return sharedEnvFilePath(startDirectory);
}
