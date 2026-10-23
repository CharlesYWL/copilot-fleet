/**
 * Why this Node cannot reach its Host, as far as the Node can tell.
 *
 * The WebSocket alone cannot say: in Corp direct and Dev Tunnel modes it dials
 * a local forward, so every failure arrives as the same refused upgrade or
 * relay `502` whether the Host is stopped, unreachable, or cut off by a
 * firewall between regions. A separate check of the real route produces this.
 */
export type HostConnectionProblemKind =
  | "host-connection-failed"
  | "host-not-running"
  | "host-unreachable"
  | "network-intercepted"
  | "handshake-failed"
  | "tunnel-not-hosted"
  | "tunnel-not-answering"
  | "tunnel-check-failed";

export type HostConnectionProblem = {
  kind: HostConnectionProblemKind;
  /** A few words for the status line, such as "Host is not running". */
  summary: string;
  /** The full explanation, naming the address checked and what to do next. */
  message: string;
  /** When the check finished, as an ISO timestamp. */
  checkedAt: string;
};
