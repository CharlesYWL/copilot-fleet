import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand, updateCheckout, type CommandResult } from "./updater.js";

/**
 * The scripted tests prove the decisions; this proves the commands.
 *
 * `git fetch`, the upstream lookup and `git reset --hard` are the calls whose
 * real behaviour the update depends on, and a stub agreeing with itself would
 * not have caught argument or platform mistakes in the ones actually issued —
 * `@{u}` in particular travels through a shell on Windows.
 */

const temporary: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeTemp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporary) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Real git, stubbed npm: a temp checkout has no dependencies to install. */
function gitOnly(record: string[]) {
  return async (
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<CommandResult> => {
    if (command !== "git") {
      record.push(`${command} ${args.join(" ")}`);
      return { ok: true, output: "" };
    }
    return runCommand(command, args, cwd);
  };
}

function commit(repository: string, file: string, contents: string): void {
  writeFileSync(join(repository, file), contents);
  git(repository, "add", ".");
  git(repository, "commit", "-m", `add ${file}`);
}

/** The commit a repository is on; `short` matches what the update reports. */
function head(repository: string, short = false): string {
  return execFileSync(
    "git",
    short ? ["rev-parse", "--short=12", "HEAD"] : ["rev-parse", "HEAD"],
    {
      cwd: repository,
      encoding: "utf8",
    },
  ).trim();
}

describe("updateCheckout against a real repository", () => {
  // Real git plus a Windows shell is far slower than the default per-test budget.
  const timeout = 60_000;

  it(
    "moves a clone onto the remote and reports the commit it landed on",
    async () => {
      const origin = makeTemp("fleet-origin-");
      git(origin, "init", "--initial-branch=main");
      git(origin, "config", "user.email", "fleet@example.com");
      git(origin, "config", "user.name", "Fleet Test");
      commit(origin, "first.txt", "one");

      const clone = makeTemp("fleet-clone-");
      execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });

      // Nothing new upstream yet: the node must stay up rather than restart.
      const npmCalls: string[] = [];
      const unchanged = await updateCheckout({
        repoRoot: clone,
        report: () => {},
        run: gitOnly(npmCalls),
      });
      expect(unchanged).toEqual({ action: "none", reason: "Already up to date" });
      expect(npmCalls).toEqual([]);

      commit(origin, "second.txt", "two");

      const updated = await updateCheckout({
        repoRoot: clone,
        report: () => {},
        run: gitOnly(npmCalls),
      });
      expect(updated.action).toBe("restart");
      expect(updated).toEqual({ action: "restart", revision: head(clone, true) });
      // The build has to run before a restart is proposed, or a node could exit
      // into a tree that does not compile.
      expect(npmCalls).toEqual(["npm install", "npm run build:node"]);
    },
    timeout,
  );

  it(
    "forces a diverged checkout onto the remote",
    async () => {
      const origin = makeTemp("fleet-origin2-");
      git(origin, "init", "--initial-branch=main");
      git(origin, "config", "user.email", "fleet@example.com");
      git(origin, "config", "user.name", "Fleet Test");
      commit(origin, "first.txt", "one");

      const clone = makeTemp("fleet-clone2-");
      execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });
      git(clone, "config", "user.email", "fleet@example.com");
      git(clone, "config", "user.name", "Fleet Test");

      commit(origin, "upstream.txt", "theirs");
      commit(clone, "local.txt", "mine");
      // A tracked file edited on the box as well: a fast-forward refused over
      // either of these, and refusing is how a machine falls a month behind.
      writeFileSync(join(clone, "first.txt"), "hand-edited");
      // Nothing the remote tracks stands here, so this has to survive — it is
      // where a node keeps the address of the Host it answers to.
      writeFileSync(join(clone, ".env"), "FLEET_HOST_URL=http://127.0.0.1:8787");

      const npmCalls: string[] = [];
      const outcome = await updateCheckout({
        repoRoot: clone,
        report: () => {},
        run: gitOnly(npmCalls),
      });

      expect(outcome.action).toBe("restart");
      expect(head(clone)).toBe(head(origin));
      expect(readFileSync(join(clone, "upstream.txt"), "utf8")).toBe("theirs");
      expect(readFileSync(join(clone, "first.txt"), "utf8")).toBe("one");
      expect(existsSync(join(clone, "local.txt"))).toBe(false);
      expect(existsSync(join(clone, ".env"))).toBe(true);
      expect(npmCalls).toEqual(["npm install", "npm run build:node"]);
    },
    timeout,
  );

  it(
    "stops on a branch with no upstream rather than guessing at one",
    async () => {
      const origin = makeTemp("fleet-origin3-");
      git(origin, "init", "--initial-branch=main");
      git(origin, "config", "user.email", "fleet@example.com");
      git(origin, "config", "user.name", "Fleet Test");
      commit(origin, "first.txt", "one");

      const clone = makeTemp("fleet-clone3-");
      execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });
      git(clone, "checkout", "-b", "detour");

      // Resetting onto origin/main here would move the machine off the branch
      // someone deliberately put it on, so the update says so and stops.
      const npmCalls: string[] = [];
      const outcome = await updateCheckout({
        repoRoot: clone,
        report: () => {},
        run: gitOnly(npmCalls),
      });
      expect(outcome.action).toBe("failed");
      expect(npmCalls).toEqual([]);
    },
    timeout,
  );
});
