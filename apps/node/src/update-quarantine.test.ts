import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeAdmission } from "./node-admission.js";
import { UpdateQuarantine, UPDATE_QUARANTINE_REASON } from "./update-quarantine.js";
import { updateCheckout, type RunCommand } from "./updater.js";

const roots: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fleet-update-quarantine-"));
  roots.push(directory);
  const root = join(directory, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  const admission = new NodeAdmission();
  const quarantine = new UpdateQuarantine(admission, directory, root, "a".repeat(12));
  return { directory, root, admission, quarantine };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("update admission quarantine", () => {
  it("does not quarantine a failure before the first mutation", async () => {
    const f = fixture();
    const beforeMutation = vi.fn(() => f.quarantine.beforeMutation());
    const outcome = await updateCheckout({
      repoRoot: f.root,
      report() {},
      beforeMutation,
      run: async () => ({ ok: false, output: "cannot read HEAD" }),
    });
    expect(outcome.action).toBe("failed");
    expect(beforeMutation).not.toHaveBeenCalled();
    expect(f.admission.reason).toBe("");
  });

  it("persists a mutation failure across restarts and permits only an explicit guarded retry", async () => {
    const f = fixture();
    const close = f.admission.close("Updating");
    const run: RunCommand = async (command, args) => {
      if (command === "git" && args[0] === "rev-parse") {
        return { ok: true, output: args[1] === "HEAD" ? "a".repeat(40) : "origin/main" };
      }
      if (command === "git")
        expect(f.admission.quarantined).toBe(UPDATE_QUARANTINE_REASON);
      return { ok: command !== "npm", output: "install failed" };
    };
    const outcome = await updateCheckout({
      repoRoot: f.root,
      report() {},
      run,
      forceRebuild: true,
      beforeMutation: () => f.quarantine.beforeMutation(),
    });
    expect(outcome.action).toBe("failed");
    f.quarantine.restoreBlock();
    close();
    expect(() => f.admission.enter("new command")).toThrow();
    const restarted = new NodeAdmission();
    const recovery = new UpdateQuarantine(restarted, f.directory, f.root, "a".repeat(12));
    expect(restarted.reason).toBe(UPDATE_QUARANTINE_REASON);
    const reopen = restarted.close("Explicit update retry");
    expect(recovery.prepareRetry()).toBe(true);
    expect(() => restarted.enter("racing command")).toThrow();
    recovery.restoreBlock();
    reopen();
    expect(restarted.reason).toBe(UPDATE_QUARANTINE_REASON);
  });

  it("forces install/build even when Git already reached the running revision", async () => {
    const f = fixture();
    const calls: string[] = [];
    const outcome = await updateCheckout({
      repoRoot: f.root,
      runningRevision: "a".repeat(12),
      forceRebuild: true,
      beforeMutation: () => f.quarantine.beforeMutation(),
      report() {},
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return {
          ok: true,
          output:
            args[0] === "rev-parse" && args[1] === "HEAD"
              ? "a".repeat(40)
              : "origin/main",
        };
      },
    });
    expect(outcome).toEqual({ action: "restart", revision: "a".repeat(12) });
    expect(calls).toContain("npm install --include=dev");
    expect(calls).toContain("npm run build:node");
    f.quarantine.built("a".repeat(12));
    expect(f.admission.reason).toBe(UPDATE_QUARANTINE_REASON);
    const wrongBuild = new NodeAdmission();
    new UpdateQuarantine(wrongBuild, f.directory, f.root, "b".repeat(12));
    expect(wrongBuild.reason).toBe(UPDATE_QUARANTINE_REASON);
    const restarted = new NodeAdmission();
    new UpdateQuarantine(restarted, f.directory, f.root, "a".repeat(12));
    expect(restarted.reason).toBe("");
  });

  it("does not clear another unresolved ownership quarantine", () => {
    const f = fixture();
    f.quarantine.beforeMutation();
    f.admission.quarantine("Unknown process ownership");
    f.quarantine.prepareRetry();
    f.quarantine.restoreBlock();
    expect(f.admission.reason).toBe("Unknown process ownership");
  });
});
