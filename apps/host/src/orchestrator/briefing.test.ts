import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { orchestratorBriefing } from "./briefing.js";
import { fleet } from "./fleet-harness.js";
import { LeadTokens } from "./lead-tokens.js";
import { MCP_PATH, mcpRoutes } from "./mcp-routes.js";

/** Every tool the orchestrator is actually offered, read from the live server. */
async function registeredTools(): Promise<string[]> {
  const world = fleet();
  const app = Fastify();
  app.log.level = "silent";
  const tokens = new LeadTokens({
    getSetting: () => undefined,
    setSetting: () => {},
  });
  const token = tokens.mint(world.leadId);
  await app.register(mcpRoutes, { service: world.service, tokens });
  await app.ready();
  const response = await app.inject({
    method: "POST",
    url: MCP_PATH,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  const body = response.json() as { result: { tools: { name: string }[] } };
  await app.close();
  return body.result.tools.map((tool) => tool.name);
}

/** Tool names a piece of prose tells the orchestrator to call. */
function toolsNamedIn(text: string): string[] {
  return [...new Set(text.match(/fleet_[a-z_]+/g) ?? [])];
}

// Relative to this file rather than the working directory, because the runner
// starts at the repo root and the packages build from their own.
const agentFile = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "node",
    "agents",
    "fleet-orchestrator.agent.md",
  ),
  "utf8",
);

describe("what the orchestrator is told", () => {
  /*
   * The whole reason the briefing is a prompt rather than a file shipped with
   * the Node: it travels with the Host, so it can name the tools this build
   * actually has. That only holds if something checks.
   *
   * This is not hypothetical. `fleet_escalate` was named in three places —
   * the briefing, the agent file, and the refusal a blocked orchestrator gets
   * from fleet_submit_task — while never being registered. An orchestrator
   * that hit an impossible criterion was told to call a tool that did not
   * exist, having already been refused the only other way out.
   */
  it("names no tool this Host does not offer", async () => {
    const registered = new Set(await registeredTools());
    const named = toolsNamedIn(orchestratorBriefing("nodes", { hasAgent: false }));

    expect(named.length).toBeGreaterThan(4);
    expect(named.filter((name) => !registered.has(name))).toEqual([]);
  });

  it("does not send the agent file's judgement a second time", () => {
    /*
     * Both halves used to say the same six things, with nothing keeping them in
     * step. Whichever copy someone edits, the other goes stale — and the model
     * reads both.
     */
    const attached = orchestratorBriefing("nodes", { hasAgent: true });

    expect(attached).not.toContain("A worker's report is a lead");
    expect(attached).not.toContain("What done means");
    expect(attached).not.toContain("Reading your own history");
  });

  it("still says everything when the machine has no orchestrator agent", () => {
    // The degradation path: an older Node, or one whose catalog lacks the file.
    // A session with the whole policy in a prompt beats one with half of it.
    const standalone = orchestratorBriefing("nodes", { hasAgent: false });

    expect(standalone).toContain("What done means");
    expect(standalone).toContain("not evidence");
    expect(standalone).toContain("failed three times");
  });

  it("carries the mechanics either way, because only the Host knows them", () => {
    // These change with this package. A copy on a Node would go stale, so they
    // are the one thing the briefing must always carry.
    for (const hasAgent of [true, false]) {
      const text = orchestratorBriefing("NODE-SUMMARY-HERE", { hasAgent });
      expect(text).toContain("fleet_advance_task");
      expect(text).toContain("fleet_transcript");
      expect(text).toContain("<fleet-wake>");
      expect(text).toContain("review-quick");
      expect(text).toContain("Only one writing step runs on a checkout at a time");
      expect(text).toContain("NODE-SUMMARY-HERE");
    }
  });

  it("keeps the agent file pointed at tools that exist", async () => {
    // The agent file lives on the Node and is the copy most likely to go stale,
    // since it is not rebuilt with the Host.
    const registered = new Set(await registeredTools());

    expect(toolsNamedIn(agentFile).filter((name) => !registered.has(name))).toEqual([]);
  });
});
