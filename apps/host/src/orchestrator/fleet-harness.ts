import type { FastifyBaseLogger } from "fastify";
import type { FleetNode } from "@fleet/protocol";
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
 *
 * A second machine is offered rather than included. Placement is decided by
 * counting what is free, so an extra node changes the answer for every test in
 * both files; the ones that need somewhere else to send work ask for it.
 */
export function fleet(): {
  store: FleetStore;
  service: FleetService;
  leadId: string;
  /** What a lead token for this world's orchestrator has to claim. */
  leadSubject: { sessionId: string; runId: string; nodeId: string };
  addNode: (name: string, options?: { online?: boolean }) => FleetNode;
} {
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

  /** Another machine with the same two checkouts, so only the name differs. */
  const addNode = (name: string, options: { online?: boolean } = {}) => {
    const added = store.registerNode({
      name,
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      revision: "test",
      capabilities: ["copilot-acp", "host-yolo"],
      agents: [],
      maxSessions: 8,
    }).node;
    service.attachNode(added.id, fakeSocket());
    store.setNodeOnline(added.id, options.online ?? true, 0);
    store.createPlacement(first.id, added.id, `/src/alpha-${name}`);
    store.createPlacement(second.id, added.id, `/src/beta-${name}`);
    return added;
  };

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
  /*
   * No task, which is how a real conversation starts.
   *
   * This used to seed one called "General", copying what the Host did then. It
   * no longer does either, and a harness that kept the fixture would be the
   * only place the old shape still existed — which is precisely where a
   * regression hides: every test would exercise "a lead that already has a
   * task" and none would exercise the first call of a fresh one.
   */
  return {
    store,
    service,
    leadId: lead.id,
    leadSubject: { sessionId: lead.id, runId: lead.runId, nodeId: lead.nodeId },
    addNode,
  };
}
