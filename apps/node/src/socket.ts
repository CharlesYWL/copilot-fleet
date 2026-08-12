import type WebSocket from "ws";

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
