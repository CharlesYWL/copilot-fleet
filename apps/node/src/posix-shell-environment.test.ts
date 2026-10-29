import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { posixShellEnvironment } from "./posix-shell-environment.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const bash = ["/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path));

describe("POSIX shell environment", () => {
  it("drops every variable that makes a shell run code before its script", () => {
    const sanitized = posixShellEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/fleet",
      ENV: "/tmp/env.sh",
      BASH_ENV: "/tmp/bash_env.sh",
      SHELLOPTS: "xtrace",
      BASHOPTS: "extdebug",
      PS4: "$(touch /tmp/pwned)",
      "BASH_FUNC_read%%": "() { echo hijacked; }",
      "BASH_FUNC_git%%": "() { echo hijacked; }",
    });
    expect(sanitized).toEqual({ PATH: "/usr/bin", HOME: "/home/fleet" });
  });

  it.skipIf(process.platform === "win32" || !bash)(
    "stops real Bash from reading BASH_ENV or importing functions",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "fleet-shell-env-"));
      directories.push(directory);
      const marker = join(directory, "startup-ran");
      const startup = join(directory, "startup.sh");
      writeFileSync(startup, `printf ran > '${marker}'\n`);
      const hostile = {
        ...process.env,
        BASH_ENV: startup,
        "BASH_FUNC_true%%": "() { printf hijacked; }",
      };
      const run = (env: NodeJS.ProcessEnv) =>
        execFileSync(bash!, ["-c", "true; printf ok"], { env, encoding: "utf8" });
      // Unsanitized, Bash does both, which is what the supervisor must prevent.
      expect(run(hostile)).toBe("hijackedok");
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      expect(run(posixShellEnvironment(hostile))).toBe("ok");
      expect(existsSync(marker)).toBe(false);
    },
  );
});
