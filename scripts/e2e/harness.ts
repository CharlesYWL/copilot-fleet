import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { TranscriptProjector, type SessionEvent } from "@fleet/protocol";
import {
  AUTH_MODE_SETTING,
  NO_AUTH_PRINCIPAL,
} from "../../apps/host/src/auth/service.js";
import { FleetStore } from "../../apps/host/src/store.js";
import { historyEvents } from "../benchmarks/history-fixture.js";
import { seed } from "../benchmarks/history.js";

/**
 * A disposable Fleet Host with synthetic conversations, for driving its real UI
 * from a browser. Shared by the browser benchmark and the browser tests.
 *
 * Nothing here touches an operator's Host: the database is a new file, the Host
 * listens on a free loopback port with sign-in off, and its environment drops
 * every Fleet setting the caller's shell might carry.
 */

export const conversationName = (index: number) => `Synthetic session ${index}`;
/** The last line of each seeded conversation, so a test can tell which is open. */
export const endMarker = (index: number) => `BENCHMARK-END-${index}`;

export function freePort(): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? accept(address.port)
          : reject(new Error("No port")),
      );
    });
  });
}

export type PreparedConversations = {
  /** Conversation 0 is the long one; the rest are `ceil(events / 14)` long. */
  ids: string[];
  nodeId: string;
  /** The seeded Node's shared secret, for {@link FakeNode}. */
  nodeSecret: string;
  leadEvents: number;
  leadBlocks: number;
  /** The next unused sequence number in every conversation. */
  nextSequence: Map<string, number>;
};

/** Seeds a disposable Host database: synthetic content only, signed in to nobody. */
export function prepareConversations(
  path: string,
  input: { events: number; sessions: number },
): PreparedConversations {
  const store = new FleetStore(path);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const { ids, fixture, node } = seed(store, database, {
      events: input.events,
      sessions: input.sessions,
      iterations: 1,
      warmup: 0,
      output: "",
      worker: false,
      help: false,
    });
    const nextSequence = new Map<string, number>();
    ids.forEach((id, index) =>
      nextSequence.set(
        id,
        (index === 0 ? fixture.leadEvents : fixture.backgroundEventsPerSession) + 1,
      ),
    );
    const insert = database.prepare(
      "INSERT INTO events (event_id,session_id,sequence,type,payload,created_at,received_at) VALUES (?,?,?,?,?,?,?)",
    );
    const at = new Date(Date.UTC(2026, 0, 2)).toISOString();
    ids.forEach((id, index) => {
      // A unique last line, so "opened" can be detected without scanning the page.
      for (const event of lineEvents(id, nextSequence.get(id)!, endMarker(index), at)) {
        insert.run(
          event.eventId,
          id,
          event.sequence,
          event.type,
          JSON.stringify(event.payload),
          at,
          at,
        );
      }
      nextSequence.set(id, nextSequence.get(id)! + 2);
      store.setSessionFavorite(id, true);
    });
    // The page opens on the first listed conversation; keep the long one cold.
    store.reorderSessions([...ids.slice(1), ids[0]!]);
    store.setSetting(AUTH_MODE_SETTING, NO_AUTH_PRINCIPAL);
    const projector = new TranscriptProjector();
    for (const event of historyEvents(ids[0]!, 0, fixture.leadEvents))
      projector.apply(event);
    return {
      ids,
      nodeId: node.id,
      nodeSecret: node.secret,
      leadEvents: fixture.leadEvents,
      leadBlocks: projector.blocks.length,
      nextSequence,
    };
  } finally {
    database.close();
    store.close();
  }
}

/**
 * A line of agent text in a block of its own.
 *
 * Agent text appends to the block before it, so a turn boundary goes first;
 * otherwise the line would join the end of the previous answer.
 */
export function lineEvents(
  sessionId: string,
  sequence: number,
  text: string,
  createdAt = new Date().toISOString(),
): SessionEvent[] {
  return [
    {
      eventId: randomUUID(),
      sessionId,
      sequence,
      type: "turn_complete",
      payload: { stopReason: "end_turn" },
      createdAt,
    },
    {
      eventId: randomUUID(),
      sessionId,
      sequence: sequence + 1,
      type: "agent_text",
      payload: { text },
      createdAt,
    },
  ];
}

