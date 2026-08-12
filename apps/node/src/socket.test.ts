import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { closeQuietly } from "./socket.js";

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
