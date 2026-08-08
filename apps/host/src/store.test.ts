import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canTransition } from "@fleet/protocol";
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
  it("learns new capabilities when an upgraded node reconnects", () => {
    // Registration happens once, but agents are upgraded in place; without this
    // the Host keeps rejecting a feature the machine has already gained.
    const { store, node } = setup();
    expect(store.getNode(node.id)?.capabilities).toEqual(["copilot-acp"]);
    store.setNodeIdentity(node.id, "0.2.0", ["copilot-acp", "host-yolo"]);
    const updated = store.getNode(node.id);
    expect(updated?.capabilities).toEqual(["copilot-acp", "host-yolo"]);
    expect(updated?.version).toBe("0.2.0");
  });

  it("re-enrolling under an existing name reclaims the node and rotates its secret", () => {
    const { store, node, placement } = setup();
    const reclaimed = store.registerNode({
      name: "node",
      os: "win32",
      arch: "x64",
      version: "0.2.0",
      capabilities: ["copilot-acp"],
      maxSessions: 4,
    });

    expect(reclaimed.node.id).toBe(node.id);
    expect(reclaimed.node.version).toBe("0.2.0");
    expect(reclaimed.node.maxSessions).toBe(4);
    expect(store.listNodes()).toHaveLength(1);
    // Placements survive so a rebuilt machine keeps its workspace mapping.
    expect(store.listPlacements().map((entry) => entry.id)).toContain(placement.id);
    expect(store.authenticateNode(node.id, reclaimed.secret)).toBe(true);
  });

  it("keeps each session's yolo choice independent of the current default", () => {
    const { store, placement } = setup();
    const yolo = store.createSession(placement, "hello", true);
    const safe = store.createSession(placement, "hello", false);

    // Flipping the default must not rewrite sessions that already exist,
    // otherwise a running agent would silently change permission behaviour.
    store.setDefaultYolo(false);

    expect(store.getSession(yolo.id)?.yolo).toBe(true);
    expect(store.getSession(safe.id)?.yolo).toBe(false);
    expect(store.getDefaultYolo()).toBe(false);
  });

  it("defaults yolo on until it is explicitly turned off", () => {
    const { store } = setup();
    expect(store.getDefaultYolo()).toBe(true);
    store.setDefaultYolo(false);
    expect(store.getDefaultYolo()).toBe(false);
  });

  it("resumes a stopped session all the way to idle", () => {
    const { store, placement } = setup();
    const session = store.createSession(placement, "hello");
    const event = (sequence: number, state: string) => ({
      eventId: `e${sequence}`,
      sessionId: session.id,
      sequence,
      type: "state" as const,
      payload: { state },
      createdAt: "2026-08-08T09:00:00.000Z",
    });

    store.transitionSession(session.id, "starting");
    store.appendEvent(event(1, "starting"));
    store.transitionSession(session.id, "running");
    store.appendEvent(event(2, "running"));
    store.transitionSession(session.id, "stopped");
    store.appendEvent(event(3, "stopped"));

    const offset = store.maxEventSequence(session.id);
    expect(offset).toBe(3);

    // The node re-attaches and reports idle because a resumed session waits
    // for the next prompt rather than replaying the original one.
    store.transitionSession(session.id, "starting");
    expect(store.appendEvent(event(offset + 1, "starting"))).toBe(true);
    expect(store.appendEvent(event(offset + 2, "idle"))).toBe(true);
    expect(canTransition("starting", "idle")).toBe(true);
    expect(store.transitionSession(session.id, "idle").state).toBe("idle");
  });

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

  it("records the agent session id and event high-water mark for resume", () => {
    const { store, placement } = setup();
    const session = store.createSession(placement, "hello");
    store.appendEvent({
      eventId: "e1",
      sessionId: session.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "copilot-abc" },
      createdAt: new Date().toISOString(),
    });
    expect(store.getSession(session.id)?.agentSessionId).toBe("copilot-abc");
    expect(store.maxEventSequence(session.id)).toBe(1);
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

  it("soft-disconnects sessions and resurrects ones the Node still owns", () => {
    const { store, node, placement } = setup();
    const dropped = store.createSession(placement, "drop");
    expect(store.markNodeSessionsOffline(node.id, "Node disconnected")[0]?.state).toBe(
      "offline",
    );
    expect(store.reconcileOfflineSessions(node.id, [])[0]?.state).toBe("failed");
    expect(store.getSession(dropped.id)?.state).toBe("failed");

    const kept = store.createSession(placement, "keep");
    const lost = store.createSession(placement, "lose");
    store.resetConnectivity();
    expect(store.getSession(kept.id)?.state).toBe("offline");
    expect(store.getSession(lost.id)?.state).toBe("offline");

    const changed = store.reconcileOfflineSessions(node.id, [kept.id]);
    expect(changed).toHaveLength(2);
    expect(store.getSession(kept.id)?.state).toBe("idle");
    expect(store.getSession(lost.id)?.state).toBe("failed");
  });

  it("dismisses ended sessions but refuses to delete live ones", () => {
    const { store, placement } = setup();
    const live = store.createSession(placement, "live");
    const dead = store.createSession(placement, "dead");
    store.transitionSession(dead.id, "failed", "gone");

    expect(() => store.deleteSession(live.id)).toThrow(/ended sessions/);
    store.deleteSession(dead.id);
    expect(store.getSession(dead.id)).toBeUndefined();
    expect(store.deleteEndedSessions()).toBe(0);

    store.transitionSession(live.id, "failed", "later");
    expect(store.deleteEndedSessions()).toBe(1);
    expect(store.listSessions()).toHaveLength(0);
  });

  it("renames nodes and tracks the home directory reported on reconnect", () => {
    const { store, node } = setup();
    expect(node.homeDir).toBe("");

    expect(store.renameNode(node.id, "windows-vm")?.name).toBe("windows-vm");
    store.setNodeHomeDir(node.id, "C:\\Users\\dev");
    expect(store.getNode(node.id)?.homeDir).toBe("C:\\Users\\dev");

    store.setNodeHomeDir(node.id, "");
    expect(store.getNode(node.id)?.homeDir).toBe("C:\\Users\\dev");
    expect(() => store.renameNode(node.id, "windows-vm")).not.toThrow();
  });

  it("persists tunnel enabled setting", () => {
    const store = new FleetStore(":memory:");
    stores.push(store);
    expect(store.getTunnelEnabled()).toBe(false);
    store.setTunnelEnabled(true);
    expect(store.getTunnelEnabled()).toBe(true);
    store.setTunnelEnabled(false);
    expect(store.getTunnelEnabled()).toBe(false);
  });

  it("updates and deletes workspaces, placements, and idle nodes", () => {
    const { store, node, placement } = setup();
    const workspace = store.listWorkspaces()[0]!;

    expect(store.updateWorkspace(workspace.id, "renamed", "updated")?.name).toBe(
      "renamed",
    );
    expect(store.updatePlacement(placement.id, "D:\\other")?.localPath).toBe("D:\\other");

    const live = store.createSession(placement, "still running");
    expect(() => store.deletePlacement(placement.id)).toThrow(/still active/);
    expect(() => store.deleteWorkspace(workspace.id)).toThrow(/still active/);
    expect(() => store.deleteNode(node.id)).toThrow(/still active/);

    store.transitionSession(live.id, "starting", "boot");
    store.transitionSession(live.id, "running", "go");
    store.transitionSession(live.id, "stopped", "done");

    store.deletePlacement(placement.id);
    expect(store.listPlacements()).toHaveLength(0);
    expect(store.getSession(live.id)).toBeUndefined();

    const replacement = store.createPlacement(workspace.id, node.id, "E:\\repo");
    const archived = store.createSession(replacement, "archive me");
    store.transitionSession(archived.id, "stopped", "done");
    store.deleteWorkspace(workspace.id);
    expect(store.listWorkspaces()).toHaveLength(0);
    expect(store.listPlacements()).toHaveLength(0);

    store.deleteNode(node.id);
    expect(store.getNode(node.id)).toBeUndefined();
  });
});
