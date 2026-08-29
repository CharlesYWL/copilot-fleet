import type { WebSocket } from "ws";

/**
 * The close code a socket gets when its authorisation stopped being true.
 *
 * In the application range (4000-4999) and distinct from every other close, so
 * the page can say "sign in again" rather than reconnecting forever against a
 * Host that will keep refusing it.
 */
export const AUTHENTICATION_CLOSE_CODE = 4401;

/** How often live sockets are re-checked against the database. */
export const SESSION_REVALIDATION_MS = 60_000;

const CLOSE_REASON = "Session ended — sign in again";

export type SocketBinding = {
  /** The session digest, so a revocation can name exactly this socket. */
  tokenHash: string;
  /** Empty for a legacy password operator, who has no administrator row. */
  administratorId: string;
  expiresAt: number;
};

export type LiveSession = {
  administratorId: string;
  expiresAt: number;
};

export type BrowserSessionRegistryOptions = {
  now?: (() => number) | undefined;
  /**
   * The current truth about a session, or nothing if it no longer exists.
   *
   * Injected rather than reached for so this stays a policy about sockets: the
   * caller decides whether "still valid" means a database row, and this decides
   * what happens to the socket when it does not.
   */
  lookup: (tokenHash: string) => LiveSession | undefined;
};

/**
 * Which browser socket belongs to which session.
 *
 * A REST check happens once per request; a WebSocket is checked once and then
 * streams every transcript in the fleet for as long as it stays open. Without
 * this, removing an administrator revoked their cookie and left their live
 * stream running — the one surface where the revocation mattered most.
 *
 * Two mechanisms, because they fail differently. Revocation is immediate and
 * happens in the same operation that removed the authority. Revalidation is a
 * timer, and catches everything the immediate path could not know about: an
 * idle session lapsing, a row changed by another process, a socket whose
 * administrator was removed while this registry was not looking.
 */
export class BrowserSessionRegistry {
  private readonly now: () => number;
  private readonly lookup: (tokenHash: string) => LiveSession | undefined;
  private readonly sockets = new Map<WebSocket, SocketBinding>();

  constructor(options: BrowserSessionRegistryOptions) {
    this.now = options.now ?? Date.now;
    this.lookup = options.lookup;
  }

  add(socket: WebSocket, binding: SocketBinding): void {
    this.sockets.set(socket, binding);
  }

  remove(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  size(): number {
    return this.sockets.size;
  }

  /** Every socket currently bound, for a caller that broadcasts. */
  bindings(): ReadonlyMap<WebSocket, SocketBinding> {
    return this.sockets;
  }

  /** Closes the sockets belonging to sessions that were just revoked. */
  revokeSessions(tokenHashes: readonly string[]): number {
    const revoked = new Set(tokenHashes);
    return this.closeWhere((binding) => revoked.has(binding.tokenHash));
  }

  /** Closes every socket a removed administrator held. */
  revokeAdministrator(administratorId: string): number {
    if (!administratorId) return 0;
    return this.closeWhere((binding) => binding.administratorId === administratorId);
  }

  /**
   * Re-checks every socket against the current session state.
   *
   * The administrator comparison is not redundant with the lookup succeeding: a
   * session row can be re-pointed, and a socket that was authorised for one
   * identity must not keep streaming for another.
   */
  revalidate(): number {
    const now = this.now();
    return this.closeWhere((binding) => {
      if (binding.expiresAt <= now) return true;
      const live = this.lookup(binding.tokenHash);
      if (!live) return true;
      if (live.expiresAt <= now) return true;
      return live.administratorId !== binding.administratorId;
    });
  }

  closeAll(): void {
    this.closeWhere(() => true);
  }

  private closeWhere(matches: (binding: SocketBinding) => boolean): number {
    let closed = 0;
    for (const [socket, binding] of [...this.sockets]) {
      if (!matches(binding)) continue;
      this.sockets.delete(socket);
      closed += 1;
      socket.close(AUTHENTICATION_CLOSE_CODE, CLOSE_REASON);
    }
    return closed;
  }
}
