import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand, updateCheckout, type CommandResult } from "./updater.js";

/**
 * The scripted tests prove the decisions; this proves the commands.
 *
 * `git pull --ff-only` and `rev-parse` are the two calls whose real behaviour
 * the update depends on, and a stub agreeing with itself would not have caught
 * argument or platform mistakes in the ones actually issued.
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
  return (command: string, args: readonly string[], cwd: string): CommandResult => {
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

describe("updateCheckout against a real repository", () => {
  // Real git plus a Windows shell is far slower than the default per-test budget.
  const timeout = 60_000;

  it(
    "fast-forwards a clone and reports the commit it landed on",
    () => {
      const origin = makeTemp("fleet-origin-");
      git(origin, "init", "--initial-branch=main");
      git(origin, "config", "user.email", "fleet@example.com");
      git(origin, "config", "user.name", "Fleet Test");
      commit(origin, "first.txt", "one");

      const clone = makeTemp("fleet-clone-");
      execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });

      // Nothing new upstream yet: the node must stay up rather than restart.
      const npmCalls: string[] = [];
      const unchanged = updateCheckout({
        repoRoot: clone,
        report: () => {},
        run: gitOnly(npmCalls),
      });
      expect(unchanged).toEqual({ action: "none", reason: "Already up to date" });
      expect(npmCalls).toEqual([]);

      commit(origin, "second.txt", "two");

      const updated = updateCheckout({
        repoRoot: clone,
        report: () => {},
        run: gitOnly(npmCalls),
      });
      expect(updated.action).toBe("restart");
      const head = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
        cwd: clone,
        encoding: "utf8",
      }).trim();
      expect(updated).toEqual({ action: "restart", revision: head });
      // The build has to run before a restart is proposed, or a node could exit
      // into a tree that does not compile.
      expect(npmCalls).toEqual(["npm install", "npm run build:node"]);
    },
    timeout,
  );

  it(
    "refuses to move a checkout that has diverged",
    () => {
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

      // A machine someone has been hacking on locally must say so rather than
      // invent a merge nobody asked for while nobody is watching.
      const npmCalls: string[] = [];
      const outcome = updateCheckout({
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
