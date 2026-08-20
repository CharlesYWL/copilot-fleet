import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import {
  HOST_URL_SYNC_CAPABILITY,
  NODE_NAME_SYNC_CAPABILITY,
  SELF_UPDATE_CAPABILITY,
} from "@fleet/protocol";
import { FleetService } from "./fleet-service.js";
import { FleetStore } from "./store.js";

type SentFrame = {
  type: string;
  hostUrl?: string;
  name?: string;
  nodeId?: string;
  stage?: string;
  detail?: string;
  command?: { type: string; sessionId: string };
};

/** Just enough socket for the service to consider it writable and record sends. */
function fakeSocket() {
  const sent: SentFrame[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as SentFrame),
  };
  return { sent, socket: socket as unknown as WebSocket };
}

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
} as unknown as FastifyBaseLogger;

function setup(hostRevision: string | (() => string) = "") {
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, silentLog, hostRevision);
  const enroll = (name: string, capabilities: string[], revision = "") => {
    const { node } = store.registerNode({
      name,
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      revision,
      capabilities,
      maxSessions: 1,
    });
    const wire = fakeSocket();
    service.attachNode(node.id, wire.socket);
    return { ...wire, nodeId: node.id };
  };
  return { store, service, enroll };
}

describe("handleEvent after a Host restart", () => {
  const event = (sessionId: string, sequence: number, payload: object, type = "state") =>
    ({
      eventId: `e${sequence}`,
      sessionId,
      sequence,
      type,
      payload,
      createdAt: new Date().toISOString(),
    }) as Parameters<FleetService["handleEvent"]>[0];

  it("keeps applying events whose predecessors were lost", () => {
    // The exact freeze: the Host restarted mid-turn, the Node kept working and
    // kept numbering, and the first event afterwards was ahead of what the Host
    // expected. Refusing it refused everything after it, so the session sat at
    // whatever state the reconnect had guessed — accepting no output and no
    // state change — while its agent was alive and well on the Node.
    const { store, service } = setup();
    const { node } = store.registerNode({
      name: "devbox",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 4,
    });
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
    const session = store.createSession(placement, "long task");

    service.handleEvent(event(session.id, 1, { state: "starting" }));
    service.handleEvent(event(session.id, 2, { state: "running" }));
    expect(store.getSession(session.id)?.state).toBe("running");

    // Host restarts: everything live is parked, and the Node that still owns the
    // session brings it back as idle on reconnect.
    store.resetConnectivity();
    store.reconcileOfflineSessions(node.id, [session.id]);
    expect(store.getSession(session.id)?.state).toBe("idle");

    // Events 3-11 were raised while nothing was listening.
    service.handleEvent(event(session.id, 12, { text: "back" }, "agent_text"));
    service.handleEvent(event(session.id, 13, { state: "running" }));

    expect(store.getSession(session.id)?.lastText).toBe("back");
    expect(store.getSession(session.id)?.state).toBe("running");

    // And the session keeps moving, rather than being deaf from here on.
    service.handleEvent(event(session.id, 14, { state: "idle", activity: "Done" }));
    expect(store.getSession(session.id)?.state).toBe("idle");
  });
});

