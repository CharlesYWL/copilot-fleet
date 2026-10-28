/**
 * The environment a Fleet-run POSIX shell is given.
 *
 * Several variables make a shell run code before it reads its script:
 * `BASH_ENV` (Bash, non-interactive) and `ENV` (sh/dash/mksh) name a startup
 * file; `SHELLOPTS=xtrace` with a `PS4` containing a command substitution runs
 * that substitution on every traced line; and Bash imports `BASH_FUNC_<name>%%`
 * variables as functions, which take precedence over builtins such as `read`
 * and over programs on PATH. `/bin/sh` is often Bash, and Fleet runs it by its
 * canonical path, so it is not in POSIX mode and honours all of them.
 *
 * Removing them keeps two promises. Nothing runs before a command's gate opens,
 * and the program a permission rule pinned is the program that runs, not a
 * function of the same name. The permission resolver and the command
 * supervisor use the same environment, so they agree on what a name means.
 */
const STARTUP_VARIABLES = new Set(["ENV", "BASH_ENV", "SHELLOPTS", "BASHOPTS", "PS4"]);

export function posixShellEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !STARTUP_VARIABLES.has(key) && !key.startsWith("BASH_FUNC_"),
    ),
  );
}
