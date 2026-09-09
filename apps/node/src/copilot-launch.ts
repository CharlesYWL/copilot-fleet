import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

export type CopilotLaunch = {
  command: string;
  args: readonly string[];
  provider: "copilot" | "agency";
  notice?: string;
};

/**
 * Resolve on the executing Node, not the Host. Missing installations are not
 * cached so installing Agency can take effect on the very next launch.
 */
export async function findAgencyCommand(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const windows = process.platform === "win32";
  const extensions = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((extension) => /^\.(?:com|exe|bat|cmd)$/i.test(extension))
        .map((extension) => extension.toLowerCase())
    : [""];
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(resolve(directory), `agency${extension}`);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          continue;
        }
        throw error;
      }
    }
  }
  return undefined;
}

export async function resolveCopilotLaunch(
  agencyMode: boolean,
  copilotCommand: string,
  findAgency: () => Promise<string | undefined> = findAgencyCommand,
): Promise<CopilotLaunch> {
  if (agencyMode) {
    const command = await findAgency();
    if (command) {
      return {
        command,
        args: ["copilot"],
        provider: "agency",
        notice: "Using Agency Copilot on this node.",
      };
    }
  }
  return {
    command: copilotCommand || process.env.FLEET_COPILOT_COMMAND || "copilot",
    args: [],
    provider: "copilot",
    ...(agencyMode
      ? {
          notice:
            "Agency mode is enabled, but Agency was not found on this node's PATH. Falling back to standard Copilot.",
        }
      : {}),
  };
}

/** Native executables do not need a shell; npm's Windows shims do. */
export function copilotSpawnTarget(command: string): {
  command: string;
  shell: boolean;
} {
  const shell = process.platform === "win32" && !/\.(?:exe|com)$/i.test(command);
  return {
    command: shell && /\s/.test(command) ? `"${command}"` : command,
    shell,
  };
}
