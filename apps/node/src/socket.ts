import type WebSocket from "ws";
import type { NodeToHostMessage, OutboxFlushId, SessionEvent } from "@fleet/protocol";
import type { EventOutbox, OutboxFlush } from "./outbox.js";

/**
 * How long a dial may sit in the opening handshake before it is abandoned.
 *
 * A dial that is refused fails in about a millisecond, and that is the failure
 * everything downstream was written for: the close handler rotates to the next
 * address, counts the attempt, and rebuilds the dev tunnel once enough of them
 * have failed. None of it runs while a dial is merely *slow*.
 *
 * And a dial through a dead tunnel is slow rather than refused. A
 * `devtunnel connect` whose relay session is gone keeps its loopback listener
 * open, so the TCP connection is accepted and then goes nowhere — no refusal,
 * no response, nothing to report. Left to the operating system that dial sits
 * there for the whole retransmission budget, which on Windows is about half an
 * hour. For those thirty minutes the node has one connection attempt in flight,
 * no close event, no reconnect, and no way to notice the tunnel it is waiting
 * on is the thing that is broken: the automatic rebuild that exists for exactly
 * this failure is driven by close events it will never get. A rebooted Host
 * therefore cost this node its whole session, recoverable only by a person
 * pressing Rebuild on the config page.
 *
 * Generous enough that a Host reached over a real tunnel on a cold start is not
 * cut off mid-handshake, short enough that a black hole is recognised as one
 * while the operator is still watching.
 */
export const HOST_DIAL_TIMEOUT_MS = 10_000;

/** How often an open socket asks the Host to prove it is still there. */
export const LIVENESS_PING_INTERVAL_MS = 10_000;

/**
 * How long the Host may say nothing at all before the socket is declared dead.
 *
 * Three missed pings. The Host answers a ping automatically, so silence this
 * long is not an idle fleet — it is a connection that is still open on this end
 * only, which is what a power-cycled Host or a dropped relay leaves behind.
 */
export const LIVENESS_TIMEOUT_MS = 30_000;

/**
 * The parts of a socket the watchdog touches, so a test can supply its own.
 */
export type LivenessSocket = {
  readonly readyState: number;
  on(event: "message", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
  ping(): void;
  terminate(): void;
};

/** `ws`'s OPEN, spelled out so the watchdog needs nothing from the class. */
const SOCKET_OPEN = 1;

type OutboxFlushedMessage = Extract<NodeToHostMessage, { type: "outbox_flushed" }>;

export type ReconnectInventory = {
  activeSessionIds: readonly string[];
  busySessionIds: readonly string[];
};

export type ReconnectFlush = OutboxFlush & {
  flushId?: OutboxFlushId;
  reconciliationSent: boolean;
};

/**
 * Flushes buffered events before sending the inventory that unlocks Host
 * reconciliation. If either send stops accepting frames, the final inventory
 * is withheld so a partial flush cannot falsely settle the session.
 */
export function flushReconnectOutbox(
  outbox: EventOutbox,
  sendEvent: (
    event: SessionEvent,
    position: {
      flushId: OutboxFlushId;
      eventCount: number;
      eventIndex: number;
    },
  ) => boolean,
  sendReconciliation: (message: OutboxFlushedMessage) => boolean,
  inventory: () => ReconnectInventory,
): ReconnectFlush {
  const batch = outbox.currentBatch;
  if (!batch) return { sent: 0, dropped: 0, reconciliationSent: false };
  let sent = 0;
  for (const [eventIndex, event] of batch.events.entries()) {
    if (
      !sendEvent(event, {
        flushId: batch.flushId,
        eventCount: batch.events.length,
        eventIndex,
      })
    ) {
      return {
        flushId: batch.flushId,
        sent,
        dropped: batch.dropped,
        reconciliationSent: false,
      };
    }
    sent += 1;
  }
  const current = inventory();
  const reconciliationSent = sendReconciliation({
    type: "outbox_flushed",
    activeSessionIds: [...current.activeSessionIds],
    busySessionIds: [...current.busySessionIds],
    outboxFlush: {
      flushId: batch.flushId,
      eventCount: batch.events.length,
    },
  });
  return {
    flushId: batch.flushId,
    sent,
    dropped: batch.dropped,
    reconciliationSent,
  };
}

export type LivenessOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Called with the silence that condemned the socket, for the log. */
  onDead?: (silentMs: number) => void;
};

/**
 * Hangs up on a Host that has stopped answering, so the reconnect loop can run.
 *
 * An established socket has the same blind spot as a dial: a Host that is
 * rebooted, or a tunnel whose relay drops, does not close the connection — it
 * simply stops existing. TCP does not report that until a write has exhausted
 * its retransmissions, which is minutes at best, and the node's own heartbeat
 * is a write into that void rather than a check on it. Nothing arrives to prove
 * the far end is gone, so nothing fires and the node waits on a socket that is
 * open on one side only.
 *
 * A ping is the missing half. `ws` answers one automatically, so a Host that is
 * still there refreshes the clock within a round trip and no protocol change is
 * needed; a Host that is not lets the clock run out, and terminating the socket
 * produces the close event the reconnect, address rotation and tunnel rebuild
 * all hang off. Any inbound frame counts as proof, so a busy connection is
 * never condemned for failing to answer a ping it was too busy to reach.
 *
 * Returns the function that stops watching, for the caller to run on close.
 */
export function watchHostLiveness(
  socket: LivenessSocket,
  options: LivenessOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? LIVENESS_PING_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? LIVENESS_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((fn, ms) => {
      const handle = setInterval(fn, ms);
      // The node has nothing to do between pings, so this must not be the
      // reason the process refuses to exit.
      handle.unref();
      return handle;
    });
  const clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer));

  let lastHeard = now();
  const heard = (): void => {
    lastHeard = now();
  };
  socket.on("message", heard);
  socket.on("pong", heard);

  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (!timer) return;
    clearTimer(timer);
    timer = undefined;
  };

  timer = setTimer(() => {
    // A socket that is no longer open has nothing left to prove, and pinging
    // one throws or emits an error nobody is listening for. Retargeting a node
    // drops every listener before closing the socket it is leaving, so this is
    // also what keeps a watchdog from outliving the connection it was given.
    if (socket.readyState !== SOCKET_OPEN) {
      stop();
      return;
    }
    const silentMs = now() - lastHeard;
    if (silentMs <= timeoutMs) {
      socket.ping();
      return;
    }
    // Stopped before terminating: `terminate` closes the socket, and the close
    // handler stops the watchdog too. Doing it here means the timer is gone
    // whichever of them runs first.
    stop();
    options.onDead?.(silentMs);
    socket.terminate();
  }, intervalMs);

  return stop;
}

/**
 * Closes a socket nobody listens to any more.
 *
 * `close()` on a socket that is still handshaking makes ws emit `error`
 * ("WebSocket was closed before the connection was established"), and an
 * emitter with no `error` listener throws instead. Callers drop the old
 * listeners on purpose — a stale close handler would schedule a retry against
 * the address they are moving away from — so the emitter is left bare at
 * exactly the moment ws needs it not to be, and retargeting a node whose dial
 * was still in flight took the process down with it.
 */
export function closeQuietly(socket: WebSocket): void {
  socket.on("error", () => {});
  socket.close();
}
