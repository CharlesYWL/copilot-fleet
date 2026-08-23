import type { FastifyBaseLogger } from "fastify";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { OrchestratorEngine } from "./engine.js";

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as FastifyBaseLogger;

function fakeSocket() {
  return {
    readyState: 1,
    // `dispatch` compares against the socket's own OPEN, so a stub without it
    // silently reads as closed and every command is "sent to a dead node".
    OPEN: 1,
    send: () => {},
  } as unknown as Parameters<FleetService["attachNode"]>[1];
}

/**
 * A fleet with one online node holding two different checkouts.
 *
 * Shared by the tests that call the tools directly and the ones that go through
 * the MCP endpoint, so both are talking to the same world — a harness that
 * drifted between them would let a wire-level bug hide behind a passing unit.
 */
export function fleet(): { store: FleetStore; service: FleetService; leadId: string } {
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, silent, "test");

  const { node } = store.registerNode({
    name: "box",
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    revision: "test",
    capabilities: ["copilot-acp", "host-yolo"],
    agents: [],
    maxSessions: 8,
  });
  service.attachNode(node.id, fakeSocket());
  store.setNodeOnline(node.id, true, 0);

  const first = store.createWorkspace("Alpha", "");
  const second = store.createWorkspace("Beta", "");
  store.createPlacement(first.id, node.id, "/src/alpha");
  store.createPlacement(second.id, node.id, "/src/beta");

  const engine = new OrchestratorEngine(service);
  service.attachOrchestration({
    leadTokens: { mint: () => "flt_test" },
    mcpUrl: () => "http://127.0.0.1/mcp",
    tickRun: (runId) => engine.tickRun(runId),
  });

  const lead = store.createSession(
    store.listPlacements()[0]!,
    "orchestrate",
    true,
    "Orchestrator",
    { runRole: "lead" },
  );
  const run = store.createRun({
    workspaceId: first.id,
    name: "General",
    objective: "general",
    policy: { wakePolicy: "on_any_settle" },
  });
  store.updateRun(run.id, { leadSessionId: lead.id, state: "running" });
  return { store, service, leadId: lead.id };
}