/** Starts the Host built in `root` on a disposable database. */
export async function startHost(root: string, databasePath: string, port: number) {
  const entry = join(root, "apps", "host", "dist", "server", "server.js");
  if (!existsSync(entry)) throw new Error(`Build the Host first: ${entry} is missing`);
  // Only what is set here: never the operator's own Host configuration.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(FLEET_|ENROLLMENT_TOKEN|DATABASE_PATH|PORT|HOST$)/.test(key))
      env[key] = value;
  }
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...env,
      NODE_ENV: "production",
      DATABASE_PATH: databasePath,
      PORT: String(port),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4_000);
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 600; attempt++) {
    if (child.exitCode !== null) throw new Error(`Host exited early:\n${errors}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return { child, url };
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  child.kill();
  throw new Error(`Host did not start:\n${errors}`);
}

export async function stopHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((accept) => child.once("exit", accept));
  child.kill();
  await Promise.race([exited, delay(10_000)]);
}

/**
 * Installed in the page before the app loads.
 *
 * Keeps the app's sockets reachable, can refuse new ones to simulate a lost
 * Host, and resolves when given text is painted.
 */
export const PAGE_SCRIPT = `
// tsx keeps function names by wrapping them in __name, which page functions
// sent through page.evaluate then reference.
window.__name = (target) => target;
(() => {
  const sockets = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      // A path the Host does not serve: the attempt fails like a lost Host.
      super(window.__harness.offline ? String(url).replace("/ws/browser", "/ws/offline") : url, protocols);
      sockets.push(this);
    }
  };
  window.__harness = {
    sockets,
    offline: false,
    /** Drops the app's live connection and refuses new ones until online again. */
    disconnect() {
      this.offline = true;
      for (const socket of sockets) socket.close();
    },
    reconnect() {
      this.offline = false;
    },
    /** Resolves with ms from now until text containing "needle" is painted. */
    untilPainted(needle, timeoutMs) {
      const start = performance.now();
      return new Promise((accept, reject) => {
        const contains = (node) => (node.textContent || "").includes(needle);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          requestAnimationFrame(() => setTimeout(() => accept(performance.now() - start), 0));
        };
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === "characterData" ? contains(record.target) : [...record.addedNodes].some(contains)) {
              finish();
              return;
            }
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error("Timed out waiting for " + needle)); }, timeoutMs);
      });
    },
  };
})();
`;

/** How a page script reaches {@link PAGE_SCRIPT}'s helpers. */
export type PageHarness = {
  sockets: WebSocket[];
  offline: boolean;
  disconnect(): void;
  reconnect(): void;
  untilPainted(needle: string, timeoutMs: number): Promise<number>;
};

/**
 * The seeded Node, connected the way a Node that predates key enrolment is.
 *
 * Its events take the same path a real Node's do — the gateway, the store, the
 * transcript projection, the browser broadcast — without starting an agent.
 * It reports every conversation as running and idle, which also enables their
 * composers.
 */
export class FakeNode {
  private readonly heartbeat: NodeJS.Timeout;

  private constructor(
    private readonly socket: WebSocket,
    private readonly sessionIds: readonly string[],
    private readonly nextSequence: Map<string, number>,
  ) {
    this.heartbeat = setInterval(() => {
      this.write({
        type: "heartbeat",
        activeSessionIds: this.sessionIds,
        busySessionIds: [],
        sentAt: new Date().toISOString(),
      });
    }, 5_000);
    this.heartbeat.unref();
  }

  static async connect(hostUrl: string, prepared: PreparedConversations) {
    const socket = new WebSocket(`${hostUrl.replace(/^http/, "ws")}/ws/node`);
    await new Promise<void>((accept, reject) => {
      socket.addEventListener("open", () => accept(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Node socket failed")), {
        once: true,
      });
    });
    const welcomed = new Promise<void>((accept, reject) => {
      const onMessage = (message: MessageEvent) => {
        const frame = JSON.parse(String(message.data)) as { type?: string };
        if (frame.type !== "welcome") return;
        socket.removeEventListener("message", onMessage);
        accept();
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener(
        "close",
        (event) =>
          reject(new Error(`Host refused the Node: ${event.code} ${event.reason}`)),
        { once: true },
      );
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        nodeId: prepared.nodeId,
        secret: prepared.nodeSecret,
        os: process.platform,
        arch: process.arch,
        version: "e2e",
        capabilities: ["copilot-acp"],
        maxSessions: prepared.ids.length,
        activeSessionIds: prepared.ids,
        busySessionIds: [],
      }),
    );
    await welcomed;
    return new FakeNode(socket, prepared.ids, new Map(prepared.nextSequence));
  }

  /** Stores events in order, as the agent in `sessionId` would produce them. */
  send(
    sessionId: string,
    events: readonly Pick<SessionEvent, "type" | "payload">[],
  ): SessionEvent[] {
    let sequence = this.nextSequence.get(sessionId);
    if (sequence === undefined) throw new Error(`Unknown session ${sessionId}`);
    const sent = events.map((event) => ({
      eventId: randomUUID(),
      sessionId,
      sequence: sequence!++,
      type: event.type,
      payload: event.payload,
      createdAt: new Date().toISOString(),
    })) as SessionEvent[];
    this.nextSequence.set(sessionId, sequence);
    for (const event of sent) this.write({ type: "event", event });
    return sent;
  }

  /** One line of agent text in a block of its own. */
  say(sessionId: string, text: string): void {
    this.send(
      sessionId,
      lineEvents(sessionId, 0, text).map(({ type, payload }) => ({ type, payload })),
    );
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.socket.close();
  }

  private write(frame: unknown): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Node socket closed");
    this.socket.send(JSON.stringify(frame));
  }
}