describe("broadcastHostUrl", () => {
  it("tells a node that can follow the Host where it went", () => {
    const { service, enroll } = setup();
    const node = enroll("new-node", ["copilot-acp", HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(1);
    expect(node.sent).toEqual([
      { type: "host_url", hostUrl: "https://two.trycloudflare.com" },
    ]);
  });

  it("says nothing to a node whose agent predates the message", () => {
    // An older agent validates every frame against its own copy of the message
    // union and closes the socket on anything it does not recognise, so sending
    // this would cost it the connection this feature exists to preserve — and
    // it would reconnect and lose it again, forever.
    const { service, enroll } = setup();
    const older = enroll("older-node", ["copilot-acp", "host-yolo"]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(0);
    expect(older.sent).toEqual([]);
  });

  it("reaches only the capable half of a mixed fleet", () => {
    const { service, enroll } = setup();
    const older = enroll("older-node", ["copilot-acp"]);
    const newer = enroll("new-node", [HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(1);
    expect(older.sent).toEqual([]);
    expect(newer.sent).toHaveLength(1);
  });

  it("refuses to send an address a node could never authenticate to", () => {
    // Checked here as well as where the address is chosen, because this is the
    // one mistake that cannot be taken back: a node that follows a Dev Tunnels
    // URL meets a Microsoft login, cannot reach the Host, and so cannot be told
    // to go anywhere else.
    const { service, enroll } = setup();
    const node = enroll("new-node", [HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("https://hqn74pr4-8790.usw2.devtunnels.ms")).toBe(0);
    expect(node.sent).toEqual([]);
  });

  it("refuses an address that names the Host's own machine", () => {
    const { service, enroll } = setup();
    const node = enroll("new-node", [HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("http://127.0.0.1:8790")).toBe(0);
    expect(node.sent).toEqual([]);
  });
});

describe("announceNodeName", () => {
  it("tells a node the name a browser gave it", () => {
    const { store, service, enroll } = setup();
    const node = enroll("weili-pc", ["copilot-acp", NODE_NAME_SYNC_CAPABILITY]);
    store.renameNode(node.nodeId, "build-01");

    expect(service.announceNodeName(node.nodeId, "build-01")).toBe(true);
    expect(node.sent).toEqual([{ type: "node_name", name: "build-01" }]);
  });

  it("says nothing to a node whose agent predates the message", () => {
    // Same hazard as `host_url`: an older agent hangs up on a frame its copy of
    // the union does not have, so a label change would cost it its connection.
    const { service, enroll } = setup();
    const older = enroll("weili-pc", ["copilot-acp"]);

    expect(service.announceNodeName(older.nodeId, "build-01")).toBe(false);
    expect(older.sent).toEqual([]);
  });

  it("reports nothing sent when the node is offline", () => {
    const { store, service } = setup();
    const { node } = store.registerNode({
      name: "offline-node",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: [NODE_NAME_SYNC_CAPABILITY],
      maxSessions: 1,
    });

    expect(service.announceNodeName(node.id, "build-01")).toBe(false);
  });
});

describe("requestUpdate", () => {
  it("asks a stale node to update itself", () => {
    const { service, enroll } = setup("host2222");
    const node = enroll("devbox", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");

    expect(service.requestUpdate(node.nodeId)).toEqual({ started: true });
    expect(node.sent.map((frame) => frame.type)).toEqual(["update_node"]);
  });

  it("refuses a node whose build cannot be updated remotely", () => {
    // The frame is not in that agent's copy of the message union, so sending it
    // would close the socket instead of updating the machine.
    const { service, enroll } = setup("host2222");
    const older = enroll("older", ["copilot-acp"], "node1111");

    const result = service.requestUpdate(older.nodeId);
    expect(result.started).toBe(false);
    expect(result.reason).toContain("by hand");
    expect(older.sent).toEqual([]);
  });

  it("refuses to restart a node out from under a running session", () => {
    // An update restarts the process and every agent it hosts dies with it, so
    // one click on "Update all" must not cost a colleague their running turn.
    const { store, service, enroll } = setup("host2222");
    const node = enroll("busy", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.nodeId, "C:\\repo");
    store.createSession(placement, "mid-flight");

    const result = service.requestUpdate(node.nodeId);
    expect(result.started).toBe(false);
    expect(result.reason).toContain("session");
    // Named, so a browser can offer to stop them rather than only complaining.
    expect(result.blockedBy?.map((session) => session.initialPrompt)).toEqual([
      "mid-flight",
    ]);
    expect(node.sent).toEqual([]);
  });

  it("stops the sessions in the way when told to", () => {
    // The operator has seen what is running and decided; the stop goes first so
    // each agent ends deliberately rather than dying with the process.
    const { store, service, enroll } = setup("host2222");
    const node = enroll("busy", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.nodeId, "C:\\repo");
    store.createSession(placement, "mid-flight");

    expect(service.requestUpdate(node.nodeId, { stopSessions: true })).toEqual({
      started: true,
    });
    const sent = node.sent.map((frame) => frame.command?.type ?? frame.type);
    expect(sent).toEqual(["stop", "update_node"]);
  });

  it("lists only the nodes that are actually behind", () => {
    const { service, enroll } = setup("host2222");
    const stale = enroll("stale", [SELF_UPDATE_CAPABILITY], "node1111");
    enroll("current", [SELF_UPDATE_CAPABILITY], "host2222");
    // No revision on either side is not evidence of being behind.
    enroll("unknown", [SELF_UPDATE_CAPABILITY], "");

    expect(service.staleNodeIds()).toEqual([stale.nodeId]);
  });
});

describe("settleUpdateOnReconnect", () => {
  /** Enrols a node with an update already in flight and a browser watching. */
  function updating() {
    const { service, enroll } = setup("host2222");
    const node = enroll("devbox", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");
    const browser = fakeSocket();
    service.addBrowser(browser.socket);
    service.requestUpdate(node.nodeId);
    const stages = () =>
      browser.sent.filter((frame) => frame.type === "node_update").map((f) => f.stage);
    return { service, node, browser, stages };
  }

  it("finishes the update the node was never able to report on", () => {
    const { service, node, browser, stages } = updating();
    // "restarting" is the node's last word — it exits on the next line, so
    // without the Host noticing the return, the browser renders it forever.
    service.publishNodeUpdate(node.nodeId, "restarting", "Updated to abcdef123456");

    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");

    expect(stages()).toEqual(["checking", "restarting", "up_to_date"]);
    // The revision it came back on is what the operator wanted to know.
    expect(browser.sent.at(-1)?.detail).toBe("Updated to abcdef123456");
  });

  it("stays silent when a node reconnects for any other reason", () => {
    // Tunnels drop and machines wake up; neither is an update finishing.
    const { service, enroll } = setup("host2222");
    const node = enroll("devbox", ["copilot-acp", SELF_UPDATE_CAPABILITY], "node1111");
    const browser = fakeSocket();
    service.addBrowser(browser.socket);

    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");

    expect(browser.sent).toEqual([]);
  });

  it("settles an update once, however often the node reconnects", () => {
    const { service, node, browser } = updating();
    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");
    browser.sent.length = 0;

    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");

    expect(browser.sent).toEqual([]);
  });

  it("does not reopen an update that already failed", () => {
    // A failure is a conclusion. The node still comes back — it never left —
    // and that return must not overwrite the reason with a success.
    const { service, node, browser } = updating();
    service.publishNodeUpdate(node.nodeId, "failed", "A watcher owns this process");
    browser.sent.length = 0;

    service.settleUpdateOnReconnect(node.nodeId, "abcdef1234567890");

    expect(browser.sent).toEqual([]);
  });

  it("still concludes when the node cannot name a revision", () => {
    const { service, node, browser, stages } = updating();

    service.settleUpdateOnReconnect(node.nodeId, undefined);

    expect(stages()).toEqual(["checking", "up_to_date"]);
    expect(browser.sent.at(-1)?.detail).toBe("Update finished");
  });
});

describe("host revision", () => {
  it("follows a commit made while the Host kept running", () => {
    // The reported bug: an update that worked still showed "Update available".
    // Committing moves HEAD without touching a file, so nothing restarts the
    // Host; a revision captured at construction then disagreed with the node
    // that had just landed on the real HEAD, and pressing update again re-landed
    // the same commit — so the badge could never clear.
    let head = "aaaaaaaaaaaa";
    const { service, enroll } = setup(() => head);
    enroll("box", [SELF_UPDATE_CAPABILITY], "bbbbbbbbbbbb");

    expect(service.staleNodeIds()).toHaveLength(1);
    head = "bbbbbbbbbbbb";
    expect(service.staleNodeIds()).toEqual([]);
    expect(service.snapshot().hostRevision).toBe("bbbbbbbbbbbb");
  });

  it("still accepts a fixed revision", () => {
    const { service } = setup("cccccccccccc");
    expect(service.snapshot().hostRevision).toBe("cccccccccccc");
  });
});
