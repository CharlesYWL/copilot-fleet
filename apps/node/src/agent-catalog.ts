import { readdir, readFile, mkdir, writeFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { NodeAgentSchema, type NodeAgent } from "@fleet/protocol";
import { configDirectory } from "./config.js";
import { packageRoot } from "./paths.js";

/**
 * The Copilot agents this machine can put a session into.
 *
 * Two sources, one catalog:
 *
 * - **built-in**, shipped with the Node package, so a fleet gets a working
 *   orchestrator without anyone installing anything;
 * - **the operator's own**, under the node config directory, so a machine can
 *   offer roles we did not write.
 *
 * The second source is not a nicety. Agent definitions worth having are often
 * someone else's, under someone else's licence — an operator may install those
 * on their own machine under terms they accepted, which is a different act from
 * us redistributing them.
 *
 * Markdown rather than TypeScript string literals, and outside `src/` so `tsc`
 * has nothing to copy: an agent is prose, and prose in a `.ts` file stops being
 * editable by the people who are best at writing it.
 */

/** Where an operator drops agents of their own. */
export function userAgentDirectory(): string {
  return join(configDirectory(), "agents");
}

/** Where the agents we ship live, in the package rather than in `dist/`. */
export function builtinAgentDirectory(): string {
  return join(packageRoot(), "agents");
}

export type CatalogEntry = NodeAgent & {
  /** The file this came from, so a broken one can be named. */
  path: string;
  markdown: string;
};

const SUFFIX = ".agent.md";

/**
 * Everything this Node can offer, with the operator's copies winning.
 *
 * Shadowing by name is deliberate: an operator who writes their own
 * `fleet-orchestrator` has decided how their fleet should think, and a built-in
 * that silently outranked them would make that undoable without a fork.
 */
export async function readAgentCatalog(): Promise<CatalogEntry[]> {
  const byName = new Map<string, CatalogEntry>();
  for (const directory of [builtinAgentDirectory(), userAgentDirectory()]) {
    for (const entry of await readDirectory(directory)) {
      byName.set(entry.name, entry);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What the Host is told: names and descriptions, never the prose. */
export function catalogSummary(entries: readonly CatalogEntry[]): NodeAgent[] {
  return entries.map(({ name, description }) => ({ name, description }));
}

/**
 * Puts an agent where Copilot will find it.
 *
 * Discovery is relative to the session's working directory, so shipping the
 * definition with the Node is not enough on its own — it has to land beneath the
 * session before `session/new`, or no picker appears at all.
 */
export async function installAgent(cwd: string, entry: CatalogEntry): Promise<void> {
  const directory = join(cwd, ".github", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${entry.name}${SUFFIX}`), entry.markdown, "utf8");
  await excludeLocally(cwd, `.github/agents/${entry.name}${SUFFIX}`);
}

/**
 * Keeps an installed agent out of the operator's git status.
 *
 * A session's working directory is usually a real checkout — the orchestrator
 * is handed one because every session needs somewhere to be, not because it
 * should touch anything there. Writing a file into it would otherwise show up
 * as an untracked change in the operator's own repository, which is our mess in
 * their working tree.
 *
 * `.git/info/exclude` is the right place precisely because it is not the
 * repository's business: it is local, never committed, and leaves `.gitignore`
 * alone. Anything unexpected — a worktree whose `.git` is a file, a directory
 * that is not a checkout, a read-only `.git` — means no exclude and one
 * untracked file, which is a blemish rather than a failure.
 *
 * Reading before appending is not atomic, so two sessions starting on the same
 * checkout at the same instant can each write the line. That is left alone
 * deliberately: git treats a repeated exclude pattern as the same pattern, the
 * duplicate is bounded by how many sessions start at once rather than growing
 * per start, and a lock file would be more machinery than a cosmetic blemish in
 * a local file is worth.
 */
async function excludeLocally(cwd: string, relativePath: string): Promise<void> {
  try {
    const info = join(cwd, ".git", "info");
    if (!(await stat(join(cwd, ".git")).then((s) => s.isDirectory()))) return;
    await mkdir(info, { recursive: true });
    const file = join(info, "exclude");
    const current = await readFile(file, "utf8").catch(() => "");
    if (current.split(/\r?\n/).includes(relativePath)) return;
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await appendFile(file, `${separator}${relativePath}\n`, "utf8");
  } catch {
    return;
  }
}

/**
 * Installs the agent a command asked for, and answers with what to select.
 *
 * An empty answer means "start an ordinary session", and it covers three cases
 * that all deserve the same treatment: nothing was asked for, this machine has
 * never heard of what was asked for, or the file could not be written. A Node
 * that refused to start a session over a missing agent would turn a stale
 * machine into a broken one — the orchestrator is worth more without its
 * definition than not at all.
 */
export async function installRequestedAgent(
  cwd: string,
  requested: string,
  catalog: readonly CatalogEntry[],
): Promise<{ selected: string; reason: string }> {
  if (!requested) return { selected: "", reason: "" };
  const entry = catalog.find((candidate) => candidate.name === requested);
  if (!entry) {
    return { selected: "", reason: `this node has no agent named "${requested}"` };
  }
  try {
    await installAgent(cwd, entry);
    return { selected: entry.name, reason: "" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { selected: "", reason: `could not write the agent into ${cwd}: ${detail}` };
  }
}

async function readDirectory(directory: string): Promise<CatalogEntry[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // A machine with no agents of its own is the ordinary case, not a fault.
    return [];
  }

  const found: CatalogEntry[] = [];
  for (const file of names) {
    if (!file.endsWith(SUFFIX)) continue;
    const path = join(directory, file);
    try {
      const markdown = await readFile(path, "utf8");
      const parsed = NodeAgentSchema.safeParse({
        name: file.slice(0, -SUFFIX.length),
        description: frontmatterDescription(markdown),
      });
      // One unreadable or badly named file is not a reason to offer nothing.
      if (parsed.success) found.push({ ...parsed.data, path, markdown });
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * The `description:` line from YAML frontmatter.
 *
 * Parsed by hand rather than with a YAML dependency: one scalar off the top of
 * a file the same package wrote is not worth a parser, and a wrong answer costs
 * a label in a picker rather than anything a session depends on.
 */
export function frontmatterDescription(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return "";
  const line = /^description:\s*(.+)$/m.exec(match[1] ?? "");
  const value = line?.[1]?.trim() ?? "";
  return value.replace(/^["']|["']$/g, "").slice(0, 200);
}
