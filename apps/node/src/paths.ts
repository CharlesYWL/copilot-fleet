import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { envFilePath as sharedEnvFilePath } from "@fleet/protocol/runtime";

/**
 * Absolute path of the repo-root `.env`.
 *
 * Anchored on a package.json walk rather than a fixed number of `../` so the
 * sources and the build output, which sit at different depths, agree.
 */
export function envFilePath(
  startDirectory = dirname(fileURLToPath(import.meta.url)),
): string {
  return sharedEnvFilePath(startDirectory);
}
