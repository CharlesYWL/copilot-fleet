import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FleetStore } from "./store.js";

const stores: FleetStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const store = new FleetStore(":memory:");
  stores.push(store);
  const { node } = store.registerNode({
    name: "node",
    os: "win32",
    arch: "x64",
    version: "0.1.0",
    capabilities: ["copilot-acp"],
    maxSessions: 2,
  });
  const workspace = store.createWorkspace("repo", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
  return { store, node, placement };
}

describe("FleetStore", () => {
  it("persists sessions and ordered events", () => {
    const { store, placement } = setup();
    const session = store.createSession(placement, "hello");
    store.transitionSession(session.id, "starting");
    expect(
      store.appendEvent({
        eventId: "e1",
        sessionId: session.id,
        sequence: 1,
        type: "state",
        payload: { state: "starting" },
        createdAt: new Date().toISOString(),
      }),
    ).toBe(true);
    expect(store.appendEvent(store.listEvents(session.id)[0]!)).toBe(false);
    expect(store.listEvents(session.id)).toHaveLength(1);
  });

  it("rejects event gaps and invalid state transitions", () => {
    const { store, placement } = setup();
    const session = store.createSession(placement, "hello");
    expect(() => store.transitionSession(session.id, "idle")).toThrow();
    expect(() =>
      store.appendEvent({
        eventId: "e2",
        sessionId: session.id,
        sequence: 2,
        type: "agent_text",
        payload: { text: "gap" },
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(/Expected event sequence 1/);
  });

  it("retains inventory and event history across a database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "copilot-fleet-"));
    directories.push(directory);
    const path = join(directory, "fleet.db");
    const first = new FleetStore(path);
    const { node } = first.registerNode({
      name: "persistent-node",
      os: "linux",
      arch: "arm64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 2,
    });
    const workspace = first.createWorkspace("persistent-workspace", "");
    const placement = first.createPlacement(workspace.id, node.id, "/workspace");
    const session = first.createSession(placement, "persist this");
    first.appendEvent({
      eventId: "persistent-event",
      sessionId: session.id,
      sequence: 1,
      type: "system",
      payload: { text: "saved" },
      createdAt: new Date().toISOString(),
    });
    first.close();

    const reopened = new FleetStore(path);
    stores.push(reopened);
    expect(reopened.listWorkspaces()).toHaveLength(1);
    expect(reopened.getSession(session.id)?.initialPrompt).toBe("persist this");
    expect(reopened.listEvents(session.id)[0]?.payload.text).toBe("saved");
  });

  it("fails disconnected sessions and reconciles host-restart offline rows", () => {
    const { store, node, placement } = setup();
    const disconnected = store.createSession(placement, "disconnect");
    expect(
      store.markNodeSessionsFailed(node.id, "Node disconnected")[0]?.state,
    ).toBe("failed");

    const restarted = store.createSession(placement, "restart");
    store.resetConnectivity();
    expect(store.getSession(restarted.id)?.state).toBe("offline");
    expect(store.reconcileOfflineSessions(node.id, [disconnected.id])).toHaveLength(1);
    expect(store.getSession(restarted.id)?.state).toBe("failed");
  });
});
