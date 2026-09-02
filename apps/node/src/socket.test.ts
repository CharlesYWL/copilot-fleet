import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  closeQuietly,
  flushReconnectOutbox,
  HOST_DIAL_TIMEOUT_MS,
  watchHostLiveness,
  type LivenessSocket,
} from "./socket.js";
import { EventOutbox } from "./outbox.js";
import {
  OutboxFlushIdSchema,
  type NodeToHostMessage,
  type SessionEvent,
} from "@fleet/protocol";

/** A dial that will never be answered, so the socket stays in CONNECTING. */
function handshakingSocket(): WebSocket {
  const socket = new WebSocket("ws://127.0.0.1:9/ws/node");
  expect(socket.readyState).toBe(WebSocket.CONNECTING);
  return socket;
}

describe("closeQuietly", () => {
  it("survives closing a socket that is still handshaking", async () => {
    const socket = handshakingSocket();
    // What the caller does before dropping a socket: without a replacement
    // `error` listener this close crashed the process a tick later, which no
    // assertion here can catch — an unhandled 'error' fails the run instead.
    socket.removeAllListeners();

    closeQuietly(socket);

    expect(socket.listenerCount("error")).toBe(1);
    await delay(50);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  describe("ordered reconnect outbox flush", () => {
    const flushId = OutboxFlushIdSchema.parse("11111111-1111-4111-8111-111111111111");
    const event = (sequence: number, type: SessionEvent["type"]): SessionEvent => ({
      eventId: `event-${sequence}`,
      sessionId: "session-1",
      sequence,
      type,
      payload: type === "state" ? { state: "idle" } : {},
      createdAt: "2026-09-01T20:00:00.000Z",
    });

    it("sends authoritative events before exactly one current inventory", () => {
      const outbox = new EventOutbox(10, () => flushId);
      outbox.add(event(1, "turn_complete"));
      outbox.add(event(2, "state"));
      outbox.prepareFlush();
      const sent: NodeToHostMessage[] = [];

      const result = flushReconnectOutbox(
        outbox,
        (buffered, position) => {
          sent.push({ type: "event", event: buffered, outboxFlush: position });
          return true;
        },
        (message) => {
          sent.push(message);
          return true;
        },
        () => ({
          activeSessionIds: ["session-1"],
          busySessionIds: [],
        }),
      );

      expect(sent.map((message) => message.type)).toEqual([
        "event",
        "event",
        "outbox_flushed",
      ]);
      expect(sent.at(-1)).toEqual({
        type: "outbox_flushed",
        activeSessionIds: ["session-1"],
        busySessionIds: [],
        outboxFlush: { flushId, eventCount: 2 },
      });
      expect(result).toEqual({
        flushId,
        sent: 2,
        dropped: 0,
        reconciliationSent: true,
      });
      expect(outbox.size).toBe(2);
      expect(
        sent
          .slice(0, 2)
          .map((message) =>
            message.type === "event" ? message.outboxFlush?.eventIndex : undefined,
          ),
      ).toEqual([0, 1]);
    });

    it("withholds reconciliation when the socket stops accepting the flush", () => {
      const outbox = new EventOutbox(10, () => flushId);
      outbox.add(event(1, "turn_complete"));
      outbox.add(event(2, "state"));
      outbox.prepareFlush();
      const reconciliations: NodeToHostMessage[] = [];

      const result = flushReconnectOutbox(
        outbox,
        (buffered) => buffered.sequence === 1,
        (message) => {
          reconciliations.push(message);
          return true;
        },
        () => ({
          activeSessionIds: ["session-1"],
          busySessionIds: [],
        }),
      );

      expect(result).toEqual({
        flushId,
        sent: 1,
        dropped: 0,
        reconciliationSent: false,
      });
      expect(outbox.size).toBe(2);
      expect(reconciliations).toEqual([]);
    });

    it("can finish a pending handshake after a prior socket emptied the queue", () => {
      const reconciliations: NodeToHostMessage[] = [];
      const outbox = new EventOutbox(10, () => flushId);
      outbox.prepareFlush(true);
      const result = flushReconnectOutbox(
        outbox,
        () => true,
        (message) => {
          reconciliations.push(message);
          return true;
        },
        () => ({ activeSessionIds: [], busySessionIds: [] }),
      );

      expect(result.reconciliationSent).toBe(true);
      expect(result.flushId).toBe(flushId);
      expect(reconciliations).toHaveLength(1);
    });
  });

  it("leaves an already open socket to close normally", async () => {
    const socket = handshakingSocket();
    socket.removeAllListeners();
    closeQuietly(socket);
    await delay(50);

    // Closing twice must stay quiet too: shutdown can race a reconnect.
    expect(() => closeQuietly(socket)).not.toThrow();
    await delay(10);
  });
});

/**
 * A listener that accepts a connection and then says nothing, which is what a
 * `devtunnel connect` whose relay session is gone leaves behind: the local port
 * is still bound, so the dial is neither refused nor answered.
 */
async function blackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const held: Socket[] = [];
  const server: Server = createServer((socket) => held.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("dialing a Host that accepts and then goes silent", () => {
  it("gives up instead of waiting out the operating system", async () => {
    const hole = await blackHole();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${hole.port}/ws/node`, {
        handshakeTimeout: 200,
      });
      socket.on("error", () => {});

      // The close is the whole point: everything that recovers a node -- the
      // retry, the address rotation, the dev tunnel rebuild -- hangs off it,
      // and an unbounded dial never produces one.
      const code = await new Promise<number>((resolve) => {
        socket.on("close", resolve);
      });

      expect(code).toBe(1006);
    } finally {
      await hole.close();
    }
  });

  it("uses a deadline long enough for a real handshake", () => {
    // A dial that is merely slow must not be mistaken for a dead tunnel, or a
    // node behind a cold tunnel would rebuild the one thing it is waiting on.
    expect(HOST_DIAL_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});

/** Records what the watchdog did to it, without opening a socket. */
function fakeSocket() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    // ws's OPEN; the watchdog retires itself on anything else.
    readyState: 1,
    pings: 0,
    terminated: 0,
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.terminated += 1;
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

describe("watchHostLiveness", () => {
  /** Drives the watchdog by hand so no test waits on a real clock. */
  const harness = () => {
    const socket = fakeSocket();
    const ticks = new Map<number, () => void>();
    let nextHandle = 1;
    let clock = 0;
    const dead: number[] = [];
    const stop = watchHostLiveness(socket as unknown as LivenessSocket, {
      intervalMs: 10,
      timeoutMs: 30,
      now: () => clock,
      setTimer: ((fn: () => void) => {
        const handle = nextHandle;
        nextHandle += 1;
        ticks.set(handle, fn);
        return handle as unknown as NodeJS.Timeout;
      }) as never,
      clearTimer: ((handle: number) => {
        ticks.delete(handle);
      }) as never,
      onDead: (silentMs) => dead.push(silentMs),
    });
    return {
      socket,
      stop,
      dead,
      pending: () => ticks.size,
      tick: () => {
        for (const fn of [...ticks.values()]) fn();
      },
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };

  it("pings a Host that is still answering rather than hanging up on it", () => {
    const h = harness();
    h.advance(20);
    h.tick();
    expect(h.socket.pings).toBe(1);
    expect(h.socket.terminated).toBe(0);

    // ws answers a ping on its own, so this is what a live Host looks like.
    h.socket.emit("pong");
    h.advance(20);
    h.tick();
    expect(h.socket.terminated).toBe(0);
  });

  it("terminates a socket the Host has stopped answering on", () => {
    const h = harness();
    h.advance(31);

    h.tick();

    // Without this the socket stays open on one side only, and the node waits
    // on a Host that is not there instead of reconnecting to one that is.
    expect(h.socket.terminated).toBe(1);
    expect(h.dead).toEqual([31]);
  });

  it("counts any traffic as proof of life, not just a pong", () => {
    const h = harness();
    // A connection busy enough to miss a ping is not a dead one.
    h.advance(31);
    h.socket.emit("message");

    h.tick();

    expect(h.socket.terminated).toBe(0);
    expect(h.socket.pings).toBe(1);
  });

  it("stops watching a socket that has already closed", () => {
    const h = harness();

    h.stop();
    h.advance(100);
    h.tick();

    // A watchdog that outlived its socket would terminate whatever came next.
    expect(h.pending()).toBe(0);
    expect(h.socket.terminated).toBe(0);
    // Stopping twice must stay inert: close and terminate can race.
    expect(() => h.stop()).not.toThrow();
  });

  it("retires itself on a socket that was abandoned without closing", () => {
    const h = harness();
    // What retargeting a node leaves behind: every listener is dropped, so the
    // hook that would have stopped this watchdog never runs. Pinging on from
    // here throws on a socket that is no longer open, and with the listeners
    // gone that error has nowhere to go but the top of the process.
    h.socket.readyState = 3;
    h.advance(100);

    h.tick();

    expect(h.socket.pings).toBe(0);
    expect(h.socket.terminated).toBe(0);
    expect(h.pending()).toBe(0);
  });
});
