import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  orchestratorBriefing,
  owedPrompt,
  statusCheckEnvelope,
  transferEnvelope,
  wakeEnvelope,
} from "./briefing.js";
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
  const token = tokens.mint(world.leadSubject);
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
    expect(attached).not.toContain("Sizing the work");
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
      expect(text).toContain("fleet_follow_up");
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

  it("distinguishes a revisit from a different worker role", () => {
    expect(agentFile).toContain("same session");
    expect(agentFile).toContain("planning, coding, testing and review");
    expect(agentFile).toContain("fleet_follow_up");
    expect(agentFile).toContain("fleet_list_work");
    expect(agentFile).toContain("stay open and idle");
    expect(agentFile).toContain("Archiving stops them");
    expect(agentFile).toContain("after reopening");
  });

  it("keeps worker publication and dispatch authority consistent with or without the agent", () => {
    for (const text of [
      agentFile,
      orchestratorBriefing("nodes", { hasAgent: true }),
      orchestratorBriefing("nodes", { hasAgent: false }),
    ]) {
      const normalized = text.replace(/`/g, "").replace(/\s+/g, " ");
      expect(normalized).toContain(
        "does not prohibit authorized writing workers from publishing",
      );
      expect(normalized).toContain("create a source branch, push, and create/update");
      expect(normalized).toContain(
        "fleet_submit_task is not a prerequisite for authorized worker publication",
      );
      expect(normalized).toContain("Record partial results and continue the parent");
      expect(normalized).toContain("never mark unmet criteria met");
      expect(normalized).toContain("Read-only work grants no publication authority");
      expect(normalized).toContain("sealed-result and explicit approval gates");
      expect(normalized).toContain("retained-worker binding and prepared batch");
      expect(normalized).toContain("provider-observed source/head and base");
      expect(normalized).toContain("verification results and limitations");
      expect(normalized).toContain("authoritative links/paths");
      expect(normalized).toContain("The worker chooses the investigation");
      expect(normalized).toContain("Distinguish historical facts from current");
    }
  });

  it("teaches discovery before replacement and distinguishes queued work from failure", () => {
    for (const text of [
      agentFile,
      orchestratorBriefing("nodes", { hasAgent: true }),
      orchestratorBriefing("nodes", { hasAgent: false }),
    ]) {
      const normalized = text.replace(/\s+/g, " ");
      expect(normalized).toContain("fleet_get_task");
      expect(normalized).toContain("closed tasks");
      expect(normalized).toContain("does not prove");
      expect(normalized).toContain("persisted");
      expect(normalized).toContain("do not resend");
    }
  });

  it("carries stable task and worker IDs in wake messages", () => {
    const message = wakeEnvelope({
      runId: "stable-task-id",
      task: "A display name that can change",
      wakes: 1,
      maxWakes: 12,
      settled: [
        {
          title: "Rename the helper",
          category: "implement",
          state: "succeeded",
          output: "The rename is complete.",
          sessionId: "same-worker-id",
        },
      ],
      running: [],
    });

    expect(message).toContain('taskId="stable-task-id"');
    expect(message).toContain("same-worker-id");
    expect(message).toContain("fleet_follow_up");
  });

  it("scales phases and workers without dropping evidence or independent review for risky work", () => {
    for (const text of [agentFile, orchestratorBriefing("nodes", { hasAgent: false })]) {
      const normalized = text.replace(/\s+/g, " ");
      expect(normalized).toContain("**One phase, one worker** is the default");
      expect(normalized).toContain("small, well-understood, low-risk fix");
      expect(normalized).toContain("runs targeted verification in the same session");
      expect(normalized).toContain(
        "**Two phases** when only one extra handoff adds value",
      );
      expect(normalized).toContain(
        "**Three phases** for substantial, cross-cutting or high-risk work",
      );
      expect(normalized).toContain(
        "inspect/plan -> implement with verification -> independent review",
      );
      expect(normalized).toContain(
        "Keep success criteria and concrete evidence at every size",
      );
      expect(normalized).toContain("If new findings increase scope or risk");
    }

    for (const hasAgent of [true, false]) {
      const text = orchestratorBriefing("nodes", { hasAgent });
      expect(text).toContain("Choose the fewest phases and workers");
      expect(text).not.toContain("Three or four phases for a change");
      expect(text).not.toContain("should normally have separate sessions");
    }
  });

  it("makes periodic status checks read-only for dispatched workers", () => {
    const text = statusCheckEnvelope([
      {
        name: "Fix auth",
        state: "running",
        phase: "phase 2/3: implement",
        openSteps: 1,
        dispatchedSteps: 1,
      },
    ]);

    expect(text).toContain("Fix auth");
    expect(text).toContain("fleet_list_work");
    expect(text).toContain("read-only check");
    expect(text).toContain("do not prompt, follow up with, stop");
    expect(text).toContain("waiting on dispatched work");
  });

  it("routes enablement through a pending proposal instead of JSON copying or self-authorization", () => {
    for (const text of [
      orchestratorBriefing("nodes", { hasAgent: true }),
      orchestratorBriefing("nodes", { hasAgent: false }),
      agentFile,
    ]) {
      expect(text).toContain("fleet_propose_pr_maintenance");
      expect(text).toMatch(/prefilled/i);
      expect(text).toMatch(/authenticated authorization/i);
    }
  });

  it("recovers maintenance on all wake types without reopening a completed task", () => {
    const status = statusCheckEnvelope([], { ids: ["maintenance-1"], count: 1 });
    const wake = wakeEnvelope({
      runId: "done-task",
      wakes: 1,
      maxWakes: 12,
      settled: [],
      running: [],
    });
    for (const text of [
      status,
      wake,
      orchestratorBriefing("nodes", { hasAgent: true }),
      orchestratorBriefing("nodes", { hasAgent: false }),
      agentFile,
    ]) {
      expect(text).toContain("fleet_get_pr_maintenance");
      expect(text).toContain("pr-maintenance");
    }
    expect(status).toContain("maintenance-1");
    expect(status).toContain("task list is empty");
    expect(wake).toContain("holds override");
  });

  it("states immutable batch, whole-PR human gate and external-review-only limits", () => {
    for (const text of [agentFile, orchestratorBriefing("nodes")]) {
      const normalized = text.replace(/\s+/g, " ");
      expect(normalized).toContain("whole PR");
      expect(normalized).toContain("immutable batch/prompt");
      expect(normalized).toContain("Send back");
      expect(normalized).toContain("named external reviewers");
    }
  });
});

describe("the transfer brief", () => {
  it("points the receiving orchestrator at the record and asks it to continue", () => {
    const text = transferEnvelope({
      taskId: "task-1",
      task: "Ship it",
      state: "running",
      phase: "Review (2/2)",
      from: "Orchestrator (lead-1)",
      note: "Review is next; the worker already pushed.",
    });

    expect(text.split("\n")[0]).toBe(
      '<fleet-task-transfer task="Ship it" taskId="task-1" state="running" phase="Review (2/2)" from="Orchestrator (lead-1)">',
    );
    expect(text).toContain("Handoff note:\nReview is next; the worker already pushed.");
    expect(text).toContain('fleet_get_task with task "task-1"');
    expect(text).toContain('fleet_get_pr_maintenance with taskId "task-1"');
    expect(text).toContain("do not re-plan, restart or duplicate work that exists");
  });

  it("says nothing it was not given", () => {
    const text = transferEnvelope({
      taskId: "task-1",
      task: "Ship it",
      state: "running",
    });

    expect(text.split("\n")[0]).toBe(
      '<fleet-task-transfer task="Ship it" taskId="task-1" state="running">',
    );
    expect(text).not.toContain("Handoff note");
  });

  it("names only tools this Host offers", async () => {
    const registered = new Set(await registeredTools());
    const text = transferEnvelope({ taskId: "t", task: "t", state: "running" });

    expect(toolsNamedIn(text).filter((name) => !registered.has(name))).toEqual([]);
  });

  it("adds to what is owed rather than replacing it", () => {
    expect(owedPrompt("", "Sent back")).toBe("Sent back");
    expect(owedPrompt("Brief", "Sent back")).toBe("Brief\n\nSent back");
    expect(owedPrompt("Brief", "")).toBe("Brief");
  });
});
