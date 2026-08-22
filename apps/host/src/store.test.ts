import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  return { store, node, workspace, placement };
}

describe("FleetStore", () => {
  it("learns new capabilities when an upgraded node reconnects", () => {
    // Registration happens once, but agents are upgraded in place; without this
    // the Host keeps rejecting a feature the machine has already gained.
    const { store, node } = setup();
    expect(store.getNode(node.id)?.capabilities).toEqual(["copilot-acp"]);
    store.setNodeIdentity(node.id, {
      version: "0.2.0",
      capabilities: ["copilot-acp", "host-yolo"],
    });
    const updated = store.getNode(node.id);
    expect(updated?.capabilities).toEqual(["copilot-acp", "host-yolo"]);
    expect(updated?.version).toBe("0.2.0");
  });

  it("adopts the capacity a reconnecting node reports", () => {
    // Editing Max Sessions in the Node UI reconnects rather than re-registers,
    // so without this the Host keeps scheduling against the enrollment value.
    const { store, node } = setup();
    expect(store.getNode(node.id)?.maxSessions).toBe(2);
    store.setNodeIdentity(node.id, { maxSessions: 10 });
    expect(store.getNode(node.id)?.maxSessions).toBe(10);
  });

  it("adopts the platform a rebuilt node reports", () => {
    const { store, node } = setup();
    store.setNodeIdentity(node.id, { os: "linux", arch: "arm64" });
    const updated = store.getNode(node.id);
    expect(updated?.os).toBe("linux");
    expect(updated?.arch).toBe("arm64");
  });

  it("keeps what a reconnecting node does not report", () => {
    // A Node older than a protocol field must not blank the column for it.
    const { store, node } = setup();
    store.setNodeIdentity(node.id, { version: "0.2.0" });
    const updated = store.getNode(node.id);
    expect(updated?.maxSessions).toBe(2);
    expect(updated?.capabilities).toEqual(["copilot-acp"]);
    expect(updated?.os).toBe("win32");
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

  it("defaults yolo off until it is explicitly turned on", () => {
    const { store } = setup();
    expect(store.getDefaultYolo()).toBe(false);
    store.setDefaultYolo(true);
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
    expect(store.appendEvent(event(offset + 1, "starting")).stored).toBe(true);
    expect(store.appendEvent(event(offset + 2, "idle")).stored).toBe(true);
    expect(canTransition("starting", "idle")).toBe(true);
    expect(store.transitionSession(session.id, "idle").state).toBe("idle");
  });

  it("names a session, and clears the name back to the prompt fallback", () => {
    const { store, placement } = setup();
    const unnamed = store.createSession(placement, "refactor the router");
    expect(unnamed.name).toBe("");

    // Surrounding whitespace would render as a blank label that still counts as
    // a name, so it is trimmed on the way in.
    expect(store.renameSession(unnamed.id, "  Router cleanup  ")?.name).toBe(
      "Router cleanup",
    );
    // Empty is not a rejected rename: it is how an operator gets the
    // prompt-derived label back.
    expect(store.renameSession(unnamed.id, "")?.name).toBe("");
    expect(store.renameSession("missing", "x")).toBeUndefined();
  });

  it("keeps a name given at creation", () => {
    const { store, placement } = setup();
    const named = store.createSession(placement, "hello", false, "Nightly build");
    expect(store.getSession(named.id)?.name).toBe("Nightly build");
  });

  it("keeps a resumable session when clearing ended ones", () => {
    // A node reboot settles its sessions as failed while Copilot still holds the
    // conversation. Sweeping those away made Clear ended — the one button left
    // on screen after a restart — destroy exactly what Resume exists to recover.
    const { store, placement } = setup();
    const resumable = store.createSession(placement, "keep me");
    store.appendEvent({
      eventId: "e1",
      sessionId: resumable.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "copilot-abc" },
      createdAt: new Date().toISOString(),
    });
    store.transitionSession(resumable.id, "failed", "Node reconnected without this");

    const spent = store.createSession(placement, "clear me");
    store.transitionSession(spent.id, "failed", "Never reached the agent");

    expect(store.deleteEndedSessions()).toBe(1);
    expect(store.getSession(spent.id)).toBeUndefined();
    const kept = store.getSession(resumable.id);
    expect(kept?.agentSessionId).toBe("copilot-abc");
    // The transcript is the point of keeping it, so it must survive too.
    expect(store.listEvents(resumable.id)).toHaveLength(1);
  });

  it("still dismisses a resumable session one at a time", () => {
    // Sparing them in bulk must not make them permanent; Dismiss is a deliberate
    // act on a session someone is looking at.
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
    store.transitionSession(session.id, "failed", "Node reconnected without this");

    store.deleteSession(session.id);
    expect(store.getSession(session.id)).toBeUndefined();
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
      }).stored,
    ).toBe(true);
    expect(store.appendEvent(store.listEvents(session.id)[0]!).stored).toBe(false);
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

  it("rejects invalid state transitions", () => {
    const { store, placement } = setup();
    const session = store.createSession(placement, "hello");
    expect(() => store.transitionSession(session.id, "idle")).toThrow();
  });

  it("keeps recording after events were lost while the Host was down", () => {
    // The Node keeps working through a Host restart and its sequence keeps
    // climbing, so the first event afterwards is numbered past what the Host
    // expects. Refusing it refused every event after it too — the gap could
    // never close — which left the session's transcript stopped and its state
    // frozen wherever it happened to be, with no way back but restarting it.
    const { store, placement } = setup();
    const session = store.createSession(placement, "hello");
    const event = (sequence: number, text: string) => ({
      eventId: `e${sequence}`,
      sessionId: session.id,
      sequence,
      type: "agent_text" as const,
      payload: { text },
      createdAt: new Date().toISOString(),
    });

    expect(store.appendEvent(event(1, "before"))).toEqual({ stored: true, skipped: 0 });
    // Events 2-8 happened while the Host was unreachable and are simply gone.
    expect(store.appendEvent(event(9, "after"))).toEqual({ stored: true, skipped: 7 });
    // The session keeps streaming rather than going deaf.
    expect(store.appendEvent(event(10, "still here"))).toEqual({
      stored: true,
      skipped: 0,
    });
    expect(store.getSession(session.id)?.lastText).toBe("still here");
    expect(store.maxEventSequence(session.id)).toBe(10);
  });

  it("still refuses a duplicate, and keeps the preview on the newest event", () => {
    const { store, placement } = setup();
    const session = store.createSession(placement, "hello");
    const event = (sequence: number, text: string) => ({
      eventId: `e${sequence}`,
      sessionId: session.id,
      sequence,
      type: "agent_text" as const,
      payload: { text },
      createdAt: new Date().toISOString(),
    });

    store.appendEvent(event(1, "first"));
    store.appendEvent(event(5, "newest"));
    expect(store.appendEvent(event(5, "newest")).stored).toBe(false);

    // A straggler that fills an earlier hole belongs in the transcript, but must
    // not drag the tile preview back to something the agent has moved past.
    expect(store.appendEvent(event(3, "late arrival")).stored).toBe(true);
    expect(store.getSession(session.id)?.lastText).toBe("newest");
    expect(store.listEvents(session.id).map((item) => item.sequence)).toEqual([1, 3, 5]);
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

  it("brings a session whose turn never stopped back as running, not idle", () => {
    // Landing every reconnected session on `idle` was a guess, and a socket
    // that dropped mid-turn made it the wrong one: the UI unlocked its
    // composer over an agent that still had a prompt in flight, and every
    // follow-up typed into it was refused by the Node and silently dropped.
    const { store, node, placement } = setup();
    const working = store.createSession(placement, "still working");
    const waiting = store.createSession(placement, "waiting");
    store.transitionSession(working.id, "starting", "start");
    store.transitionSession(working.id, "running", "Copilot is working");
    store.markNodeSessionsOffline(node.id, "Node disconnected");

    const restored = store.reconcileOfflineSessions(
      node.id,
      [working.id, waiting.id],
      [working.id],
    );
    expect(restored).toHaveLength(2);
    expect(store.getSession(working.id)?.state).toBe("running");
    expect(store.getSession(working.id)?.currentActivity).toBe(
      "Reconnected to node; still working",
    );
    // A node too old to report business sends no busy ids, so a quiet session
    // keeps the original landing state.
    expect(store.getSession(waiting.id)?.state).toBe("idle");
  });

  it("says the Node came back without the session, and whether Resume can help", () => {
    // This runs when the Node reconnects, so repeating "the connection was
    // lost" described the wrong moment and hid the fact that a session with an
    // agent id is one Resume away from continuing.
    const { store, node, placement } = setup();
    const resumable = store.createSession(placement, "resumable");
    const never = store.createSession(placement, "never started");
    store.appendEvent({
      eventId: "agent-session-event",
      sessionId: resumable.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "acp-1" },
      createdAt: new Date().toISOString(),
    });
    store.markNodeSessionsOffline(node.id, "Node disconnected");

    const settled = store.reconcileOfflineSessions(node.id, []);
    const byId = new Map(settled.map((session) => [session.id, session]));
    expect(byId.get(resumable.id)?.currentActivity).toBe(
      "Node reconnected without this session; Resume re-attaches it",
    );
    expect(byId.get(never.id)?.currentActivity).toBe(
      "Node reconnected without this session; it never reached the agent",
    );
  });

  it("keeps the newest commands and pickers on the session row", () => {
    // A browser opening a session renders its composer from these, so they have
    // to be current state on the row rather than something replayed out of the
    // event log.
    const { store, placement } = setup();
    const session = store.createSession(placement, "prompt");
    const at = new Date().toISOString();

    store.appendEvent({
      eventId: "e1",
      sessionId: session.id,
      sequence: 1,
      type: "commands",
      payload: { commands: [{ name: "usage", description: "Show usage" }] },
      createdAt: at,
    });
    store.appendEvent({
      eventId: "e2",
      sessionId: session.id,
      sequence: 2,
      type: "config",
      payload: {
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            currentValue: "sonnet",
            choices: [
              { value: "sonnet", name: "Sonnet" },
              { value: "haiku", name: "Haiku" },
            ],
          },
        ],
      },
      createdAt: at,
    });

    const stored = store.getSession(session.id);
    expect(stored?.commands).toEqual([{ name: "usage", description: "Show usage" }]);
    expect(stored?.configOptions[0]).toMatchObject({
      id: "model",
      currentValue: "sonnet",
    });
  });

  it("ignores a picker report that arrives behind a newer one", () => {
    // Events can land out of order after a Host restart, and reinstating the
    // model a session has already left would fight the operator's own change.
    const { store, placement } = setup();
    const session = store.createSession(placement, "prompt");
    const at = new Date().toISOString();
    const config = (currentValue: string) => ({
      options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          currentValue,
          choices: [
            { value: "sonnet", name: "Sonnet" },
            { value: "haiku", name: "Haiku" },
          ],
        },
      ],
    });

    store.appendEvent({
      eventId: "e5",
      sessionId: session.id,
      sequence: 5,
      type: "config",
      payload: config("haiku"),
      createdAt: at,
    });
    store.appendEvent({
      eventId: "e2",
      sessionId: session.id,
      sequence: 2,
      type: "config",
      payload: config("sonnet"),
      createdAt: at,
    });

    expect(store.getSession(session.id)?.configOptions[0]?.currentValue).toBe("haiku");
  });

  it("keeps storing pickers after the agent adds one with an empty-value choice", () => {
    // How a working picker became a frozen one. Copilot started reporting an
    // `agent` option whose default choice is "", the whole list failed to parse,
    // and the Host went on serving the last list that did — so every change the
    // operator made was accepted by the agent and then snapped back in the UI.
    const { store, placement } = setup();
    const session = store.createSession(placement, "prompt");
    const at = new Date().toISOString();
    const model = (currentValue: string) => ({
      id: "model",
      name: "Model",
      category: "model",
      currentValue,
      choices: [
        { value: "sonnet", name: "Sonnet" },
        { value: "haiku", name: "Haiku" },
      ],
    });

    store.appendEvent({
      eventId: "e1",
      sessionId: session.id,
      sequence: 1,
      type: "config",
      payload: { options: [model("sonnet")] },
      createdAt: at,
    });
    store.appendEvent({
      eventId: "e2",
      sessionId: session.id,
      sequence: 2,
      type: "config",
      payload: {
        options: [
          model("haiku"),
          {
            id: "agent",
            name: "Agent",
            category: "_agent",
            currentValue: "",
            choices: [{ value: "", name: "Copilot" }],
          },
        ],
      },
      createdAt: at,
    });

    const stored = store.getSession(session.id);
    expect(stored?.configOptions.map((option) => option.id)).toEqual(["model", "agent"]);
    expect(stored?.configOptions[0]?.currentValue).toBe("haiku");
  });

  it("rebuilds pickers a previous build could not read when it reopens the file", () => {
    // The deadlock this breaks: a session whose picker list was dropped has no
    // control left to press, so nothing will ever produce the next `config`
    // frame. The frames were stored whole, so a Host that now understands the
    // payload re-reads what it already has rather than waiting for a change
    // that cannot be made.
    const file = join(mkdtempSync(join(tmpdir(), "fleet-rebuild-")), "fleet.db");
    directories.push(dirname(file));
    const first = new FleetStore(file);
    const { node } = first.registerNode({
      name: "box",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: [],
      maxSessions: 2,
    });
    const workspace = first.createWorkspace("repo", "");
    const placement = first.createPlacement(workspace.id, node.id, "/repo");
    const session = first.createSession(placement, "prompt");
    first.appendEvent({
      eventId: "e1",
      sessionId: session.id,
      sequence: 1,
      type: "config",
      payload: {
        options: [
          { id: "model", name: "Model", currentValue: "opus", choices: [] },
          {
            id: "agent",
            name: "Agent",
            currentValue: "",
            choices: [{ value: "", name: "Copilot" }],
          },
        ],
      },
      createdAt: new Date().toISOString(),
    });
    first.close();

    // Exactly what the build that could not read the frame left on disk: the
    // event stored whole, the session's cache of it empty. Written directly
    // because no supported call can produce that state any more.
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE sessions SET config_options=''").run();
    raw.close();

    const reopened = new FleetStore(file);
    stores.push(reopened);
    expect(
      reopened.getSession(session.id)?.configOptions.map((option) => option.id),
    ).toEqual(["model", "agent"]);
  });

  it("moves a placement to another workspace, taking its sessions along", () => {
    // Sessions carry their own workspace_id so the sidebar can group history
    // without a join; leaving it behind would file past runs under the project
    // the checkout no longer belongs to.
    const { store, placement } = setup();
    const session = store.createSession(placement, "did some work");
    const other = store.createWorkspace("other-repo", "");

    const moved = store.updatePlacement(placement.id, undefined, other.id);

    expect(moved?.workspaceId).toBe(other.id);
    expect(moved?.localPath).toBe(placement.localPath);
    expect(store.getSession(session.id)?.workspaceId).toBe(other.id);
  });

  it("refuses a move that would double up a node in one workspace", () => {
    const { store, node, placement } = setup();
    const other = store.createWorkspace("other-repo", "");
    store.createPlacement(other.id, node.id, "C:\\other");

    expect(() => store.updatePlacement(placement.id, undefined, other.id)).toThrow(
      /already has a placement/,
    );
    // The failed move must leave the original exactly where it was.
    expect(store.getPlacement(placement.id)?.workspaceId).not.toBe(other.id);
  });

  it("refuses a move to a workspace that does not exist", () => {
    const { store, placement } = setup();
    expect(() => store.updatePlacement(placement.id, undefined, "nope")).toThrow(
      /Unknown workspace/,
    );
  });

  it("changes only the path when no workspace is named", () => {
    const { store, placement } = setup();
    const updated = store.updatePlacement(placement.id, "D:\\elsewhere");
    expect(updated?.localPath).toBe("D:\\elsewhere");
    expect(updated?.workspaceId).toBe(placement.workspaceId);
  });

  it("keeps the order an operator arranged, and puts new placements last", () => {
    const { store, workspace } = setup();
    const second = store.registerNode({
      name: "aaa-alphabetically-first",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: [],
      maxSessions: 2,
    }).node;
    const first = store.listPlacements()[0]!;
    const other = store.createPlacement(workspace.id, second.id, "/repo");

    // Default order is by node name, so the new one sorts to the front.
    const reversed = store.reorderPlacements(workspace.id, [other.id, first.id]);
    expect(reversed.map((entry) => entry.id)).toEqual([other.id, first.id]);

    const restored = store.reorderPlacements(workspace.id, [first.id, other.id]);
    expect(restored.map((entry) => entry.id)).toEqual([first.id, other.id]);
  });

  it("ignores ids from elsewhere and keeps unmentioned placements at the end", () => {
    // A browser can post a list it built before another one added a row; that
    // must not drop the new row out of the ordering entirely.
    const { store, workspace, node } = setup();
    const first = store.listPlacements()[0]!;
    const extra = store.registerNode({
      name: "extra",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: [],
      maxSessions: 1,
    }).node;
    const added = store.createPlacement(workspace.id, extra.id, "/late");

    const ordered = store.reorderPlacements(workspace.id, ["not-a-placement", first.id]);

    expect(ordered.map((entry) => entry.id)).toEqual([first.id, added.id]);
    expect(node.id).toBeTruthy();
  });

  it("honours the order an operator dragged sessions into, both ways", () => {
    // Not asserted against created_at: two sessions made in the same
    // millisecond have no defined order to compare with, which is exactly the
    // ambiguity the position column exists to settle.
    const { store, placement } = setup();
    const first = store.createSession(placement, "one");
    const second = store.createSession(placement, "two");

    store.reorderSessions([first.id, second.id]);
    expect(store.listSessions().map((entry) => entry.id)).toEqual([first.id, second.id]);

    store.reorderSessions([second.id, first.id]);
    expect(store.listSessions().map((entry) => entry.id)).toEqual([second.id, first.id]);
  });

  it("leaves an untouched fleet in its newest-first order", () => {
    // The default must survive the column being added, or every existing
    // fleet's sidebar silently rearranges on upgrade.
    const { store, placement } = setup();
    const older = store.createSession(placement, "older");
    const newer = store.createSession(placement, "newer");
    const positions = store
      .listSessions()
      .map((entry) => entry.id)
      .sort();
    expect(positions).toEqual([older.id, newer.id].sort());
  });

  it("ignores session ids it does not know", () => {
    const { store, placement } = setup();
    const only = store.createSession(placement, "one");
    expect(() => store.reorderSessions(["ghost", only.id])).not.toThrow();
    expect(store.listSessions().map((entry) => entry.id)).toEqual([only.id]);
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
    store.setNodeIdentity(node.id, { homeDir: "C:\\Users\\dev" });
    expect(store.getNode(node.id)?.homeDir).toBe("C:\\Users\\dev");

    store.setNodeIdentity(node.id, { homeDir: "" });
    expect(store.getNode(node.id)?.homeDir).toBe("C:\\Users\\dev");
    expect(() => store.renameNode(node.id, "windows-vm")).not.toThrow();
  });

  it("reports a name already in use instead of throwing at a reconnecting node", () => {
    // A rename arriving over `hello` has nobody watching for a 409, so the
    // collision has to come back as an answer the gateway can act on.
    const { store, node } = setup();
    store.registerNode({
      name: "taken",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 1,
    });

    expect(store.tryRenameNode(node.id, "taken")).toBeUndefined();
    expect(store.getNode(node.id)?.name).toBe("node");
    expect(store.tryRenameNode(node.id, "build-01")?.name).toBe("build-01");
    // Renaming to the name it already has is not a collision with itself.
    expect(store.tryRenameNode(node.id, "build-01")?.name).toBe("build-01");
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

describe("Host backup", () => {
  it("round-trips catalog, transcripts, hashes, and parks live sessions", () => {
    const { store, node, workspace, placement } = setup();
    const { secret } = store.registerNode({
      name: "other",
      os: "linux",
      arch: "arm64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 3,
    });
    store.setDefaultYolo(false);
    store.setAutoResume(false);
    store.setTunnelEnabled(true);
    store.setTunnelProvider("tailscale");
    store.reorderWorkspaces([workspace.id]);
    const live = store.createSession(placement, "keep going", true, "alpha");
    store.transitionSession(live.id, "starting");
    store.transitionSession(live.id, "running", "coding");
    store.appendEvent({
      eventId: "e1",
      sessionId: live.id,
      sequence: 1,
      type: "agent_text",
      payload: { text: "hello from the agent" },
      createdAt: new Date().toISOString(),
    });
    store.appendEvent({
      eventId: "e2",
      sessionId: live.id,
      sequence: 2,
      type: "agent_session",
      payload: { agentSessionId: "acp-keep" },
      createdAt: new Date().toISOString(),
    });
    const stopped = store.createSession(placement, "already done");
    store.transitionSession(stopped.id, "stopped", "done");

    const backup = store.exportHostBackup({
      enrollmentToken: "move-me",
      publicUrl: "https://fleet.example.com",
    });
    expect(backup.kind).toBe("copilot-fleet-host");
    expect(backup.nodes).toHaveLength(2);
    expect(backup.events).toHaveLength(2);

    const restored = new FleetStore(":memory:");
    stores.push(restored);
    restored.replaceHostBackup(backup);

    expect(restored.authenticateNode(node.id, secret)).toBe(false);
    const other = restored.listNodes().find((entry) => entry.name === "other")!;
    expect(restored.authenticateNode(other.id, secret)).toBe(true);
    expect(restored.getDefaultYolo()).toBe(false);
    expect(restored.getAutoResume()).toBe(false);
    expect(restored.getTunnelEnabled()).toBe(true);
    expect(restored.getTunnelProvider()).toBe("tailscale");
    expect(restored.getSetting("enrollment.token")).toBe("move-me");
    expect(restored.getSetting("host.publicUrl")).toBe("https://fleet.example.com");
    expect(restored.listWorkspaces()[0]?.id).toBe(workspace.id);
    expect(restored.listPlacements()[0]?.localPath).toBe("C:\\repo");

    const importedLive = restored.getSession(live.id)!;
    expect(importedLive.state).toBe("offline");
    expect(importedLive.currentActivity).toBe("Imported onto this Host");
    expect(importedLive.agentSessionId).toBe("acp-keep");
    expect(importedLive.name).toBe("alpha");
    expect(importedLive.yolo).toBe(true);
    expect(restored.listEvents(live.id)).toHaveLength(2);
    expect(restored.getSession(stopped.id)?.state).toBe("stopped");
  });

  it("replaces whatever was already on the destination Host", () => {
    const { store, workspace } = setup();
    const backup = store.exportHostBackup({ enrollmentToken: "token" });

    const other = new FleetStore(":memory:");
    stores.push(other);
    other.createWorkspace("pre-existing", "");
    other.replaceHostBackup(backup);
    expect(other.listWorkspaces().map((entry) => entry.name)).toEqual([workspace.name]);
    expect(other.listWorkspaces()).toHaveLength(1);
  });
});

describe("FleetStore runs", () => {
  it("creates a run that starts unapproved and unpinned", () => {
    const { store, workspace } = setup();
    const run = store.createRun({
      workspaceId: workspace.id,
      name: "flaky auth",
      objective: "Fix the flaky auth refresh test",
    });
    expect(run.state).toBe("awaiting_approval");
    expect(run.placementId).toBe("");
    expect(run.settleSeq).toBe(0);
    expect(run.policy.maxWakes).toBe(12);
    expect(store.listRuns()).toHaveLength(1);
    expect(store.getRun(run.id)?.objective).toBe("Fix the flaky auth refresh test");
  });

  it("reuses a row when a step key comes back, so a retry is not a second step", () => {
    const { store, workspace } = setup();
    const run = store.createRun({
      workspaceId: workspace.id,
      name: "r",
      objective: "o",
    });
    const first = store.upsertRunStep(run.id, {
      stepKey: "audit",
      title: "Audit",
      prompt: "look",
    });
    expect(first.attempts).toBe(1);
    const retry = store.upsertRunStep(run.id, {
      stepKey: "audit",
      title: "Audit",
      prompt: "look again",
    });
    expect(retry.id).toBe(first.id);
    expect(retry.attempts).toBe(2);
    expect(retry.prompt).toBe("look again");
    expect(store.listRunSteps(run.id)).toHaveLength(1);
  });

  it("counts settles and wakes separately so a wake can be owed", () => {
    const { store, workspace } = setup();
    const run = store.createRun({ workspaceId: workspace.id, name: "r", objective: "o" });
    const settled = store.recordRunSettle(run.id);
    expect(settled?.settleSeq).toBe(1);
    expect(settled?.wakeSeq).toBe(0);
    const woken = store.recordRunWake(run.id);
    expect(woken?.wakeSeq).toBe(1);
  });

  it("defaults run columns on sessions written before runs existed", () => {
    const { store, placement } = setup();
    const plain = store.createSession(placement, "hello");
    expect(plain.runId).toBe("");
    expect(plain.runRole).toBe("");
    const worker = store.createSession(placement, "work", false, "", {
      runId: "r1",
      runRole: "worker",
    });
    expect(worker.runId).toBe("r1");
    expect(worker.runRole).toBe("worker");
  });

  it("reads a policy back as it was written, not as defaults", () => {
    const { store, workspace } = setup();
    const run = store.createRun({
      workspaceId: workspace.id,
      name: "r",
      objective: "o",
      policy: { wakePolicy: "on_any_settle", maxWakes: 5 },
    });
    // A policy silently read as defaults turns an orchestrator's wake path off
    // and finishes its run behind its back.
    expect(run.policy.wakePolicy).toBe("on_any_settle");
    expect(store.getRun(run.id)?.policy.wakePolicy).toBe("on_any_settle");
    expect(store.getRun(run.id)?.policy.maxWakes).toBe(5);
  });
  it("carries runs through a backup and never restores one still believing it is live", () => {
    const first = new FleetStore(":memory:");
    stores.push(first);
    const { node } = first.registerNode({
      name: "node",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 2,
    });
    const workspace = first.createWorkspace("repo", "");
    const placement = first.createPlacement(workspace.id, node.id, "C:\\repo");
    const run = first.createRun({ workspaceId: workspace.id, name: "r", objective: "o" });
    first.setRunState(run.id, "running");
    const step = first.upsertRunStep(run.id, {
      stepKey: "impl",
      title: "Implement",
      prompt: "do",
    });
    const session = first.createSession(placement, "work", false, "", {
      runId: run.id,
      runRole: "worker",
    });
    first.updateRunStep(step.id, { state: "starting", sessionId: session.id });

    const backup = first.exportHostBackup({ enrollmentToken: "t" });
    expect(backup.runs).toHaveLength(1);
    expect(backup.runSteps).toHaveLength(1);

    const second = new FleetStore(":memory:");
    stores.push(second);
    second.replaceHostBackup(backup);

    // Sessions land offline on import, so a run that came back "running" would
    // wait forever for a settle that nothing can produce.
    expect(second.getRun(run.id)?.state).toBe("awaiting_lead");
    expect(second.listRunSteps(run.id)[0]?.state).toBe("failed");
  });

  it("carries a task's notes and phases through a move", () => {
    /*
     * Notes are the orchestrator's own record of a task and phase_index is
     * where each step belongs in it. A restore that dropped either left a live
     * task with its steps intact and no memory of why they were run — and
     * because run_notes references runs, omitting it from the wipe made the
     * whole restore fail the foreign key rather than merely lose data.
     */
    const first = new FleetStore(":memory:");
    stores.push(first);
    const workspace = first.createWorkspace("repo", "");
    const run = first.createRun({
      workspaceId: workspace.id,
      name: "r",
      objective: "o",
      phases: ["Implement", "Review"],
    });
    first.updateRun(run.id, { phaseIndex: 1 });
    first.upsertRunStep(run.id, {
      stepKey: "review",
      title: "Review",
      prompt: "check",
      phaseIndex: 1,
    });
    first.appendRunNote(run.id, 0, "wrote the thing");
    first.appendRunNote(run.id, 1, "looks right");

    const backup = first.exportHostBackup({ enrollmentToken: "t" });
    expect(backup.runNotes).toHaveLength(2);

    const second = new FleetStore(":memory:");
    stores.push(second);
    // A populated target is the normal case for a restore, and run_notes there
    // is exactly what the wipe used to trip over.
    const other = second.createWorkspace("old", "");
    const stale = second.createRun({
      workspaceId: other.id,
      name: "old",
      objective: "o",
    });
    second.appendRunNote(stale.id, 0, "from before the move");

    second.replaceHostBackup(backup);

    expect(second.listRunNotes(run.id).map((note) => note.body)).toEqual([
      "wrote the thing",
      "looks right",
    ]);
    expect(second.listRunSteps(run.id)[0]?.phaseIndex).toBe(1);
    expect(second.getRun(stale.id)).toBeUndefined();
  });

  it("deletes a task's notes along with it", () => {
    // run_notes references runs, so a task that ever recorded one could not be
    // deleted at all — the foreign key took the whole transaction with it.
    const store = new FleetStore(":memory:");
    stores.push(store);
    const workspace = store.createWorkspace("repo", "");
    const run = store.createRun({ workspaceId: workspace.id, name: "r", objective: "o" });
    store.upsertRunStep(run.id, { stepKey: "impl", title: "Implement", prompt: "do" });
    store.appendRunNote(run.id, 0, "what happened");

    expect(store.deleteRun(run.id)).toBe(true);
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.listRunNotes(run.id)).toEqual([]);
  });
});
