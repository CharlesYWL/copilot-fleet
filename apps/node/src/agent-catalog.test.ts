import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogSummary,
  frontmatterDescription,
  installRequestedAgent,
  type CatalogEntry,
} from "./agent-catalog.js";

const entry = (name: string, markdown = `# ${name}`): CatalogEntry => ({
  name,
  description: "",
  path: `/nowhere/${name}.agent.md`,
  markdown,
});

describe("frontmatterDescription", () => {
  it("reads the description a picker will show", () => {
    expect(
      frontmatterDescription("---\nname: x\ndescription: Runs the fleet.\n---\n\nBody"),
    ).toBe("Runs the fleet.");
  });

  it("unwraps a quoted value", () => {
    expect(frontmatterDescription('---\ndescription: "Runs it."\n---\n')).toBe(
      "Runs it.",
    );
  });

  it("answers with nothing rather than guessing", () => {
    // A file with no frontmatter is still a usable agent; only its label is
    // missing, and inventing one would put a wrong sentence in the UI.
    expect(frontmatterDescription("Just a body")).toBe("");
    expect(frontmatterDescription("---\nname: x\n---\n")).toBe("");
  });

  it("survives CRLF, because these files are edited on Windows", () => {
    expect(frontmatterDescription("---\r\ndescription: Runs it.\r\n---\r\n")).toBe(
      "Runs it.",
    );
  });
});

describe("catalogSummary", () => {
  it("sends names and descriptions, never the prose", () => {
    // The Host chooses a role; it has no use for the definition, and a catalog
    // of several agents would put tens of kilobytes on every hello.
    const summary = catalogSummary([entry("fleet-orchestrator", "a very long body")]);
    expect(summary).toEqual([{ name: "fleet-orchestrator", description: "" }]);
  });
});

describe("installRequestedAgent", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fleet-agent-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes the definition where Copilot looks for it", async () => {
    /*
     * Discovery is relative to the session's directory, so shipping the agent
     * with the Node is not enough on its own — without this the picker never
     * appears and the selection has nothing to select.
     */
    const result = await installRequestedAgent(cwd, "fleet-orchestrator", [
      entry("fleet-orchestrator", "# body"),
    ]);

    expect(result).toEqual({ selected: "fleet-orchestrator", reason: "" });
    expect(
      readFileSync(join(cwd, ".github", "agents", "fleet-orchestrator.agent.md"), "utf8"),
    ).toBe("# body");
  });

  it("asks for nothing when the session wanted nothing", async () => {
    expect(await installRequestedAgent(cwd, "", [entry("fleet-orchestrator")])).toEqual({
      selected: "",
      reason: "",
    });
    // An ordinary worker leaves no agent behind in the checkout it borrowed.
    expect(() => readFileSync(join(cwd, ".github", "agents"), "utf8")).toThrow();
  });

  it("starts an ordinary session when this machine has never heard of it", async () => {
    // A Node too old to carry the definition is stale, not broken; refusing
    // here would turn one out-of-date machine into a fleet that cannot start
    // an orchestrator at all.
    const result = await installRequestedAgent(cwd, "fleet-orchestrator", []);

    expect(result.selected).toBe("");
    expect(result.reason).toContain("fleet-orchestrator");
  });

  it("starts an ordinary session when the file cannot be written", async () => {
    const file = join(cwd, "not-a-directory");
    writeFileSync(file, "");

    const result = await installRequestedAgent(file, "fleet-orchestrator", [
      entry("fleet-orchestrator"),
    ]);

    expect(result.selected).toBe("");
    expect(result.reason).toContain("could not write");
  });

  it("overwrites a stale copy rather than trusting what is there", async () => {
    // Resume re-installs, and the definition on this machine may have moved on
    // since the session first started.
    mkdirSync(join(cwd, ".github", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".github", "agents", "fleet-orchestrator.agent.md"), "old");

    await installRequestedAgent(cwd, "fleet-orchestrator", [
      entry("fleet-orchestrator", "new"),
    ]);

    expect(
      readFileSync(join(cwd, ".github", "agents", "fleet-orchestrator.agent.md"), "utf8"),
    ).toBe("new");
  });

  it("keeps itself out of the operator's git status", async () => {
    /*
     * A session's directory is usually a real checkout. Left alone, the agent
     * would show up as an untracked file in someone else's repository — our
     * mess in their working tree. `.git/info/exclude` is local and never
     * committed, so this changes nothing about the repository itself.
     */
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    writeFileSync(join(cwd, ".git", "info", "exclude"), "# existing\nbuild/\n");

    await installRequestedAgent(cwd, "fleet-orchestrator", [entry("fleet-orchestrator")]);

    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".github/agents/fleet-orchestrator.agent.md");
    // What was already there is someone else's decision.
    expect(exclude).toContain("build/");
  });

  it("does not write the same exclude twice across resumes", async () => {
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    const install = () =>
      installRequestedAgent(cwd, "fleet-orchestrator", [entry("fleet-orchestrator")]);

    await install();
    await install();
    await install();

    const lines = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("fleet-orchestrator"));
    expect(lines).toHaveLength(1);
  });

  it("installs anyway when the directory is not a checkout", async () => {
    // A scratch directory has no .git, and that is not a reason to refuse the
    // agent — it is the case where nothing needed excluding.
    const result = await installRequestedAgent(cwd, "fleet-orchestrator", [
      entry("fleet-orchestrator"),
    ]);

    expect(result.selected).toBe("fleet-orchestrator");
    expect(() => readFileSync(join(cwd, ".git", "info", "exclude"), "utf8")).toThrow();
  });

  it("installs anyway when .git is a file, as in a worktree", async () => {
    writeFileSync(join(cwd, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");

    const result = await installRequestedAgent(cwd, "fleet-orchestrator", [
      entry("fleet-orchestrator"),
    ]);

    expect(result.selected).toBe("fleet-orchestrator");
  });
});
