import { spawn } from "node:child_process";
import { WorktreeConflict } from "@fleet/protocol";
import type { CheckoutLease } from "./checkout-locks.js";
import { stopProcessTree } from "./process-quiescence.js";

export class GitFailure extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(
      `Git ${args[0] ?? "command"} failed (${exitCode}): ${stderr.trim().slice(0, 1500)}`,
    );
  }
}

export type GitResult = { stdout: string; stderr: string; exitCode: number };
export type GitRunOptions = {
  allowedExitCodes?: readonly number[];
  timeoutMs?: number;
  maxBytes?: number;
  lease?: CheckoutLease;
  stdin?: string;
};

export class GitRunner {
  async run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitResult> {
    if (args.some((arg) => arg.includes("\0")))
      throw new WorktreeConflict("invalid_git_argument", "Invalid Git argument.");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_MERGE_AUTOEDIT: "no",
      GIT_EDITOR: "false",
      LC_ALL: "C",
    });
    options.lease?.processPending();
    const child = spawn("git", ["--no-pager", ...args], {
      cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(options.stdin ?? "");
    if (child.pid) options.lease?.processStarted(child.pid);
    return new Promise<GitResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let stopping: Promise<void> | undefined;
      const stop = (reason: string) => {
        if (stopping) return;
        failure = new WorktreeConflict("git_incomplete", reason);
        stopping = stopProcessTree(child);
        void stopping.catch(() => undefined);
      };
      const timer = setTimeout(
        () => stop("Git exceeded its deadline; reconcile before retrying."),
        options.timeoutMs ?? 30_000,
      );
      timer.unref();
      const capture = (parts: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? 2_000_000)) {
          stop("Git output exceeded the observation limit; cleanliness is unknown.");
        } else parts.push(chunk);
      };
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.once("error", (error) => {
        clearTimeout(timer);
        if (!child.pid) options.lease?.processesQuiesced();
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        void (async () => {
          if (stopping) await stopping;
          options.lease?.processesQuiesced();
          if (failure) throw failure;
          const result = {
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode: code ?? -1,
          };
          if (!(options.allowedExitCodes ?? [0]).includes(result.exitCode)) {
            throw new GitFailure(args, result.exitCode, result.stdout, result.stderr);
          }
          resolve(result);
        })().catch(reject);
      });
    });
  }
}

export type WorktreeRegistryEntry = {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

export function parseWorktreeRegistry(text: string): WorktreeRegistryEntry[] {
  const entries: WorktreeRegistryEntry[] = [];
  let current: WorktreeRegistryEntry | undefined;
  for (const field of text.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = {
        path: field.slice(9),
        head: "",
        branch: "",
        bare: false,
        locked: false,
        prunable: false,
      };
      entries.push(current);
    } else if (current) {
      if (field.startsWith("HEAD ")) current.head = field.slice(5);
      else if (field.startsWith("branch ")) current.branch = field.slice(7);
      else if (field === "bare") current.bare = true;
      else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
      else if (field === "prunable" || field.startsWith("prunable "))
        current.prunable = true;
    }
  }
  if (!entries.length)
    throw new WorktreeConflict(
      "unsupported_git",
      "Git did not return a supported worktree registry.",
    );
  return entries;
}
