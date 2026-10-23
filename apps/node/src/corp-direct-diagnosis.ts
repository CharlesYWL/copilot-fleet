import net from "node:net";
import type { HostConnectionProblem } from "./host-connection-problem.js";

/**
 * Why a Corp direct (private-IP) dial failed.
 *
 * The Node reaches the Host through a loopback relay, so a blocked connection
 * reaches the WebSocket only as a relay `502`. These checks dial the Host's
 * real address with raw TCP instead, which is the only way to tell a stopped
 * Host from a network device answering on the Host's behalf.
 */
export type CorpDirectDiagnosis =
  /** The Host machine answered and refused the Fleet port. */
  | "host-not-running"
  /** Nothing answered the Fleet port: timeout, no route, or silently dropped. */
  | "host-unreachable"
  /** Ports the Host does not use also accept, so a device in the path is answering. */
  | "network-intercepted"
  /** The direct path is clean and the Fleet port accepts; TLS, WebSocket or auth failed. */
  | "handshake-failed";

export type CorpDirectDiagnosisResult = {
  diagnosis: CorpDirectDiagnosis;
  /** The evidence behind the diagnosis, in a form that can be quoted in a log. */
  detail: string;
};

export type CorpDirectDiagnosisOptions = {
  timeoutMs?: number;
  /** Ports nothing on the Host should listen on; two random high ports by default. */
  probePorts?: number[];
  connect?: (options: net.NetConnectOpts) => net.Socket;
};

type ProbeOutcome = { connected: true } | { connected: false; code: string };

const DEFAULT_TIMEOUT_MS = 3_000;
const PROBE_PORT_MIN = 49_152;
const PROBE_PORT_MAX = 65_000;
const PROBE_PORT_COUNT = 2;

type HostAddress = { host: string; port: number };

const hostAddress = (hostUrl: string): HostAddress => {
  const url = new URL(hostUrl);
  return {
    // IPv6 literals keep their brackets in `hostname`; sockets want them bare.
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
  };
};

/** Two distinct high ports that are not the Fleet port. */
const randomProbePorts = (fleetPort: number): number[] => {
  const ports = new Set<number>();
  while (ports.size < PROBE_PORT_COUNT) {
    const port =
      PROBE_PORT_MIN + Math.floor(Math.random() * (PROBE_PORT_MAX - PROBE_PORT_MIN + 1));
    if (port !== fleetPort) ports.add(port);
  }
  return [...ports];
};

/** Opens and immediately closes one TCP connection; never sends a byte. */
const probe = (
  connect: NonNullable<CorpDirectDiagnosisOptions["connect"]>,
  address: HostAddress,
  timeoutMs: number,
): Promise<ProbeOutcome> =>
  new Promise((resolve) => {
    let socket: net.Socket;
    try {
      socket = connect({ host: address.host, port: address.port });
    } catch (error) {
      resolve({ connected: false, code: errorCode(error) });
      return;
    }
    let settled = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ connected: false, code: "ETIMEDOUT" }),
      timeoutMs,
    );
    socket.once("connect", () => finish({ connected: true }));
    socket.once("error", (error) => finish({ connected: false, code: errorCode(error) }));
  });

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? "ERROR";

const describeOutcome = (outcome: ProbeOutcome): string =>
  outcome.connected ? "accepted" : outcome.code;

/**
 * Classifies a failed Corp direct dial by probing the Host's real address.
 *
 * Two unused ports are probed rather than one so that a service that happens
 * to listen on one of them cannot pass for an intercepting firewall.
 */
export const diagnoseCorpDirectFailure = async (
  hostUrl: string,
  options: CorpDirectDiagnosisOptions = {},
): Promise<CorpDirectDiagnosisResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connect = options.connect ?? net.connect;
  const fleet = hostAddress(hostUrl);
  const fleetOutcome = await probe(connect, fleet, timeoutMs);
  if (!fleetOutcome.connected) {
    return fleetOutcome.code === "ECONNREFUSED"
      ? {
          diagnosis: "host-not-running",
          detail: `port ${fleet.port} refused the connection`,
        }
      : {
          diagnosis: "host-unreachable",
          detail: `port ${fleet.port}: ${fleetOutcome.code}`,
        };
  }
  const probePorts = (options.probePorts ?? randomProbePorts(fleet.port)).filter(
    (port) => port !== fleet.port,
  );
  const outcomes = await Promise.all(
    probePorts.map((port) => probe(connect, { host: fleet.host, port }, timeoutMs)),
  );
  const evidence = probePorts
    .map((port, index) => `port ${port} ${describeOutcome(outcomes[index]!)}`)
    .join(", ");
  const intercepted =
    outcomes.length > 0 && outcomes.every((outcome) => outcome.connected);
  return {
    diagnosis: intercepted ? "network-intercepted" : "handshake-failed",
    detail: `port ${fleet.port} accepted; unused ${evidence}`,
  };
};

const SUMMARIES: Record<CorpDirectDiagnosis, string> = {
  "host-not-running": "Host is not running",
  "host-unreachable": "Host is unreachable",
  "network-intercepted": "Blocked between regions",
  "handshake-failed": "Secure connection failed",
};

/** The sentence an operator reads on the Node config page. */
export const describeCorpDirectDiagnosis = (
  hostUrl: string,
  result: CorpDirectDiagnosisResult,
): string => {
  const { host, port } = hostAddress(hostUrl);
  switch (result.diagnosis) {
    case "host-not-running":
      return `The Host machine at ${host} is reachable, but nothing accepts connections on port ${port}. Start the Fleet Host on that machine, or check the port in its connect command.`;
    case "host-unreachable":
      return `Nothing answers at ${host}:${port} (${result.detail}). The Host Dev Box may be stopped or hibernating, may have a new private IP, or traffic to it is blocked.`;
    case "network-intercepted":
      return `A network device between this Node and the Host at ${host} accepts connections even on ports the Host does not use (${result.detail}), then drops Fleet's encrypted connection. This usually means this Node and the Host are in different Dev Box regions, where private-IP connections are blocked. Use a Dev Tunnel for this Node, or move it to the Host's region.`;
    case "handshake-failed":
      return `This Node reaches the Host at ${host}:${port} directly, but the secure connection failed. Check that the Host's connect command (certificate) is current and that the Host is running this Fleet version.`;
  }
};

/** Runs the check and shapes it for the Node's status. */
export const checkCorpDirectHost = async (
  hostUrl: string,
  options?: CorpDirectDiagnosisOptions,
): Promise<HostConnectionProblem> => {
  const result = await diagnoseCorpDirectFailure(hostUrl, options);
  return {
    kind: result.diagnosis,
    summary: SUMMARIES[result.diagnosis],
    message: describeCorpDirectDiagnosis(hostUrl, result),
    checkedAt: new Date().toISOString(),
  };
};
